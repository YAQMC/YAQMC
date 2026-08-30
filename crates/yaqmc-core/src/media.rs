use crate::{
    audio::{PreparedPlaybackLocation, PreparedPlaybackSource},
    storage::{CachedFile, StorageError, StorageService},
    streaming::{prepare_progressive, ProgressiveError, ProgressivePreparation},
};
#[cfg(any(test, feature = "test-support"))]
use crate::{playback_types::PlaybackSourceSelection, player::Song};
use async_trait::async_trait;
use reqwest::{header::HeaderMap, Client};
#[cfg(any(test, feature = "test-support"))]
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
pub use yaqmc_provider_api::media::{
    AudioFormat, EncryptedMedia, MediaDecryptor, OpaquePlaybackSource, PlaybackEpochClock,
    PlaybackEpochGuard, PlaybackLocation, PlaybackSourceError, PlaybackSourceResolver,
    ResolvedPlaybackSource,
};

const OPAQUE_MEDIA_CHUNK_BYTES: usize = 1024 * 1024;

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
            PlaybackLocation::Opaque(opaque) => {
                let cached = prepare_opaque_media(
                    opaque,
                    Arc::clone(&self.storage),
                    &source.cache_key,
                    source.format.extension(),
                    source.mime_type.as_deref(),
                    source.content_length,
                    source_limit,
                    &source.epoch_guard,
                )
                .await?;
                PreparedPlaybackLocation::Local(cached.path)
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
            PlaybackLocation::EncryptedHttp {
                url,
                headers,
                encryption,
            } => {
                let decryptor = encryption.create_decryptor().map_err(|error| {
                    tracing::warn!(
                        target: "media",
                        cache_key = %source.cache_key,
                        url = %url,
                        ekey_length = encryption.key_len(),
                        ekey_v2 = encryption.key_is_v2(),
                        error = %error,
                        "failed to construct the provider media decryptor"
                    );
                    error
                })?;
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
            load_generation: 0,
        })
    }
}

#[allow(clippy::too_many_arguments)]
async fn prepare_opaque_media(
    opaque: Arc<dyn OpaquePlaybackSource>,
    storage: Arc<StorageService>,
    cache_key: &str,
    extension: &str,
    mime_type: Option<&str>,
    advertised_length: Option<u64>,
    max_bytes: u64,
    guard: &PlaybackEpochGuard,
) -> Result<CachedFile, PlaybackSourceError> {
    if let Some(cached) = storage
        .lookup_cached_file(cache_key)
        .map_err(map_storage_error)?
    {
        return Ok(cached);
    }
    let content_length = opaque.content_length();
    if content_length == 0 {
        return Err(PlaybackSourceError::TrackUnavailable);
    }
    if content_length > max_bytes {
        return Err(PlaybackSourceError::ResponseTooLarge);
    }
    if advertised_length.is_some_and(|length| length != content_length) {
        return Err(PlaybackSourceError::RangeUnsupported);
    }

    let temporary = storage
        .progressive_temp_path(cache_key, extension)
        .map_err(map_storage_error)?;
    let result = async {
        let mut file = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .await
            .map_err(|_| PlaybackSourceError::CacheFailure)?;
        let mut offset = 0_u64;
        while offset < content_length {
            guard.validate()?;
            let requested =
                usize::try_from((content_length - offset).min(OPAQUE_MEDIA_CHUNK_BYTES as u64))
                    .map_err(|_| PlaybackSourceError::ResponseTooLarge)?;
            let cancellation = guard.cancellation_token();
            let bytes = tokio::select! {
                _ = cancellation.cancelled() => Err(PlaybackSourceError::Cancelled),
                result = opaque.read_range(offset, requested, cancellation.clone()) => result,
            }?;
            if bytes.len() != requested {
                return Err(PlaybackSourceError::RangeUnsupported);
            }
            file.write_all(&bytes)
                .await
                .map_err(|_| PlaybackSourceError::CacheFailure)?;
            offset = offset.saturating_add(bytes.len() as u64);
        }
        file.flush()
            .await
            .map_err(|_| PlaybackSourceError::CacheFailure)?;
        file.sync_data()
            .await
            .map_err(|_| PlaybackSourceError::CacheFailure)?;
        drop(file);
        guard.validate()?;
        storage
            .promote_progressive(cache_key, &temporary, extension, content_length, mime_type)
            .map_err(map_storage_error)
    }
    .await;
    let _ = tokio::fs::remove_file(&temporary).await;
    result
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

#[cfg(any(test, feature = "test-support"))]
pub struct PassthroughMediaPreparer;

#[cfg(any(test, feature = "test-support"))]
pub struct TestPlaybackSourceResolver;

#[cfg(any(test, feature = "test-support"))]
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
                requested_quality: crate::playback_types::AudioQualityPreference::Automatic,
                resolved_quality: song.quality,
                fallback_reason: None,
                preview: false,
                quality_capabilities: Vec::new(),
            },
            epoch_guard: PlaybackEpochGuard::unrestricted(),
        })
    }
}

#[cfg(any(test, feature = "test-support"))]
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
            load_generation: 0,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::playback_types::{
        AudioQuality, AudioQualityPreference, PlaybackEpoch, PlaybackSourceSelection,
    };
    use std::sync::Mutex;
    use tokio_util::sync::CancellationToken;

    struct MemoryOpaqueSource {
        bytes: Arc<Vec<u8>>,
        ranges: Mutex<Vec<(u64, usize)>>,
    }

    impl std::fmt::Debug for MemoryOpaqueSource {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter
                .debug_struct("MemoryOpaqueSource")
                .field("content_length", &self.bytes.len())
                .finish()
        }
    }

    #[async_trait]
    impl OpaquePlaybackSource for MemoryOpaqueSource {
        fn content_length(&self) -> u64 {
            self.bytes.len() as u64
        }

        async fn read_range(
            &self,
            offset: u64,
            length: usize,
            cancellation: CancellationToken,
        ) -> Result<Vec<u8>, PlaybackSourceError> {
            if cancellation.is_cancelled() {
                return Err(PlaybackSourceError::Cancelled);
            }
            let start =
                usize::try_from(offset).map_err(|_| PlaybackSourceError::RangeUnsupported)?;
            let end = start
                .checked_add(length)
                .filter(|end| *end <= self.bytes.len())
                .ok_or(PlaybackSourceError::RangeUnsupported)?;
            self.ranges
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push((offset, length));
            Ok(self.bytes[start..end].to_vec())
        }
    }

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
        let epoch = PlaybackEpoch::new(7, "test-account-7");
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
            PlaybackEpoch::new(1, "test-account-1"),
            CancellationToken::new(),
            clock.clone(),
        );
        clock.replace(Some(PlaybackEpoch::new(2, "test-account-2")));
        assert_eq!(guard.validate(), Err(PlaybackSourceError::Cancelled));
    }

    #[tokio::test]
    async fn opaque_sources_are_chunked_and_materialized_inside_core() {
        let root = tempfile::tempdir().expect("temp root");
        let storage = Arc::new(
            StorageService::open(root.path().join("data"), root.path().join("cache"))
                .expect("storage"),
        );
        let bytes = Arc::new(vec![0x5a; OPAQUE_MEDIA_CHUNK_BYTES + 17]);
        let opaque = Arc::new(MemoryOpaqueSource {
            bytes: Arc::clone(&bytes),
            ranges: Mutex::new(Vec::new()),
        });
        let source = ResolvedPlaybackSource {
            cache_key: "component:test-source".to_owned(),
            location: PlaybackLocation::Opaque(opaque.clone()),
            format: AudioFormat::Wav,
            mime_type: Some("audio/wav".to_owned()),
            quality_label: "component-test".to_owned(),
            bitrate_kbps: None,
            sample_rate_hz: None,
            bit_depth: None,
            content_length: Some(bytes.len() as u64),
            supports_range: true,
            expires_at_ms: None,
            timeline_offset_ms: 0,
            timeline_end_ms: None,
            is_preview: false,
            selection: PlaybackSourceSelection {
                requested_quality: AudioQualityPreference::Automatic,
                resolved_quality: AudioQuality::Standard,
                fallback_reason: None,
                preview: false,
                quality_capabilities: Vec::new(),
            },
            epoch_guard: PlaybackEpochGuard::unrestricted(),
        };
        let prepared = CachedMediaPreparer::new(reqwest::Client::new(), storage)
            .prepare(source)
            .await
            .expect("opaque source materializes");
        let PreparedPlaybackLocation::Local(path) = prepared.location else {
            panic!("opaque source must become a Core-local cache file")
        };
        assert_eq!(std::fs::read(path).expect("cached bytes"), *bytes);
        assert_eq!(
            opaque
                .ranges
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .as_slice(),
            &[
                (0, OPAQUE_MEDIA_CHUNK_BYTES),
                (OPAQUE_MEDIA_CHUNK_BYTES as u64, 17)
            ]
        );
        assert_eq!(
            format!("{opaque:?}"),
            format!("MemoryOpaqueSource {{ content_length: {} }}", bytes.len())
        );
    }
}
