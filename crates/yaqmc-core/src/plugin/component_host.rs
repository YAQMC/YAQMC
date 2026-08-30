use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Instant, SystemTime},
};

use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::credentials::CredentialStore;

pub const COMPONENT_KV_QUOTA: usize = 4 * 1024 * 1024;
pub const COMPONENT_CACHE_QUOTA: usize = 64 * 1024 * 1024;
const COMPONENT_KV_ENTRY_LIMIT: usize = 1024 * 1024;
const COMPONENT_KV_MAX_ENTRIES: usize = 4_096;
const COMPONENT_CACHE_ENTRY_LIMIT: usize = 4 * 1024 * 1024;
const COMPONENT_CACHE_MAX_ENTRIES: usize = 4_096;
const COMPONENT_RANDOM_MAX_BYTES: usize = 4_096;
const COMPONENT_CREDENTIAL_MAX_BYTES: usize = 64 * 1024;
const COMPONENT_CREDENTIAL_MAX_HANDLES: usize = 1_024;
const COMPONENT_LOG_MAX_CHARS: usize = 1_024;

#[derive(Clone)]
pub struct ComponentHostServices {
    inner: Arc<ComponentHostServicesInner>,
}

struct ComponentHostServicesInner {
    data_root: PathBuf,
    cache_root: PathBuf,
    credentials: Arc<dyn CredentialStore>,
    runtime: tokio::runtime::Handle,
    started: Instant,
    sequence: AtomicU64,
    namespaces: Mutex<HashMap<String, Arc<NamespaceState>>>,
    filesystem: Mutex<()>,
}

struct NamespaceState {
    kv: Mutex<BTreeMap<String, String>>,
}

#[derive(Clone)]
pub struct ComponentHostContext {
    services: ComponentHostServices,
    plugin_id: Arc<str>,
    provider_id: Arc<str>,
    namespace: Arc<str>,
    allowed_origins: Arc<HashSet<String>>,
    state: Arc<NamespaceState>,
    revoked: Arc<AtomicBool>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialRecord {
    origin: String,
    secret: String,
}

impl ComponentHostServices {
    pub fn open(
        data_root: PathBuf,
        cache_root: PathBuf,
        credentials: Arc<dyn CredentialStore>,
        runtime: tokio::runtime::Handle,
    ) -> Result<Self, String> {
        fs::create_dir_all(&data_root)
            .map_err(|_| "component data directory could not be created".to_owned())?;
        fs::create_dir_all(&cache_root)
            .map_err(|_| "component cache directory could not be created".to_owned())?;
        Ok(Self {
            inner: Arc::new(ComponentHostServicesInner {
                data_root,
                cache_root,
                credentials,
                runtime,
                started: Instant::now(),
                sequence: AtomicU64::new(1),
                namespaces: Mutex::new(HashMap::new()),
                filesystem: Mutex::new(()),
            }),
        })
    }

    pub fn for_plugin(
        &self,
        plugin_id: &str,
        provider_id: &str,
        allowed_origins: HashSet<String>,
    ) -> ComponentHostContext {
        let namespace = namespace_id(plugin_id, provider_id);
        let state = {
            let mut namespaces = self
                .inner
                .namespaces
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            namespaces
                .entry(namespace.clone())
                .or_insert_with(|| {
                    Arc::new(NamespaceState {
                        kv: Mutex::new(read_json(self.kv_path(&namespace)).unwrap_or_default()),
                    })
                })
                .clone()
        };
        ComponentHostContext {
            services: self.clone(),
            plugin_id: Arc::from(plugin_id),
            provider_id: Arc::from(provider_id),
            namespace: Arc::from(namespace),
            allowed_origins: Arc::new(allowed_origins),
            state,
            revoked: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn remove_plugin_data(&self, plugin_id: &str, provider_id: &str) -> Result<(), String> {
        let namespace = namespace_id(plugin_id, provider_id);
        let _filesystem = self
            .inner
            .filesystem
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let credential_index = self.read_credential_index(&namespace);
        for handle in credential_index.keys() {
            self.inner
                .credentials
                .delete(&credential_account(&namespace, handle))
                .map_err(|_| "component credential could not be deleted".to_owned())?;
        }
        remove_file_if_exists(&self.kv_path(&namespace))?;
        remove_file_if_exists(&self.credential_index_path(&namespace))?;
        let cache = self.cache_namespace_path(&namespace);
        if cache.is_dir() {
            fs::remove_dir_all(&cache)
                .map_err(|_| "component cache could not be deleted".to_owned())?;
        }
        self.inner
            .namespaces
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&namespace);
        Ok(())
    }

    fn kv_path(&self, namespace: &str) -> PathBuf {
        self.inner.data_root.join(format!("{namespace}.kv.json"))
    }

    fn credential_index_path(&self, namespace: &str) -> PathBuf {
        self.inner
            .data_root
            .join(format!("{namespace}.credentials.json"))
    }

    fn cache_namespace_path(&self, namespace: &str) -> PathBuf {
        self.inner.cache_root.join(namespace)
    }

    fn read_credential_index(&self, namespace: &str) -> BTreeMap<String, String> {
        read_json(self.credential_index_path(namespace)).unwrap_or_default()
    }

    fn write_json<T: Serialize>(&self, path: &Path, value: &T) -> Result<(), String> {
        let bytes = serde_json::to_vec(value)
            .map_err(|_| "component data could not be encoded".to_owned())?;
        let sequence = self.inner.sequence.fetch_add(1, Ordering::Relaxed);
        let temporary = path.with_extension(format!("tmp-{sequence:x}"));
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|_| "component data could not be saved".to_owned())?;
        let result = (|| {
            file.write_all(&bytes)
                .map_err(|_| "component data could not be saved".to_owned())?;
            file.sync_all()
                .map_err(|_| "component data could not be saved".to_owned())?;
            drop(file);
            if path.exists() {
                fs::remove_file(path)
                    .map_err(|_| "component data could not be replaced".to_owned())?;
            }
            fs::rename(&temporary, path)
                .map_err(|_| "component data could not be replaced".to_owned())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }
}

impl ComponentHostContext {
    pub fn revoke(&self) {
        self.revoked.store(true, Ordering::Release);
    }

    pub fn ensure_active(&self) -> Result<(), String> {
        if self.revoked.load(Ordering::Acquire) {
            Err("component host context is revoked".to_owned())
        } else {
            Ok(())
        }
    }

    pub fn allowed_origins(&self) -> &HashSet<String> {
        &self.allowed_origins
    }

    pub fn runtime(&self) -> &tokio::runtime::Handle {
        &self.services.inner.runtime
    }

    pub fn kv_get(&self, key: &str) -> Result<Option<String>, String> {
        self.ensure_active()?;
        validate_key(key)?;
        Ok(self
            .state
            .kv
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(key)
            .cloned())
    }

    pub fn kv_set(&self, key: &str, value: &str) -> Result<bool, String> {
        self.ensure_active()?;
        validate_key(key)?;
        if value.len() > COMPONENT_KV_ENTRY_LIMIT {
            return Err("component storage entry is too large".to_owned());
        }
        let _filesystem = self
            .services
            .inner
            .filesystem
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut values = self
            .state
            .kv
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !values.contains_key(key) && values.len() >= COMPONENT_KV_MAX_ENTRIES {
            return Err("component storage has too many entries".to_owned());
        }
        let previous = values.insert(key.to_owned(), value.to_owned());
        let encoded = serde_json::to_vec(&*values)
            .map_err(|_| "component storage could not be encoded".to_owned())?;
        if encoded.len() > COMPONENT_KV_QUOTA {
            restore_entry(&mut values, key, previous);
            return Err("component storage quota exceeded".to_owned());
        }
        if let Err(error) = self
            .services
            .write_json(&self.services.kv_path(&self.namespace), &*values)
        {
            restore_entry(&mut values, key, previous);
            return Err(error);
        }
        Ok(true)
    }

    pub fn kv_delete(&self, key: &str) -> Result<bool, String> {
        self.ensure_active()?;
        validate_key(key)?;
        let _filesystem = self
            .services
            .inner
            .filesystem
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut values = self
            .state
            .kv
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(previous) = values.remove(key) else {
            return Ok(false);
        };
        if let Err(error) = self
            .services
            .write_json(&self.services.kv_path(&self.namespace), &*values)
        {
            values.insert(key.to_owned(), previous);
            return Err(error);
        }
        Ok(true)
    }

    pub fn cache_get(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        self.ensure_active()?;
        validate_key(key)?;
        let _filesystem = self
            .services
            .inner
            .filesystem
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let path = self.cache_path(key);
        let metadata = match fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() => metadata,
            Ok(_) => return Err("component cache entry is invalid".to_owned()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("component cache could not be read".to_owned()),
        };
        if metadata.len() > COMPONENT_CACHE_ENTRY_LIMIT as u64 {
            let _ = fs::remove_file(path);
            return Err("component cache entry is too large".to_owned());
        }
        fs::read(path)
            .map(Some)
            .map_err(|_| "component cache could not be read".to_owned())
    }

    pub fn cache_put(&self, key: &str, value: &[u8]) -> Result<bool, String> {
        self.cache_put_with_limit(key, value, COMPONENT_CACHE_QUOTA)
    }

    fn cache_put_with_limit(&self, key: &str, value: &[u8], quota: usize) -> Result<bool, String> {
        self.ensure_active()?;
        validate_key(key)?;
        if value.len() > COMPONENT_CACHE_ENTRY_LIMIT || value.len() > quota {
            return Err("component cache entry is too large".to_owned());
        }
        let _filesystem = self
            .services
            .inner
            .filesystem
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let directory = self.services.cache_namespace_path(&self.namespace);
        fs::create_dir_all(&directory)
            .map_err(|_| "component cache could not be created".to_owned())?;
        let target = self.cache_path(key);
        let mut entries = cache_entries(&directory, &target)?;
        let mut total = entries.iter().map(|entry| entry.1).sum::<u64>();
        entries.sort_by_key(|entry| entry.2);
        while total.saturating_add(value.len() as u64) > quota as u64
            || entries.len().saturating_add(1) > COMPONENT_CACHE_MAX_ENTRIES
        {
            let Some((path, size, _)) = entries.first().cloned() else {
                return Err("component cache quota exceeded".to_owned());
            };
            fs::remove_file(path)
                .map_err(|_| "component cache entry could not be evicted".to_owned())?;
            total = total.saturating_sub(size);
            entries.remove(0);
        }
        fs::write(target, value)
            .map_err(|_| "component cache entry could not be saved".to_owned())?;
        Ok(true)
    }

    pub fn cache_delete(&self, key: &str) -> Result<bool, String> {
        self.ensure_active()?;
        validate_key(key)?;
        let _filesystem = self
            .services
            .inner
            .filesystem
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let path = self.cache_path(key);
        match fs::remove_file(path) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(_) => Err("component cache entry could not be deleted".to_owned()),
        }
    }

    pub fn credential_create(&self, origin: &str, secret: &str) -> Result<String, String> {
        self.ensure_active()?;
        if !self.allowed_origins.contains(origin) {
            return Err("component credential origin is not granted".to_owned());
        }
        if secret.is_empty() || secret.len() > COMPONENT_CREDENTIAL_MAX_BYTES {
            return Err("component credential is invalid".to_owned());
        }
        let _filesystem = self
            .services
            .inner
            .filesystem
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut index = self.services.read_credential_index(&self.namespace);
        if index.len() >= COMPONENT_CREDENTIAL_MAX_HANDLES {
            return Err("component credential quota exceeded".to_owned());
        }
        let handle = loop {
            let mut random = [0_u8; 24];
            rand::rng().fill_bytes(&mut random);
            let candidate = format!("cred_{}", encode_hex(&random));
            if !index.contains_key(&candidate) {
                break candidate;
            }
        };
        let record = serde_json::to_string(&CredentialRecord {
            origin: origin.to_owned(),
            secret: secret.to_owned(),
        })
        .map_err(|_| "component credential could not be encoded".to_owned())?;
        let account = credential_account(&self.namespace, &handle);
        self.services
            .inner
            .credentials
            .save(&account, &record)
            .map_err(|_| "component credential could not be saved".to_owned())?;
        index.insert(handle.clone(), origin.to_owned());
        if let Err(error) = self.services.write_json(
            &self.services.credential_index_path(&self.namespace),
            &index,
        ) {
            let _ = self.services.inner.credentials.delete(&account);
            return Err(error);
        }
        Ok(handle)
    }

    pub fn credential_delete(&self, handle: &str) -> Result<bool, String> {
        self.ensure_active()?;
        validate_handle(handle)?;
        let _filesystem = self
            .services
            .inner
            .filesystem
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut index = self.services.read_credential_index(&self.namespace);
        if index.remove(handle).is_none() {
            return Ok(false);
        }
        self.services
            .inner
            .credentials
            .delete(&credential_account(&self.namespace, handle))
            .map_err(|_| "component credential could not be deleted".to_owned())?;
        self.services.write_json(
            &self.services.credential_index_path(&self.namespace),
            &index,
        )?;
        Ok(true)
    }

    pub(crate) fn credential_resolve(
        &self,
        handle: &str,
        request_origin: &str,
    ) -> Result<String, String> {
        self.ensure_active()?;
        validate_handle(handle)?;
        if !self.allowed_origins.contains(request_origin) {
            return Err("component credential origin is not granted".to_owned());
        }
        let _filesystem = self
            .services
            .inner
            .filesystem
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let index = self.services.read_credential_index(&self.namespace);
        if index.get(handle).map(String::as_str) != Some(request_origin) {
            return Err("component credential handle is unavailable".to_owned());
        }
        let record = self
            .services
            .inner
            .credentials
            .load(&credential_account(&self.namespace, handle))
            .map_err(|_| "component credential could not be loaded".to_owned())?
            .ok_or_else(|| "component credential handle is unavailable".to_owned())?;
        let record: CredentialRecord = serde_json::from_str(&record)
            .map_err(|_| "component credential record is invalid".to_owned())?;
        if record.origin != request_origin {
            return Err("component credential handle is unavailable".to_owned());
        }
        Ok(record.secret)
    }

    pub fn monotonic_millis(&self) -> u64 {
        self.services.inner.started.elapsed().as_millis() as u64
    }

    pub fn random_bytes(&self, length: u32) -> Result<Vec<u8>, String> {
        self.ensure_active()?;
        let length = length as usize;
        if length > COMPONENT_RANDOM_MAX_BYTES {
            return Err("component random request is too large".to_owned());
        }
        let mut bytes = vec![0_u8; length];
        rand::rng().fill_bytes(&mut bytes);
        Ok(bytes)
    }

    pub fn log(&self, level: &str, message: &str) {
        if self.ensure_active().is_err() {
            return;
        }
        let message = redact_log_message(message);
        match level {
            "error" => {
                tracing::error!(target: "plugin.component", plugin_id = %self.plugin_id, provider_id = %self.provider_id, message)
            }
            "warn" => {
                tracing::warn!(target: "plugin.component", plugin_id = %self.plugin_id, provider_id = %self.provider_id, message)
            }
            "debug" => {
                tracing::debug!(target: "plugin.component", plugin_id = %self.plugin_id, provider_id = %self.provider_id, message)
            }
            _ => {
                tracing::info!(target: "plugin.component", plugin_id = %self.plugin_id, provider_id = %self.provider_id, message)
            }
        }
    }

    fn cache_path(&self, key: &str) -> PathBuf {
        self.services
            .cache_namespace_path(&self.namespace)
            .join(format!("{}.cache", hash_text(key)))
    }
}

fn namespace_id(plugin_id: &str, provider_id: &str) -> String {
    hash_text(&format!("{plugin_id}\0{provider_id}"))
}

fn credential_account(namespace: &str, handle: &str) -> String {
    format!("plugin-component:{namespace}:{handle}")
}

fn hash_text(value: &str) -> String {
    encode_hex(&Sha256::digest(value.as_bytes()))
}

fn encode_hex(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push_str(&format!("{byte:02x}"));
    }
    encoded
}

fn validate_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.len() > 128 || key.chars().any(|character| character.is_control()) {
        return Err("component storage key is invalid".to_owned());
    }
    Ok(())
}

fn validate_handle(handle: &str) -> Result<(), String> {
    if handle.len() != 53
        || !handle.starts_with("cred_")
        || !handle[5..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("component credential handle is invalid".to_owned());
    }
    Ok(())
}

fn restore_entry(values: &mut BTreeMap<String, String>, key: &str, previous: Option<String>) {
    if let Some(previous) = previous {
        values.insert(key.to_owned(), previous);
    } else {
        values.remove(key);
    }
}

fn read_json<T: for<'de> Deserialize<'de>>(path: PathBuf) -> Option<T> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("component data could not be deleted".to_owned()),
    }
}

fn cache_entries(
    directory: &Path,
    excluded: &Path,
) -> Result<Vec<(PathBuf, u64, SystemTime)>, String> {
    let mut entries = Vec::new();
    for entry in
        fs::read_dir(directory).map_err(|_| "component cache could not be inspected".to_owned())?
    {
        let entry = entry.map_err(|_| "component cache could not be inspected".to_owned())?;
        let path = entry.path();
        if path == excluded {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|_| "component cache could not be inspected".to_owned())?;
        if metadata.is_file() && path.extension().is_some_and(|value| value == "cache") {
            entries.push((
                path,
                metadata.len(),
                metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            ));
        }
    }
    Ok(entries)
}

fn redact_log_message(message: &str) -> String {
    let normalized = message
        .chars()
        .filter(|character| !character.is_control() || matches!(character, ' ' | '\t'))
        .take(COMPONENT_LOG_MAX_CHARS)
        .collect::<String>();
    let lower = normalized.to_ascii_lowercase();
    if [
        "authorization",
        "bearer ",
        "cookie",
        "password",
        "secret",
        "access_token",
        "refresh_token",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        "[redacted potentially sensitive plugin message]".to_owned()
    } else {
        normalized
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::MemoryCredentialStore;

    fn services(root: &tempfile::TempDir) -> ComponentHostServices {
        ComponentHostServices::open(
            root.path().join("data"),
            root.path().join("cache"),
            Arc::new(MemoryCredentialStore::default()),
            tokio::runtime::Handle::current(),
        )
        .expect("services")
    }

    #[tokio::test]
    async fn kv_and_cache_are_bounded_and_namespaced() {
        let root = tempfile::tempdir().expect("root");
        let services = services(&root);
        let first = services.for_plugin("dev.example.first", "provider.first", HashSet::new());
        let second = services.for_plugin("dev.example.second", "provider.second", HashSet::new());
        assert!(first.kv_set("key", "first").expect("set"));
        assert_eq!(first.kv_get("key").expect("get").as_deref(), Some("first"));
        assert_eq!(second.kv_get("key").expect("get"), None);
        assert!(first.cache_put_with_limit("a", b"1234", 6).expect("put"));
        assert!(first.cache_put_with_limit("b", b"5678", 6).expect("evict"));
        assert_eq!(first.cache_get("a").expect("get"), None);
        assert_eq!(first.cache_get("b").expect("get"), Some(b"5678".to_vec()));
        assert!(first.kv_delete("key").expect("delete"));
        assert!(!first.kv_delete("key").expect("delete missing"));
    }

    #[tokio::test]
    async fn credential_handles_are_origin_bound_and_not_cross_namespaced() {
        let root = tempfile::tempdir().expect("root");
        let services = services(&root);
        let origin = "https://accounts.example.com";
        let first = services.for_plugin(
            "dev.example.first",
            "provider.first",
            HashSet::from([origin.to_owned()]),
        );
        let second = services.for_plugin(
            "dev.example.second",
            "provider.second",
            HashSet::from([origin.to_owned()]),
        );
        let handle = first
            .credential_create(origin, "synthetic-secret")
            .expect("create");
        assert_eq!(
            first.credential_resolve(&handle, origin).expect("resolve"),
            "synthetic-secret"
        );
        assert!(second.credential_resolve(&handle, origin).is_err());
        assert!(first
            .credential_resolve(&handle, "https://other.example.com")
            .is_err());
        assert!(first.credential_delete(&handle).expect("delete"));
        assert!(first.credential_resolve(&handle, origin).is_err());
    }

    #[tokio::test]
    async fn removing_plugin_data_clears_kv_cache_and_credentials() {
        let root = tempfile::tempdir().expect("root");
        let services = services(&root);
        let origin = "https://accounts.example.com";
        let context = services.for_plugin(
            "dev.example.first",
            "provider.first",
            HashSet::from([origin.to_owned()]),
        );
        context.kv_set("key", "value").expect("kv");
        context.cache_put("key", b"value").expect("cache");
        let handle = context
            .credential_create(origin, "synthetic-secret")
            .expect("credential");
        services
            .remove_plugin_data("dev.example.first", "provider.first")
            .expect("remove");
        let recovered = services.for_plugin(
            "dev.example.first",
            "provider.first",
            HashSet::from([origin.to_owned()]),
        );
        assert_eq!(recovered.kv_get("key").expect("get"), None);
        assert_eq!(recovered.cache_get("key").expect("get"), None);
        assert!(recovered.credential_resolve(&handle, origin).is_err());
    }

    #[tokio::test]
    async fn revoked_context_cannot_repopulate_removed_data() {
        let root = tempfile::tempdir().expect("root");
        let services = services(&root);
        let context = services.for_plugin("dev.example.first", "provider.first", HashSet::new());
        context.kv_set("key", "before").expect("set");
        context.revoke();
        services
            .remove_plugin_data("dev.example.first", "provider.first")
            .expect("remove");
        assert!(context.kv_set("key", "after").is_err());
        assert!(context.cache_put("key", b"after").is_err());
        let recovered = services.for_plugin("dev.example.first", "provider.first", HashSet::new());
        assert_eq!(recovered.kv_get("key").expect("get"), None);
    }

    #[test]
    fn logs_are_length_bounded_and_sensitive_shapes_are_redacted() {
        assert_eq!(
            redact_log_message("Authorization: Bearer synthetic"),
            "[redacted potentially sensitive plugin message]"
        );
        assert_eq!(redact_log_message("catalog ready\n"), "catalog ready");
        assert_eq!(
            redact_log_message(&"x".repeat(COMPONENT_LOG_MAX_CHARS + 10)).len(),
            COMPONENT_LOG_MAX_CHARS
        );
    }
}
