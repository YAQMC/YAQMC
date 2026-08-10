use crate::{
    audio::{AudioFormat, PreparedPlaybackLocation, PreparedPlaybackSource},
    player::Song,
    storage::{StorageError, StorageService},
    streaming::{prepare_progressive, ProgressiveError, ProgressivePreparation},
};
use async_trait::async_trait;
use reqwest::{header::HeaderMap, Client};
use std::{path::PathBuf, sync::Arc};
use thiserror::Error;

#[derive(Clone, Debug)]
pub enum PlaybackLocation {
    Local(PathBuf),
    Http {
        url: String,
        headers: Vec<(String, String)>,
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
    #[error("the provider session expired")]
    AuthenticationExpired,
    #[error("the track is unavailable")]
    TrackUnavailable,
    #[error("the local media cache failed")]
    CacheFailure,
}

#[async_trait]
pub trait PlaybackSourceResolver: Send + Sync {
    async fn resolve(&self, song: &Song) -> Result<ResolvedPlaybackSource, PlaybackSourceError>;
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
        if source
            .content_length
            .is_some_and(|bytes| bytes > self.storage.single_media_limit())
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
                if !path.is_file() {
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
                    match prepare_progressive(
                        &self.client,
                        Arc::clone(&self.storage),
                        source.cache_key.clone(),
                        url.clone(),
                        request_headers.clone(),
                        source.format.extension().to_owned(),
                        source.mime_type.clone(),
                        self.storage.single_media_limit(),
                    )
                    .await
                    .map_err(map_progressive_error)?
                    {
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
                            let cached = self
                                .storage
                                .fetch_cached(
                                    &self.client,
                                    "media",
                                    &source.cache_key,
                                    &url,
                                    request_headers,
                                    source.format.extension(),
                                    self.storage.single_media_limit(),
                                )
                                .await
                                .map_err(map_storage_error)?;
                            PreparedPlaybackLocation::Local(cached.path)
                        }
                    }
                } else {
                    let cached = self
                        .storage
                        .fetch_cached(
                            &self.client,
                            "media",
                            &source.cache_key,
                            &url,
                            request_headers,
                            source.format.extension(),
                            self.storage.single_media_limit(),
                        )
                        .await
                        .map_err(map_storage_error)?;
                    PreparedPlaybackLocation::Local(cached.path)
                }
            }
        };

        Ok(PreparedPlaybackSource {
            location,
            format: source.format,
            timeline_offset_ms: source.timeline_offset_ms,
            timeline_end_ms: source.timeline_end_ms,
            is_preview: source.is_preview,
            cache_key: source.cache_key,
        })
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
        StorageError::Initialize | StorageError::Database | StorageError::File => {
            PlaybackSourceError::CacheFailure
        }
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
        })
    }
}
