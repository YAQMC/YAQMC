use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use thiserror::Error;

use crate::plugin::{
    manifest::{is_plugin_id, parse_semver, PluginManifest, CURRENT_API_VERSION},
    package::{extract_to, inspect_package, sha256_bytes, PackageInspection},
    permissions::PluginPermission,
    scanner::{css_is_blocked, ScanReport},
    PLUGIN_STORAGE_QUOTA,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PluginStatus {
    Installed,
    Disabled,
    Enabling,
    Active,
    Disabling,
    Failed,
    Incompatible,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRecord {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub authors: Vec<String>,
    pub enabled: bool,
    pub status: PluginStatus,
    pub status_reason: Option<String>,
    pub api_version: u32,
    pub package_sha256: String,
    pub source: String,
    pub unsigned: bool,
    pub entrypoints: EntrypointSummary,
    pub permissions: Vec<String>,
    pub granted_permissions: Vec<String>,
    pub risk_rating: String,
    pub style_scan: ScanReport,
    pub script_scan: ScanReport,
    pub compatible: bool,
    pub platforms: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings_schema: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveStyleSheet {
    pub plugin_id: String,
    pub css: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveSceneResource {
    pub plugin_id: String,
    pub plugin_name: String,
    pub scene_id: String,
    pub css: Option<String>,
    pub definition: serde_json::Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveScriptResource {
    pub plugin_id: String,
    pub source: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivePluginResources {
    pub safe_mode: bool,
    pub developer_mode: bool,
    pub style_order: Vec<String>,
    pub styles: Vec<ActiveStyleSheet>,
    pub scenes: Vec<ActiveSceneResource>,
    pub scripts: Vec<ActiveScriptResource>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntrypointSummary {
    pub styles: usize,
    pub scenes: usize,
    pub script: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDiagnostic {
    pub id: String,
    pub version: String,
    pub enabled: bool,
    pub status: PluginStatus,
    pub entrypoint_kinds: Vec<String>,
    pub api_version: u32,
    pub package_sha256: String,
    pub permissions: Vec<String>,
    pub risk_rating: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginStateFile {
    id: String,
    active_version: String,
    enabled: bool,
    status: PluginStatus,
    status_reason: Option<String>,
    granted_permissions: Vec<String>,
    package_sha256: String,
    source: String,
    style_scan: ScanReport,
    script_scan: ScanReport,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostFile {
    developer_mode: bool,
    safe_mode: bool,
    style_order: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JournalFile {
    boot_id: String,
    activation_started: bool,
    clean_exit: bool,
}

#[derive(Clone, Debug)]
pub struct RuntimeToken {
    pub token: String,
    pub plugin_id: String,
    pub permissions: HashSet<PluginPermission>,
}

#[derive(Debug, Error)]
pub enum HostError {
    #[error("{0}")]
    Message(String),
}

impl HostError {
    fn from(message: impl Into<String>) -> Self {
        Self::Message(message.into())
    }
}

struct RateBucket {
    window_start_ms: u64,
    count: u32,
}

pub struct ExtensionHost {
    root: PathBuf,
    inner: Mutex<HostInner>,
    runtime_seq: AtomicU64,
}

struct HostInner {
    host: HostFile,
    journal: JournalFile,
    records: BTreeMap<String, (PluginStateFile, PluginManifest, PathBuf)>,
    runtimes: HashMap<String, RuntimeToken>,
    storage: HashMap<String, BTreeMap<String, String>>,
    rates: HashMap<String, RateBucket>,
}

impl ExtensionHost {
    pub fn open(root: PathBuf) -> Result<Self, HostError> {
        fs::create_dir_all(&root)
            .map_err(|_| HostError::from("plugin storage could not be created"))?;
        let mut host: HostFile = read_json(&root.join("host.json")).unwrap_or_default();
        let previous: JournalFile = read_json(&root.join("journal.json")).unwrap_or_default();
        let crashed = previous.activation_started && !previous.clean_exit;
        if crashed {
            host.safe_mode = true;
        }
        let mut journal = JournalFile {
            boot_id: format!("{:x}", now_ms()),
            activation_started: false,
            clean_exit: false,
        };
        write_json(&root.join("host.json"), &host)?;
        write_json(&root.join("journal.json"), &journal)?;
        let mut records = BTreeMap::new();
        if let Ok(entries) = fs::read_dir(&root) {
            for entry in entries.flatten() {
                if !entry.path().is_dir() {
                    continue;
                }
                let state_path = entry.path().join("state.json");
                let Some(state): Option<PluginStateFile> = read_json(&state_path) else {
                    continue;
                };
                let version_dir = entry.path().join("versions").join(&state.active_version);
                let manifest_path = version_dir.join("manifest.json");
                let Ok(bytes) = fs::read(&manifest_path) else {
                    continue;
                };
                let Ok(manifest) = PluginManifest::parse(&bytes) else {
                    continue;
                };
                records.insert(state.id.clone(), (state, manifest, version_dir));
            }
        }
        if crashed {
            for (state, manifest, dir) in records.values_mut() {
                if state.enabled {
                    state.enabled = false;
                    state.status = PluginStatus::Failed;
                    state.status_reason =
                        Some("disabled after an unclean shutdown during plugin activation".into());
                    let _ = persist_state(&root, state, manifest, dir.clone());
                }
            }
        }
        if records.values().any(|(state, _, _)| state.enabled) {
            journal.activation_started = true;
            write_json(&root.join("journal.json"), &journal)?;
        }
        let mut storage = HashMap::new();
        if let Ok(entries) = fs::read_dir(&root) {
            for entry in entries.flatten() {
                let path = entry.path();
                let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                    continue;
                };
                let Some(plugin_id) = name.strip_suffix(".storage.json") else {
                    continue;
                };
                if let Some(namespace) = read_json::<BTreeMap<String, String>>(&path) {
                    storage.insert(plugin_id.to_owned(), namespace);
                }
            }
        }
        Ok(Self {
            root,
            inner: Mutex::new(HostInner {
                host,
                journal,
                records,
                runtimes: HashMap::new(),
                storage,
                rates: HashMap::new(),
            }),
            runtime_seq: AtomicU64::new(1),
        })
    }

    pub fn mark_clean_exit(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.journal.clean_exit = true;
            let _ = write_json(&self.root.join("journal.json"), &inner.journal);
        }
    }

    pub fn inspect_path(&self, path: &Path) -> Result<PackageInspection, HostError> {
        inspect_package(path).map_err(|error| HostError::from(error.to_string()))
    }

    pub fn list(&self) -> Vec<PluginRecord> {
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner
            .records
            .values()
            .map(|(state, manifest, _)| to_record(state, manifest, inner.host.safe_mode))
            .collect()
    }

    pub fn diagnostics(&self) -> Vec<PluginDiagnostic> {
        self.list()
            .into_iter()
            .map(|record| PluginDiagnostic {
                id: record.id,
                version: record.version,
                enabled: record.enabled,
                status: record.status,
                entrypoint_kinds: {
                    let mut kinds = Vec::new();
                    if record.entrypoints.styles > 0 {
                        kinds.push("style".into());
                    }
                    if record.entrypoints.scenes > 0 {
                        kinds.push("scene".into());
                    }
                    if record.entrypoints.script {
                        kinds.push("script".into());
                    }
                    kinds
                },
                api_version: record.api_version,
                package_sha256: record.package_sha256,
                permissions: record.granted_permissions,
                risk_rating: record.risk_rating,
            })
            .collect()
    }

    pub fn developer_mode(&self) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .host
            .developer_mode
    }

    pub fn set_developer_mode(&self, enabled: bool) -> Result<(), HostError> {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner.host.developer_mode = enabled;
        write_json(&self.root.join("host.json"), &inner.host)
    }

    pub fn safe_mode(&self) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .host
            .safe_mode
    }

    pub fn set_safe_mode(&self, enabled: bool) -> Result<(), HostError> {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner.host.safe_mode = enabled;
        write_json(&self.root.join("host.json"), &inner.host)
    }

    pub fn install(
        &self,
        path: &Path,
        enable: bool,
        grant: &[PluginPermission],
    ) -> Result<PluginRecord, HostError> {
        let inspection =
            inspect_package(path).map_err(|error| HostError::from(error.to_string()))?;
        if css_is_blocked(&inspection.style_scan) {
            return Err(HostError::from(
                "the style entrypoint uses blocked remote or filesystem CSS",
            ));
        }
        self.install_inspection(inspection, enable, grant, "local-file")
    }

    pub fn install_loose_css(&self, path: &Path) -> Result<PluginRecord, HostError> {
        let source = fs::read_to_string(path)
            .map_err(|_| HostError::from("the CSS file could not be read"))?;
        let scan = crate::plugin::scanner::scan_css(&source);
        if css_is_blocked(&scan) {
            return Err(HostError::from(
                "the CSS file uses blocked remote resources",
            ));
        }
        let stem = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("style")
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() {
                    ch.to_ascii_lowercase()
                } else {
                    '-'
                }
            })
            .collect::<String>();
        let id = format!("local.css.{stem}");
        let id = if is_plugin_id(&id) {
            id
        } else {
            format!("local.css.import-{}", &sha256_bytes(stem.as_bytes())[..8])
        };
        let manifest = PluginManifest {
            manifest_version: 1,
            id: id.clone(),
            name: stem,
            description: Some("Local CSS convenience import".into()),
            version: "0.0.0-local".into(),
            api_version: CURRENT_API_VERSION,
            authors: Vec::new(),
            homepage: None,
            repository: None,
            license: None,
            engines: Default::default(),
            platforms: Vec::new(),
            architectures: Vec::new(),
            entrypoints: crate::plugin::manifest::PluginEntrypoints {
                styles: vec!["styles/main.css".into()],
                scenes: Vec::new(),
                script: None,
            },
            permissions: Vec::new(),
            dependencies: BTreeMap::new(),
            conflicts: Vec::new(),
            settings_schema: None,
            signatures: None,
        };
        let inspection = PackageInspection {
            sha256: sha256_bytes(source.as_bytes()),
            compressed_bytes: source.len() as u64,
            expanded_bytes: source.len() as u64,
            file_count: 2,
            manifest: manifest.clone(),
            files: vec![
                crate::plugin::package::PackageFile {
                    path: "manifest.json".into(),
                    bytes: serde_json::to_vec_pretty(&manifest).unwrap_or_default(),
                },
                crate::plugin::package::PackageFile {
                    path: "styles/main.css".into(),
                    bytes: source.into_bytes(),
                },
            ],
            style_scan: scan,
            script_scan: ScanReport::default(),
        };
        self.install_inspection(inspection, true, &[], "loose-css")
    }

    fn install_inspection(
        &self,
        inspection: PackageInspection,
        enable: bool,
        grant: &[PluginPermission],
        source: &str,
    ) -> Result<PluginRecord, HostError> {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((existing, _, _)) = inner.records.get(&inspection.manifest.id) {
            if existing.enabled {
                return Err(HostError::from(
                    "disable the current version before installing an update",
                ));
            }
        }
        if let Some(reason) = compatibility_reason(&inspection.manifest, &inner.records) {
            let version_dir = self.version_dir(&inspection.manifest);
            let staging = version_dir.with_extension("staging");
            let _ = fs::remove_dir_all(&staging);
            extract_to(&inspection, &staging)
                .map_err(|error| HostError::from(error.to_string()))?;
            atomic_replace(&staging, &version_dir)?;
            let state = PluginStateFile {
                id: inspection.manifest.id.clone(),
                active_version: inspection.manifest.version.clone(),
                enabled: false,
                status: PluginStatus::Incompatible,
                status_reason: Some(reason.clone()),
                granted_permissions: Vec::new(),
                package_sha256: inspection.sha256.clone(),
                source: source.to_owned(),
                style_scan: inspection.style_scan.clone(),
                script_scan: inspection.script_scan.clone(),
            };
            persist_state(
                &self.root,
                &state,
                &inspection.manifest,
                version_dir.clone(),
            )?;
            inner.records.insert(
                state.id.clone(),
                (state.clone(), inspection.manifest.clone(), version_dir),
            );
            return Ok(to_record(
                &state,
                &inspection.manifest,
                inner.host.safe_mode,
            ));
        }
        let previous_granted: HashSet<String> = inner
            .records
            .get(&inspection.manifest.id)
            .map(|(state, _, _)| state.granted_permissions.iter().cloned().collect())
            .unwrap_or_default();
        let requested = inspection.manifest.requested_permissions();
        if enable {
            for permission in &requested {
                let key = permission.as_str();
                let is_expansion = !previous_granted.is_empty() && !previous_granted.contains(key);
                if (permission.sensitive() || is_expansion) && !grant.contains(permission) {
                    return Err(HostError::from(
                        "new or sensitive permissions must be explicitly accepted",
                    ));
                }
            }
        }
        let version_dir = self.version_dir(&inspection.manifest);
        let staging = version_dir.with_extension("staging");
        let _ = fs::remove_dir_all(&staging);
        extract_to(&inspection, &staging).map_err(|error| HostError::from(error.to_string()))?;
        atomic_replace(&staging, &version_dir)?;
        let granted: Vec<String> = if enable {
            requested
                .iter()
                .map(|permission| permission.as_str().to_owned())
                .collect()
        } else {
            Vec::new()
        };
        let state = PluginStateFile {
            id: inspection.manifest.id.clone(),
            active_version: inspection.manifest.version.clone(),
            enabled: enable && !inner.host.safe_mode,
            status: if enable && !inner.host.safe_mode {
                PluginStatus::Active
            } else {
                PluginStatus::Disabled
            },
            status_reason: None,
            granted_permissions: granted,
            package_sha256: inspection.sha256.clone(),
            source: source.to_owned(),
            style_scan: inspection.style_scan.clone(),
            script_scan: inspection.script_scan.clone(),
        };
        persist_state(
            &self.root,
            &state,
            &inspection.manifest,
            version_dir.clone(),
        )?;
        if enable {
            inner.journal.activation_started = true;
            write_json(&self.root.join("journal.json"), &inner.journal)?;
        }
        if !inner.host.style_order.contains(&state.id) {
            inner.host.style_order.push(state.id.clone());
            write_json(&self.root.join("host.json"), &inner.host)?;
        }
        inner.records.insert(
            state.id.clone(),
            (state.clone(), inspection.manifest.clone(), version_dir),
        );
        Ok(to_record(
            &state,
            &inspection.manifest,
            inner.host.safe_mode,
        ))
    }

    #[allow(dead_code)]
    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<PluginRecord, HostError> {
        self.set_enabled_with_grants(id, enabled, &[])
    }

    pub fn set_enabled_with_grants(
        &self,
        id: &str,
        enabled: bool,
        grants: &[PluginPermission],
    ) -> Result<PluginRecord, HostError> {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let safe_mode = inner.host.safe_mode;
        if enabled && safe_mode {
            return Err(HostError::from(
                "safe mode has disabled third-party plugins",
            ));
        }
        let Some((existing, manifest, _)) = inner.records.get(id) else {
            return Err(HostError::from("the plugin is not installed"));
        };
        let manifest = manifest.clone();
        let mut granted = existing.granted_permissions.clone();
        if let Some(reason) = compatibility_reason(&manifest, &inner.records) {
            drop_enable_locked(
                &mut inner,
                id,
                PluginStatus::Incompatible,
                Some(reason.clone()),
            )?;
            persist_locked(&self.root, &inner, id)?;
            return Err(HostError::from(reason));
        }
        if enabled {
            if let Some(reason) = missing_dependency(&manifest, &inner.records) {
                drop_enable_locked(
                    &mut inner,
                    id,
                    PluginStatus::Incompatible,
                    Some(reason.clone()),
                )?;
                persist_locked(&self.root, &inner, id)?;
                return Err(HostError::from(reason));
            }
            if dependency_cycle(id, &manifest, &inner.records) {
                return Err(HostError::from("plugin dependency cycle detected"));
            }
            for permission in manifest.requested_permissions() {
                let already = granted.iter().any(|value| value == permission.as_str());
                if permission.sensitive() && !already && !grants.contains(&permission) {
                    return Err(HostError::from(
                        "sensitive permissions must be explicitly accepted",
                    ));
                }
                if !already && (!permission.sensitive() || grants.contains(&permission)) {
                    granted.push(permission.as_str().to_owned());
                }
            }
            inner.journal.activation_started = true;
            write_json(&self.root.join("journal.json"), &inner.journal)?;
        } else {
            inner.runtimes.retain(|_, runtime| runtime.plugin_id != id);
        }
        let (state, stored_manifest, dir) = inner
            .records
            .get_mut(id)
            .ok_or_else(|| HostError::from("the plugin is not installed"))?;
        state.granted_permissions = granted;
        state.enabled = enabled;
        state.status = if enabled {
            PluginStatus::Active
        } else {
            PluginStatus::Disabled
        };
        state.status_reason = None;
        persist_state(&self.root, state, stored_manifest, dir.clone())?;
        Ok(to_record(state, stored_manifest, safe_mode))
    }

    pub fn mark_failed(&self, id: &str, reason: &str) -> Result<PluginRecord, HostError> {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner.runtimes.retain(|_, runtime| runtime.plugin_id != id);
        let safe_mode = inner.host.safe_mode;
        let (state, manifest, dir) = inner
            .records
            .get_mut(id)
            .ok_or_else(|| HostError::from("the plugin is not installed"))?;
        state.enabled = false;
        state.status = PluginStatus::Failed;
        state.status_reason = Some(reason.to_owned());
        persist_state(&self.root, state, manifest, dir.clone())?;
        Ok(to_record(state, manifest, safe_mode))
    }

    pub fn install_loose_script(&self, path: &Path) -> Result<PluginRecord, HostError> {
        let source = fs::read_to_string(path)
            .map_err(|_| HostError::from("the script file could not be read"))?;
        let scan = crate::plugin::scanner::scan_script(&source);
        let stem = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("script")
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() {
                    ch.to_ascii_lowercase()
                } else {
                    '-'
                }
            })
            .collect::<String>();
        let id = format!("local.script.{stem}");
        let id = if is_plugin_id(&id) {
            id
        } else {
            format!(
                "local.script.import-{}",
                &sha256_bytes(stem.as_bytes())[..8]
            )
        };
        let manifest = PluginManifest {
            manifest_version: 1,
            id: id.clone(),
            name: stem,
            description: Some("Local script convenience import".into()),
            version: "0.0.0-local".into(),
            api_version: CURRENT_API_VERSION,
            authors: Vec::new(),
            homepage: None,
            repository: None,
            license: None,
            engines: Default::default(),
            platforms: Vec::new(),
            architectures: Vec::new(),
            entrypoints: crate::plugin::manifest::PluginEntrypoints {
                styles: Vec::new(),
                scenes: Vec::new(),
                script: Some("dist/main.js".into()),
            },
            permissions: Vec::new(),
            dependencies: BTreeMap::new(),
            conflicts: Vec::new(),
            settings_schema: None,
            signatures: None,
        };
        let inspection = PackageInspection {
            sha256: sha256_bytes(source.as_bytes()),
            compressed_bytes: source.len() as u64,
            expanded_bytes: source.len() as u64,
            file_count: 2,
            manifest: manifest.clone(),
            files: vec![
                crate::plugin::package::PackageFile {
                    path: "manifest.json".into(),
                    bytes: serde_json::to_vec_pretty(&manifest).unwrap_or_default(),
                },
                crate::plugin::package::PackageFile {
                    path: "dist/main.js".into(),
                    bytes: source.into_bytes(),
                },
            ],
            style_scan: ScanReport::default(),
            script_scan: scan,
        };
        self.install_inspection(inspection, false, &[], "loose-script")
    }

    pub fn active_resources(&self) -> ActivePluginResources {
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if inner.host.safe_mode {
            return ActivePluginResources {
                safe_mode: true,
                developer_mode: inner.host.developer_mode,
                style_order: inner.host.style_order.clone(),
                styles: Vec::new(),
                scenes: Vec::new(),
                scripts: Vec::new(),
            };
        }
        let mut styles = Vec::new();
        let mut seen_styles = HashSet::new();
        for id in inner.host.style_order.iter().chain(inner.records.keys()) {
            if !seen_styles.insert(id.clone()) {
                continue;
            }
            let Some((state, manifest, dir)) = inner.records.get(id) else {
                continue;
            };
            if !state.enabled {
                continue;
            }
            for style in &manifest.entrypoints.styles {
                let Ok(css) = fs::read_to_string(dir.join(style)) else {
                    continue;
                };
                styles.push(ActiveStyleSheet {
                    plugin_id: id.clone(),
                    css,
                });
            }
        }
        let mut scenes = Vec::new();
        let mut scripts = Vec::new();
        for (id, (state, manifest, dir)) in &inner.records {
            if !state.enabled {
                continue;
            }
            for scene_path in &manifest.entrypoints.scenes {
                let Ok(bytes) = fs::read(dir.join(scene_path)) else {
                    continue;
                };
                let Ok(definition) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
                    continue;
                };
                let scene_id = definition
                    .get("id")
                    .and_then(|value| value.as_str())
                    .unwrap_or("scene")
                    .to_owned();
                let css_path = scene_css_path(scene_path);
                let css = fs::read_to_string(dir.join(&css_path)).ok();
                scenes.push(ActiveSceneResource {
                    plugin_id: id.clone(),
                    plugin_name: manifest.name.clone(),
                    scene_id,
                    css,
                    definition,
                });
            }
            if let Some(script) = &manifest.entrypoints.script {
                if let Ok(source) = fs::read_to_string(dir.join(script)) {
                    scripts.push(ActiveScriptResource {
                        plugin_id: id.clone(),
                        source,
                    });
                }
            }
        }
        ActivePluginResources {
            safe_mode: false,
            developer_mode: inner.host.developer_mode,
            style_order: inner.host.style_order.clone(),
            styles,
            scenes,
            scripts,
        }
    }

    pub fn uninstall(&self, id: &str, remove_data: bool) -> Result<(), HostError> {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner.records.remove(id);
        inner.host.style_order.retain(|candidate| candidate != id);
        inner.runtimes.retain(|_, runtime| runtime.plugin_id != id);
        let plugin_root = self.root.join(id);
        let _ = fs::remove_dir_all(&plugin_root);
        if remove_data {
            inner.storage.remove(id);
            let _ = fs::remove_file(self.root.join(format!("{id}.storage.json")));
        }
        write_json(&self.root.join("host.json"), &inner.host)
    }

    #[allow(dead_code)]
    pub fn style_order(&self) -> Vec<String> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .host
            .style_order
            .clone()
    }

    #[allow(dead_code)]
    pub fn read_installed_text(&self, id: &str, relative: &str) -> Result<String, HostError> {
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (_, _, dir) = inner
            .records
            .get(id)
            .ok_or_else(|| HostError::from("the plugin is not installed"))?;
        crate::plugin::manifest::is_safe_package_path(relative)
            .then_some(())
            .ok_or_else(|| HostError::from("invalid plugin path"))?;
        let path = dir.join(relative);
        if !path.starts_with(dir) {
            return Err(HostError::from("invalid plugin path"));
        }
        fs::read_to_string(path).map_err(|_| HostError::from("plugin file is missing"))
    }

    pub fn start_runtime(&self, plugin_id: &str) -> Result<RuntimeToken, HostError> {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if inner.host.safe_mode {
            return Err(HostError::from("safe mode has disabled plugin scripts"));
        }
        let (state, _, _) = inner
            .records
            .get(plugin_id)
            .ok_or_else(|| HostError::from("the plugin is not installed"))?;
        if !state.enabled {
            return Err(HostError::from("the plugin is disabled"));
        }
        let token = format!(
            "rt-{}-{}",
            self.runtime_seq.fetch_add(1, Ordering::AcqRel),
            now_ms()
        );
        let permissions = state
            .granted_permissions
            .iter()
            .filter_map(|value| value.parse().ok())
            .collect();
        let runtime = RuntimeToken {
            token: token.clone(),
            plugin_id: plugin_id.to_owned(),
            permissions,
        };
        inner.runtimes.insert(token, runtime.clone());
        Ok(runtime)
    }

    pub fn stop_runtime(&self, token: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.runtimes.remove(token);
        }
    }

    pub fn runtime(&self, token: &str) -> Option<RuntimeToken> {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| inner.runtimes.get(token).cloned())
    }

    pub fn check_permission(
        &self,
        token: &str,
        permission: PluginPermission,
    ) -> Result<RuntimeToken, HostError> {
        let runtime = self
            .runtime(token)
            .ok_or_else(|| HostError::from("unknown plugin runtime"))?;
        if !runtime.permissions.contains(&permission) {
            return Err(HostError::from(
                "the plugin was not granted this permission",
            ));
        }
        Ok(runtime)
    }

    pub fn rate_limit(&self, plugin_id: &str, key: &str, limit: u32) -> Result<(), HostError> {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = now_ms();
        let bucket_key = format!("{plugin_id}:{key}");
        let bucket = inner.rates.entry(bucket_key).or_insert(RateBucket {
            window_start_ms: now,
            count: 0,
        });
        if now.saturating_sub(bucket.window_start_ms) >= 1_000 {
            bucket.window_start_ms = now;
            bucket.count = 0;
        }
        bucket.count += 1;
        if bucket.count > limit {
            return Err(HostError::from("plugin rate limit exceeded"));
        }
        Ok(())
    }

    pub fn storage_get(&self, plugin_id: &str, key: &str) -> Option<String> {
        self.inner
            .lock()
            .ok()?
            .storage
            .get(plugin_id)?
            .get(key)
            .cloned()
    }

    pub fn storage_set(&self, plugin_id: &str, key: &str, value: &str) -> Result<(), HostError> {
        if key.len() > 64 || value.len() > 4_096 {
            return Err(HostError::from("plugin storage entry is too large"));
        }
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let namespace = inner.storage.entry(plugin_id.to_owned()).or_default();
        namespace.insert(key.to_owned(), value.to_owned());
        let encoded = serde_json::to_string(namespace).unwrap_or_default();
        if encoded.len() > PLUGIN_STORAGE_QUOTA {
            namespace.remove(key);
            return Err(HostError::from("plugin storage quota exceeded"));
        }
        write_json(
            &self.root.join(format!("{plugin_id}.storage.json")),
            namespace,
        )
    }

    fn version_dir(&self, manifest: &PluginManifest) -> PathBuf {
        self.root
            .join(&manifest.id)
            .join("versions")
            .join(&manifest.version)
    }
}

fn scene_css_path(scene_path: &str) -> String {
    if let Some(stem) = scene_path.strip_suffix(".scene.json") {
        return format!("{stem}.css");
    }
    scene_path
        .rsplit_once('.')
        .map(|(stem, _)| format!("{stem}.css"))
        .unwrap_or_default()
}

fn compatibility_reason(
    manifest: &PluginManifest,
    installed: &BTreeMap<String, (PluginStateFile, PluginManifest, PathBuf)>,
) -> Option<String> {
    if let Some(reason) = manifest.compatibility_issue() {
        return Some(reason);
    }
    if let Some(conflict) = manifest
        .conflicts
        .iter()
        .find(|conflict| *conflict != &manifest.id && installed.contains_key(*conflict))
    {
        return Some(format!("conflicts with {conflict}"));
    }
    missing_dependency(manifest, installed)
}

fn dependency_cycle(
    id: &str,
    manifest: &PluginManifest,
    installed: &BTreeMap<String, (PluginStateFile, PluginManifest, PathBuf)>,
) -> bool {
    fn visit(
        current: &str,
        stack: &mut Vec<String>,
        installed: &BTreeMap<String, (PluginStateFile, PluginManifest, PathBuf)>,
    ) -> bool {
        if stack.iter().any(|value| value == current) {
            return true;
        }
        stack.push(current.to_owned());
        if let Some((_, other, _)) = installed.get(current) {
            for dependency in other.dependencies.keys() {
                if visit(dependency, stack, installed) {
                    return true;
                }
            }
        }
        stack.pop();
        false
    }
    let mut stack = vec![id.to_owned()];
    manifest
        .dependencies
        .keys()
        .any(|dependency| visit(dependency, &mut stack, installed))
}

fn drop_enable_locked(
    inner: &mut HostInner,
    id: &str,
    status: PluginStatus,
    reason: Option<String>,
) -> Result<(), HostError> {
    if let Some((state, _, _)) = inner.records.get_mut(id) {
        state.enabled = false;
        state.status = status;
        state.status_reason = reason;
    }
    Ok(())
}

fn persist_locked(root: &Path, inner: &HostInner, id: &str) -> Result<(), HostError> {
    let Some((state, manifest, dir)) = inner.records.get(id) else {
        return Ok(());
    };
    persist_state(root, state, manifest, dir.clone())
}

fn missing_dependency(
    manifest: &PluginManifest,
    installed: &BTreeMap<String, (PluginStateFile, PluginManifest, PathBuf)>,
) -> Option<String> {
    for (dependency, range) in &manifest.dependencies {
        let Some((_, other, _)) = installed.get(dependency) else {
            return Some(format!("missing dependency {dependency} {range}"));
        };
        if let (Some(need), Some(have)) = (
            parse_semver(range.trim_start_matches('^').trim_start_matches(">=")),
            parse_semver(&other.version),
        ) {
            if have < need {
                return Some(format!("missing dependency {dependency} {range}"));
            }
        }
    }
    None
}

fn to_record(state: &PluginStateFile, manifest: &PluginManifest, safe_mode: bool) -> PluginRecord {
    let enabled = state.enabled && !safe_mode;
    PluginRecord {
        id: manifest.id.clone(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        description: manifest.description.clone(),
        authors: manifest.authors.clone(),
        enabled,
        status: if safe_mode && state.enabled {
            PluginStatus::Disabled
        } else {
            state.status
        },
        status_reason: if safe_mode && state.enabled {
            Some("safe mode disabled third-party plugins".into())
        } else {
            state.status_reason.clone()
        },
        api_version: manifest.api_version,
        package_sha256: state.package_sha256.clone(),
        source: state.source.clone(),
        unsigned: true,
        entrypoints: EntrypointSummary {
            styles: manifest.entrypoints.styles.len(),
            scenes: manifest.entrypoints.scenes.len(),
            script: manifest.entrypoints.script.is_some(),
        },
        permissions: manifest
            .requested_permissions()
            .into_iter()
            .map(|permission| permission.as_str().to_owned())
            .collect(),
        granted_permissions: state.granted_permissions.clone(),
        risk_rating: if state.script_scan.severity.is_some() {
            state.script_scan.rating().to_owned()
        } else {
            state.style_scan.rating().to_owned()
        },
        style_scan: state.style_scan.clone(),
        script_scan: state.script_scan.clone(),
        compatible: !matches!(state.status, PluginStatus::Incompatible),
        platforms: manifest.platforms.clone(),
        settings_schema: manifest.settings_schema.clone(),
    }
}

fn persist_state(
    root: &Path,
    state: &PluginStateFile,
    _manifest: &PluginManifest,
    _dir: PathBuf,
) -> Result<(), HostError> {
    let plugin_root = root.join(&state.id);
    fs::create_dir_all(&plugin_root)
        .map_err(|_| HostError::from("plugin state could not be saved"))?;
    write_json(&plugin_root.join("state.json"), state)
}

fn atomic_replace(staging: &Path, destination: &Path) -> Result<(), HostError> {
    if destination.exists() {
        let backup = destination.with_extension("previous");
        let _ = fs::remove_dir_all(&backup);
        fs::rename(destination, &backup)
            .map_err(|_| HostError::from("plugin version could not be replaced"))?;
        if fs::rename(staging, destination).is_err() {
            let _ = fs::rename(&backup, destination);
            return Err(HostError::from("plugin version could not be replaced"));
        }
        let _ = fs::remove_dir_all(&backup);
        return Ok(());
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| HostError::from("plugin version could not be created"))?;
    }
    fs::rename(staging, destination)
        .map_err(|_| HostError::from("plugin version could not be created"))
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), HostError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| HostError::from("plugin state could not be saved"))?;
    }
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|_| HostError::from("plugin state could not be saved"))?;
    fs::write(path, bytes).map_err(|_| HostError::from("plugin state could not be saved"))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::package::PackageFile;
    use crate::plugin::scanner::ScanReport;

    fn style_inspection(id: &str) -> PackageInspection {
        let manifest = PluginManifest::parse(
            format!(
                r#"{{
                    "manifestVersion": 1,
                    "id": "{id}",
                    "name": "Demo",
                    "version": "1.0.0",
                    "apiVersion": 1,
                    "entrypoints": {{ "styles": ["styles/main.css"] }}
                }}"#
            )
            .as_bytes(),
        )
        .expect("manifest");
        PackageInspection {
            sha256: sha256_bytes(id.as_bytes()),
            compressed_bytes: 12,
            expanded_bytes: 12,
            file_count: 2,
            files: vec![
                PackageFile {
                    path: "manifest.json".into(),
                    bytes: serde_json::to_vec(&manifest).unwrap(),
                },
                PackageFile {
                    path: "styles/main.css".into(),
                    bytes: b"[data-yaqmc=\"player-bar\"]{border-radius:8px}".to_vec(),
                },
            ],
            manifest,
            style_scan: ScanReport::default(),
            script_scan: ScanReport::default(),
        }
    }

    #[test]
    fn install_enable_disable_uninstall_does_not_leak_style_registration() {
        let root = tempfile::tempdir().expect("root");
        let host = ExtensionHost::open(root.path().to_path_buf()).expect("host");
        host.install_inspection(style_inspection("dev.example.one"), true, &[], "test")
            .expect("install");
        assert!(host.style_order().contains(&"dev.example.one".to_owned()));
        assert!(host
            .read_installed_text("dev.example.one", "styles/main.css")
            .expect("css")
            .contains("player-bar"));
        assert_eq!(host.list()[0].status, PluginStatus::Active);
        host.set_enabled("dev.example.one", false).expect("disable");
        assert!(!host.list()[0].enabled);
        host.set_enabled("dev.example.one", true).expect("enable");
        host.uninstall("dev.example.one", true).expect("uninstall");
        assert!(host.list().is_empty());
    }

    #[test]
    fn unclean_shutdown_marks_enabled_plugins_failed() {
        let root = tempfile::tempdir().expect("root");
        let host = ExtensionHost::open(root.path().to_path_buf()).expect("host");
        host.install_inspection(style_inspection("dev.example.one"), true, &[], "test")
            .expect("install");
        drop(host);
        let journal = root.path().join("journal.json");
        std::fs::write(
            &journal,
            r#"{"bootId":"1","activationStarted":true,"cleanExit":false}"#,
        )
        .expect("journal");
        let recovered = ExtensionHost::open(root.path().to_path_buf()).expect("reopen");
        assert!(recovered.safe_mode());
        assert_eq!(recovered.list()[0].status, PluginStatus::Failed);
        assert!(!recovered.list()[0].enabled);
    }

    #[test]
    fn runtime_token_is_bound_and_cannot_be_spoofed() {
        let root = tempfile::tempdir().expect("root");
        let host = ExtensionHost::open(root.path().to_path_buf()).expect("host");
        host.install_inspection(style_inspection("dev.example.one"), true, &[], "test")
            .expect("install");
        let runtime = host.start_runtime("dev.example.one").expect("runtime");
        assert!(host.runtime("forged").is_none());
        assert!(host
            .check_permission(&runtime.token, PluginPermission::PlayerControl)
            .is_err());
        assert!(host
            .check_permission(&runtime.token, PluginPermission::StyleRegister)
            .is_ok());
        assert!(host.rate_limit("dev.example.one", "player", 2).is_ok());
        assert!(host.rate_limit("dev.example.one", "player", 2).is_ok());
        assert!(host.rate_limit("dev.example.one", "player", 2).is_err());
    }

    #[test]
    fn plugin_storage_is_namespaced_and_quota_bounded() {
        let root = tempfile::tempdir().expect("root");
        let host = ExtensionHost::open(root.path().to_path_buf()).expect("host");
        host.storage_set("dev.a", "k", "v").expect("a");
        host.storage_set("dev.b", "k", "other").expect("b");
        assert_eq!(host.storage_get("dev.a", "k").as_deref(), Some("v"));
        assert_eq!(host.storage_get("dev.b", "k").as_deref(), Some("other"));
        let huge = "x".repeat(70_000);
        assert!(host.storage_set("dev.a", "big", &huge).is_err());
        host.install_inspection(style_inspection("dev.a"), false, &[], "test")
            .expect("install");
        host.uninstall("dev.a", false).expect("keep");
        assert_eq!(host.storage_get("dev.a", "k").as_deref(), Some("v"));
        host.install_inspection(style_inspection("dev.a"), false, &[], "test")
            .expect("reinstall");
        host.uninstall("dev.a", true).expect("remove");
        assert!(host.storage_get("dev.a", "k").is_none());
    }

    fn scene_inspection(id: &str) -> PackageInspection {
        let manifest = PluginManifest::parse(
            format!(
                r#"{{
                    "manifestVersion": 1,
                    "id": "{id}",
                    "name": "Vinyl Pack",
                    "version": "1.0.0",
                    "apiVersion": 1,
                    "entrypoints": {{ "scenes": ["scenes/vinyl.scene.json"] }}
                }}"#
            )
            .as_bytes(),
        )
        .expect("manifest");
        PackageInspection {
            sha256: sha256_bytes(id.as_bytes()),
            compressed_bytes: 24,
            expanded_bytes: 24,
            file_count: 3,
            files: vec![
                PackageFile {
                    path: "manifest.json".into(),
                    bytes: serde_json::to_vec(&manifest).unwrap(),
                },
                PackageFile {
                    path: "scenes/vinyl.scene.json".into(),
                    bytes: br#"{"id":"vinyl","layout":"vinyl"}"#.to_vec(),
                },
                PackageFile {
                    path: "scenes/vinyl.css".into(),
                    bytes: b"[data-scene-widget=\"vinyl\"]{opacity:1}".to_vec(),
                },
            ],
            manifest,
            style_scan: ScanReport::default(),
            script_scan: ScanReport::default(),
        }
    }

    #[test]
    fn scene_css_path_maps_scene_json_to_sibling_css() {
        assert_eq!(
            scene_css_path("scenes/vinyl.scene.json"),
            "scenes/vinyl.css"
        );
        assert_eq!(scene_css_path("scenes/aurora.json"), "scenes/aurora.css");
    }

    #[test]
    fn scene_registration_is_removed_on_disable() {
        let root = tempfile::tempdir().expect("root");
        let host = ExtensionHost::open(root.path().to_path_buf()).expect("host");
        host.install_inspection(scene_inspection("dev.example.scene"), true, &[], "test")
            .expect("install");
        assert_eq!(host.active_resources().scenes.len(), 1);
        assert_eq!(host.active_resources().scenes[0].scene_id, "vinyl");
        assert_eq!(
            host.active_resources().scenes[0].css.as_deref(),
            Some("[data-scene-widget=\"vinyl\"]{opacity:1}")
        );
        host.set_enabled("dev.example.scene", false)
            .expect("disable");
        assert!(host.active_resources().scenes.is_empty());
        host.set_enabled("dev.example.scene", true).expect("enable");
        assert_eq!(host.active_resources().scenes.len(), 1);
    }

    #[test]
    fn style_order_is_deterministic_and_safe_mode_clears_resources() {
        let root = tempfile::tempdir().expect("root");
        let host = ExtensionHost::open(root.path().to_path_buf()).expect("host");
        host.install_inspection(style_inspection("dev.example.a"), true, &[], "test")
            .expect("a");
        host.install_inspection(style_inspection("dev.example.b"), true, &[], "test")
            .expect("b");
        assert_eq!(
            host.style_order(),
            vec!["dev.example.a".to_owned(), "dev.example.b".to_owned()]
        );
        assert_eq!(host.active_resources().styles.len(), 2);
        host.set_safe_mode(true).expect("safe");
        assert!(host.active_resources().styles.is_empty());
        assert!(host.active_resources().scenes.is_empty());
        assert!(host
            .set_enabled("dev.example.a", true)
            .unwrap_err()
            .to_string()
            .contains("safe mode"));
    }

    #[test]
    fn enabled_plugin_cannot_be_replaced_until_disabled() {
        let root = tempfile::tempdir().expect("root");
        let host = ExtensionHost::open(root.path().to_path_buf()).expect("host");
        host.install_inspection(style_inspection("dev.example.one"), true, &[], "test")
            .expect("install");
        let error = host
            .install_inspection(style_inspection("dev.example.one"), true, &[], "test")
            .unwrap_err();
        assert!(error.to_string().contains("disable the current version"));
        host.set_enabled("dev.example.one", false).expect("disable");
        host.install_inspection(style_inspection("dev.example.one"), false, &[], "test")
            .expect("update");
    }

    #[test]
    fn permission_expansion_requires_explicit_grant() {
        let root = tempfile::tempdir().expect("root");
        let host = ExtensionHost::open(root.path().to_path_buf()).expect("host");
        host.install_inspection(style_inspection("dev.example.ctrl"), true, &[], "test")
            .expect("install");
        host.set_enabled("dev.example.ctrl", false)
            .expect("disable");
        let mut next = style_inspection("dev.example.ctrl");
        next.manifest.permissions = vec!["player.control".into()];
        next.manifest.version = "1.1.0".into();
        let error = host
            .install_inspection(next.clone(), true, &[], "test")
            .unwrap_err();
        assert!(error.to_string().contains("explicitly accepted"));
        host.install_inspection(next, true, &[PluginPermission::PlayerControl], "test")
            .expect("granted");
    }

    #[test]
    fn diagnostics_omit_plugin_source_and_include_hash() {
        let root = tempfile::tempdir().expect("root");
        let host = ExtensionHost::open(root.path().to_path_buf()).expect("host");
        host.install_inspection(style_inspection("dev.example.one"), true, &[], "test")
            .expect("install");
        let encoded = serde_json::to_string(&host.diagnostics()).expect("json");
        assert!(encoded.contains("dev.example.one"));
        assert!(encoded.contains("packageSha256"));
        assert!(!encoded.contains("player-bar"));
        assert!(!encoded.contains("stylesheet"));
    }
}
