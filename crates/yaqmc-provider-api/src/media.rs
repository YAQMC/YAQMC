//! Provider-to-player source resolution boundary.

use crate::{PlaybackEpoch, PlaybackSourceSelection, Song};
use async_trait::async_trait;
use std::{
    collections::BTreeMap,
    fmt, io,
    path::PathBuf,
    sync::{Arc, RwLock},
};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AudioFormat {
    Mp3,
    Aac,
    Flac,
    Wav,
}

impl AudioFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Mp3 => "mp3",
            Self::Aac => "m4a",
            Self::Flac => "flac",
            Self::Wav => "wav",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mp3 => "mp3",
            Self::Aac => "aac",
            Self::Flac => "flac",
            Self::Wav => "wav",
        }
    }
}

#[derive(Default)]
pub struct PlaybackEpochClock {
    current: RwLock<Option<PlaybackEpoch>>,
}

impl PlaybackEpochClock {
    #[doc(hidden)]
    pub fn replace(&self, epoch: Option<PlaybackEpoch>) {
        *self
            .current
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = epoch;
    }
}

#[derive(Clone)]
pub struct PlaybackEpochGuard {
    expected: Option<PlaybackEpoch>,
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

    #[doc(hidden)]
    pub fn account_bound(
        expected: PlaybackEpoch,
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

/// Seek-safe decryptor implemented by the provider-specific encrypted-media codec.
pub trait MediaDecryptor: Send + Sync + fmt::Debug {
    fn decrypt(&self, data: &mut [u8], offset: u64) -> io::Result<()>;
    fn cipher_kind(&self) -> &'static str;
    fn derived_key_length(&self) -> usize;
}

/// Opaque encrypted-media material. Core asks for a decryptor only during media
/// preparation, preserving the pre-extraction failure timing.
pub trait EncryptedMedia: Send + Sync + fmt::Debug {
    fn key_len(&self) -> usize;
    fn key_is_v2(&self) -> bool;
    fn create_decryptor(&self) -> Result<Arc<dyn MediaDecryptor>, PlaybackSourceError>;
}

/// Core-only byte source used by sandboxed provider components. Implementations
/// retain every URL, credential handle, and request header behind this object;
/// renderer-facing DTOs can therefore never serialize media authority.
#[async_trait]
pub trait OpaquePlaybackSource: Send + Sync + fmt::Debug {
    fn content_length(&self) -> u64;

    /// Read exactly the requested byte range unless cancellation or an error
    /// occurs. Callers bound `length`, so implementations never return an
    /// unbounded provider response.
    async fn read_range(
        &self,
        offset: u64,
        length: usize,
        cancellation: CancellationToken,
    ) -> Result<Vec<u8>, PlaybackSourceError>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProtectedHlsResponse {
    pub status: u16,
    pub body: Vec<u8>,
    pub content_range: Option<String>,
    pub content_length: Option<u64>,
    pub content_type: Option<String>,
}

#[derive(Clone)]
pub struct ProtectedHlsBrowserPlayer {
    pub html: Arc<[u8]>,
    /// Package-relative JavaScript assets, snapshotted for this playback session.
    pub scripts: BTreeMap<String, Arc<[u8]>>,
}

impl fmt::Debug for ProtectedHlsBrowserPlayer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProtectedHlsBrowserPlayer")
            .field("html_bytes", &self.html.len())
            .field("scripts", &self.scripts.keys())
            .finish()
    }
}

/// A DRM-protected HLS session whose manifests, media ranges, and licence
/// challenges remain behind provider-owned credential handles. Core uses this
/// boundary to expose only a loopback URL to a browser or native media stack.
#[async_trait]
pub trait ProtectedHlsSource: Send + Sync + fmt::Debug {
    fn manifest_url(&self) -> &str;

    /// Optional plugin-owned browser playback implementation. Native platforms
    /// can continue consuming the manifest and DRM requests directly.
    fn browser_player(&self) -> Option<&ProtectedHlsBrowserPlayer> {
        None
    }

    /// Whether the DRM service requires a Widevine application certificate
    /// before the first license challenge.
    fn requires_application_certificate(&self) -> bool {
        false
    }

    async fn fetch_manifest(
        &self,
        cancellation: CancellationToken,
    ) -> Result<ProtectedHlsResponse, PlaybackSourceError>;

    async fn fetch_media_range(
        &self,
        url: String,
        offset: u64,
        length: usize,
        cancellation: CancellationToken,
    ) -> Result<ProtectedHlsResponse, PlaybackSourceError>;

    async fn request_license(
        &self,
        challenge: Vec<u8>,
        cancellation: CancellationToken,
    ) -> Result<ProtectedHlsResponse, PlaybackSourceError>;

    /// Fetch the application certificate when the provider advertises one.
    /// Providers without certificate exchange keep the default `None` result.
    async fn fetch_application_certificate(
        &self,
        _cancellation: CancellationToken,
    ) -> Result<Option<ProtectedHlsResponse>, PlaybackSourceError> {
        Ok(None)
    }
}

#[derive(Clone, Debug)]
pub enum PlaybackLocation {
    Local(PathBuf),
    Opaque(Arc<dyn OpaquePlaybackSource>),
    ProtectedHls(Arc<dyn ProtectedHlsSource>),
    Http {
        url: String,
        headers: Vec<(String, String)>,
    },
    EncryptedHttp {
        url: String,
        headers: Vec<(String, String)>,
        encryption: Arc<dyn EncryptedMedia>,
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
    RangeUnsupported,
    #[error("the media response exceeded the configured cache limit")]
    ResponseTooLarge,
    #[error("this audio format is not supported")]
    DecoderUnsupported,
    #[error("the active account is not entitled to this track or quality")]
    EntitlementInsufficient,
    #[error("this track requires a music membership")]
    MembershipRequired,
    #[error("this track requires a separate purchase")]
    PurchaseRequired,
    #[error("this track is restricted by the platform's licensing")]
    CopyrightRestricted,
    #[error("the music plugin does not support this playback operation")]
    ProviderUnsupported,
    #[error("the music plugin is unavailable or not configured")]
    ProviderUnavailable,
    #[error("the music plugin failed to resolve a valid playback source")]
    ProviderFailure,
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

    /// Retry an automatic selection with a strictly lower quality after its
    /// refreshed media URL is still unavailable. Account rights remain enforced
    /// by the provider; providers without this recovery retain the original error.
    async fn resolve_unavailable_fallback(
        &self,
        _song: &Song,
        _failed: &PlaybackSourceSelection,
    ) -> Result<ResolvedPlaybackSource, PlaybackSourceError> {
        Err(PlaybackSourceError::UrlExpired)
    }

    async fn resolve_client_fallback(
        &self,
        _song: &Song,
        _failed: &PlaybackSourceSelection,
    ) -> Result<ResolvedPlaybackSource, PlaybackSourceError> {
        Err(PlaybackSourceError::DecoderUnsupported)
    }
}
