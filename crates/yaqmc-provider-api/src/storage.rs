//! Narrow provider-facing view of Core-owned SQLite and cache services.

use async_trait::async_trait;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use thiserror::Error;

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub total_bytes: u64,
    pub media_bytes: u64,
    pub artwork_bytes: u64,
    pub media_entries: u64,
    pub artwork_entries: u64,
    pub metadata_entries: u64,
    pub lyric_entries: u64,
    pub media_limit_bytes: u64,
    pub artwork_limit_bytes: u64,
}

#[derive(Clone)]
#[doc(hidden)]
pub enum ProviderCacheMutation {
    Put {
        key: String,
        kind: String,
        value_json: String,
        expires_at_ms: u64,
    },
    Delete {
        key: String,
    },
    DeleteKindPrefix {
        kind: String,
        prefix: String,
    },
}

#[derive(Clone, Copy, Debug, Error)]
#[error("the provider storage operation failed")]
pub struct ProviderStorageError;

#[async_trait]
pub trait ProviderStorage: Send + Sync {
    fn get_json_value(
        &self,
        key: &str,
        allow_expired: bool,
    ) -> Result<Option<Value>, ProviderStorageError>;

    fn put_json_value(
        &self,
        key: &str,
        kind: &str,
        value: Value,
        ttl_ms: u64,
    ) -> Result<(), ProviderStorageError>;

    fn delete_provider_cache_kind(&self, kind: &str) -> Result<u64, ProviderStorageError>;

    fn apply_provider_cache_batch(
        &self,
        operations: &[ProviderCacheMutation],
    ) -> Result<(), ProviderStorageError>;

    fn get_setting(&self, key: &str) -> Result<Option<String>, ProviderStorageError>;
    fn set_setting(&self, key: &str, value: &str) -> Result<(), ProviderStorageError>;

    fn load_queue_value(&self) -> Result<Option<Value>, ProviderStorageError>;

    fn record_search(&self, provider: &str, query: &str) -> Result<(), ProviderStorageError>;

    fn record_playback_snapshot_value(
        &self,
        provider: &str,
        track_id: &str,
        snapshot: Value,
    ) -> Result<(), ProviderStorageError>;

    fn backfill_playback_history_snapshot_value(
        &self,
        provider: &str,
        track_id: &str,
        snapshot: Value,
    ) -> Result<(), ProviderStorageError>;

    fn load_playback_history_values(
        &self,
        provider: &str,
        limit: u32,
    ) -> Result<Vec<(Value, u64)>, ProviderStorageError>;

    async fn artwork_data_uri(
        &self,
        client: &reqwest::Client,
        url: &str,
    ) -> Result<String, ProviderStorageError>;

    fn stats(&self) -> Result<CacheStats, ProviderStorageError>;
    fn clear(&self) -> Result<CacheStats, ProviderStorageError>;
}

/// Typed convenience methods stay outside the object-safe storage vtable.
pub trait ProviderStorageExt: ProviderStorage {
    fn get_json<T: DeserializeOwned>(
        &self,
        key: &str,
        allow_expired: bool,
    ) -> Result<Option<T>, ProviderStorageError> {
        self.get_json_value(key, allow_expired)?
            .map(serde_json::from_value)
            .transpose()
            .map_err(|_| ProviderStorageError)
    }

    fn put_json<T: Serialize + ?Sized>(
        &self,
        key: &str,
        kind: &str,
        value: &T,
        ttl_ms: u64,
    ) -> Result<(), ProviderStorageError> {
        let value = serde_json::to_value(value).map_err(|_| ProviderStorageError)?;
        self.put_json_value(key, kind, value, ttl_ms)
    }

    fn load_queue<T: DeserializeOwned>(&self) -> Result<Option<T>, ProviderStorageError> {
        self.load_queue_value()?
            .map(serde_json::from_value)
            .transpose()
            .map_err(|_| ProviderStorageError)
    }

    fn record_playback_snapshot<T: Serialize + ?Sized>(
        &self,
        provider: &str,
        track_id: &str,
        snapshot: &T,
    ) -> Result<(), ProviderStorageError> {
        let snapshot = serde_json::to_value(snapshot).map_err(|_| ProviderStorageError)?;
        self.record_playback_snapshot_value(provider, track_id, snapshot)
    }

    fn backfill_playback_history_snapshot<T: Serialize + ?Sized>(
        &self,
        provider: &str,
        track_id: &str,
        snapshot: &T,
    ) -> Result<(), ProviderStorageError> {
        let snapshot = serde_json::to_value(snapshot).map_err(|_| ProviderStorageError)?;
        self.backfill_playback_history_snapshot_value(provider, track_id, snapshot)
    }

    fn load_playback_history<T: DeserializeOwned>(
        &self,
        provider: &str,
        limit: u32,
    ) -> Result<Vec<(T, u64)>, ProviderStorageError> {
        self.load_playback_history_values(provider, limit)?
            .into_iter()
            .map(|(value, timestamp)| {
                serde_json::from_value(value)
                    .map(|value| (value, timestamp))
                    .map_err(|_| ProviderStorageError)
            })
            .collect()
    }
}

impl<T: ProviderStorage + ?Sized> ProviderStorageExt for T {}
