#![cfg_attr(windows, windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Transaction {
    operation_id: String,
    token: String,
    parent_pid: u32,
    #[serde(default)]
    launcher_pid: u32,
    target: PathBuf,
    package: PathBuf,
    old_sha256: String,
    sha256: String,
    size: u64,
    version: String,
    #[serde(default)]
    target_kind: Option<String>,
    state: String,
    #[serde(default)]
    error: Option<String>,
}

fn hash(path: &Path) -> Result<String> {
    let mut input = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 128 * 1024];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn atomic_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let temporary = path.with_extension("tmp");
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&temporary)?;
    file.write_all(&serde_json::to_vec(value)?)?;
    file.sync_all()?;
    drop(file);
    fs::rename(temporary, path)?;
    Ok(())
}

fn paths(tx: &Transaction) -> Result<(PathBuf, PathBuf)> {
    if tx.operation_id.len() != 32
        || !tx.operation_id.bytes().all(|b| b.is_ascii_hexdigit())
        || tx.token.len() != 64
        || !tx.token.bytes().all(|b| b.is_ascii_hexdigit())
        || tx.parent_pid == 0
        || tx.parent_pid == std::process::id()
        || !tx.target.is_absolute()
        || !tx.package.is_absolute()
        || tx.sha256.len() != 64
        || tx.old_sha256.len() != 64
        || tx.size == 0
    {
        return Err("update-transaction-invalid".into());
    }
    let metadata = fs::symlink_metadata(&tx.target)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("update-target-invalid".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("update-target-invalid".into());
        }
    }
    validate_target_kind(&tx.target, tx.target_kind.as_deref())?;
    let parent = tx.target.parent().ok_or("update-target-invalid")?;
    Ok((
        parent.join(format!(".yaqmc-next-{}", tx.operation_id)),
        parent.join(format!(".yaqmc-previous-{}", tx.operation_id)),
    ))
}

fn validate_target_kind(target: &Path, kind: Option<&str>) -> Result<()> {
    if kind != Some("AppImage") {
        return Ok(());
    }
    let mut input = File::open(target)?;
    let mut header = [0_u8; 12];
    input.read_exact(&mut header)?;
    if &header[..4] != b"\x7fELF" || &header[8..10] != b"AI" || !matches!(header[10], 1 | 2) {
        return Err("update-target-invalid".into());
    }
    Ok(())
}

#[cfg(windows)]
struct Parent(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl Parent {
    fn open(pid: u32) -> Result<Self> {
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(Self(handle))
    }
    fn wait(&self) -> Result<()> {
        use windows_sys::Win32::System::Threading::WaitForSingleObject;
        if unsafe { WaitForSingleObject(self.0, 90_000) } != 0 {
            return Err("update-parent-did-not-exit".into());
        }
        Ok(())
    }
}
#[cfg(windows)]
impl Drop for Parent {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
#[cfg(unix)]
struct Parent(u32);
#[cfg(unix)]
impl Parent {
    fn open(pid: u32) -> Result<Self> {
        Ok(Self(pid))
    }
    fn wait(&self) -> Result<()> {
        let start = Instant::now();
        while unsafe { libc::kill(self.0 as i32, 0) } == 0 {
            if start.elapsed() > Duration::from_secs(90) {
                return Err("update-parent-did-not-exit".into());
            }
            thread::sleep(Duration::from_millis(100));
        }
        Ok(())
    }
}

fn replace(target: &Path, next: &Path, backup: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
        let wide = |p: &Path| {
            p.as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<_>>()
        };
        let (target, next, backup) = (wide(target), wide(next), wide(backup));
        if unsafe {
            ReplaceFileW(
                target.as_ptr(),
                next.as_ptr(),
                backup.as_ptr(),
                0,
                std::ptr::null(),
                std::ptr::null(),
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    #[cfg(unix)]
    {
        fs::copy(target, backup)?;
        File::open(backup)?.sync_all()?;
        fs::rename(next, target)?;
        File::open(target.parent().ok_or("update-target-invalid")?)?.sync_all()?;
    }
    Ok(())
}

fn replace_wait(target: &Path, next: &Path, backup: &Path) -> Result<()> {
    let started = Instant::now();
    loop {
        match replace(target, next, backup) {
            Ok(()) => return Ok(()),
            Err(error) if started.elapsed() >= Duration::from_secs(30) => return Err(error),
            Err(_) => thread::sleep(Duration::from_millis(200)),
        }
    }
}

fn launch(tx: &Transaction, operation: Option<&str>) -> Result<std::process::Child> {
    let mut command = Command::new(&tx.target);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
        .env_remove("APPIMAGE")
        .env_remove("APPDIR")
        .env_remove("PORTABLE_EXECUTABLE_FILE")
        .env_remove("PORTABLE_EXECUTABLE_DIR")
        .env_remove("PORTABLE_EXECUTABLE_APP_FILENAME");
    if let Some(id) = operation {
        command.env("YAQMC_APP_UPDATE_OPERATION", id);
    } else {
        command.env_remove("YAQMC_APP_UPDATE_OPERATION");
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    Ok(command.spawn()?)
}

fn update(directory: &Path) -> Result<()> {
    let journal = directory.join("transaction.json");
    let mut tx: Transaction = serde_json::from_slice(&fs::read(&journal)?)?;
    let (next, backup) = paths(&tx)?;
    let parent = Parent::open(tx.parent_pid)?;
    #[cfg(windows)]
    validate_launcher(tx.launcher_pid, &tx.target)?;
    if hash(&tx.target)? != tx.old_sha256 {
        return Err("update-target-changed".into());
    }
    let package = fs::symlink_metadata(&tx.package)?;
    if !package.is_file() || package.file_type().is_symlink() {
        return Err("update-package-invalid".into());
    }
    if package.len() != tx.size || hash(&tx.package)? != tx.sha256 {
        return Err("update-hash-mismatch".into());
    }
    if next.exists() || backup.exists() {
        return Err("update-recovery-required".into());
    }
    fs::copy(&tx.package, &next)?;
    fs::set_permissions(&next, fs::metadata(&tx.target)?.permissions())?;
    OpenOptions::new().write(true).open(&next)?.sync_all()?;
    tx.state = "prepared".into();
    atomic_json(&journal, &tx)?;
    atomic_json(
        &directory.join("ready.json"),
        &serde_json::json!({"operationId":tx.operation_id}),
    )?;
    if let Err(error) = parent.wait() {
        let _ = fs::remove_file(&next);
        return Err(error);
    }
    if hash(&tx.target)? != tx.old_sha256 || hash(&next)? != tx.sha256 {
        return Err("update-target-changed".into());
    }
    tx.state = "installing".into();
    atomic_json(&journal, &tx)?;
    replace_wait(&tx.target, &next, &backup)?;
    tx.state = "restarting".into();
    atomic_json(&journal, &tx)?;
    let launched = launch(&tx, Some(&tx.operation_id));
    let mut child = launched.ok();
    let deadline = Instant::now();
    let success = loop {
        let health = fs::read(directory.join("healthy.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
        if health.is_some_and(|value| value["token"] == tx.token && value["version"] == tx.version)
        {
            break true;
        }
        if child.is_none()
            || deadline.elapsed() >= Duration::from_secs(60)
            || child
                .as_mut()
                .is_some_and(|process| process.try_wait().ok().flatten().is_some())
        {
            break false;
        }
        thread::sleep(Duration::from_millis(100));
    };
    if success {
        tx.state = "completed".into();
        atomic_json(&journal, &tx)?;
        let _ = fs::remove_file(&backup);
        let _ = fs::remove_file(&tx.package);
        return Ok(());
    }
    // One rollback only. Never recursively update the restored executable.
    stop_candidate(directory, &tx);
    if let Some(mut process) = child {
        let _ = process.kill();
        let _ = process.wait();
    }
    if hash(&backup)? != tx.old_sha256 {
        return Err("update-backup-invalid".into());
    }
    replace_wait(&tx.target, &backup, &next)?;
    let _ = fs::remove_file(&next);
    tx.state = "rolled-back".into();
    tx.error = Some("update-startup-failed".into());
    atomic_json(&journal, &tx)?;
    launch(&tx, None)?;
    Ok(())
}

#[cfg(windows)]
fn validate_launcher(pid: u32, target: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
        },
    };
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return Err("update-launcher-not-found".into());
    }
    let mut buffer = vec![0u16; 32768];
    let mut size = buffer.len() as u32;
    let success = unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut size) };
    unsafe {
        CloseHandle(process);
    }
    if success == 0 {
        return Err("update-launcher-unreadable".into());
    }
    let image = PathBuf::from(std::ffi::OsString::from_wide(&buffer[..size as usize]));
    if fs::canonicalize(image)?.to_string_lossy().to_lowercase()
        != fs::canonicalize(target)?.to_string_lossy().to_lowercase()
    {
        return Err("update-target-is-not-the-portable-launcher".into());
    }
    Ok(())
}

fn stop_candidate(directory: &Path, tx: &Transaction) {
    let value = fs::read(directory.join("launched.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    let Some(value) = value else {
        return;
    };
    if value["token"] != tx.token {
        return;
    }
    let Some(pid) = value["pid"]
        .as_u64()
        .and_then(|pid| u32::try_from(pid).ok())
    else {
        return;
    };
    if pid == 0 || pid == std::process::id() || pid == tx.parent_pid {
        return;
    }
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::Threading::{
                OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
                PROCESS_TERMINATE,
            },
        };
        let process = OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, pid);
        if !process.is_null() {
            TerminateProcess(process, 1);
            WaitForSingleObject(process, 10_000);
            CloseHandle(process);
        }
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
}

fn healthy(directory: &Path, tx: &Transaction) -> bool {
    fs::read(directory.join("healthy.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .is_some_and(|value| value["token"] == tx.token && value["version"] == tx.version)
}

fn recover(directory: &Path) -> Result<()> {
    let journal = directory.join("transaction.json");
    let mut tx: Transaction = serde_json::from_slice(&fs::read(&journal)?)?;
    let (next, backup) = paths(&tx)?;
    let current = hash(&tx.target)?;
    if current == tx.old_sha256 {
        let _ = fs::remove_file(&next);
        if !matches!(tx.state.as_str(), "rolled-back" | "error") {
            tx.state = "error".into();
            tx.error = Some("update-interrupted-before-install".into());
            atomic_json(&journal, &tx)?;
        }
        return Ok(());
    }
    if current != tx.sha256 {
        return Err("update-target-changed".into());
    }
    if tx.state == "completed" {
        let _ = fs::remove_file(backup);
        let _ = fs::remove_file(&tx.package);
        return Ok(());
    }
    if hash(&backup)? != tx.old_sha256 {
        return Err("update-backup-invalid".into());
    }
    let started = Instant::now();
    while !healthy(directory, &tx) && started.elapsed() < Duration::from_secs(60) {
        thread::sleep(Duration::from_millis(100));
    }
    if healthy(directory, &tx) {
        tx.state = "completed".into();
        atomic_json(&journal, &tx)?;
        let _ = fs::remove_file(backup);
        let _ = fs::remove_file(&tx.package);
    } else {
        stop_candidate(directory, &tx);
        replace_wait(&tx.target, &backup, &next)?;
        let _ = fs::remove_file(next);
        tx.state = "rolled-back".into();
        tx.error = Some("update-startup-failed".into());
        atomic_json(&journal, &tx)?;
        launch(&tx, None)?;
    }
    Ok(())
}

fn operation_lock(directory: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    let file = options.open(directory.join("operation.lock"))?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    Ok(file)
}

fn main() {
    let arguments: Vec<_> = std::env::args_os().collect();
    if arguments.len() != 3 || (arguments[1] != "--apply" && arguments[1] != "--recover") {
        std::process::exit(2);
    }
    let directory = PathBuf::from(&arguments[2]);
    if !directory.is_absolute() {
        std::process::exit(2);
    }
    let Ok(_lock) = operation_lock(&directory) else {
        return;
    };
    let result = if arguments[1] == "--recover" {
        recover(&directory)
    } else {
        update(&directory)
    };
    if let Err(error) = result {
        let journal = directory.join("transaction.json");
        if let Ok(bytes) = fs::read(&journal) {
            if let Ok(mut tx) = serde_json::from_slice::<Transaction>(&bytes) {
                tx.state = if matches!(
                    tx.state.as_str(),
                    "installing" | "restarting" | "recovery-required"
                ) {
                    "recovery-required".into()
                } else {
                    "error".into()
                };
                tx.error = Some(error.to_string());
                let _ = atomic_json(&journal, &tx);
            }
        }
        std::process::exit(1);
    }
}
