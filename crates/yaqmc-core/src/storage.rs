use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::StreamExt;
use reqwest::{
    header::{HeaderMap, HeaderValue, REFERER},
    Client, StatusCode,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(any(test, feature = "test-support"))]
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering as AtomicOrdering};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use thiserror::Error;
use tokio::{fs as async_fs, io::AsyncWriteExt, sync::Semaphore};
pub use yaqmc_provider_api::storage::{CacheStats, ProviderCacheMutation};
use yaqmc_provider_api::storage::{ProviderStorage, ProviderStorageError};

const MEDIA_CACHE_LIMIT: u64 = 256 * 1024 * 1024;
const ARTWORK_CACHE_LIMIT: u64 = 64 * 1024 * 1024;
const SINGLE_MEDIA_LIMIT: u64 = 128 * 1024 * 1024;
const SINGLE_ARTWORK_LIMIT: u64 = 5 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("local storage could not be initialized")]
    Initialize,
    #[error("the local database operation failed")]
    Database,
    #[error("the cache file operation failed")]
    File,
    #[error("the network request failed")]
    Network,
    #[error("the provider media URL expired")]
    UrlExpired,
    #[error("the provider returned HTTP {0}")]
    Http(u16),
    #[error("the downloaded response exceeded the configured cache limit")]
    ResponseTooLarge,
    #[error("the cached response did not provide the required content type")]
    InvalidContentType,
}

#[derive(Clone, Debug)]
pub struct CachedFile {
    pub path: PathBuf,
    pub bytes: u64,
    pub mime_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CacheRow {
    relative_path: String,
    bytes: i64,
    mime_type: Option<String>,
}

pub struct StorageService {
    connection: Mutex<Connection>,
    cache_root: PathBuf,
    download_guard: Semaphore,
    #[cfg(any(test, feature = "test-support"))]
    _temporary_root: Option<tempfile::TempDir>,
    #[cfg(any(test, feature = "test-support"))]
    fail_provider_cache_delete: AtomicBool,
    #[cfg(any(test, feature = "test-support"))]
    fail_provider_cache_batch_after: AtomicUsize,
}

fn artwork_fetch_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(REFERER, HeaderValue::from_static("https://y.qq.com/"));
    headers
}

impl StorageService {
    pub fn open(data_root: PathBuf, cache_root: PathBuf) -> Result<Self, StorageError> {
        fs::create_dir_all(&data_root).map_err(|_| StorageError::Initialize)?;
        fs::create_dir_all(&cache_root).map_err(|_| StorageError::Initialize)?;
        cleanup_partial_files(&cache_root);
        let connection = Connection::open(data_root.join("library.sqlite3"))
            .map_err(|_| StorageError::Initialize)?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|_| StorageError::Initialize)?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(|_| StorageError::Initialize)?;
        migrate(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
            cache_root,
            download_guard: Semaphore::new(4),
            #[cfg(any(test, feature = "test-support"))]
            _temporary_root: None,
            #[cfg(any(test, feature = "test-support"))]
            fail_provider_cache_delete: AtomicBool::new(false),
            #[cfg(any(test, feature = "test-support"))]
            fail_provider_cache_batch_after: AtomicUsize::new(usize::MAX),
        })
    }

    #[cfg(any(test, feature = "test-support"))]
    #[doc(hidden)]
    pub fn temporary() -> Self {
        let root = tempfile::tempdir().expect("temporary storage root");
        let mut storage = Self::open(root.path().join("data"), root.path().join("cache"))
            .expect("temporary storage opens");
        storage._temporary_root = Some(root);
        storage
    }

    pub fn get_json<T: DeserializeOwned>(
        &self,
        key: &str,
        allow_expired: bool,
    ) -> Result<Option<T>, StorageError> {
        let now = unix_timestamp_ms();
        let connection = self
            .connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let row: Option<(String, Option<i64>)> = connection
            .query_row(
                "SELECT value_json, expires_at_ms FROM provider_cache WHERE cache_key = ?1",
                params![key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|_| StorageError::Database)?;
        let Some((json, expires_at)) = row else {
            return Ok(None);
        };
        if !allow_expired && expires_at.is_some_and(|expires| (expires.max(0) as u64) <= now) {
            return Ok(None);
        }
        serde_json::from_str(&json)
            .map(Some)
            .map_err(|_| StorageError::Database)
    }

    pub fn put_json<T: Serialize>(
        &self,
        key: &str,
        kind: &str,
        value: &T,
        ttl_ms: u64,
    ) -> Result<(), StorageError> {
        let json = serde_json::to_string(value).map_err(|_| StorageError::Database)?;
        let now = unix_timestamp_ms();
        let expires_at = now.saturating_add(ttl_ms);
        let connection = self
            .connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        connection
            .execute(
                "INSERT INTO provider_cache(cache_key, kind, value_json, expires_at_ms, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(cache_key) DO UPDATE SET
                   kind = excluded.kind,
                   value_json = excluded.value_json,
                   expires_at_ms = excluded.expires_at_ms,
                   updated_at_ms = excluded.updated_at_ms",
                params![key, kind, json, sqlite_i64(expires_at), sqlite_i64(now)],
            )
            .map_err(|_| StorageError::Database)?;
        connection
            .execute(
                "DELETE FROM provider_cache WHERE cache_key IN (
                   SELECT cache_key FROM provider_cache
                   ORDER BY updated_at_ms DESC LIMIT -1 OFFSET 5000
                 )",
                [],
            )
            .map_err(|_| StorageError::Database)?;
        Ok(())
    }

    pub fn delete_provider_cache_kind(&self, kind: &str) -> Result<u64, StorageError> {
        #[cfg(any(test, feature = "test-support"))]
        if self
            .fail_provider_cache_delete
            .load(AtomicOrdering::Acquire)
        {
            return Err(StorageError::Database);
        }
        let deleted = self
            .connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .execute("DELETE FROM provider_cache WHERE kind = ?1", params![kind])
            .map_err(|_| StorageError::Database)?;
        Ok(deleted as u64)
    }

    #[doc(hidden)]
    pub fn apply_provider_cache_batch(
        &self,
        operations: &[ProviderCacheMutation],
    ) -> Result<(), StorageError> {
        let now = unix_timestamp_ms();
        let mut connection = self
            .connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let transaction = connection
            .transaction()
            .map_err(|_| StorageError::Database)?;
        #[cfg(any(test, feature = "test-support"))]
        let mut applied_operations = 0_usize;
        for operation in operations {
            match operation {
                ProviderCacheMutation::Put {
                    key,
                    kind,
                    value_json,
                    expires_at_ms,
                } => {
                    transaction
                        .execute(
                            "INSERT INTO provider_cache(cache_key, kind, value_json, expires_at_ms, updated_at_ms)
                             VALUES (?1, ?2, ?3, ?4, ?5)
                             ON CONFLICT(cache_key) DO UPDATE SET
                               kind = excluded.kind,
                               value_json = excluded.value_json,
                               expires_at_ms = excluded.expires_at_ms,
                               updated_at_ms = excluded.updated_at_ms",
                            params![
                                key,
                                kind,
                                value_json,
                                sqlite_i64(*expires_at_ms),
                                sqlite_i64(now)
                            ],
                        )
                        .map_err(|_| StorageError::Database)?;
                }
                ProviderCacheMutation::Delete { key } => {
                    transaction
                        .execute(
                            "DELETE FROM provider_cache WHERE cache_key = ?1",
                            params![key],
                        )
                        .map_err(|_| StorageError::Database)?;
                }
                ProviderCacheMutation::DeleteKindPrefix { kind, prefix } => {
                    transaction
                        .execute(
                            "DELETE FROM provider_cache
                             WHERE kind = ?1 AND substr(cache_key, 1, length(?2)) = ?2",
                            params![kind, prefix],
                        )
                        .map_err(|_| StorageError::Database)?;
                }
            }
            #[cfg(any(test, feature = "test-support"))]
            {
                applied_operations += 1;
                if self
                    .fail_provider_cache_batch_after
                    .load(AtomicOrdering::Acquire)
                    == applied_operations
                {
                    return Err(StorageError::Database);
                }
            }
        }
        transaction
            .execute(
                "DELETE FROM provider_cache WHERE cache_key IN (
                   SELECT cache_key FROM provider_cache
                   ORDER BY updated_at_ms DESC LIMIT -1 OFFSET 5000
                 )",
                [],
            )
            .map_err(|_| StorageError::Database)?;
        transaction.commit().map_err(|_| StorageError::Database)
    }

    #[cfg(any(test, feature = "test-support"))]
    #[doc(hidden)]
    pub fn fail_provider_cache_delete_for_test(&self) {
        self.fail_provider_cache_delete
            .store(true, AtomicOrdering::Release);
    }

    #[cfg(any(test, feature = "test-support"))]
    #[doc(hidden)]
    pub fn fail_provider_cache_batch_after_for_test(&self, operation_count: usize) {
        self.fail_provider_cache_batch_after
            .store(operation_count, AtomicOrdering::Release);
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>, StorageError> {
        self.connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .query_row(
                "SELECT value FROM app_settings WHERE setting_key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| StorageError::Database)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        connection
            .execute(
                "INSERT INTO app_settings(setting_key, value, updated_at_ms)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(setting_key) DO UPDATE SET
                   value = excluded.value,
                   updated_at_ms = excluded.updated_at_ms",
                params![key, value, sqlite_i64(unix_timestamp_ms())],
            )
            .map_err(|_| StorageError::Database)?;
        Ok(())
    }

    pub fn update_setting<F>(&self, key: &str, update: F) -> Result<String, StorageError>
    where
        F: FnOnce(Option<String>) -> String,
    {
        let connection = self
            .connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let current = connection
            .query_row(
                "SELECT value FROM app_settings WHERE setting_key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| StorageError::Database)?;
        let value = update(current);
        connection
            .execute(
                "INSERT INTO app_settings(setting_key, value, updated_at_ms)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(setting_key) DO UPDATE SET
                   value = excluded.value,
                   updated_at_ms = excluded.updated_at_ms",
                params![key, value, sqlite_i64(unix_timestamp_ms())],
            )
            .map_err(|_| StorageError::Database)?;
        Ok(value)
    }

    pub fn remove_setting(&self, key: &str) -> Result<(), StorageError> {
        self.connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .execute(
                "DELETE FROM app_settings WHERE setting_key = ?1",
                params![key],
            )
            .map_err(|_| StorageError::Database)?;
        Ok(())
    }

    pub fn record_search(&self, provider: &str, query: &str) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        connection
            .execute(
                "INSERT INTO recent_searches(provider, query, searched_at_ms) VALUES (?1, ?2, ?3)",
                params![provider, query, sqlite_i64(unix_timestamp_ms())],
            )
            .map_err(|_| StorageError::Database)?;
        connection
            .execute(
                "DELETE FROM recent_searches WHERE id NOT IN (
                   SELECT id FROM recent_searches ORDER BY searched_at_ms DESC LIMIT 100
                 )",
                [],
            )
            .map_err(|_| StorageError::Database)?;
        Ok(())
    }

    pub fn load_queue<T: DeserializeOwned>(&self) -> Result<Option<T>, StorageError> {
        let value: Option<String> = self
            .connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .query_row(
                "SELECT value_json FROM queue_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| StorageError::Database)?;
        value
            .map(|json| serde_json::from_str(&json).map_err(|_| StorageError::Database))
            .transpose()
    }

    pub fn save_queue<T: Serialize>(&self, value: &T) -> Result<(), StorageError> {
        let json = serde_json::to_string(value).map_err(|_| StorageError::Database)?;
        self.connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .execute(
                "INSERT INTO queue_state(singleton, value_json, updated_at_ms)
                 VALUES (1, ?1, ?2)
                 ON CONFLICT(singleton) DO UPDATE SET
                   value_json = excluded.value_json,
                   updated_at_ms = excluded.updated_at_ms",
                params![json, sqlite_i64(unix_timestamp_ms())],
            )
            .map_err(|_| StorageError::Database)?;
        Ok(())
    }

    pub fn record_playback_snapshot<T: Serialize>(
        &self,
        provider: &str,
        track_id: &str,
        value: &T,
    ) -> Result<(), StorageError> {
        let value_json = serde_json::to_string(value).map_err(|_| StorageError::Database)?;
        let now = sqlite_i64(unix_timestamp_ms());
        let connection = self
            .connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        connection
            .execute(
                "INSERT INTO playback_history(provider, track_id, played_at_ms, value_json)
                 VALUES (?1, ?2, ?3, ?4)",
                params![provider, track_id, now, value_json],
            )
            .map_err(|_| StorageError::Database)?;
        connection
            .execute(
                "DELETE FROM playback_history WHERE id NOT IN (
                   SELECT id FROM playback_history ORDER BY played_at_ms DESC, id DESC LIMIT 2000
                 )",
                [],
            )
            .map_err(|_| StorageError::Database)?;
        Ok(())
    }

    pub fn load_playback_history<T: DeserializeOwned>(
        &self,
        provider: &str,
        limit: u32,
    ) -> Result<Vec<(T, u64)>, StorageError> {
        let connection = self
            .connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut statement = connection
            .prepare(
                "SELECT value_json, played_at_ms FROM playback_history AS history
                 WHERE provider = ?1 AND value_json IS NOT NULL
                   AND id = (
                     SELECT MAX(latest.id) FROM playback_history AS latest
                     WHERE latest.provider = history.provider
                       AND latest.track_id = history.track_id
                       AND latest.value_json IS NOT NULL
                   )
                 ORDER BY played_at_ms DESC, id DESC LIMIT ?2",
            )
            .map_err(|_| StorageError::Database)?;
        let rows = statement
            .query_map(params![provider, i64::from(limit.clamp(1, 500))], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|_| StorageError::Database)?;
        let mut history = Vec::new();
        for row in rows {
            let (json, played_at_ms) = row.map_err(|_| StorageError::Database)?;
            let value = serde_json::from_str(&json).map_err(|_| StorageError::Database)?;
            history.push((value, played_at_ms.max(0) as u64));
        }
        Ok(history)
    }

    pub fn backfill_playback_history_snapshot<T: Serialize>(
        &self,
        provider: &str,
        track_id: &str,
        value: &T,
    ) -> Result<(), StorageError> {
        let value_json = serde_json::to_string(value).map_err(|_| StorageError::Database)?;
        self.connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .execute(
                "UPDATE playback_history SET value_json = ?3
                 WHERE provider = ?1 AND track_id = ?2 AND value_json IS NULL",
                params![provider, track_id, value_json],
            )
            .map_err(|_| StorageError::Database)?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)] // Explicit cache policy keeps call sites auditable.
    pub async fn fetch_cached(
        &self,
        client: &Client,
        kind: &str,
        stable_key: &str,
        url: &str,
        headers: HeaderMap,
        extension: &str,
        max_bytes: u64,
        required_mime_prefix: Option<&str>,
    ) -> Result<CachedFile, StorageError> {
        if let Some(cached) = self.lookup_file(stable_key)? {
            return self.validate_cached_mime(stable_key, cached, required_mime_prefix);
        }

        let _guard = self
            .download_guard
            .acquire()
            .await
            .map_err(|_| StorageError::File)?;
        if let Some(cached) = self.lookup_file(stable_key)? {
            return self.validate_cached_mime(stable_key, cached, required_mime_prefix);
        }

        let response = client
            .get(url)
            .headers(headers)
            .send()
            .await
            .map_err(|_| StorageError::Network)?;
        let response_status = response.status().as_u16();
        let response_content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(normalize_mime_type);
        tracing::debug!(
            target: "storage.fetch",
            cache_kind = kind,
            status = response_status,
            content_type = response_content_type.as_deref().unwrap_or("missing"),
            "cache fetch response received"
        );
        if kind == "media"
            && matches!(
                response.status(),
                StatusCode::UNAUTHORIZED
                    | StatusCode::FORBIDDEN
                    | StatusCode::NOT_FOUND
                    | StatusCode::GONE
            )
        {
            return Err(StorageError::UrlExpired);
        }
        if !response.status().is_success() {
            return Err(StorageError::Http(response.status().as_u16()));
        }
        if response
            .content_length()
            .is_some_and(|length| length > max_bytes)
        {
            return Err(StorageError::ResponseTooLarge);
        }
        let mime_type = response_content_type;
        if !mime_matches_prefix(mime_type.as_deref(), required_mime_prefix) {
            return Err(StorageError::InvalidContentType);
        }

        let directory = self.cache_root.join(kind);
        async_fs::create_dir_all(&directory)
            .await
            .map_err(|_| StorageError::File)?;
        let digest = sha256(stable_key.as_bytes());
        let relative_path = format!("{kind}/{digest}.{extension}");
        let target = self.cache_root.join(&relative_path);
        let temporary = directory.join(format!("{digest}.{}.part", rand::random::<u64>()));
        let mut file = async_fs::File::create(&temporary)
            .await
            .map_err(|_| StorageError::File)?;
        let mut stream = response.bytes_stream();
        let mut bytes = 0_u64;
        while let Some(chunk) = stream.next().await {
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(_) => {
                    let _ = async_fs::remove_file(&temporary).await;
                    return Err(StorageError::Network);
                }
            };
            bytes = bytes.saturating_add(chunk.len() as u64);
            if bytes > max_bytes {
                let _ = async_fs::remove_file(&temporary).await;
                return Err(StorageError::ResponseTooLarge);
            }
            if file.write_all(&chunk).await.is_err() {
                let _ = async_fs::remove_file(&temporary).await;
                return Err(StorageError::File);
            }
        }
        if file.flush().await.is_err() {
            let _ = async_fs::remove_file(&temporary).await;
            return Err(StorageError::File);
        }
        drop(file);
        if target.is_file() {
            let _ = async_fs::remove_file(&temporary).await;
        } else if async_fs::rename(&temporary, &target).await.is_err() {
            let _ = async_fs::remove_file(&temporary).await;
            if !target.is_file() {
                return Err(StorageError::File);
            }
        }

        if let Err(error) = self.record_file(
            stable_key,
            kind,
            &relative_path,
            bytes,
            mime_type.as_deref(),
        ) {
            let _ = async_fs::remove_file(&target).await;
            return Err(error);
        }
        self.enforce_file_limit(kind, cache_limit(kind))?;
        Ok(CachedFile {
            path: target,
            bytes,
            mime_type,
        })
    }

    pub async fn artwork_data_uri(
        &self,
        client: &Client,
        url: &str,
    ) -> Result<String, StorageError> {
        let stable_key = format!("artwork:{}", sha256(url.as_bytes()));
        let file = self
            .fetch_cached(
                client,
                "artwork",
                &stable_key,
                url,
                artwork_fetch_headers(),
                "img",
                SINGLE_ARTWORK_LIMIT,
                Some("image/"),
            )
            .await?;
        let bytes = async_fs::read(file.path)
            .await
            .map_err(|_| StorageError::File)?;
        let mime = file
            .mime_type
            .as_deref()
            .filter(|mime| mime.starts_with("image/"))
            .ok_or(StorageError::InvalidContentType)?;
        Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
    }

    pub fn stats(&self) -> Result<CacheStats, StorageError> {
        let connection = self
            .connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let file_stats = |kind: &str| -> Result<(u64, u64), StorageError> {
            let (bytes, entries): (i64, i64) = connection
                .query_row(
                    "SELECT COALESCE(SUM(bytes), 0), COUNT(*) FROM cache_files WHERE kind = ?1",
                    params![kind],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(|_| StorageError::Database)?;
            Ok((bytes.max(0) as u64, entries.max(0) as u64))
        };
        let entry_count = |kind: &str| -> Result<u64, StorageError> {
            let count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM provider_cache WHERE kind = ?1",
                    params![kind],
                    |row| row.get(0),
                )
                .map_err(|_| StorageError::Database)?;
            Ok(count.max(0) as u64)
        };
        let (media_bytes, media_entries) = file_stats("media")?;
        let (artwork_bytes, artwork_entries) = file_stats("artwork")?;
        Ok(CacheStats {
            total_bytes: media_bytes.saturating_add(artwork_bytes),
            media_bytes,
            artwork_bytes,
            media_entries,
            artwork_entries,
            metadata_entries: entry_count("metadata")?,
            lyric_entries: entry_count("lyrics")?,
            media_limit_bytes: MEDIA_CACHE_LIMIT,
            artwork_limit_bytes: ARTWORK_CACHE_LIMIT,
        })
    }

    pub fn clear(&self) -> Result<CacheStats, StorageError> {
        let paths = {
            let connection = self
                .connection
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let mut statement = connection
                .prepare("SELECT relative_path FROM cache_files")
                .map_err(|_| StorageError::Database)?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|_| StorageError::Database)?;
            rows.filter_map(Result::ok).collect::<Vec<_>>()
        };
        for relative in paths {
            if is_safe_relative_cache_path(&relative) {
                let _ = fs::remove_file(self.cache_root.join(relative));
            }
        }
        let connection = self
            .connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        connection
            .execute("DELETE FROM cache_files", [])
            .map_err(|_| StorageError::Database)?;
        connection
            .execute("DELETE FROM provider_cache", [])
            .map_err(|_| StorageError::Database)?;
        drop(connection);
        self.stats()
    }

    pub fn single_media_limit(&self) -> u64 {
        SINGLE_MEDIA_LIMIT
    }

    pub fn encrypted_media_limit(&self) -> u64 {
        MEDIA_CACHE_LIMIT
    }

    #[doc(hidden)]
    pub fn lookup_cached_file(&self, stable_key: &str) -> Result<Option<CachedFile>, StorageError> {
        self.lookup_file(stable_key)
    }

    #[doc(hidden)]
    pub fn progressive_temp_path(
        &self,
        stable_key: &str,
        extension: &str,
    ) -> Result<PathBuf, StorageError> {
        let directory = self.cache_root.join("media");
        fs::create_dir_all(&directory).map_err(|_| StorageError::File)?;
        let digest = sha256(stable_key.as_bytes());
        Ok(directory.join(format!(
            "{digest}.progressive-{}.{}.part",
            rand::random::<u64>(),
            extension
        )))
    }

    #[doc(hidden)]
    pub fn promote_progressive(
        &self,
        stable_key: &str,
        source: &Path,
        extension: &str,
        bytes: u64,
        mime_type: Option<&str>,
    ) -> Result<CachedFile, StorageError> {
        if let Some(cached) = self.lookup_file(stable_key)? {
            return Ok(cached);
        }
        if !source.is_file() || source.metadata().map_err(|_| StorageError::File)?.len() != bytes {
            return Err(StorageError::File);
        }

        let directory = self.cache_root.join("media");
        fs::create_dir_all(&directory).map_err(|_| StorageError::File)?;
        let digest = sha256(stable_key.as_bytes());
        let relative_path = format!("media/{digest}.{extension}");
        let target = self.cache_root.join(&relative_path);
        if !target.is_file() {
            let staging = directory.join(format!("{digest}.{}.part", rand::random::<u64>()));
            fs::copy(source, &staging).map_err(|_| StorageError::File)?;
            if fs::rename(&staging, &target).is_err() {
                let _ = fs::remove_file(&staging);
                if !target.is_file() {
                    return Err(StorageError::File);
                }
            }
        }
        self.record_file(stable_key, "media", &relative_path, bytes, mime_type)?;
        self.enforce_file_limit("media", MEDIA_CACHE_LIMIT)?;
        Ok(CachedFile {
            path: target,
            bytes,
            mime_type: mime_type.map(str::to_owned),
        })
    }

    fn lookup_file(&self, stable_key: &str) -> Result<Option<CachedFile>, StorageError> {
        let row: Option<CacheRow> = {
            let connection = self
                .connection
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            connection
                .query_row(
                    "SELECT relative_path, bytes, mime_type FROM cache_files WHERE cache_key = ?1",
                    params![stable_key],
                    |row| {
                        Ok(CacheRow {
                            relative_path: row.get(0)?,
                            bytes: row.get(1)?,
                            mime_type: row.get(2)?,
                        })
                    },
                )
                .optional()
                .map_err(|_| StorageError::Database)?
        };
        let Some(row) = row else {
            return Ok(None);
        };
        if !is_safe_relative_cache_path(&row.relative_path) {
            return Ok(None);
        }
        let path = self.cache_root.join(&row.relative_path);
        if !path.is_file() {
            self.connection
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .execute(
                    "DELETE FROM cache_files WHERE cache_key = ?1",
                    params![stable_key],
                )
                .map_err(|_| StorageError::Database)?;
            return Ok(None);
        }
        self.connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .execute(
                "UPDATE cache_files SET last_accessed_at_ms = ?2 WHERE cache_key = ?1",
                params![stable_key, sqlite_i64(unix_timestamp_ms())],
            )
            .map_err(|_| StorageError::Database)?;
        Ok(Some(CachedFile {
            path,
            bytes: row.bytes.max(0) as u64,
            mime_type: row.mime_type,
        }))
    }

    fn validate_cached_mime(
        &self,
        stable_key: &str,
        mut cached: CachedFile,
        required_mime_prefix: Option<&str>,
    ) -> Result<CachedFile, StorageError> {
        if required_mime_prefix.is_none() {
            return Ok(cached);
        }
        cached.mime_type = cached.mime_type.as_deref().and_then(normalize_mime_type);
        if mime_matches_prefix(cached.mime_type.as_deref(), required_mime_prefix) {
            return Ok(cached);
        }
        if cached.path.is_file() {
            fs::remove_file(&cached.path).map_err(|_| StorageError::File)?;
        }
        self.connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .execute(
                "DELETE FROM cache_files WHERE cache_key = ?1",
                params![stable_key],
            )
            .map_err(|_| StorageError::Database)?;
        Err(StorageError::InvalidContentType)
    }

    fn record_file(
        &self,
        cache_key: &str,
        kind: &str,
        relative_path: &str,
        bytes: u64,
        mime_type: Option<&str>,
    ) -> Result<(), StorageError> {
        let now = unix_timestamp_ms();
        self.connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .execute(
                "INSERT INTO cache_files(cache_key, kind, relative_path, bytes, mime_type, created_at_ms, last_accessed_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
                 ON CONFLICT(cache_key) DO UPDATE SET
                   kind = excluded.kind,
                   relative_path = excluded.relative_path,
                   bytes = excluded.bytes,
                   mime_type = excluded.mime_type,
                   last_accessed_at_ms = excluded.last_accessed_at_ms",
                params![
                    cache_key,
                    kind,
                    relative_path,
                    sqlite_i64(bytes),
                    mime_type,
                    sqlite_i64(now)
                ],
            )
            .map_err(|_| StorageError::Database)?;
        Ok(())
    }

    fn enforce_file_limit(&self, kind: &str, limit: u64) -> Result<(), StorageError> {
        loop {
            let candidate: Option<(String, String, i64)> = {
                let connection = self
                    .connection
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let total: i64 = connection
                    .query_row(
                        "SELECT COALESCE(SUM(bytes), 0) FROM cache_files WHERE kind = ?1",
                        params![kind],
                        |row| row.get(0),
                    )
                    .map_err(|_| StorageError::Database)?;
                if total.max(0) as u64 <= limit {
                    return Ok(());
                }
                connection
                    .query_row(
                        "SELECT cache_key, relative_path, bytes FROM cache_files
                         WHERE kind = ?1 ORDER BY last_accessed_at_ms ASC LIMIT 1",
                        params![kind],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .optional()
                    .map_err(|_| StorageError::Database)?
            };
            let Some((cache_key, relative_path, _)) = candidate else {
                return Ok(());
            };
            if is_safe_relative_cache_path(&relative_path) {
                let _ = fs::remove_file(self.cache_root.join(relative_path));
            }
            self.connection
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .execute(
                    "DELETE FROM cache_files WHERE cache_key = ?1",
                    params![cache_key],
                )
                .map_err(|_| StorageError::Database)?;
        }
    }
}

#[async_trait::async_trait]
impl ProviderStorage for StorageService {
    fn get_json_value(
        &self,
        key: &str,
        allow_expired: bool,
    ) -> Result<Option<serde_json::Value>, ProviderStorageError> {
        StorageService::get_json(self, key, allow_expired).map_err(|_| ProviderStorageError)
    }

    fn put_json_value(
        &self,
        key: &str,
        kind: &str,
        value: serde_json::Value,
        ttl_ms: u64,
    ) -> Result<(), ProviderStorageError> {
        StorageService::put_json(self, key, kind, &value, ttl_ms).map_err(|_| ProviderStorageError)
    }

    fn delete_provider_cache_kind(&self, kind: &str) -> Result<u64, ProviderStorageError> {
        StorageService::delete_provider_cache_kind(self, kind).map_err(|_| ProviderStorageError)
    }

    fn apply_provider_cache_batch(
        &self,
        operations: &[ProviderCacheMutation],
    ) -> Result<(), ProviderStorageError> {
        StorageService::apply_provider_cache_batch(self, operations)
            .map_err(|_| ProviderStorageError)
    }

    fn get_setting(&self, key: &str) -> Result<Option<String>, ProviderStorageError> {
        StorageService::get_setting(self, key).map_err(|_| ProviderStorageError)
    }

    fn set_setting(&self, key: &str, value: &str) -> Result<(), ProviderStorageError> {
        StorageService::set_setting(self, key, value).map_err(|_| ProviderStorageError)
    }

    fn load_queue_value(&self) -> Result<Option<serde_json::Value>, ProviderStorageError> {
        StorageService::load_queue(self).map_err(|_| ProviderStorageError)
    }

    fn record_search(&self, provider: &str, query: &str) -> Result<(), ProviderStorageError> {
        StorageService::record_search(self, provider, query).map_err(|_| ProviderStorageError)
    }

    fn record_playback_snapshot_value(
        &self,
        provider: &str,
        track_id: &str,
        snapshot: serde_json::Value,
    ) -> Result<(), ProviderStorageError> {
        StorageService::record_playback_snapshot(self, provider, track_id, &snapshot)
            .map_err(|_| ProviderStorageError)
    }

    fn backfill_playback_history_snapshot_value(
        &self,
        provider: &str,
        track_id: &str,
        snapshot: serde_json::Value,
    ) -> Result<(), ProviderStorageError> {
        StorageService::backfill_playback_history_snapshot(self, provider, track_id, &snapshot)
            .map_err(|_| ProviderStorageError)
    }

    fn load_playback_history_values(
        &self,
        provider: &str,
        limit: u32,
    ) -> Result<Vec<(serde_json::Value, u64)>, ProviderStorageError> {
        StorageService::load_playback_history(self, provider, limit)
            .map_err(|_| ProviderStorageError)
    }

    async fn artwork_data_uri(
        &self,
        client: &Client,
        url: &str,
    ) -> Result<String, ProviderStorageError> {
        StorageService::artwork_data_uri(self, client, url)
            .await
            .map_err(|_| ProviderStorageError)
    }

    fn stats(&self) -> Result<CacheStats, ProviderStorageError> {
        StorageService::stats(self).map_err(|_| ProviderStorageError)
    }

    fn clear(&self) -> Result<CacheStats, ProviderStorageError> {
        StorageService::clear(self).map_err(|_| ProviderStorageError)
    }
}

fn migrate(connection: &Connection) -> Result<(), StorageError> {
    let version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|_| StorageError::Database)?;
    if version < 1 {
        connection
            .execute_batch(
                "BEGIN;
                 CREATE TABLE IF NOT EXISTS provider_cache (
                   cache_key TEXT PRIMARY KEY,
                   kind TEXT NOT NULL,
                   value_json TEXT NOT NULL,
                   expires_at_ms INTEGER,
                   updated_at_ms INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS cache_files (
                   cache_key TEXT PRIMARY KEY,
                   kind TEXT NOT NULL,
                   relative_path TEXT NOT NULL UNIQUE,
                   bytes INTEGER NOT NULL CHECK(bytes >= 0),
                   mime_type TEXT,
                   created_at_ms INTEGER NOT NULL,
                   last_accessed_at_ms INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS app_settings (
                   setting_key TEXT PRIMARY KEY,
                   value TEXT NOT NULL,
                   updated_at_ms INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS recent_searches (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   provider TEXT NOT NULL,
                   query TEXT NOT NULL,
                   searched_at_ms INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS playback_history (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   provider TEXT NOT NULL,
                   track_id TEXT NOT NULL,
                   played_at_ms INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS queue_state (
                   singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                   value_json TEXT NOT NULL,
                   updated_at_ms INTEGER NOT NULL
                 );
                 PRAGMA user_version = 1;
                 COMMIT;",
            )
            .map_err(|_| StorageError::Database)?;
    }
    if version < 2 {
        connection
            .execute_batch(
                "BEGIN;
                 CREATE INDEX IF NOT EXISTS provider_cache_kind_expiry
                   ON provider_cache(kind, expires_at_ms);
                 CREATE INDEX IF NOT EXISTS cache_files_kind_access
                   ON cache_files(kind, last_accessed_at_ms);
                 CREATE INDEX IF NOT EXISTS recent_searches_time
                   ON recent_searches(searched_at_ms DESC);
                 CREATE INDEX IF NOT EXISTS playback_history_time
                   ON playback_history(played_at_ms DESC);
                 PRAGMA user_version = 2;
                 COMMIT;",
            )
            .map_err(|_| StorageError::Database)?;
    }
    if version < 3 {
        connection
            .execute_batch(
                "BEGIN;
                 INSERT OR IGNORE INTO app_settings(setting_key, value, updated_at_ms)
                   VALUES ('preferences-schema-version', '1', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
                 PRAGMA user_version = 3;
                 COMMIT;",
            )
            .map_err(|_| StorageError::Database)?;
    }
    if version < 4 {
        connection
            .execute_batch(
                "BEGIN;
                 DELETE FROM app_settings
                   WHERE setting_key = 'lyrics-surface-geometry:taskbar';
                 INSERT INTO app_settings(setting_key, value, updated_at_ms)
                   VALUES ('preferences-schema-version', '2', CAST(strftime('%s', 'now') AS INTEGER) * 1000)
                   ON CONFLICT(setting_key) DO UPDATE SET
                     value = excluded.value,
                     updated_at_ms = excluded.updated_at_ms;
                 PRAGMA user_version = 4;
                 COMMIT;",
            )
            .map_err(|_| StorageError::Database)?;
    }
    if version < 5 {
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS playback_history (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   provider TEXT NOT NULL,
                   track_id TEXT NOT NULL,
                   played_at_ms INTEGER NOT NULL
                 );",
            )
            .map_err(|_| StorageError::Database)?;
        let has_value_json = connection
            .prepare("PRAGMA table_info(playback_history)")
            .and_then(|mut statement| {
                let columns = statement
                    .query_map([], |row| row.get::<_, String>(1))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(columns.iter().any(|column| column == "value_json"))
            })
            .map_err(|_| StorageError::Database)?;
        if !has_value_json {
            connection
                .execute_batch(
                    "BEGIN;
                     ALTER TABLE playback_history ADD COLUMN value_json TEXT;
                     CREATE INDEX IF NOT EXISTS playback_history_time
                       ON playback_history(played_at_ms DESC);
                     PRAGMA user_version = 5;
                     COMMIT;",
                )
                .map_err(|_| StorageError::Database)?;
        } else {
            connection
                .pragma_update(None, "user_version", 5)
                .map_err(|_| StorageError::Database)?;
        }
    }
    Ok(())
}

fn cache_limit(kind: &str) -> u64 {
    match kind {
        "artwork" => ARTWORK_CACHE_LIMIT,
        _ => MEDIA_CACHE_LIMIT,
    }
}

fn normalize_mime_type(value: &str) -> Option<String> {
    let value = value.split(';').next()?.trim().to_ascii_lowercase();
    let (top_level, subtype) = value.split_once('/')?;
    let valid_token = |token: &str| {
        !token.is_empty()
            && token.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || matches!(
                        byte,
                        b'!' | b'#' | b'$' | b'&' | b'^' | b'_' | b'.' | b'+' | b'-'
                    )
            })
    };
    (valid_token(top_level) && valid_token(subtype)).then_some(value)
}

fn mime_matches_prefix(mime_type: Option<&str>, required_prefix: Option<&str>) -> bool {
    required_prefix.is_none_or(|prefix| {
        mime_type.is_some_and(|mime_type| mime_type.starts_with(&prefix.to_ascii_lowercase()))
    })
}

fn sha256(input: &[u8]) -> String {
    let digest = Sha256::digest(input);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn is_safe_relative_cache_path(path: &str) -> bool {
    let path = Path::new(path);
    !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
}

fn cleanup_partial_files(cache_root: &Path) {
    for kind in ["media", "artwork"] {
        let directory = cache_root.join(kind);
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path
                .extension()
                .is_some_and(|extension| extension == "part")
            {
                let _ = fs::remove_file(path);
            }
        }
    }
}

fn unix_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn sqlite_i64(value: u64) -> i64 {
    value.min(i64::MAX as u64) as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::header::CONTENT_TYPE, response::Response, routing::get, Router};

    fn storage() -> (tempfile::TempDir, StorageService) {
        let root = tempfile::tempdir().expect("temp directory");
        let service = StorageService::open(root.path().join("data"), root.path().join("cache"))
            .expect("storage opens");
        (root, service)
    }

    #[test]
    fn migrations_and_provider_cache_round_trip() {
        let (_root, storage) = storage();
        let version: u32 = storage
            .connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("migration version");
        assert_eq!(version, 5);
        storage
            .put_json("qq:search:test", "metadata", &vec!["one", "two"], 60_000)
            .expect("cache write");
        let value: Vec<String> = storage
            .get_json("qq:search:test", false)
            .expect("cache read")
            .expect("cache hit");
        assert_eq!(value, vec!["one", "two"]);
        assert_eq!(storage.stats().expect("stats").metadata_entries, 1);
    }

    #[test]
    fn settings_persist_without_entering_provider_cache() {
        let (_root, storage) = storage();
        storage
            .set_setting("preferred-quality", "high")
            .expect("setting write");
        assert_eq!(
            storage.get_setting("preferred-quality").expect("read"),
            Some("high".to_owned())
        );
        assert_eq!(storage.stats().expect("stats").metadata_entries, 0);
    }

    #[test]
    fn account_cache_invalidation_preserves_guest_cache_settings_and_history() {
        let (_root, storage) = storage();
        storage
            .put_json("qqmusic:home", "metadata", &vec!["guest"], 60_000)
            .expect("guest cache write");
        storage
            .put_json(
                "qqmusic:account:opaque:favorites",
                "qqmusic-account",
                &vec!["private"],
                60_000,
            )
            .expect("account cache write");
        storage
            .set_setting("preferred-quality", "high")
            .expect("setting write");
        storage
            .record_playback_snapshot("qqmusic", "TRACK", &vec!["history"])
            .expect("history write");

        assert_eq!(
            storage
                .delete_provider_cache_kind("qqmusic-account")
                .expect("account cache delete"),
            1
        );
        assert!(storage
            .get_json::<Vec<String>>("qqmusic:home", true)
            .expect("guest cache read")
            .is_some());
        assert!(storage
            .get_json::<Vec<String>>("qqmusic:account:opaque:favorites", true)
            .expect("account cache read")
            .is_none());
        assert_eq!(
            storage
                .get_setting("preferred-quality")
                .expect("setting read")
                .as_deref(),
            Some("high")
        );
        let history_entries: i64 = storage
            .connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .query_row("SELECT COUNT(*) FROM playback_history", [], |row| {
                row.get(0)
            })
            .expect("history count");
        assert_eq!(history_entries, 1);
    }

    #[test]
    fn local_playback_history_keeps_latest_unique_song_snapshots() {
        #[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
        struct Track {
            id: String,
            title: String,
        }

        let (_root, storage) = storage();
        let first = Track {
            id: "one".to_owned(),
            title: "First".to_owned(),
        };
        let second = Track {
            id: "two".to_owned(),
            title: "Second".to_owned(),
        };
        let updated = Track {
            id: "one".to_owned(),
            title: "First updated".to_owned(),
        };
        storage
            .record_playback_snapshot("qqmusic", "one", &first)
            .expect("first record");
        storage
            .record_playback_snapshot("qqmusic", "two", &second)
            .expect("second record");
        storage
            .record_playback_snapshot("qqmusic", "one", &updated)
            .expect("updated record");

        let history = storage
            .load_playback_history::<Track>("qqmusic", 10)
            .expect("history loads");
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].0, updated);
        assert_eq!(history[1].0, second);
        assert!(history[0].1 >= history[1].1);
    }

    #[test]
    fn provider_cache_batch_rolls_back_every_operation_on_injected_fault() {
        let (_root, storage) = storage();
        storage
            .put_json(
                "qqmusic:account:before",
                "qqmusic-account",
                &vec!["before"],
                60_000,
            )
            .expect("baseline row");
        storage.fail_provider_cache_batch_after_for_test(1);
        let result = storage.apply_provider_cache_batch(&[
            ProviderCacheMutation::Delete {
                key: "qqmusic:account:before".to_owned(),
            },
            ProviderCacheMutation::Put {
                key: "qqmusic:account:after".to_owned(),
                kind: "qqmusic-account".to_owned(),
                value_json: "[\"after\"]".to_owned(),
                expires_at_ms: unix_timestamp_ms().saturating_add(60_000),
            },
        ]);

        assert!(matches!(result, Err(StorageError::Database)));
        assert!(storage
            .get_json::<Vec<String>>("qqmusic:account:before", false)
            .expect("baseline read")
            .is_some());
        assert!(storage
            .get_json::<Vec<String>>("qqmusic:account:after", false)
            .expect("new row read")
            .is_none());
    }

    #[test]
    fn provider_cache_batch_delete_prefix_is_literal_and_kind_scoped() {
        let (_root, storage) = storage();
        for (key, kind) in [
            ("qqmusic:account:a_%:one", "qqmusic-account"),
            ("qqmusic:account:a_other", "qqmusic-account"),
            ("qqmusic:account:a_%:guest", "metadata"),
        ] {
            storage
                .put_json(key, kind, &vec![key], 60_000)
                .expect("fixture row");
        }

        storage
            .apply_provider_cache_batch(&[ProviderCacheMutation::DeleteKindPrefix {
                kind: "qqmusic-account".to_owned(),
                prefix: "qqmusic:account:a_%:".to_owned(),
            }])
            .expect("literal prefix delete");

        assert!(storage
            .get_json::<Vec<String>>("qqmusic:account:a_%:one", true)
            .expect("deleted row")
            .is_none());
        assert!(storage
            .get_json::<Vec<String>>("qqmusic:account:a_other", true)
            .expect("similar row")
            .is_some());
        assert!(storage
            .get_json::<Vec<String>>("qqmusic:account:a_%:guest", true)
            .expect("other kind")
            .is_some());
    }

    #[test]
    fn v4_migration_removes_retired_taskbar_geometry() {
        let root = tempfile::tempdir().expect("temp directory");
        let data_root = root.path().join("data");
        let cache_root = root.path().join("cache");
        fs::create_dir_all(&data_root).expect("data directory");
        let database = data_root.join("library.sqlite3");
        let connection = Connection::open(&database).expect("legacy database");
        connection
            .execute_batch(
                "CREATE TABLE app_settings (
                   setting_key TEXT PRIMARY KEY,
                   value TEXT NOT NULL,
                   updated_at_ms INTEGER NOT NULL
                 );
                 INSERT INTO app_settings VALUES
                   ('lyrics-surface-geometry:taskbar', '{}', 1),
                   ('preferences-schema-version', '1', 1);
                 PRAGMA user_version = 3;",
            )
            .expect("legacy schema");
        drop(connection);

        let storage = StorageService::open(data_root, cache_root).expect("migration succeeds");
        assert_eq!(
            storage
                .get_setting("lyrics-surface-geometry:taskbar")
                .expect("geometry lookup"),
            None
        );
        assert_eq!(
            storage
                .get_setting("preferences-schema-version")
                .expect("schema lookup"),
            Some("2".to_owned())
        );
    }

    async fn start_artwork_server() -> (String, tokio::task::JoinHandle<()>) {
        let app = Router::new()
            .route(
                "/image",
                get(|| async {
                    Response::builder()
                        .status(StatusCode::OK)
                        .header(CONTENT_TYPE, "Image/PNG; charset=binary")
                        .body(Body::from(vec![0_u8, 1, 2, 3]))
                        .expect("image response")
                }),
            )
            .route(
                "/html",
                get(|| async {
                    Response::builder()
                        .status(StatusCode::OK)
                        .header(CONTENT_TYPE, "text/html")
                        .body(Body::from("not an image"))
                        .expect("HTML response")
                }),
            )
            .route(
                "/missing",
                get(|| async {
                    Response::builder()
                        .status(StatusCode::OK)
                        .body(Body::from(vec![0_u8, 1, 2, 3]))
                        .expect("response without Content-Type")
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("loopback listener");
        let address = listener.local_addr().expect("loopback address");
        let task = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("artwork test server");
        });
        (format!("http://{address}"), task)
    }

    #[tokio::test]
    async fn artwork_responses_require_an_explicit_image_content_type() {
        let (base_url, server) = start_artwork_server().await;
        let client = Client::builder().no_proxy().build().expect("HTTP client");

        for path in ["html", "missing"] {
            let (root, storage) = storage();
            let result = storage
                .artwork_data_uri(&client, &format!("{base_url}/{path}"))
                .await;
            assert!(matches!(result, Err(StorageError::InvalidContentType)));
            assert_eq!(storage.stats().expect("cache stats").artwork_entries, 0);
            assert!(!root.path().join("cache/artwork").exists());
        }

        let (_root, storage) = storage();
        let data_uri = storage
            .artwork_data_uri(&client, &format!("{base_url}/image"))
            .await
            .expect("valid image response is cached");
        assert_eq!(data_uri, "data:image/png;base64,AAECAw==");
        assert_eq!(storage.stats().expect("cache stats").artwork_entries, 1);
        server.abort();
    }

    #[tokio::test]
    async fn artwork_cache_hit_revalidates_mime_and_evicts_an_invalid_entry() {
        let (root, storage) = storage();
        let relative_path = "artwork/invalid.img";
        let cached_path = root.path().join("cache").join(relative_path);
        fs::create_dir_all(cached_path.parent().expect("cache directory"))
            .expect("cache directory");
        fs::write(&cached_path, b"not an image").expect("cached bytes");
        storage
            .record_file(
                "artwork:invalid",
                "artwork",
                relative_path,
                12,
                Some("text/html"),
            )
            .expect("cache row");
        let client = Client::builder().no_proxy().build().expect("HTTP client");

        let result = storage
            .fetch_cached(
                &client,
                "artwork",
                "artwork:invalid",
                "http://127.0.0.1:1/not-used",
                HeaderMap::new(),
                "img",
                SINGLE_ARTWORK_LIMIT,
                Some("image/"),
            )
            .await;

        assert!(matches!(result, Err(StorageError::InvalidContentType)));
        assert!(!cached_path.exists());
        assert!(storage
            .lookup_cached_file("artwork:invalid")
            .expect("cache lookup")
            .is_none());
    }
}
