use std::{
    collections::HashMap,
    fs::{self, File},
    io::Write,
    path::Path,
    sync::{Arc, Mutex},
};

use rusqlite::Connection;
use serde_json::json;
use tempfile::TempDir;
use yaqmc_core::{
    credentials::{CredentialError, CredentialStore, SpawnBlockingCredentialStore},
    plugin::{
        host::ExtensionHost,
        package::{inspect_package, PackageError},
        permissions::PluginPermission,
    },
    storage::StorageService,
};
use zip::{write::SimpleFileOptions, ZipWriter};

fn table_names(database: &Path) -> Vec<String> {
    let connection = Connection::open(database).expect("database opens");
    let mut statement = connection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .expect("table query prepares");
    statement
        .query_map([], |row| row.get(0))
        .expect("table query runs")
        .collect::<Result<Vec<_>, _>>()
        .expect("table names load")
}

#[test]
fn storage_uses_injected_roots_and_preserves_the_v5_schema() {
    let root = TempDir::new().expect("temporary root");
    let data_root = root.path().join("injected-data");
    let cache_root = root.path().join("injected-cache");
    let storage =
        StorageService::open(data_root.clone(), cache_root.clone()).expect("storage opens");
    let database = data_root.join("library.sqlite3");

    assert!(database.is_file());
    assert!(cache_root.is_dir());
    storage
        .set_setting("task6-setting", "persists")
        .expect("setting saves");
    storage
        .save_queue(&json!({ "queue": ["track-1"] }))
        .expect("queue saves");
    drop(storage);

    let reopened = StorageService::open(data_root.clone(), cache_root).expect("storage reopens");
    assert_eq!(
        reopened
            .get_setting("task6-setting")
            .expect("setting loads"),
        Some("persists".to_owned())
    );
    assert_eq!(
        reopened
            .load_queue::<serde_json::Value>()
            .expect("queue loads"),
        Some(json!({ "queue": ["track-1"] }))
    );
    drop(reopened);

    let connection = Connection::open(&database).expect("database opens");
    let version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .expect("schema version");
    let journal_mode: String = connection
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .expect("journal mode");
    assert_eq!(version, 5);
    assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
    drop(connection);
    assert_eq!(
        table_names(&database),
        vec![
            "app_settings",
            "cache_files",
            "playback_history",
            "provider_cache",
            "queue_state",
            "recent_searches",
            "sqlite_sequence",
        ]
    );
}

#[derive(Default)]
struct InMemoryStore(Mutex<HashMap<String, String>>);

impl CredentialStore for InMemoryStore {
    fn load(&self, account: &str) -> Result<Option<String>, CredentialError> {
        Ok(self.0.lock().expect("store lock").get(account).cloned())
    }

    fn save(&self, account: &str, secret: &str) -> Result<(), CredentialError> {
        self.0
            .lock()
            .expect("store lock")
            .insert(account.to_owned(), secret.to_owned());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), CredentialError> {
        self.0.lock().expect("store lock").remove(account);
        Ok(())
    }
}

struct PanickingStore;

impl CredentialStore for PanickingStore {
    fn load(&self, _account: &str) -> Result<Option<String>, CredentialError> {
        panic!("credential test worker panic")
    }

    fn save(&self, _account: &str, _secret: &str) -> Result<(), CredentialError> {
        Ok(())
    }

    fn delete(&self, _account: &str) -> Result<(), CredentialError> {
        Ok(())
    }
}

#[tokio::test]
async fn credentials_round_trip_and_keep_blocking_failures_sanitized() {
    let backend: Arc<dyn CredentialStore> = Arc::new(InMemoryStore::default());
    let store = SpawnBlockingCredentialStore::new(backend);
    store
        .save("qqmusic-session", "session")
        .await
        .expect("credential saves");
    assert_eq!(
        store
            .load("qqmusic-session")
            .await
            .expect("credential loads"),
        Some("session".to_owned())
    );
    store
        .delete("qqmusic-session")
        .await
        .expect("credential deletes");
    assert_eq!(
        store
            .load("qqmusic-session")
            .await
            .expect("credential loads"),
        None
    );

    let panicking = SpawnBlockingCredentialStore::new(Arc::new(PanickingStore));
    let error = panicking
        .load("qqmusic-session")
        .await
        .expect_err("panic is a join failure");
    assert!(matches!(error, CredentialError::JoinFailed));
    assert_eq!(error.to_string(), "the secure credential worker failed");
}

fn manifest() -> &'static str {
    r#"{
        "manifestVersion": 1,
        "id": "dev.example.task6",
        "name": "Task 6",
        "version": "1.0.0",
        "apiVersion": 1,
        "entrypoints": { "styles": ["styles/main.css"] }
    }"#
}

fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
    let file = File::create(path).expect("archive creates");
    let mut archive = ZipWriter::new(file);
    for (name, contents) in entries {
        archive
            .start_file(*name, SimpleFileOptions::default())
            .expect("archive entry starts");
        archive.write_all(contents).expect("archive entry writes");
    }
    archive.finish().expect("archive finishes");
}

#[test]
fn plugin_host_persists_safety_and_enforces_runtime_and_package_contracts() {
    let root = TempDir::new().expect("temporary root");
    let package = root.path().join("plugin.yaqmc-plugin");
    write_zip(
        &package,
        &[
            ("manifest.json", manifest().as_bytes()),
            ("styles/main.css", b"body { color: white; }"),
        ],
    );

    let host = ExtensionHost::open(root.path().join("host")).expect("host opens");
    host.install(&package, true, &[]).expect("plugin installs");
    let runtime = host
        .start_runtime("dev.example.task6")
        .expect("runtime starts");
    assert_eq!(runtime.plugin_id, "dev.example.task6");
    assert!(host
        .check_permission(&runtime.token, PluginPermission::StyleRegister)
        .is_ok());
    assert!(host
        .check_permission(&runtime.token, PluginPermission::PlayerControl)
        .is_err());
    host.storage_set("dev.example.task6", "key", "value")
        .expect("storage write");
    assert_eq!(
        host.storage_get("dev.example.task6", "key").as_deref(),
        Some("value")
    );
    assert!(host
        .storage_set("dev.example.task6", "oversized", &"x".repeat(70_000))
        .is_err());
    host.mark_clean_exit();
    drop(host);

    let clean_reopened = ExtensionHost::open(root.path().join("host")).expect("clean host reopens");
    assert!(!clean_reopened.safe_mode());
    drop(clean_reopened);

    fs::write(
        root.path().join("host/journal.json"),
        r#"{"bootId":"task6","activationStarted":true,"cleanExit":false}"#,
    )
    .expect("unclean journal writes");
    let recovered = ExtensionHost::open(root.path().join("host")).expect("host reopens");
    assert!(recovered.safe_mode());
    assert!(!recovered.list()[0].enabled);

    let traversal = root.path().join("traversal.yaqmc-plugin");
    write_zip(
        &traversal,
        &[
            ("manifest.json", manifest().as_bytes()),
            ("../escape.css", b"body{}"),
        ],
    );
    assert_eq!(
        inspect_package(&traversal).unwrap_err(),
        PackageError::UnsafePath
    );

    let duplicate = root.path().join("duplicate.yaqmc-plugin");
    write_zip(
        &duplicate,
        &[
            ("manifest.json", manifest().as_bytes()),
            ("styles/main.css", b"a{}"),
            ("styles/./main.css", b"b{}"),
        ],
    );
    assert_eq!(
        inspect_package(&duplicate).unwrap_err(),
        PackageError::UnsafePath
    );

    let symlink = root.path().join("symlink.yaqmc-plugin");
    let file = File::create(&symlink).expect("symlink archive creates");
    let mut archive = ZipWriter::new(file);
    archive
        .add_symlink(
            "styles/main.css",
            "../escape.css",
            SimpleFileOptions::default(),
        )
        .expect("symlink entry starts");
    archive
        .start_file("manifest.json", SimpleFileOptions::default())
        .expect("manifest entry starts");
    archive
        .write_all(manifest().as_bytes())
        .expect("manifest writes");
    archive.finish().expect("symlink archive finishes");
    assert_eq!(
        inspect_package(&symlink).unwrap_err(),
        PackageError::Symlink
    );

    let oversized = root.path().join("oversized.yaqmc-plugin");
    fs::write(&oversized, vec![0_u8; 8 * 1024 * 1024 + 1]).expect("oversized package writes");
    assert_eq!(
        inspect_package(&oversized).unwrap_err(),
        PackageError::Oversize
    );
}
