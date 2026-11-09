use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

fn hash(path: &Path) -> String {
    format!("{:x}", Sha256::digest(fs::read(path).unwrap()))
}
fn probe(root: &Path, revision: &str, fail: bool) -> PathBuf {
    let source = root.join(format!("{revision}.rs"));
    let binary = root.join(format!("{revision}{}", std::env::consts::EXE_SUFFIX));
    fs::write(&source, format!(r####"
fn main() {{
    if std::env::args().any(|a| a == "--wait") {{ std::thread::sleep(std::time::Duration::from_secs(60)); return; }}
    let root = std::path::PathBuf::from(std::env::var("YAQMC_TEST_OPERATION_DIRECTORY").unwrap());
    if std::env::var("YAQMC_APP_UPDATE_OPERATION").is_ok() {{
        if {fail} {{ std::process::exit(1); }}
        std::fs::write(root.join("healthy.json"), r###"{{"token":"{token}","version":"2.0.0"}}"###).unwrap();
    }} else {{ std::fs::write(root.join("restored.txt"), "{revision}").unwrap(); }}
}}
"####, token="b".repeat(64))).unwrap();
    let status = Command::new("rustc")
        .args(["--edition=2021", "-C", "debuginfo=0"])
        .arg(&source)
        .arg("-o")
        .arg(&binary)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
    binary
}
struct Fixture {
    root: tempfile::TempDir,
    target: PathBuf,
    candidate: PathBuf,
    parent: Child,
    old_hash: String,
}
impl Fixture {
    fn new(fail: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let old = probe(root.path(), "old", false);
        let candidate = probe(root.path(), "new", fail);
        let target = root
            .path()
            .join(format!("Custom YAQMC{}", std::env::consts::EXE_SUFFIX));
        fs::copy(&old, &target).unwrap();
        // Linux CI can briefly report ETXTBSY for a just-copied executable.
        // Retry only fixture startup; updater operations and assertions still run once.
        let deadline = Instant::now() + Duration::from_secs(2);
        let parent = loop {
            match Command::new(&target).arg("--wait").spawn() {
                Ok(child) => break child,
                Err(error)
                    if cfg!(target_os = "linux")
                        && error.raw_os_error() == Some(26)
                        && Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(20));
                }
                Err(error) => panic!("failed to start fixture {}: {error}", target.display()),
            }
        };
        let old_hash = hash(&target);
        let tx = json!({"operationId":"a".repeat(32),"token":"b".repeat(64),"parentPid":parent.id(),"launcherPid":parent.id(),
            "target":target,"package":candidate,"oldSha256":old_hash,"sha256":hash(&candidate),
            "size":fs::metadata(&candidate).unwrap().len(),"version":"2.0.0","state":"preparing"});
        fs::write(
            root.path().join("transaction.json"),
            serde_json::to_vec(&tx).unwrap(),
        )
        .unwrap();
        fs::write(
            root.path().join("session.json"),
            "synthetic-credential-reference",
        )
        .unwrap();
        Self {
            root,
            target,
            candidate,
            parent,
            old_hash,
        }
    }
    fn start(&self, mode: &str) -> Child {
        Command::new(env!("CARGO_BIN_EXE_yaqmc-update-helper"))
            .args([mode])
            .arg(self.root.path())
            .env("YAQMC_TEST_OPERATION_DIRECTORY", self.root.path())
            .spawn()
            .unwrap()
    }
    fn state(&self) -> Value {
        serde_json::from_slice(&fs::read(self.root.path().join("transaction.json")).unwrap())
            .unwrap()
    }
    fn ready(&self) {
        let deadline = Instant::now();
        while !self.root.path().join("ready.json").exists() {
            assert!(
                deadline.elapsed() < Duration::from_secs(10),
                "helper did not prepare: {}",
                self.state()
            );
            thread::sleep(Duration::from_millis(20));
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.parent.kill();
        let _ = self.parent.wait();
    }
}
fn finished(child: &mut Child) -> bool {
    let deadline = Instant::now();
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status.success();
        }
        assert!(
            deadline.elapsed() < Duration::from_secs(20),
            "helper did not finish"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn replaces_the_original_custom_filename_after_exit_and_keeps_user_data() {
    let mut f = Fixture::new(false);
    let expected = hash(&f.candidate);
    let mut helper = f.start("--apply");
    f.ready();
    assert_eq!(
        hash(&f.target),
        f.old_hash,
        "old process still owns its executable"
    );
    f.parent.kill().unwrap();
    f.parent.wait().unwrap();
    assert!(finished(&mut helper));
    assert_eq!(hash(&f.target), expected);
    assert_eq!(f.state()["state"], "completed");
    assert_eq!(
        fs::read_to_string(f.root.path().join("session.json")).unwrap(),
        "synthetic-credential-reference"
    );
    assert!(!f
        .root
        .path()
        .join(format!(".yaqmc-previous-{}", "a".repeat(32)))
        .exists());
}

#[test]
fn failed_new_process_restores_and_relaunches_the_previous_executable_once() {
    let mut f = Fixture::new(true);
    let mut helper = f.start("--apply");
    f.ready();
    f.parent.kill().unwrap();
    f.parent.wait().unwrap();
    assert!(finished(&mut helper));
    assert_eq!(hash(&f.target), f.old_hash);
    assert_eq!(f.state()["state"], "rolled-back");
    let start = Instant::now();
    while !f.root.path().join("restored.txt").exists() {
        assert!(start.elapsed() < Duration::from_secs(5));
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(
        fs::read_to_string(f.root.path().join("restored.txt")).unwrap(),
        "old"
    );
}

#[test]
fn a_bad_hash_never_stops_or_replaces_the_old_program() {
    let mut f = Fixture::new(false);
    let mut tx = f.state();
    tx["sha256"] = json!("0".repeat(64));
    fs::write(
        f.root.path().join("transaction.json"),
        serde_json::to_vec(&tx).unwrap(),
    )
    .unwrap();
    assert!(!finished(&mut f.start("--apply")));
    assert_eq!(hash(&f.target), f.old_hash);
    assert!(f.parent.try_wait().unwrap().is_none());
    assert_eq!(f.state()["state"], "error");
}

#[cfg(windows)]
#[test]
fn an_inherited_portable_environment_cannot_replace_an_unrelated_executable() {
    let mut f = Fixture::new(false);
    let mut tx = f.state();
    tx["launcherPid"] = json!(std::process::id());
    fs::write(
        f.root.path().join("transaction.json"),
        serde_json::to_vec(&tx).unwrap(),
    )
    .unwrap();
    assert!(!finished(&mut f.start("--apply")));
    assert_eq!(hash(&f.target), f.old_hash);
    assert!(f.parent.try_wait().unwrap().is_none());
    assert_eq!(
        f.state()["error"],
        "update-target-is-not-the-portable-launcher"
    );
}

#[test]
fn interrupted_preparation_recovers_without_installing_and_the_operation_lock_is_exclusive() {
    let f = Fixture::new(false);
    let mut helper = f.start("--apply");
    f.ready();
    assert!(
        finished(&mut f.start("--recover")),
        "another helper must leave the live operation alone"
    );
    helper.kill().unwrap();
    helper.wait().unwrap();
    assert!(finished(&mut f.start("--recover")));
    assert_eq!(hash(&f.target), f.old_hash);
    assert_eq!(f.state()["state"], "error");
    assert!(!f
        .root
        .path()
        .join(format!(".yaqmc-next-{}", "a".repeat(32)))
        .exists());
}

#[test]
fn recovery_after_atomic_replacement_keeps_a_proven_healthy_installation() {
    let mut f = Fixture::new(false);
    f.parent.kill().unwrap();
    f.parent.wait().unwrap();
    let backup = f
        .root
        .path()
        .join(format!(".yaqmc-previous-{}", "a".repeat(32)));
    fs::copy(&f.target, &backup).unwrap();
    fs::copy(&f.candidate, &f.target).unwrap();
    let expected = hash(&f.target);
    let mut tx = f.state();
    tx["state"] = json!("installing");
    fs::write(
        f.root.path().join("transaction.json"),
        serde_json::to_vec(&tx).unwrap(),
    )
    .unwrap();
    fs::write(
        f.root.path().join("healthy.json"),
        serde_json::to_vec(&json!({"token":"b".repeat(64),"version":"2.0.0"})).unwrap(),
    )
    .unwrap();
    assert!(finished(&mut f.start("--recover")));
    assert_eq!(hash(&f.target), expected);
    assert_eq!(f.state()["state"], "completed");
    assert!(!backup.exists());
    assert!(
        finished(&mut f.start("--recover")),
        "committed recovery is idempotent"
    );
}
