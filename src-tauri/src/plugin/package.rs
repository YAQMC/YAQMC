use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path},
};
use thiserror::Error;
use zip::ZipArchive;

use crate::plugin::{
    manifest::{is_safe_package_path, PluginManifest},
    scanner::{scan_css, scan_script, ScanReport},
    MAX_COMPRESSED_BYTES, MAX_EXPANDED_BYTES, MAX_FILE_BYTES, MAX_FILE_COUNT,
};

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PackageError {
    #[error("the plugin package could not be read")]
    Unreadable,
    #[error("the plugin package is too large")]
    Oversize,
    #[error("the plugin package contains an unsafe path")]
    UnsafePath,
    #[error("the plugin package contains a symlink")]
    Symlink,
    #[error("the plugin package is missing a manifest")]
    MissingManifest,
    #[error("{0}")]
    Manifest(String),
    #[error("a plugin entrypoint is missing from the package")]
    MissingEntrypoint,
}

#[derive(Clone, Debug)]
pub struct PackageFile {
    pub path: String,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct PackageInspection {
    pub sha256: String,
    pub compressed_bytes: u64,
    pub expanded_bytes: u64,
    pub file_count: usize,
    pub manifest: PluginManifest,
    pub files: Vec<PackageFile>,
    pub style_scan: ScanReport,
    pub script_scan: ScanReport,
}

pub fn inspect_package(path: &Path) -> Result<PackageInspection, PackageError> {
    let metadata = fs::metadata(path).map_err(|_| PackageError::Unreadable)?;
    if metadata.is_dir() {
        return inspect_directory(path);
    }
    if metadata.len() > MAX_COMPRESSED_BYTES {
        return Err(PackageError::Oversize);
    }
    let sha256 = sha256_file(path)?;
    let file = File::open(path).map_err(|_| PackageError::Unreadable)?;
    let mut archive = ZipArchive::new(file).map_err(|_| PackageError::Unreadable)?;
    if archive.len() > MAX_FILE_COUNT {
        return Err(PackageError::Oversize);
    }
    let mut expanded = 0_u64;
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| PackageError::Unreadable)?;
        if entry.is_symlink()
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o120000 == 0o120000)
        {
            return Err(PackageError::Symlink);
        }
        let name = entry
            .enclosed_name()
            .ok_or(PackageError::UnsafePath)?
            .to_string_lossy()
            .replace('\\', "/");
        if entry.is_dir() || name.ends_with('/') {
            continue;
        }
        if !is_safe_package_path(&name) || !is_jail_path(Path::new(&name)) {
            return Err(PackageError::UnsafePath);
        }
        if !seen.insert(name.clone()) {
            return Err(PackageError::UnsafePath);
        }
        if entry.size() > MAX_FILE_BYTES {
            return Err(PackageError::Oversize);
        }
        expanded = expanded.saturating_add(entry.size());
        if expanded > MAX_EXPANDED_BYTES {
            return Err(PackageError::Oversize);
        }
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|_| PackageError::Unreadable)?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(PackageError::Oversize);
        }
        files.push(PackageFile { path: name, bytes });
    }
    let manifest_file = files
        .iter()
        .find(|file| file.path == "manifest.json")
        .ok_or(PackageError::MissingManifest)?;
    let manifest = PluginManifest::parse(&manifest_file.bytes)
        .map_err(|error| PackageError::Manifest(error.to_string()))?;
    for path in manifest
        .entrypoints
        .styles
        .iter()
        .chain(manifest.entrypoints.scenes.iter())
        .chain(manifest.entrypoints.script.iter())
    {
        if !files.iter().any(|file| file.path == *path) {
            return Err(PackageError::MissingEntrypoint);
        }
    }
    let mut style_scan = ScanReport::default();
    for style in &manifest.entrypoints.styles {
        if let Some(file) = files.iter().find(|file| file.path == *style) {
            if let Ok(source) = std::str::from_utf8(&file.bytes) {
                let next = scan_css(source);
                merge_scan(&mut style_scan, next);
            }
        }
    }
    let mut script_scan = ScanReport::default();
    if let Some(script) = &manifest.entrypoints.script {
        if let Some(file) = files.iter().find(|file| file.path == *script) {
            if let Ok(source) = std::str::from_utf8(&file.bytes) {
                script_scan = scan_script(source);
            }
        }
    }
    Ok(PackageInspection {
        sha256,
        compressed_bytes: metadata.len(),
        expanded_bytes: expanded,
        file_count: files.len(),
        manifest,
        files,
        style_scan,
        script_scan,
    })
}

pub fn inspect_directory(root: &Path) -> Result<PackageInspection, PackageError> {
    let mut files = Vec::new();
    let mut expanded = 0_u64;
    collect_directory(root, root, &mut files, &mut expanded)?;
    if files.len() > MAX_FILE_COUNT {
        return Err(PackageError::Oversize);
    }
    finish_inspection(files, sha256_directory(root)?, expanded)
}

pub fn stale_typescript_message(files: &[PackageFile]) -> Option<String> {
    let has_ts = files.iter().any(|file| file.path == "src/main.ts");
    let has_js = files.iter().any(|file| file.path == "dist/main.js");
    if has_ts && !has_js {
        return Some("Developer Mode found src/main.ts but dist/main.js is missing. Build the plugin before loading it.".into());
    }
    None
}

fn collect_directory(
    root: &Path,
    current: &Path,
    files: &mut Vec<PackageFile>,
    expanded: &mut u64,
) -> Result<(), PackageError> {
    let entries = fs::read_dir(current).map_err(|_| PackageError::Unreadable)?;
    for entry in entries {
        let entry = entry.map_err(|_| PackageError::Unreadable)?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|_| PackageError::Unreadable)?;
        if file_type.is_symlink() {
            return Err(PackageError::Symlink);
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == "node_modules" || name == ".git" || name == "target" {
            continue;
        }
        if file_type.is_dir() {
            collect_directory(root, &path, files, expanded)?;
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| PackageError::UnsafePath)?
            .to_string_lossy()
            .replace('\\', "/");
        if !is_safe_package_path(&relative) || !is_jail_path(Path::new(&relative)) {
            continue;
        }
        let bytes = fs::read(&path).map_err(|_| PackageError::Unreadable)?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(PackageError::Oversize);
        }
        *expanded = expanded.saturating_add(bytes.len() as u64);
        if *expanded > MAX_EXPANDED_BYTES {
            return Err(PackageError::Oversize);
        }
        files.push(PackageFile {
            path: relative,
            bytes,
        });
    }
    Ok(())
}

fn sha256_directory(root: &Path) -> Result<String, PackageError> {
    let mut hasher = Sha256::new();
    hasher.update(root.to_string_lossy().as_bytes());
    let metadata = fs::metadata(root).map_err(|_| PackageError::Unreadable)?;
    if let Ok(modified) = metadata.modified() {
        if let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) {
            hasher.update(duration.as_secs().to_le_bytes());
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn finish_inspection(
    files: Vec<PackageFile>,
    sha256: String,
    expanded: u64,
) -> Result<PackageInspection, PackageError> {
    let manifest_file = files
        .iter()
        .find(|file| file.path == "manifest.json")
        .ok_or(PackageError::MissingManifest)?;
    let manifest = PluginManifest::parse(&manifest_file.bytes)
        .map_err(|error| PackageError::Manifest(error.to_string()))?;
    for path in manifest
        .entrypoints
        .styles
        .iter()
        .chain(manifest.entrypoints.scenes.iter())
        .chain(manifest.entrypoints.script.iter())
    {
        if !files.iter().any(|file| file.path == *path) {
            return Err(PackageError::MissingEntrypoint);
        }
    }
    let mut style_scan = ScanReport::default();
    for style in &manifest.entrypoints.styles {
        if let Some(file) = files.iter().find(|file| file.path == *style) {
            if let Ok(source) = std::str::from_utf8(&file.bytes) {
                merge_scan(&mut style_scan, scan_css(source));
            }
        }
    }
    let mut script_scan = ScanReport::default();
    if let Some(script) = &manifest.entrypoints.script {
        if let Some(file) = files.iter().find(|file| file.path == *script) {
            if let Ok(source) = std::str::from_utf8(&file.bytes) {
                script_scan = scan_script(source);
            }
        }
    }
    Ok(PackageInspection {
        sha256,
        compressed_bytes: expanded,
        expanded_bytes: expanded,
        file_count: files.len(),
        manifest,
        files,
        style_scan,
        script_scan,
    })
}

pub fn extract_to(inspection: &PackageInspection, destination: &Path) -> Result<(), PackageError> {
    fs::create_dir_all(destination).map_err(|_| PackageError::Unreadable)?;
    for file in &inspection.files {
        let target = destination.join(&file.path);
        if !target.starts_with(destination) {
            return Err(PackageError::UnsafePath);
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|_| PackageError::Unreadable)?;
        }
        let mut out = File::create(&target).map_err(|_| PackageError::Unreadable)?;
        out.write_all(&file.bytes)
            .map_err(|_| PackageError::Unreadable)?;
    }
    Ok(())
}

pub fn sha256_file(path: &Path) -> Result<String, PackageError> {
    let mut file = File::open(path).map_err(|_| PackageError::Unreadable)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| PackageError::Unreadable)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn is_jail_path(path: &Path) -> bool {
    if path.is_absolute() {
        return false;
    }
    for component in path.components() {
        match component {
            Component::Normal(_) => {}
            Component::CurDir => {}
            _ => return false,
        }
    }
    true
}

fn merge_scan(target: &mut ScanReport, next: ScanReport) {
    target.findings.extend(next.findings);
    target.severity = match (target.severity, next.severity) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (left, right) => left.or(right),
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;
    use zip::{write::SimpleFileOptions, ZipWriter};

    fn write_zip(files: &[(&str, &str)]) -> PathBuf {
        let directory = tempfile::tempdir().expect("temp");
        let path = directory.path().join("plugin.yaqmc-plugin");
        let file = File::create(&path).expect("zip");
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default();
        for (name, contents) in files {
            zip.start_file(*name, options).expect("entry");
            zip.write_all(contents.as_bytes()).expect("write");
        }
        zip.finish().expect("finish");
        std::mem::forget(directory);
        path
    }

    fn manifest() -> &'static str {
        r#"{
            "manifestVersion": 1,
            "id": "dev.example.sakura",
            "name": "Sakura",
            "version": "1.0.0",
            "apiVersion": 1,
            "entrypoints": { "styles": ["styles/main.css"] }
        }"#
    }

    #[test]
    fn valid_package_hashes_and_extracts() {
        let path = write_zip(&[
            ("manifest.json", manifest()),
            ("styles/main.css", "[data-yaqmc=\"player-bar\"]{opacity:1}"),
        ]);
        let inspection = inspect_package(&path).expect("inspect");
        assert_eq!(inspection.manifest.id, "dev.example.sakura");
        assert_eq!(inspection.sha256.len(), 64);
        let dest = path.parent().unwrap().join("out");
        extract_to(&inspection, &dest).expect("extract");
        assert!(dest.join("styles/main.css").is_file());
    }

    #[test]
    fn traversal_and_absolute_paths_are_rejected() {
        let path = write_zip(&[("manifest.json", manifest()), ("../escape.css", "body{}")]);
        assert_eq!(
            inspect_package(&path).unwrap_err(),
            PackageError::UnsafePath
        );
    }

    #[test]
    fn missing_entrypoint_is_rejected() {
        let path = write_zip(&[("manifest.json", manifest())]);
        assert_eq!(
            inspect_package(&path).unwrap_err(),
            PackageError::MissingEntrypoint
        );
    }

    #[test]
    fn absolute_windows_paths_are_rejected() {
        let path = write_zip(&[
            ("C:/Windows/escape.css", "body{}"),
            ("manifest.json", manifest()),
        ]);
        assert_eq!(
            inspect_package(&path).unwrap_err(),
            PackageError::UnsafePath
        );
    }

    #[test]
    fn jail_rejects_parent_and_absolute_components() {
        assert!(!is_jail_path(Path::new("../x")));
        assert!(!is_jail_path(Path::new("/etc/passwd")));
        assert!(is_jail_path(Path::new("styles/main.css")));
    }

    #[test]
    fn duplicate_archive_paths_are_rejected() {
        let directory = tempfile::tempdir().expect("temp");
        let path = directory.path().join("plugin.yaqmc-plugin");
        let file = File::create(&path).expect("zip");
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default();
        zip.start_file("manifest.json", options).expect("entry");
        zip.write_all(manifest().as_bytes()).expect("write");
        zip.start_file("styles/main.css", options).expect("entry");
        zip.write_all(b"a{}").expect("write");
        zip.start_file("styles/./main.css", options).expect("dup");
        zip.write_all(b"b{}").expect("write");
        zip.finish().expect("finish");
        std::mem::forget(directory);
        assert_eq!(
            inspect_package(&path).unwrap_err(),
            PackageError::UnsafePath
        );
    }

    #[test]
    fn unix_symlink_entries_are_rejected() {
        let directory = tempfile::tempdir().expect("temp");
        let path = directory.path().join("plugin.yaqmc-plugin");
        let file = File::create(&path).expect("zip");
        let mut zip = ZipWriter::new(file);
        zip.add_symlink(
            "styles/main.css",
            "../escape.css",
            SimpleFileOptions::default(),
        )
        .expect("symlink");
        zip.start_file("manifest.json", SimpleFileOptions::default())
            .expect("manifest");
        zip.write_all(manifest().as_bytes()).expect("write");
        zip.finish().expect("finish");
        std::mem::forget(directory);
        assert_eq!(inspect_package(&path).unwrap_err(), PackageError::Symlink);
    }

    #[test]
    fn example_studio_package_inspects() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../examples/plugins/packages/dev.yaqmc.example.studio-1.0.0.yaqmc-plugin");
        let inspection = inspect_package(&path).expect("studio example package");
        assert_eq!(inspection.manifest.id, "dev.yaqmc.example.studio");
        assert_eq!(inspection.manifest.entrypoints.styles.len(), 1);
        assert_eq!(inspection.manifest.entrypoints.scenes.len(), 2);
        assert!(inspection.manifest.entrypoints.script.is_some());
        assert!(inspection.sha256.len() == 64);
    }

    #[test]
    fn excessive_file_count_is_oversize() {
        let directory = tempfile::tempdir().expect("temp");
        let path = directory.path().join("plugin.yaqmc-plugin");
        let file = File::create(&path).expect("zip");
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default();
        zip.start_file("manifest.json", options).expect("manifest");
        zip.write_all(manifest().as_bytes()).expect("write");
        zip.start_file("styles/main.css", options).expect("css");
        zip.write_all(b"x{}").expect("write");
        for index in 0..=MAX_FILE_COUNT {
            zip.start_file(format!("pad/{index}.txt"), options)
                .expect("pad");
            zip.write_all(b".").expect("write");
        }
        zip.finish().expect("finish");
        std::mem::forget(directory);
        assert_eq!(inspect_package(&path).unwrap_err(), PackageError::Oversize);
    }
}
