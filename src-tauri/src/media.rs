use crate::{
    audio::{AudioFormat, PreparedPlaybackLocation, PreparedPlaybackSource},
    player::Song,
    qmc::{EncryptedMediaKey, QmcDecryptor, QmcError},
    qqmusic::{AccountEpoch, PlaybackSourceSelection},
    storage::{StorageError, StorageService},
    streaming::{prepare_progressive, ProgressiveError, ProgressivePreparation},
};
use async_trait::async_trait;
use reqwest::{header::HeaderMap, Client};
use std::{
    fmt,
    path::PathBuf,
    sync::{Arc, RwLock as StdRwLock},
};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct PlaybackEpochClock {
    current: StdRwLock<Option<AccountEpoch>>,
}

impl PlaybackEpochClock {
    pub(crate) fn replace(&self, epoch: Option<AccountEpoch>) {
        *self
            .current
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = epoch;
    }
}

#[derive(Clone)]
pub struct PlaybackEpochGuard {
    expected: Option<AccountEpoch>,
    cancellation: CancellationToken,
    clock: Arc<PlaybackEpochClock>,
    identity: Arc<()>,
}

impl PlaybackEpochGuard {
    pub fn unrestricted() -> Self {
        Self {
            expected: None,
            cancellation: CancellationToken::new(),
            clock: Arc::new(PlaybackEpochClock::default()),
            identity: Arc::new(()),
        }
    }

    pub(crate) fn account_bound(
        expected: AccountEpoch,
        cancellation: CancellationToken,
        clock: Arc<PlaybackEpochClock>,
    ) -> Self {
        Self {
            expected: Some(expected),
            cancellation,
            clock,
            identity: Arc::new(()),
        }
    }

    pub fn is_account_bound(&self) -> bool {
        self.expected.is_some()
    }

    pub fn cancellation_token(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    pub fn same_instance(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.identity, &other.identity)
    }

    pub fn validate(&self) -> Result<(), PlaybackSourceError> {
        self.validate_and_run(|| ())
    }

    pub fn validate_and_run<T>(
        &self,
        operation: impl FnOnce() -> T,
    ) -> Result<T, PlaybackSourceError> {
        if self.cancellation.is_cancelled() {
            return Err(PlaybackSourceError::Cancelled);
        }
        let current = self
            .clock
            .current
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self
            .expected
            .as_ref()
            .is_some_and(|expected| current.as_ref() != Some(expected))
        {
            return Err(PlaybackSourceError::Cancelled);
        }
        let result = operation();
        if self.cancellation.is_cancelled() {
            return Err(PlaybackSourceError::Cancelled);
        }
        Ok(result)
    }
}

impl fmt::Debug for PlaybackEpochGuard {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PlaybackEpochGuard")
            .field("account_bound", &self.is_account_bound())
            .finish()
    }
}

#[derive(Clone, Debug)]
pub enum PlaybackLocation {
    Local(PathBuf),
    Http {
        url: String,
        headers: Vec<(String, String)>,
    },
    EncryptedHttp {
        url: String,
        headers: Vec<(String, String)>,
        ekey: EncryptedMediaKey,
    },
}

#[derive(Clone, Debug)]
pub struct ResolvedPlaybackSource {
    pub cache_key: String,
    pub location: PlaybackLocation,
    pub format: AudioFormat,
    pub mime_type: Option<String>,
    pub quality_label: String,
    pub bitrate_kbps: Option<u32>,
    pub sample_rate_hz: Option<u32>,
    pub bit_depth: Option<u16>,
    pub content_length: Option<u64>,
    pub supports_range: bool,
    pub expires_at_ms: Option<u64>,
    pub timeline_offset_ms: u64,
    pub timeline_end_ms: Option<u64>,
    pub is_preview: bool,
    pub selection: PlaybackSourceSelection,
    pub epoch_guard: PlaybackEpochGuard,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum PlaybackSourceError {
    #[error("no playable media URL is available for this track")]
    UrlUnavailable,
    #[error("the provider media URL expired")]
    UrlExpired,
    #[error("the network request failed")]
    Network,
    #[error("the server does not support the required media request")]
    #[allow(dead_code)]
    // Used by the future progressive Range reader; full-file cache is current.
    RangeUnsupported,
    #[error("the media response exceeded the configured cache limit")]
    ResponseTooLarge,
    #[error("this audio format is not supported")]
    #[allow(dead_code)] // Resolver currently emits only formats enabled in Rodio.
    DecoderUnsupported,
    #[error("the active account is not entitled to this track or quality")]
    EntitlementInsufficient,
    #[error("the active account entitlement could not be confirmed")]
    EntitlementUnknown,
    #[error("the provider session expired")]
    AuthenticationExpired,
    #[error("the track is unavailable")]
    TrackUnavailable,
    #[error("the account-bound playback source was cancelled")]
    Cancelled,
    #[error("the local media cache failed")]
    CacheFailure,
    #[error("the encrypted media could not be decrypted")]
    DecryptionFailed,
}

#[async_trait]
pub trait PlaybackSourceResolver: Send + Sync {
    async fn resolve(&self, song: &Song) -> Result<ResolvedPlaybackSource, PlaybackSourceError>;

    async fn resolve_client_fallback(
        &self,
        _song: &Song,
        _failed: &PlaybackSourceSelection,
    ) -> Result<ResolvedPlaybackSource, PlaybackSourceError> {
        Err(PlaybackSourceError::DecoderUnsupported)
    }
}

#[async_trait]
pub trait MediaPreparer: Send + Sync {
    async fn prepare(
        &self,
        source: ResolvedPlaybackSource,
    ) -> Result<PreparedPlaybackSource, PlaybackSourceError>;
}

pub struct CachedMediaPreparer {
    client: Client,
    storage: Arc<StorageService>,
}

impl CachedMediaPreparer {
    pub fn new(client: Client, storage: Arc<StorageService>) -> Self {
        Self { client, storage }
    }
}

#[async_trait]
impl MediaPreparer for CachedMediaPreparer {
    async fn prepare(
        &self,
        source: ResolvedPlaybackSource,
    ) -> Result<PreparedPlaybackSource, PlaybackSourceError> {
        source.epoch_guard.validate()?;
        let source_limit = if matches!(&source.location, PlaybackLocation::EncryptedHttp { .. }) {
            self.storage.encrypted_media_limit()
        } else {
            self.storage.single_media_limit()
        };
        if source
            .content_length
            .is_some_and(|bytes| bytes > source_limit)
        {
            return Err(PlaybackSourceError::ResponseTooLarge);
        }
        tracing::debug!(
            target: "media",
            quality = %source.quality_label,
            bitrate_kbps = source.bitrate_kbps,
            sample_rate_hz = source.sample_rate_hz,
            bit_depth = source.bit_depth,
            mime_type = source.mime_type.as_deref(),
            seekable = source.supports_range,
            expires_at_ms = source.expires_at_ms,
            "preparing playback source"
        );
        let location = match source.location {
            PlaybackLocation::Local(path) => {
                if !source.epoch_guard.validate_and_run(|| path.is_file())? {
                    return Err(PlaybackSourceError::TrackUnavailable);
                }
                PreparedPlaybackLocation::Local(path)
            }
            PlaybackLocation::Http { url, headers } => {
                let mut request_headers = HeaderMap::new();
                for (name, value) in headers {
                    let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
                        .map_err(|_| PlaybackSourceError::Network)?;
                    let value = reqwest::header::HeaderValue::from_str(&value)
                        .map_err(|_| PlaybackSourceError::Network)?;
                    request_headers.insert(name, value);
                }
                if source.supports_range {
                    let cancellation = source.epoch_guard.cancellation_token();
                    let preparation = tokio::select! {
                        _ = cancellation.cancelled() => Err(PlaybackSourceError::Cancelled),
                        result = prepare_progressive(
                            &self.client,
                            Arc::clone(&self.storage),
                            source.cache_key.clone(),
                            url.clone(),
                            request_headers.clone(),
                            source.format.extension().to_owned(),
                            source.mime_type.clone(),
                            self.storage.single_media_limit(),
                        ) => result.map_err(map_progressive_error),
                    }?;
                    source.epoch_guard.validate()?;
                    match preparation {
                        ProgressivePreparation::Complete(cached) => {
                            tracing::debug!(
                                target: "media",
                                bytes = cached.bytes,
                                "complete media cache hit"
                            );
                            PreparedPlaybackLocation::Local(cached.path)
                        }
                        ProgressivePreparation::Progressive(progressive) => {
                            tracing::info!(
                                target: "media",
                                bytes = progressive.content_length(),
                                "progressive Range source ready"
                            );
                            PreparedPlaybackLocation::Progressive(progressive)
                        }
                        ProgressivePreparation::FullDownloadFallback => {
                            let cancellation = source.epoch_guard.cancellation_token();
                            let cached = tokio::select! {
                                _ = cancellation.cancelled() => Err(PlaybackSourceError::Cancelled),
                                result = self.storage.fetch_cached(
                                    &self.client,
                                    "media",
                                    &source.cache_key,
                                    &url,
                                    request_headers,
                                    source.format.extension(),
                                    self.storage.single_media_limit(),
                                    None,
                                ) => result.map_err(map_storage_error),
                            }?;
                            source.epoch_guard.validate()?;
                            PreparedPlaybackLocation::Local(cached.path)
                        }
                    }
                } else {
                    let cancellation = source.epoch_guard.cancellation_token();
                    let cached = tokio::select! {
                        _ = cancellation.cancelled() => Err(PlaybackSourceError::Cancelled),
                        result = self.storage.fetch_cached(
                            &self.client,
                            "media",
                            &source.cache_key,
                            &url,
                            request_headers,
                            source.format.extension(),
                            self.storage.single_media_limit(),
                            None,
                        ) => result.map_err(map_storage_error),
                    }?;
                    source.epoch_guard.validate()?;
                    PreparedPlaybackLocation::Local(cached.path)
                }
            }
            PlaybackLocation::EncryptedHttp { url, headers, ekey } => {
                let decryptor = QmcDecryptor::new(&ekey).map_err(map_qmc_error)?;
                let encrypted_key = format!("{}:encrypted", source.cache_key);
                let encrypted_limit = self.storage.encrypted_media_limit();
                if let Some(cached) = self
                    .storage
                    .lookup_cached_file(&encrypted_key)
                    .map_err(map_storage_error)?
                {
                    PreparedPlaybackLocation::EncryptedLocal {
                        path: cached.path,
                        content_length: cached.bytes,
                        decryptor,
                    }
                } else if source.supports_range {
                    let request_headers = parse_headers(headers)?;
                    let cancellation = source.epoch_guard.cancellation_token();
                    let preparation = tokio::select! {
                        _ = cancellation.cancelled() => Err(PlaybackSourceError::Cancelled),
                        result = prepare_progressive(
                            &self.client,
                            Arc::clone(&self.storage),
                            encrypted_key.clone(),
                            url.clone(),
                            request_headers.clone(),
                            "mflac".to_owned(),
                            None,
                            encrypted_limit,
                        ) => result.map_err(map_progressive_error),
                    }?;
                    source.epoch_guard.validate()?;
                    match preparation {
                        ProgressivePreparation::Complete(cached) => {
                            PreparedPlaybackLocation::EncryptedLocal {
                                path: cached.path,
                                content_length: cached.bytes,
                                decryptor,
                            }
                        }
                        ProgressivePreparation::Progressive(progressive) => {
                            PreparedPlaybackLocation::EncryptedProgressive {
                                source: progressive,
                                decryptor,
                            }
                        }
                        ProgressivePreparation::FullDownloadFallback => {
                            let cancellation = source.epoch_guard.cancellation_token();
                            let encrypted = tokio::select! {
                                _ = cancellation.cancelled() => Err(PlaybackSourceError::Cancelled),
                                result = self.storage.fetch_cached(
                                    &self.client,
                                    "media",
                                    &encrypted_key,
                                    &url,
                                    request_headers,
                                    "mflac",
                                    encrypted_limit,
                                    None,
                                ) => result.map_err(map_storage_error),
                            }?;
                            source.epoch_guard.validate()?;
                            PreparedPlaybackLocation::EncryptedLocal {
                                path: encrypted.path,
                                content_length: encrypted.bytes,
                                decryptor,
                            }
                        }
                    }
                } else {
                    let request_headers = parse_headers(headers)?;
                    let cancellation = source.epoch_guard.cancellation_token();
                    let encrypted = tokio::select! {
                        _ = cancellation.cancelled() => Err(PlaybackSourceError::Cancelled),
                        result = self.storage.fetch_cached(
                            &self.client,
                            "media",
                            &encrypted_key,
                            &url,
                            request_headers,
                            "mflac",
                            encrypted_limit,
                            None,
                        ) => result.map_err(map_storage_error),
                    }?;
                    source.epoch_guard.validate()?;
                    PreparedPlaybackLocation::EncryptedLocal {
                        path: encrypted.path,
                        content_length: encrypted.bytes,
                        decryptor,
                    }
                }
            }
        };

        source.epoch_guard.validate()?;
        Ok(PreparedPlaybackSource {
            location,
            format: source.format,
            timeline_offset_ms: source.timeline_offset_ms,
            timeline_end_ms: source.timeline_end_ms,
            is_preview: source.is_preview,
            cache_key: source.cache_key,
            selection: source.selection,
            epoch_guard: source.epoch_guard,
        })
    }
}

fn parse_headers(headers: Vec<(String, String)>) -> Result<HeaderMap, PlaybackSourceError> {
    let mut parsed = HeaderMap::new();
    for (name, value) in headers {
        let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| PlaybackSourceError::Network)?;
        let value = reqwest::header::HeaderValue::from_str(&value)
            .map_err(|_| PlaybackSourceError::Network)?;
        parsed.insert(name, value);
    }
    Ok(parsed)
}

fn map_qmc_error(error: QmcError) -> PlaybackSourceError {
    match error {
        QmcError::InvalidKey => PlaybackSourceError::DecryptionFailed,
    }
}

fn map_progressive_error(error: ProgressiveError) -> PlaybackSourceError {
    match error {
        ProgressiveError::Network => PlaybackSourceError::Network,
        ProgressiveError::UrlExpired => PlaybackSourceError::UrlExpired,
        ProgressiveError::InvalidRange | ProgressiveError::RangeUnsupported => {
            PlaybackSourceError::RangeUnsupported
        }
        ProgressiveError::ResponseTooLarge => PlaybackSourceError::ResponseTooLarge,
        ProgressiveError::Cache => PlaybackSourceError::CacheFailure,
    }
}

fn map_storage_error(error: StorageError) -> PlaybackSourceError {
    match error {
        StorageError::UrlExpired => PlaybackSourceError::UrlExpired,
        StorageError::Network | StorageError::Http(_) => PlaybackSourceError::Network,
        StorageError::ResponseTooLarge => PlaybackSourceError::ResponseTooLarge,
        StorageError::Initialize
        | StorageError::Database
        | StorageError::File
        | StorageError::InvalidContentType => PlaybackSourceError::CacheFailure,
    }
}

#[cfg(test)]
pub struct PassthroughMediaPreparer;

#[cfg(test)]
pub struct TestPlaybackSourceResolver;

#[cfg(test)]
#[async_trait]
impl PlaybackSourceResolver for TestPlaybackSourceResolver {
    async fn resolve(&self, song: &Song) -> Result<ResolvedPlaybackSource, PlaybackSourceError> {
        Ok(ResolvedPlaybackSource {
            cache_key: format!("test:{}", song.id),
            location: PlaybackLocation::Local(PathBuf::from("deterministic-test.wav")),
            format: AudioFormat::Wav,
            mime_type: Some("audio/wav".to_owned()),
            quality_label: "test".to_owned(),
            bitrate_kbps: Some(256),
            sample_rate_hz: Some(16_000),
            bit_depth: Some(16),
            content_length: None,
            supports_range: true,
            expires_at_ms: None,
            timeline_offset_ms: 0,
            timeline_end_ms: Some(song.duration_ms),
            is_preview: false,
            selection: PlaybackSourceSelection {
                requested_quality: crate::qqmusic::AudioQualityPreference::Automatic,
                resolved_quality: song.quality,
                fallback_reason: None,
                preview: false,
                quality_capabilities: Vec::new(),
            },
            epoch_guard: PlaybackEpochGuard::unrestricted(),
        })
    }
}

#[cfg(test)]
#[async_trait]
impl MediaPreparer for PassthroughMediaPreparer {
    async fn prepare(
        &self,
        source: ResolvedPlaybackSource,
    ) -> Result<PreparedPlaybackSource, PlaybackSourceError> {
        source.epoch_guard.validate()?;
        let PlaybackLocation::Local(path) = source.location else {
            return Err(PlaybackSourceError::Network);
        };
        Ok(PreparedPlaybackSource {
            location: PreparedPlaybackLocation::Local(path),
            format: source.format,
            timeline_offset_ms: source.timeline_offset_ms,
            timeline_end_ms: source.timeline_end_ms,
            is_preview: source.is_preview,
            cache_key: source.cache_key,
            selection: source.selection,
            epoch_guard: source.epoch_guard,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_util::sync::CancellationToken;

    #[test]
    fn invalid_content_type_maps_to_cache_failure() {
        assert_eq!(
            map_storage_error(StorageError::InvalidContentType),
            PlaybackSourceError::CacheFailure
        );
    }

    #[test]
    fn account_bound_guard_is_atomic_and_debug_output_is_sanitized() {
        let clock = Arc::new(PlaybackEpochClock::default());
        let epoch = AccountEpoch::for_test(7);
        clock.replace(Some(epoch.clone()));
        let cancellation = CancellationToken::new();
        let guard = PlaybackEpochGuard::account_bound(epoch, cancellation.clone(), clock.clone());

        assert_eq!(guard.validate_and_run(|| 42), Ok(42));
        let debug = format!("{guard:?}");
        assert_eq!(debug, "PlaybackEpochGuard { account_bound: true }");
        assert!(!debug.contains("000000"));

        cancellation.cancel();
        assert_eq!(guard.validate(), Err(PlaybackSourceError::Cancelled));
        assert_eq!(
            guard.validate_and_run(|| panic!("stale closure must not run")),
            Err(PlaybackSourceError::Cancelled)
        );
    }

    #[test]
    fn epoch_mismatch_rejects_even_without_token_delivery() {
        let clock = Arc::new(PlaybackEpochClock::default());
        let guard = PlaybackEpochGuard::account_bound(
            AccountEpoch::for_test(1),
            CancellationToken::new(),
            clock.clone(),
        );
        clock.replace(Some(AccountEpoch::for_test(2)));
        assert_eq!(guard.validate(), Err(PlaybackSourceError::Cancelled));
    }
}
