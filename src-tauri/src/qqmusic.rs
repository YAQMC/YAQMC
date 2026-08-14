use crate::{
    audio::{write_fixture_wav, AudioFormat},
    credentials::{CredentialStore, SpawnBlockingCredentialStore},
    media::{
        PlaybackEpochGuard, PlaybackLocation, PlaybackSourceError, PlaybackSourceResolver,
        ResolvedPlaybackSource,
    },
    player::{
        AlbumSummary, ArtistSummary, Artwork, AudioCodec, AudioFormatInfo, AudioQuality,
        LyricDocument, LyricLine, LyricMetadata, LyricSyncMode, LyricWord, PlaybackCapability,
        ProviderTrackReference, Song, SongAvailability,
    },
    qmc::EncryptedMediaKey,
    storage::{CacheStats, StorageService},
};
use async_trait::async_trait;
use base64::Engine as _;
use lyrics_crypto::decrypter::qrc::decrypter::decrypt_lyrics as decrypt_qrc;
use md5::{Digest as Md5Digest, Md5};
use quick_xml::{escape::unescape, events::Event, Reader};
use reqwest::{
    header::{self, HeaderMap, HeaderValue},
    Client, Method, RequestBuilder, StatusCode, Url,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use thiserror::Error;
use tokio::sync::{Mutex as AsyncMutex, RwLock};

pub(crate) mod account;
mod artwork;
mod auth;
mod cache;
mod clock;
mod entitlement;
pub(crate) mod oauth;
mod redaction;
mod transport;

pub(crate) use cache::AccountEpoch;
pub use entitlement::{AudioQualityPreference, PlaybackFallbackReason, PlaybackSourceSelection};

use artwork::{artwork_for_album, artwork_from_provider_url, is_allowed_artwork_url};

use account::{
    AccountEntitlement, AccountPlaylistDetail, AccountPlaylistSummary, AccountSnapshot,
    CollectPlaylistRequest, CreatePlaylistRequest, DeletePlaylistRequest, EntitlementTier,
    FavoriteMutationRequest, FavoriteMutationResult, MembershipState, Page, PlaylistMutationResult,
    PlaylistTrackMutationRequest, ProviderErrorCode, QQMusicAccountService, RemotePlayHistoryItem,
    RemotePlayHistorySource, RenamePlaylistRequest,
};
use auth::{QQMusicAuthService, SessionRecord, TransportQQMusicAuthProtocol};
use clock::{Clock, SystemClock};
use entitlement::{
    candidates_for_request, choose_source, ClientCapabilityState, PreviewRange, SourceCandidate,
    VkeyAvailability,
};
use transport::{QqTransport, RedirectMode, ReqwestQqTransport, RetryClass, TransportRequest};
use zeroize::Zeroize;

pub(crate) use oauth::OAuthLoginProvider;

const QQ_MUSICU_URL: &str = "https://u.y.qq.com/cgi-bin/musicu.fcg";
const QQ_MUSICS_URL: &str = "https://u.y.qq.com/cgi-bin/musics.fcg";
const QQ_EVKEY_MODULE_KEY: &str = "music.vkey.GetEVkey.CgiGetEVkey";
const QQ_SEARCH_URL: &str = "https://c.y.qq.com/soso/fcgi-bin/client_search_cp";
const QQ_ALBUM_URL: &str = "https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg";
const QQ_PLAYLIST_URL: &str = "https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg";
const QQ_LRC_URL: &str = "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg";
const DEFAULT_TOPLIST_ID: u64 = 62;
const METADATA_TTL_MS: u64 = 15 * 60 * 1_000;
const ENTITY_TTL_MS: u64 = 24 * 60 * 60 * 1_000;
const LYRIC_TTL_MS: u64 = 30 * 24 * 60 * 60 * 1_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Album {
    pub id: String,
    pub title: String,
    pub artist: ArtistSummary,
    pub artwork: Artwork,
    pub release_year: u32,
    pub genre: String,
    pub description: String,
    pub tracks: Vec<Song>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistOwner {
    pub id: String,
    pub display_name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: String,
    pub title: String,
    pub description: String,
    pub owner: PlaylistOwner,
    pub artwork: Artwork,
    pub updated_label: String,
    pub tracks: Vec<Song>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", content = "item", rename_all = "kebab-case")]
pub enum MediaCollection {
    Album(Album),
    Playlist(Playlist),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FeaturedRelease {
    pub eyebrow: String,
    pub album: Album,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeFeed {
    pub featured: FeaturedRelease,
    pub recently_played: Vec<MediaCollection>,
    pub made_for_you: Vec<Playlist>,
    pub new_releases: Vec<Album>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySnapshot {
    pub favorite_songs: Vec<Song>,
    pub saved_albums: Vec<Album>,
    pub saved_playlists: Vec<Playlist>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub query: String,
    pub songs: Vec<Song>,
    pub albums: Vec<Album>,
    pub playlists: Vec<Playlist>,
    pub page: u32,
    pub has_more: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogProviderCapabilities {
    pub search: bool,
    pub album: bool,
    pub artist: bool,
    pub playlist: bool,
    pub lyrics: bool,
    pub word_timed_lyrics: bool,
    pub streaming: bool,
    pub quality_selection: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider_id: String,
    pub display_name: String,
    pub connection: String,
    pub message: String,
    pub preferred_quality: AudioQualityPreference,
    pub capabilities: CatalogProviderCapabilities,
}

struct QQSession {
    uin: String,
    cookie_header: String,
}

impl From<SessionRecord> for QQSession {
    fn from(session: SessionRecord) -> Self {
        Self {
            uin: session.uin,
            cookie_header: session.cookie_header,
        }
    }
}

#[derive(Debug, Error)]
pub enum QQMusicError {
    #[error("QQ Music is unreachable")]
    Offline,
    #[error("the QQ Music request timed out")]
    Timeout,
    #[error("QQ Music rate-limited this request")]
    RateLimited,
    #[error("the QQ Music response no longer matches the expected schema")]
    SchemaChanged,
    #[error("the QQ Music response was malformed")]
    MalformedResponse,
    #[error("the requested QQ Music item is unavailable")]
    NotFound,
    #[error("the QQ Music playlist reference contains an invalid provider identifier")]
    InvalidPlaylistIdentifier,
    #[error("this QQ Music account collection is not supported")]
    UnsupportedAccountCollection,
    #[error("the QQ Music request was invalid")]
    InvalidRequest,
    #[error("the QQ Music operation is intentionally unsupported")]
    UnsupportedOperation,
    #[error("the QQ Music session expired")]
    AuthenticationExpired,
    #[error("QQ Music rejected this authorization request")]
    AuthorizationRejected,
    #[error("the QQ Music protocol response was invalid")]
    Protocol,
    #[error("the QQ Music operation outcome is unknown")]
    OutcomeUnknown,
    #[error("the QQ Music operation was cancelled")]
    Cancelled,
    #[error("another mutation for this QQ Music entity is already running")]
    MutationInProgress,
    #[error("the account is not entitled to this media")]
    EntitlementUnavailable,
    #[error("the account entitlement could not be confirmed")]
    EntitlementUnknown,
    #[error("the native client does not support this media source")]
    ClientUnsupported,
    #[error("local provider storage failed")]
    Storage,
}

impl QQMusicError {
    pub fn error_code(&self) -> ProviderErrorCode {
        match self {
            Self::Offline => ProviderErrorCode::Offline,
            Self::Timeout => ProviderErrorCode::Timeout,
            Self::RateLimited => ProviderErrorCode::RateLimited,
            Self::SchemaChanged => ProviderErrorCode::SchemaChanged,
            Self::MalformedResponse | Self::Protocol => ProviderErrorCode::MalformedResponse,
            Self::NotFound => ProviderErrorCode::SongUnavailable,
            Self::InvalidPlaylistIdentifier => ProviderErrorCode::InvalidPlaylistIdentifier,
            Self::UnsupportedAccountCollection => ProviderErrorCode::UnsupportedAccountCollection,
            Self::InvalidRequest => ProviderErrorCode::InvalidRequest,
            Self::UnsupportedOperation => ProviderErrorCode::UnsupportedOperation,
            Self::AuthenticationExpired => ProviderErrorCode::AuthenticationExpired,
            Self::AuthorizationRejected => ProviderErrorCode::AuthorizationRejected,
            Self::OutcomeUnknown => ProviderErrorCode::ProviderFailure,
            Self::Cancelled => ProviderErrorCode::Cancelled,
            Self::MutationInProgress => ProviderErrorCode::MutationInProgress,
            Self::EntitlementUnavailable => ProviderErrorCode::EntitlementUnavailable,
            Self::EntitlementUnknown => ProviderErrorCode::EntitlementUnknown,
            Self::ClientUnsupported => ProviderErrorCode::ClientUnsupported,
            Self::Storage => ProviderErrorCode::StorageFailure,
        }
    }

    pub fn code(&self) -> &'static str {
        self.error_code().as_str()
    }

    pub fn retryable(&self) -> bool {
        matches!(self, Self::Offline | Self::Timeout | Self::RateLimited)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCommandError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl From<QQMusicError> for ProviderCommandError {
    fn from(error: QQMusicError) -> Self {
        Self {
            code: error.code().to_owned(),
            message: error.to_string(),
            retryable: error.retryable(),
        }
    }
}

pub type ProviderResult<T> = Result<T, ProviderCommandError>;

pub struct QQMusicService {
    client: QQMusicClient,
    account_transport: Arc<dyn QqTransport>,
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "used by the QQ account services introduced in later tasks"
        )
    )]
    clock: Arc<dyn Clock>,
    auth: Arc<QQMusicAuthService>,
    account: Arc<QQMusicAccountService>,
    storage: Arc<StorageService>,
    preferred_quality: RwLock<AudioQualityPreference>,
    current_quality_override: RwLock<Option<(String, AudioQualityPreference)>>,
    fixture_root: PathBuf,
    fixture_guard: AsyncMutex<()>,
    session_invalid: AtomicBool,
}

impl QQMusicService {
    pub fn new(
        storage: Arc<StorageService>,
        credentials: Arc<dyn CredentialStore>,
        fixture_root: PathBuf,
    ) -> Result<Self, QQMusicError> {
        let clock: Arc<dyn Clock> = Arc::new(SystemClock);
        let account_transport: Arc<dyn QqTransport> =
            Arc::new(ReqwestQqTransport::new(Arc::clone(&clock))?);
        Self::new_with_runtime(storage, credentials, fixture_root, account_transport, clock)
    }

    pub(crate) fn new_with_runtime(
        storage: Arc<StorageService>,
        credentials: Arc<dyn CredentialStore>,
        fixture_root: PathBuf,
        account_transport: Arc<dyn QqTransport>,
        clock: Arc<dyn Clock>,
    ) -> Result<Self, QQMusicError> {
        let preferred_quality = AudioQualityPreference::from_setting(
            storage
                .get_setting("preferred-quality")
                .map_err(|_| QQMusicError::Storage)?,
        );
        let auth_protocol = Arc::new(TransportQQMusicAuthProtocol::new(
            Arc::clone(&account_transport),
            Arc::clone(&clock),
        ));
        let auth = Arc::new(QQMusicAuthService::new(
            auth_protocol,
            SpawnBlockingCredentialStore::new(Arc::clone(&credentials)),
            Arc::clone(&clock),
            Arc::clone(&storage),
        ));
        let account = Arc::new(QQMusicAccountService::new(
            Arc::clone(&account_transport),
            Arc::clone(&clock),
            Arc::clone(&storage),
            Arc::clone(&auth),
        ));
        Ok(Self {
            client: QQMusicClient::new()?,
            account_transport,
            clock,
            auth,
            account,
            storage,
            preferred_quality: RwLock::new(preferred_quality),
            current_quality_override: RwLock::new(None),
            fixture_root,
            fixture_guard: AsyncMutex::new(()),
            session_invalid: AtomicBool::new(false),
        })
    }

    pub fn http_client(&self) -> Client {
        self.client.http.clone()
    }

    pub fn capabilities(&self) -> CatalogProviderCapabilities {
        CatalogProviderCapabilities {
            search: true,
            album: true,
            artist: true,
            playlist: true,
            lyrics: true,
            word_timed_lyrics: true,
            streaming: true,
            quality_selection: true,
        }
    }

    pub async fn status(&self) -> ProviderStatus {
        let connection = match self.client.toplist(DEFAULT_TOPLIST_ID, 1).await {
            Ok(_) => "online",
            Err(_)
                if self
                    .storage
                    .get_json::<HomeFeed>("qqmusic:home", true)
                    .ok()
                    .flatten()
                    .is_some() =>
            {
                "cached"
            }
            Err(_) => "offline",
        };
        ProviderStatus {
            provider_id: "qqmusic".to_owned(),
            display_name: "QQ Music".to_owned(),
            connection: connection.to_owned(),
            message: match connection {
                "online" => "Public catalog access is available.",
                "cached" => "QQ Music is unreachable; cached catalog data remains available.",
                _ => "QQ Music is currently unreachable. Offline fixtures remain available for development.",
            }
            .to_owned(),
            preferred_quality: *self.preferred_quality.read().await,
            capabilities: self.capabilities(),
        }
    }

    pub async fn set_preferred_quality(
        &self,
        quality: AudioQualityPreference,
    ) -> Result<ProviderStatus, QQMusicError> {
        self.storage
            .set_setting("preferred-quality", quality.as_setting())
            .map_err(|_| QQMusicError::Storage)?;
        *self.preferred_quality.write().await = quality;
        Ok(self.status().await)
    }

    pub async fn set_current_quality(
        &self,
        track_id: String,
        quality: AudioQualityPreference,
    ) -> Result<(), QQMusicError> {
        if track_id.trim().is_empty() {
            return Err(QQMusicError::InvalidRequest);
        }
        *self.current_quality_override.write().await = Some((track_id, quality));
        Ok(())
    }

    async fn playback_quality_for(&self, track_id: &str) -> AudioQualityPreference {
        let preferred = *self.preferred_quality.read().await;
        let mut current = self.current_quality_override.write().await;
        match current.as_ref() {
            Some((override_track_id, quality)) if override_track_id == track_id => *quality,
            Some(_) => {
                *current = None;
                preferred
            }
            None => preferred,
        }
    }

    pub async fn account_snapshot(&self) -> AccountSnapshot {
        self.auth.snapshot().await
    }

    pub async fn favorite_songs(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> Result<Page<Song>, QQMusicError> {
        let page = self.account.favorite_songs(cursor, limit).await?;
        self.account.remember_songs(&page.items).await;
        Ok(page)
    }

    pub async fn account_playlists(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> Result<Page<AccountPlaylistSummary>, QQMusicError> {
        self.account.playlists(cursor, limit).await
    }

    pub async fn account_playlist_tracks(
        &self,
        playlist: AccountPlaylistSummary,
        cursor: Option<String>,
        limit: u32,
    ) -> Result<AccountPlaylistDetail, QQMusicError> {
        let detail = self
            .account
            .playlist_tracks(playlist, cursor, limit)
            .await?;
        self.account.remember_songs(&detail.tracks.items).await;
        Ok(detail)
    }

    pub async fn account_recently_played(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> Result<Page<RemotePlayHistoryItem>, QQMusicError> {
        let limit = limit.clamp(1, 100);
        let remote = self.account.recently_played(cursor.clone(), limit).await;
        let local = self.local_recent_history(if cursor.is_none() { limit } else { 0 })?;
        let page = match remote {
            Ok(page) => merge_recent_history(page, local, limit),
            Err(error) if recent_history_fallback_eligible(&error) => {
                let snapshot = self.auth.snapshot().await;
                Page {
                    total: Some(local.len() as u64),
                    items: local,
                    next_cursor: None,
                    fetched_at_ms: unix_timestamp_ms(),
                    stale: false,
                    auth_revision: snapshot.revision,
                }
            }
            Err(error) => return Err(error),
        };
        self.account
            .remember_songs(page.items.iter().map(|item| &item.song))
            .await;
        Ok(page)
    }

    fn local_recent_history(&self, limit: u32) -> Result<Vec<RemotePlayHistoryItem>, QQMusicError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        if let Ok(Some(snapshot)) = self.storage.load_queue::<crate::player::PlayerSnapshot>() {
            for song in snapshot.queue {
                if let Some(provider) = song
                    .provider
                    .as_ref()
                    .filter(|provider| provider.provider_id == "qqmusic")
                {
                    self.storage
                        .backfill_playback_history_snapshot("qqmusic", &provider.track_id, &song)
                        .map_err(|_| QQMusicError::Storage)?;
                }
            }
        }
        self.storage
            .load_playback_history::<Song>("qqmusic", limit)
            .map_err(|_| QQMusicError::Storage)
            .map(|history| {
                history
                    .into_iter()
                    .map(|(song, played_at_ms)| RemotePlayHistoryItem {
                        song,
                        played_at_ms: Some(played_at_ms),
                        source: RemotePlayHistorySource::LocalPlayback,
                    })
                    .collect()
            })
    }

    pub async fn set_favorite(
        &self,
        request: FavoriteMutationRequest,
    ) -> Result<FavoriteMutationResult, QQMusicError> {
        self.account.set_favorite(request).await
    }

    pub(crate) async fn remember_songs<'a>(&self, songs: impl IntoIterator<Item = &'a Song>) {
        self.account.remember_songs(songs).await;
    }

    pub async fn create_playlist(
        &self,
        request: CreatePlaylistRequest,
    ) -> Result<PlaylistMutationResult, QQMusicError> {
        self.account.create_playlist(request).await
    }

    pub async fn rename_playlist(
        &self,
        request: RenamePlaylistRequest,
    ) -> Result<PlaylistMutationResult, QQMusicError> {
        self.account.rename_playlist(request).await
    }

    pub async fn add_playlist_track(
        &self,
        request: PlaylistTrackMutationRequest,
    ) -> Result<PlaylistMutationResult, QQMusicError> {
        self.account.add_playlist_track(request).await
    }

    pub async fn remove_playlist_track(
        &self,
        request: PlaylistTrackMutationRequest,
    ) -> Result<PlaylistMutationResult, QQMusicError> {
        self.account.remove_playlist_track(request).await
    }

    pub async fn delete_playlist(
        &self,
        request: DeletePlaylistRequest,
    ) -> Result<PlaylistMutationResult, QQMusicError> {
        self.account.delete_playlist(request).await
    }

    pub async fn set_playlist_collected(
        &self,
        request: CollectPlaylistRequest,
    ) -> Result<PlaylistMutationResult, QQMusicError> {
        self.account.set_playlist_collected(request).await
    }

    pub async fn start_qr_login(&self) -> Result<AccountSnapshot, QQMusicError> {
        self.auth.start().await
    }

    pub(crate) async fn start_oauth_login(
        self: &Arc<Self>,
        provider: OAuthLoginProvider,
    ) -> Result<oauth::OAuthLaunch, QQMusicError> {
        self.auth.start_oauth(provider).await
    }

    pub(crate) async fn complete_oauth_login(
        &self,
        attempt_id: &str,
        provider: OAuthLoginProvider,
        callback_url: reqwest::Url,
    ) -> Result<AccountSnapshot, QQMusicError> {
        self.auth
            .complete_oauth_callback(attempt_id, provider, callback_url)
            .await
    }

    pub(crate) async fn cancel_oauth_login(
        &self,
        attempt_id: &str,
    ) -> Result<AccountSnapshot, QQMusicError> {
        self.auth.cancel(attempt_id).await
    }

    pub async fn heartbeat_qr_login(
        &self,
        attempt_id: String,
        owner_lease_id: String,
    ) -> Result<AccountSnapshot, QQMusicError> {
        self.auth.heartbeat(&attempt_id, &owner_lease_id).await
    }

    pub(crate) async fn is_oauth_login(&self, attempt_id: &str) -> bool {
        self.auth.is_oauth_attempt(attempt_id).await
    }

    pub async fn cancel_qr_login(
        &self,
        attempt_id: String,
    ) -> Result<AccountSnapshot, QQMusicError> {
        self.auth.cancel(&attempt_id).await
    }

    pub async fn refresh_qr_login(
        &self,
        attempt_id: Option<String>,
    ) -> Result<AccountSnapshot, QQMusicError> {
        self.auth.refresh(attempt_id.as_deref()).await
    }

    pub async fn restore_session(&self) {
        let _ = self.auth.restore().await;
    }

    pub fn cancel_login_owner(&self, reason: &'static str) -> bool {
        self.auth.cancel_login_owner(reason)
    }

    pub async fn sign_out(&self) -> Result<AccountSnapshot, QQMusicError> {
        let result = self.auth.logout().await;
        self.account.clear_runtime_state().await;
        self.session_invalid.store(false, Ordering::Release);
        result
    }

    pub async fn search(
        &self,
        query: String,
        page: u32,
        limit: u32,
    ) -> Result<SearchResult, QQMusicError> {
        let query = query.trim().to_owned();
        if query.is_empty() {
            return Ok(SearchResult {
                query,
                songs: vec![],
                albums: vec![],
                playlists: vec![],
                page: 1,
                has_more: false,
            });
        }
        let page = page.max(1);
        let limit = limit.clamp(1, 30);
        let key = format!("qqmusic:search:{}:{page}:{limit}", stable_component(&query));
        if let Some(result) = self
            .storage
            .get_json::<SearchResult>(&key, false)
            .map_err(|_| QQMusicError::Storage)?
        {
            self.account
                .remember_songs(
                    result
                        .songs
                        .iter()
                        .chain(result.albums.iter().flat_map(|album| album.tracks.iter()))
                        .chain(
                            result
                                .playlists
                                .iter()
                                .flat_map(|playlist| playlist.tracks.iter()),
                        ),
                )
                .await;
            return Ok(result);
        }

        self.storage
            .record_search("qqmusic", &query)
            .map_err(|_| QQMusicError::Storage)?;
        match self.client.search(&query, page, limit).await {
            Ok(result) => {
                self.storage
                    .put_json(&key, "metadata", &result, METADATA_TTL_MS)
                    .map_err(|_| QQMusicError::Storage)?;
                self.account
                    .remember_songs(
                        result
                            .songs
                            .iter()
                            .chain(result.albums.iter().flat_map(|album| album.tracks.iter()))
                            .chain(
                                result
                                    .playlists
                                    .iter()
                                    .flat_map(|playlist| playlist.tracks.iter()),
                            ),
                    )
                    .await;
                Ok(result)
            }
            Err(error) => {
                let result = self
                    .storage
                    .get_json::<SearchResult>(&key, true)
                    .map_err(|_| QQMusicError::Storage)?
                    .ok_or(error)?;
                self.account
                    .remember_songs(
                        result
                            .songs
                            .iter()
                            .chain(result.albums.iter().flat_map(|album| album.tracks.iter()))
                            .chain(
                                result
                                    .playlists
                                    .iter()
                                    .flat_map(|playlist| playlist.tracks.iter()),
                            ),
                    )
                    .await;
                Ok(result)
            }
        }
    }

    pub async fn album(&self, id: String) -> Result<Album, QQMusicError> {
        let mid = strip_entity_prefix(&id, "qqmusic:album:");
        let key = format!("qqmusic:album:{mid}");
        if let Some(album) = self
            .storage
            .get_json::<Album>(&key, false)
            .map_err(|_| QQMusicError::Storage)?
        {
            self.account.remember_songs(&album.tracks).await;
            return Ok(album);
        }
        match self.client.album(mid).await {
            Ok(album) => {
                self.storage
                    .put_json(&key, "metadata", &album, ENTITY_TTL_MS)
                    .map_err(|_| QQMusicError::Storage)?;
                self.account.remember_songs(&album.tracks).await;
                Ok(album)
            }
            Err(error) => {
                let album = self
                    .storage
                    .get_json::<Album>(&key, true)
                    .map_err(|_| QQMusicError::Storage)?
                    .ok_or(error)?;
                self.account.remember_songs(&album.tracks).await;
                Ok(album)
            }
        }
    }

    pub async fn playlist(&self, id: String) -> Result<Playlist, QQMusicError> {
        let key = id.clone();
        if let Some(playlist) = self
            .storage
            .get_json::<Playlist>(&key, false)
            .map_err(|_| QQMusicError::Storage)?
        {
            self.account.remember_songs(&playlist.tracks).await;
            return Ok(playlist);
        }
        let result = if let Some(top_id) = id.strip_prefix("qqmusic:toplist:") {
            self.client
                .toplist(top_id.parse().map_err(|_| QQMusicError::NotFound)?, 30)
                .await
        } else {
            self.client
                .playlist(strip_entity_prefix(&id, "qqmusic:playlist:"))
                .await
        };
        match result {
            Ok(playlist) => {
                self.storage
                    .put_json(&key, "metadata", &playlist, METADATA_TTL_MS)
                    .map_err(|_| QQMusicError::Storage)?;
                self.account.remember_songs(&playlist.tracks).await;
                Ok(playlist)
            }
            Err(error) => {
                let playlist = self
                    .storage
                    .get_json::<Playlist>(&key, true)
                    .map_err(|_| QQMusicError::Storage)?
                    .ok_or(error)?;
                self.account.remember_songs(&playlist.tracks).await;
                Ok(playlist)
            }
        }
    }

    pub async fn home(&self) -> Result<HomeFeed, QQMusicError> {
        if let Some(feed) = self
            .storage
            .get_json("qqmusic:home", false)
            .map_err(|_| QQMusicError::Storage)?
        {
            self.remember_home_songs(&feed).await;
            return Ok(feed);
        }
        match self.build_home().await {
            Ok(feed) => {
                self.storage
                    .put_json("qqmusic:home", "metadata", &feed, METADATA_TTL_MS)
                    .map_err(|_| QQMusicError::Storage)?;
                self.remember_home_songs(&feed).await;
                Ok(feed)
            }
            Err(error) => {
                let feed = self
                    .storage
                    .get_json("qqmusic:home", true)
                    .map_err(|_| QQMusicError::Storage)?
                    .ok_or(error)?;
                self.remember_home_songs(&feed).await;
                Ok(feed)
            }
        }
    }

    async fn remember_home_songs(&self, feed: &HomeFeed) {
        self.account
            .remember_songs(
                feed.featured
                    .album
                    .tracks
                    .iter()
                    .chain(
                        feed.recently_played
                            .iter()
                            .flat_map(|collection| match collection {
                                MediaCollection::Album(album) => album.tracks.iter(),
                                MediaCollection::Playlist(playlist) => playlist.tracks.iter(),
                            }),
                    )
                    .chain(
                        feed.made_for_you
                            .iter()
                            .flat_map(|playlist| playlist.tracks.iter()),
                    )
                    .chain(
                        feed.new_releases
                            .iter()
                            .flat_map(|album| album.tracks.iter()),
                    ),
            )
            .await;
    }

    async fn build_home(&self) -> Result<HomeFeed, QQMusicError> {
        let chart = self.client.toplist(DEFAULT_TOPLIST_ID, 18).await?;
        let first = chart.tracks.first().ok_or(QQMusicError::NotFound)?;
        let featured_album = match self.album(first.album.id.clone()).await {
            Ok(album) => album,
            Err(_) => album_from_songs(&first.album, &first.artists, vec![first.clone()]),
        };
        let first_half = chart.tracks.iter().take(9).cloned().collect::<Vec<_>>();
        let second_half = chart.tracks.iter().skip(9).cloned().collect::<Vec<_>>();
        let chart_artwork = chart.artwork.clone();
        let rising = Playlist {
            id: "qqmusic:toplist:62".to_owned(),
            title: "QQ Music Rising Chart".to_owned(),
            description: chart.description.clone(),
            owner: PlaylistOwner {
                id: "qqmusic".to_owned(),
                display_name: "QQ Music".to_owned(),
            },
            artwork: chart_artwork.clone(),
            updated_label: chart.updated_label.clone(),
            tracks: first_half,
        };
        let preview_mix = Playlist {
            id: "qqmusic:generated:preview-mix".to_owned(),
            title: "Current discoveries".to_owned(),
            description: "A live provider selection. Guest playback uses full public streams where available and official previews otherwise.".to_owned(),
            owner: PlaylistOwner {
                id: "qqmusic".to_owned(),
                display_name: "QQ Music".to_owned(),
            },
            artwork: chart_artwork,
            updated_label: "Updated from QQ Music".to_owned(),
            tracks: second_half,
        };

        let mut grouped: BTreeMap<String, (AlbumSummary, Vec<ArtistSummary>, Vec<Song>)> =
            BTreeMap::new();
        for song in &chart.tracks {
            let entry = grouped
                .entry(song.album.id.clone())
                .or_insert_with(|| (song.album.clone(), song.artists.clone(), Vec::new()));
            entry.2.push(song.clone());
        }
        let new_releases = grouped
            .into_values()
            .take(4)
            .map(|(summary, artists, songs)| album_from_songs(&summary, &artists, songs))
            .collect();

        Ok(HomeFeed {
            featured: FeaturedRelease {
                eyebrow: "LIVE FROM QQ MUSIC".to_owned(),
                album: featured_album,
            },
            recently_played: vec![MediaCollection::Playlist(rising.clone())],
            made_for_you: vec![rising, preview_mix],
            new_releases,
        })
    }

    pub fn library(&self) -> LibrarySnapshot {
        LibrarySnapshot::default()
    }

    pub async fn lyrics(&self, song_id: String) -> Result<Option<LyricDocument>, QQMusicError> {
        let mid = strip_entity_prefix(&song_id, "qqmusic:track:");
        // Include the normalized-document schema/parser revision so fixes do not
        // leave already-cached lyric documents permanently malformed.
        let key = format!("qqmusic:lyrics:v2:{mid}");
        if let Some(document) = self
            .storage
            .get_json(&key, false)
            .map_err(|_| QQMusicError::Storage)?
        {
            return Ok(document);
        }
        match self.client.lyrics(mid).await {
            Ok(document) => {
                self.storage
                    .put_json(&key, "lyrics", &document, LYRIC_TTL_MS)
                    .map_err(|_| QQMusicError::Storage)?;
                Ok(document)
            }
            Err(error) => self
                .storage
                .get_json(&key, true)
                .map_err(|_| QQMusicError::Storage)?
                .ok_or(error),
        }
    }

    pub async fn artwork_data_uri(&self, url: String) -> Result<String, QQMusicError> {
        if !is_allowed_artwork_url(&url) {
            return Err(QQMusicError::MalformedResponse);
        }
        self.storage
            .artwork_data_uri(&self.client.artwork_http, &url)
            .await
            .map_err(|_| QQMusicError::Storage)
    }

    pub fn cache_stats(&self) -> Result<CacheStats, QQMusicError> {
        self.storage.stats().map_err(|_| QQMusicError::Storage)
    }

    pub fn clear_cache(&self) -> Result<CacheStats, QQMusicError> {
        self.storage.clear().map_err(|_| QQMusicError::Storage)
    }

    async fn playback_context(
        &self,
    ) -> Result<(Option<QQSession>, AccountEntitlement, PlaybackEpochGuard), QQMusicError> {
        if self.auth.current_session().await.is_none() {
            return Ok((
                None,
                AccountEntitlement {
                    tier: EntitlementTier::Free,
                    membership: MembershipState::Inactive,
                    expires_at_ms: None,
                    secondary_entitlements: Vec::new(),
                    permitted_qualities: vec![AudioQuality::Standard],
                    observed_maximum_quality: Some(AudioQuality::Standard),
                    restrictions: Vec::new(),
                },
                PlaybackEpochGuard::unrestricted(),
            ));
        }
        let context = self.auth.capture_account_context().await?;
        let guard = PlaybackEpochGuard::account_bound(
            context.epoch,
            context.cancellation,
            self.auth.playback_epoch_clock(),
        );
        guard.validate().map_err(|_| QQMusicError::Cancelled)?;
        Ok((
            Some(QQSession::from(context.session)),
            context.entitlement,
            guard,
        ))
    }
}

#[async_trait]
impl PlaybackSourceResolver for QQMusicService {
    async fn resolve(&self, song: &Song) -> Result<ResolvedPlaybackSource, PlaybackSourceError> {
        if song
            .provider
            .as_ref()
            .map(|provider| provider.provider_id.as_str())
            == Some("qqmusic")
        {
            let provider = song
                .provider
                .as_ref()
                .ok_or(PlaybackSourceError::TrackUnavailable)?;
            let quality = self.playback_quality_for(&provider.track_id).await;
            let (session, entitlement, epoch_guard) = self
                .playback_context()
                .await
                .map_err(map_provider_source_error)?;
            let source = self
                .client
                .resolve_source(
                    song,
                    quality,
                    session.as_ref(),
                    &entitlement,
                    epoch_guard,
                    self.account_transport.as_ref(),
                )
                .await;
            if matches!(&source, Err(QQMusicError::AuthenticationExpired)) {
                self.session_invalid.store(true, Ordering::Release);
            }
            let source = source.map_err(map_provider_source_error)?;
            if let Some(provider) = &song.provider {
                let _ = self.storage.record_playback_snapshot(
                    &provider.provider_id,
                    &provider.track_id,
                    song,
                );
            }
            return Ok(source);
        }

        let _guard = self.fixture_guard.lock().await;
        tokio::fs::create_dir_all(&self.fixture_root)
            .await
            .map_err(|_| PlaybackSourceError::CacheFailure)?;
        let duration_ms = song.duration_ms.max(1_000);
        let path = self
            .fixture_root
            .join(format!("{}-{duration_ms}.wav", stable_component(&song.id)));
        if !path.is_file() {
            let output = path.clone();
            let seed = song.id.bytes().fold(0_u32, |value, byte| {
                value.wrapping_mul(31).wrapping_add(u32::from(byte))
            });
            tokio::task::spawn_blocking(move || {
                write_fixture_wav(&output, Duration::from_millis(duration_ms), seed)
            })
            .await
            .map_err(|_| PlaybackSourceError::CacheFailure)?
            .map_err(|_| PlaybackSourceError::CacheFailure)?;
        }
        Ok(ResolvedPlaybackSource {
            cache_key: format!("fixture:{}:{duration_ms}", song.id),
            location: PlaybackLocation::Local(path),
            format: AudioFormat::Wav,
            mime_type: Some("audio/wav".to_owned()),
            quality_label: "fixture-pcm".to_owned(),
            bitrate_kbps: Some(256),
            sample_rate_hz: Some(16_000),
            bit_depth: Some(16),
            content_length: None,
            supports_range: true,
            expires_at_ms: None,
            timeline_offset_ms: 0,
            timeline_end_ms: Some(duration_ms),
            is_preview: false,
            selection: PlaybackSourceSelection {
                requested_quality: AudioQualityPreference::Automatic,
                resolved_quality: song.quality,
                fallback_reason: None,
                preview: false,
                quality_capabilities: Vec::new(),
            },
            epoch_guard: PlaybackEpochGuard::unrestricted(),
        })
    }

    async fn resolve_client_fallback(
        &self,
        song: &Song,
        failed: &PlaybackSourceSelection,
    ) -> Result<ResolvedPlaybackSource, PlaybackSourceError> {
        if failed.requested_quality != AudioQualityPreference::Automatic
            || !matches!(
                failed.resolved_quality,
                AudioQuality::Lossless | AudioQuality::Master
            )
            || song
                .provider
                .as_ref()
                .map(|provider| provider.provider_id.as_str())
                != Some("qqmusic")
        {
            return Err(PlaybackSourceError::DecoderUnsupported);
        }

        let provider = song
            .provider
            .as_ref()
            .ok_or(PlaybackSourceError::TrackUnavailable)?;
        let (session, entitlement, epoch_guard) = self
            .playback_context()
            .await
            .map_err(map_provider_source_error)?;
        let source = self
            .client
            .resolve_source(
                song,
                AudioQualityPreference::High,
                session.as_ref(),
                &entitlement,
                epoch_guard,
                self.account_transport.as_ref(),
            )
            .await;
        if matches!(&source, Err(QQMusicError::AuthenticationExpired)) {
            self.session_invalid.store(true, Ordering::Release);
        }
        let mut source = source.map_err(map_provider_source_error)?;
        source.selection.requested_quality = AudioQualityPreference::Automatic;
        source.selection.fallback_reason = Some(PlaybackFallbackReason::ClientUnsupported);
        if let Some(capability) = source
            .selection
            .quality_capabilities
            .iter_mut()
            .find(|capability| capability.quality == failed.resolved_quality)
        {
            capability.client = ClientCapabilityState::Unsupported;
            capability.playable = false;
        }
        let _ =
            self.storage
                .record_playback_snapshot(&provider.provider_id, &provider.track_id, song);
        Ok(source)
    }
}

fn map_provider_source_error(error: QQMusicError) -> PlaybackSourceError {
    match error {
        QQMusicError::Offline | QQMusicError::Timeout | QQMusicError::RateLimited => {
            PlaybackSourceError::Network
        }
        QQMusicError::AuthenticationExpired | QQMusicError::AuthorizationRejected => {
            PlaybackSourceError::AuthenticationExpired
        }
        QQMusicError::EntitlementUnavailable => PlaybackSourceError::EntitlementInsufficient,
        QQMusicError::EntitlementUnknown => PlaybackSourceError::EntitlementUnknown,
        QQMusicError::ClientUnsupported => PlaybackSourceError::DecoderUnsupported,
        QQMusicError::NotFound => PlaybackSourceError::TrackUnavailable,
        QQMusicError::SchemaChanged
        | QQMusicError::MalformedResponse
        | QQMusicError::InvalidRequest
        | QQMusicError::InvalidPlaylistIdentifier
        | QQMusicError::UnsupportedAccountCollection
        | QQMusicError::UnsupportedOperation
        | QQMusicError::Protocol
        | QQMusicError::OutcomeUnknown
        | QQMusicError::MutationInProgress
        | QQMusicError::Storage => PlaybackSourceError::UrlUnavailable,
        QQMusicError::Cancelled => PlaybackSourceError::Cancelled,
    }
}

#[derive(Clone)]
struct QQMusicClient {
    http: Client,
    artwork_http: Client,
}

impl QQMusicClient {
    fn new() -> Result<Self, QQMusicError> {
        #[cfg(test)]
        let _proxy_environment_lock = transport::proxy_environment_lock();
        let http = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
            .build()
            .map_err(|_| QQMusicError::Offline)?;
        let artwork_http = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| QQMusicError::Offline)?;
        Ok(Self { http, artwork_http })
    }

    async fn search(
        &self,
        query: &str,
        page: u32,
        limit: u32,
    ) -> Result<SearchResult, QQMusicError> {
        let song_query = query.to_owned();
        let album_query = query.to_owned();
        let song_request = || {
            self.http
                .get(QQ_SEARCH_URL)
                .header(header::REFERER, "https://y.qq.com/")
                .query(&[
                    ("p", page.to_string()),
                    ("n", limit.to_string()),
                    ("w", song_query.clone()),
                    ("format", "json".to_owned()),
                    ("new_json", "1".to_owned()),
                    ("t", "0".to_owned()),
                ])
        };
        let album_request = || {
            self.http
                .get(QQ_SEARCH_URL)
                .header(header::REFERER, "https://y.qq.com/")
                .query(&[
                    ("p", page.to_string()),
                    ("n", limit.min(12).to_string()),
                    ("w", album_query.clone()),
                    ("format", "json".to_owned()),
                    ("new_json", "1".to_owned()),
                    ("t", "8".to_owned()),
                ])
        };
        let (song_response, album_response): (SearchResponse, SearchResponse) = tokio::try_join!(
            self.send_json("search.songs", song_request),
            self.send_json("search.albums", album_request)
        )?;
        if song_response.code != 0 || album_response.code != 0 {
            return Err(QQMusicError::SchemaChanged);
        }

        let song_block = song_response.data.song.unwrap_or_default();
        let songs = song_block
            .list
            .into_iter()
            .filter_map(normalize_new_song)
            .collect::<Vec<_>>();
        let mut songs_by_album: HashMap<String, Vec<Song>> = HashMap::new();
        for song in &songs {
            songs_by_album
                .entry(song.album.id.clone())
                .or_default()
                .push(song.clone());
        }
        let albums = album_response
            .data
            .album
            .unwrap_or_default()
            .list
            .into_iter()
            .filter_map(|album| {
                let mid = non_empty(album.album_mid)?;
                let id = album_id(&mid);
                let artist_mid =
                    non_empty(album.singer_mid).unwrap_or_else(|| "unknown".to_owned());
                let artist_name = clean_text(&album.singer_name);
                Some(Album {
                    id: id.clone(),
                    title: clean_text(&album.album_name),
                    artist: ArtistSummary {
                        id: artist_id(&artist_mid),
                        name: artist_name,
                    },
                    artwork: artwork_for_album(&mid, &album.album_name),
                    release_year: parse_year(&album.public_time),
                    genre: "QQ Music".to_owned(),
                    description: "Album metadata supplied by QQ Music.".to_owned(),
                    tracks: songs_by_album.remove(&id).unwrap_or_default(),
                })
            })
            .collect();
        let has_more = u64::from(page).saturating_mul(u64::from(limit)) < song_block.total_num;
        Ok(SearchResult {
            query: query.to_owned(),
            songs,
            albums,
            playlists: vec![],
            page,
            has_more,
        })
    }

    async fn album(&self, mid: &str) -> Result<Album, QQMusicError> {
        let album_mid = mid.to_owned();
        let response: AlbumResponse = self
            .send_json("album", || {
                self.http
                    .get(QQ_ALBUM_URL)
                    .header(header::REFERER, "https://y.qq.com/")
                    .query(&[
                        ("albummid", album_mid.clone()),
                        ("format", "json".to_owned()),
                        ("platform", "yqq".to_owned()),
                        ("needNewCode", "0".to_owned()),
                    ])
            })
            .await?;
        if response.code != 0 {
            return Err(QQMusicError::NotFound);
        }
        let data = response.data.ok_or(QQMusicError::NotFound)?;
        let tracks = data
            .list
            .into_iter()
            .enumerate()
            .filter_map(|(index, song)| normalize_old_song(song, index as u32 + 1))
            .collect::<Vec<_>>();
        let artist_mid = non_empty(data.singer_mid).unwrap_or_else(|| "unknown".to_owned());
        Ok(Album {
            id: album_id(mid),
            title: clean_text(&data.name),
            artist: ArtistSummary {
                id: artist_id(&artist_mid),
                name: clean_text(&data.singer_name),
            },
            artwork: artwork_for_album(mid, &data.name),
            release_year: parse_year(&data.date),
            genre: non_empty(clean_text(&data.genre)).unwrap_or_else(|| "Music".to_owned()),
            description: clean_text(&data.description),
            tracks,
        })
    }

    async fn playlist(&self, diss_id: &str) -> Result<Playlist, QQMusicError> {
        let id = diss_id.to_owned();
        let response: PlaylistResponse = self
            .send_json("playlist", || {
                self.http
                    .get(QQ_PLAYLIST_URL)
                    .header(header::REFERER, "https://y.qq.com/")
                    .query(&[
                        ("type", "1".to_owned()),
                        ("json", "1".to_owned()),
                        ("utf8", "1".to_owned()),
                        ("onlysong", "0".to_owned()),
                        ("disstid", id.clone()),
                        ("format", "json".to_owned()),
                    ])
            })
            .await?;
        if response.code != 0 {
            return Err(QQMusicError::NotFound);
        }
        let data = response
            .cd_list
            .into_iter()
            .next()
            .ok_or(QQMusicError::NotFound)?;
        let title = clean_text(&data.name);
        Ok(Playlist {
            id: playlist_id(diss_id),
            title: title.clone(),
            description: clean_text(&data.description),
            owner: PlaylistOwner {
                id: format!("qqmusic:user:{}", stable_component(&data.nickname)),
                display_name: clean_text(&data.nickname),
            },
            artwork: artwork_from_provider_url(&data.logo, &title, color_for(diss_id)),
            updated_label: if data.modified_at > 0 {
                "Updated on QQ Music".to_owned()
            } else {
                "QQ Music playlist".to_owned()
            },
            tracks: data
                .songs
                .into_iter()
                .enumerate()
                .filter_map(|(index, song)| normalize_old_song(song, index as u32 + 1))
                .collect(),
        })
    }

    async fn toplist(&self, top_id: u64, limit: u32) -> Result<Playlist, QQMusicError> {
        let payload = json!({
            "comm": { "ct": 24, "cv": 0 },
            "req_1": {
                "module": "musicToplist.ToplistInfoServer",
                "method": "GetDetail",
                "param": { "topId": top_id, "offset": 0, "num": limit, "period": "" }
            }
        });
        let response: ToplistEnvelope = self
            .send_json("toplist", || self.musicu_request(&payload, None))
            .await?;
        if response.code != 0 || response.request.code != 0 {
            return Err(QQMusicError::SchemaChanged);
        }
        let details = response.request.data.details;
        let songs = response
            .request
            .data
            .song_info_list
            .into_iter()
            .filter_map(normalize_new_song)
            .collect();
        let title = clean_text(&details.title);
        let artwork_url = non_empty(details.head_artwork)
            .or_else(|| non_empty(details.front_artwork))
            .or_else(|| non_empty(details.artwork))
            .unwrap_or_default();
        let artwork_color = details
            .magic_color
            .map(|color| format!("#{:02x}{:02x}{:02x}", color.r, color.g, color.b))
            .unwrap_or_else(|| color_for(&top_id.to_string()));
        Ok(Playlist {
            id: format!("qqmusic:toplist:{top_id}"),
            title: title.clone(),
            description: clean_text(&details.description),
            owner: PlaylistOwner {
                id: "qqmusic".to_owned(),
                display_name: "QQ Music".to_owned(),
            },
            artwork: artwork_from_provider_url(&artwork_url, &title, artwork_color),
            updated_label: non_empty(details.update_time)
                .map(|value| format!("Updated {value}"))
                .unwrap_or_else(|| "Updated daily".to_owned()),
            tracks: songs,
        })
    }

    async fn lyrics(&self, mid: &str) -> Result<Option<LyricDocument>, QQMusicError> {
        let payload = json!({
            "comm": { "ct": 24, "cv": 0 },
            "req_1": {
                "module": "music.musichallSong.PlayLyricInfo",
                "method": "GetPlayLyricInfo",
                "param": { "songMID": mid, "qrc": 1, "qrc_t": 0, "roma": 1, "trans": 1 }
            }
        });
        let response: LyricEnvelope = self
            .send_json("lyrics.qrc", || self.musicu_request(&payload, None))
            .await?;
        if response.code == 0 && response.request.code == 0 {
            let data = response.request.data;
            if let Some(decrypted) = decrypt_provider_lyric(&data.lyric) {
                if let Some(mut document) = parse_qrc_document(mid, &decrypted) {
                    attach_companion_lyrics(
                        &mut document,
                        decrypt_provider_lyric(&data.translation).as_deref(),
                        decrypt_provider_lyric(&data.romanization).as_deref(),
                    );
                    return Ok(Some(document));
                }
            }
        }
        self.legacy_lyrics(mid).await
    }

    async fn legacy_lyrics(&self, mid: &str) -> Result<Option<LyricDocument>, QQMusicError> {
        let song_mid = mid.to_owned();
        let response: LegacyLyricResponse = self
            .send_json("lyrics.lrc", || {
                self.http
                    .get(QQ_LRC_URL)
                    .header(header::REFERER, "https://y.qq.com/")
                    .header(header::ORIGIN, "https://y.qq.com")
                    .query(&[
                        ("songmid", song_mid.clone()),
                        ("format", "json".to_owned()),
                        ("nobase64", "1".to_owned()),
                        ("g_tk", "5381".to_owned()),
                        ("loginUin", "0".to_owned()),
                        ("hostUin", "0".to_owned()),
                        ("inCharset", "utf8".to_owned()),
                        ("outCharset", "utf-8".to_owned()),
                        ("platform", "yqq.json".to_owned()),
                        ("needNewCode", "0".to_owned()),
                        ("trans", "1".to_owned()),
                        ("roma", "1".to_owned()),
                    ])
            })
            .await?;
        if response.code != 0 || response.lyric.trim().is_empty() {
            return Ok(None);
        }
        let mut document = parse_lrc_document(mid, &response.lyric);
        if let Some(document) = document.as_mut() {
            attach_companion_lyrics(
                document,
                non_empty(response.translation).as_deref(),
                non_empty(response.romanization).as_deref(),
            );
        }
        Ok(document)
    }

    async fn resolve_source(
        &self,
        song: &Song,
        preferred: AudioQualityPreference,
        session: Option<&QQSession>,
        entitlement: &AccountEntitlement,
        epoch_guard: PlaybackEpochGuard,
        authenticated_transport: &dyn QqTransport,
    ) -> Result<ResolvedPlaybackSource, QQMusicError> {
        epoch_guard
            .validate()
            .map_err(|_| QQMusicError::Cancelled)?;
        let provider = song.provider.as_ref().ok_or(QQMusicError::NotFound)?;
        let media_mid = provider
            .media_id
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or(&provider.track_id);
        let candidates = source_candidates(&provider.track_id, media_mid);
        let requested_candidates = candidates_for_request(preferred, entitlement, &candidates);
        let mut encrypted_results = HashMap::new();
        let mut encrypted_lookup_known = true;
        if let Some(session) = session {
            let encrypted_candidates = requested_candidates
                .iter()
                .filter(|candidate| candidate.encrypted)
                .cloned()
                .collect::<Vec<_>>();
            if !encrypted_candidates.is_empty() {
                encrypted_results = match self
                    .resolve_encrypted_sources(
                        &provider.track_id,
                        session,
                        &encrypted_candidates,
                        &epoch_guard,
                        authenticated_transport,
                    )
                    .await
                {
                    Ok(results) => results,
                    Err(QQMusicError::Cancelled) => return Err(QQMusicError::Cancelled),
                    Err(QQMusicError::AuthenticationExpired) => {
                        return Err(QQMusicError::AuthenticationExpired)
                    }
                    Err(error) => {
                        encrypted_lookup_known = false;
                        tracing::warn!(
                            target: "qqmusic",
                            error = %error,
                            "encrypted source lookup failed; continuing with clear-source fallback"
                        );
                        encrypted_candidates
                            .iter()
                            .map(|candidate| (candidate.filename.clone(), None))
                            .collect()
                    }
                };
            }
        }
        let clear_candidates = requested_candidates
            .iter()
            .filter(|candidate| !candidate.encrypted)
            .cloned()
            .collect::<Vec<_>>();
        let filenames = clear_candidates
            .iter()
            .map(|candidate| candidate.filename.clone())
            .collect::<Vec<_>>();
        let song_mids = vec![provider.track_id.clone(); filenames.len()];
        let song_types = vec![0_u8; filenames.len()];
        let uin = session.map_or("0", |session| session.uin.as_str());
        let payload = json!({
            "comm": { "uin": uin, "format": "json", "ct": 24, "cv": 0 },
            "req_0": {
                "module": "vkey.GetVkeyServer",
                "method": "CgiGetVkey",
                "param": {
                    "guid": stable_guid(),
                    "songmid": song_mids,
                    "songtype": song_types,
                    "uin": uin,
                    "loginflag": 1,
                    "platform": "20",
                    "filename": filenames
                }
            }
        });
        let response: VkeyEnvelope = if filenames.is_empty() {
            VkeyEnvelope::default()
        } else {
            self.send_json("playback.resolve", || {
                self.musicu_request(&payload, session)
            })
            .await?
        };
        epoch_guard
            .validate()
            .map_err(|_| QQMusicError::Cancelled)?;
        if !filenames.is_empty() && (response.code != 0 || response.request.code != 0) {
            return Err(QQMusicError::SchemaChanged);
        }
        let mut available_paths = HashMap::new();
        let mut availability = clear_candidates
            .iter()
            .zip(response.request.data.items)
            .map(|(candidate, item)| {
                let available = item.result == 0 && !item.path.is_empty();
                if available {
                    available_paths.insert(candidate.filename.clone(), item.path);
                }
                VkeyAvailability {
                    filename: candidate.filename.clone(),
                    available,
                    known: true,
                }
            })
            .collect::<Vec<_>>();
        availability.extend(
            encrypted_results
                .iter()
                .map(|(filename, source)| VkeyAvailability {
                    filename: filename.clone(),
                    available: source.is_some(),
                    known: encrypted_lookup_known,
                }),
        );
        let preview = match &song.playback_capability {
            Some(PlaybackCapability::Preview { start_ms, end_ms }) => Some(PreviewRange {
                start_ms: *start_ms,
                end_ms: *end_ms,
            }),
            _ => None,
        };
        let decision = choose_source(
            preferred,
            entitlement,
            &song.audio_formats,
            &candidates,
            &availability,
            preview,
        )
        .map_err(|error| match error {
            PlaybackSourceError::EntitlementInsufficient => QQMusicError::EntitlementUnavailable,
            PlaybackSourceError::EntitlementUnknown => QQMusicError::EntitlementUnknown,
            PlaybackSourceError::DecoderUnsupported => QQMusicError::ClientUnsupported,
            PlaybackSourceError::Cancelled => QQMusicError::Cancelled,
            _ => QQMusicError::NotFound,
        })?;
        let (url, encrypted_key) = if decision.candidate.encrypted {
            encrypted_results
                .remove(&decision.candidate.filename)
                .flatten()
                .map(|source| (source.url, Some(source.ekey)))
                .ok_or(QQMusicError::MalformedResponse)?
        } else {
            let sip = response
                .request
                .data
                .sip
                .into_iter()
                .find_map(|value| normalize_cdn_base(&value))
                .ok_or(QQMusicError::MalformedResponse)?;
            let path = available_paths
                .remove(&decision.candidate.filename)
                .ok_or(QQMusicError::MalformedResponse)?;
            (normalize_cdn_url(&sip, &path)?, None)
        };
        tracing::info!(
            target: "qqmusic.playback",
            requested_quality = preferred.as_setting(),
            resolved_quality = ?decision.candidate.quality,
            provider_quality_code = decision.candidate.cache_label,
            provider_file_type = decision.candidate.format.as_str(),
            extension = decision.candidate.format.extension(),
            encrypted = decision.candidate.encrypted,
            resolution_path = if decision.candidate.encrypted { "evkey" } else { "vkey" },
            ekey_present = encrypted_key.is_some(),
            client_supported = decision.candidate.client_supported,
            preview = decision.candidate.preview,
            "resolved sanitized QQ Music playback source"
        );
        let is_preview = decision.candidate.preview;
        let (timeline_offset_ms, timeline_end_ms) = if let Some(preview) = decision.preview {
            (preview.start_ms, preview.end_ms)
        } else {
            (0, song.duration_ms)
        };
        epoch_guard
            .validate()
            .map_err(|_| QQMusicError::Cancelled)?;
        Ok(ResolvedPlaybackSource {
            cache_key: format!(
                "qqmusic:{}:{}:{}",
                provider.track_id, decision.candidate.cache_label, media_mid
            ),
            location: if let Some(ekey) = encrypted_key {
                PlaybackLocation::EncryptedHttp {
                    url,
                    headers: playback_headers(),
                    ekey,
                }
            } else {
                PlaybackLocation::Http {
                    url,
                    headers: playback_headers(),
                }
            },
            format: decision.candidate.format,
            mime_type: Some(decision.candidate.mime_type.to_owned()),
            quality_label: decision.candidate.cache_label.to_owned(),
            bitrate_kbps: decision.candidate.bitrate_kbps,
            sample_rate_hz: None,
            bit_depth: None,
            content_length: decision.candidate.content_length(),
            supports_range: true,
            expires_at_ms: Some(unix_timestamp_ms().saturating_add(15 * 60 * 1_000)),
            timeline_offset_ms,
            timeline_end_ms: Some(timeline_end_ms),
            is_preview,
            selection: decision.selection,
            epoch_guard,
        })
    }

    async fn resolve_encrypted_sources(
        &self,
        song_mid: &str,
        session: &QQSession,
        candidates: &[SourceCandidate],
        epoch_guard: &PlaybackEpochGuard,
        authenticated_transport: &dyn QqTransport,
    ) -> Result<HashMap<String, Option<EncryptedPlaybackSource>>, QQMusicError> {
        epoch_guard
            .validate()
            .map_err(|_| QQMusicError::Cancelled)?;
        let music_key = cookie_value(&session.cookie_header, "qm_keyst")
            .or_else(|| cookie_value(&session.cookie_header, "qqmusic_key"))
            .ok_or(QQMusicError::AuthenticationExpired)?;
        let login_type = if music_key.starts_with("W_X") {
            "1"
        } else {
            "2"
        };
        let filenames = candidates
            .iter()
            .map(|candidate| candidate.filename.clone())
            .collect::<Vec<_>>();
        let musicfiles = candidates
            .iter()
            .map(|candidate| encrypted_musicfile(&candidate.filename, song_mid))
            .collect::<Result<Vec<_>, _>>()?;
        let payload = encrypted_source_payload(
            music_key,
            &session.uin,
            login_type,
            song_mid,
            filenames,
            musicfiles,
            stable_guid(),
        );
        let mut body = serde_json::to_vec(&payload).map_err(|_| QQMusicError::Protocol)?;
        let signature = qq_request_signature(&body);
        let mut url = Url::parse(QQ_MUSICS_URL).map_err(|_| QQMusicError::Protocol)?;
        url.query_pairs_mut().append_pair("sign", &signature);
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json; charset=utf-8"),
        );
        headers.insert(header::ORIGIN, HeaderValue::from_static("https://y.qq.com"));
        headers.insert(
            header::REFERER,
            HeaderValue::from_static("https://y.qq.com/"),
        );
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(&session.cookie_header).map_err(|_| QQMusicError::Protocol)?,
        );
        let response = authenticated_transport
            .execute(TransportRequest {
                operation: "playback.resolve-encrypted",
                method: Method::POST,
                url,
                headers,
                body: Some(body.clone()),
                retry: RetryClass::SafeRead,
                redirects: RedirectMode::FollowValidated,
                response_shape: "evkey-source",
                cancellation: epoch_guard.cancellation_token(),
            })
            .await;
        body.zeroize();
        let response = response?;
        epoch_guard
            .validate()
            .map_err(|_| QQMusicError::Cancelled)?;
        if !response.status.is_success() {
            return Err(QQMusicError::Offline);
        }
        let envelope: Value =
            serde_json::from_slice(&response.body).map_err(|_| QQMusicError::MalformedResponse)?;
        let module = envelope
            .get(QQ_EVKEY_MODULE_KEY)
            .ok_or(QQMusicError::SchemaChanged)?;
        let module_code = module.get("code").and_then(Value::as_i64).unwrap_or(-1);
        if module_code != 0 {
            return Err(map_encrypted_source_code(module_code));
        }
        let data = module.get("data").ok_or(QQMusicError::SchemaChanged)?;
        let sip = data
            .get("sip")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .find_map(normalize_cdn_base)
            .unwrap_or_else(|| "https://isure.stream.qqmusic.qq.com/".to_owned());
        let items = data
            .get("midurlinfo")
            .and_then(Value::as_array)
            .ok_or(QQMusicError::SchemaChanged)?;
        let mut sources = candidates
            .iter()
            .map(|candidate| (candidate.filename.clone(), None))
            .collect::<HashMap<_, _>>();
        for item in items {
            let Some(filename) = item.get("filename").and_then(Value::as_str) else {
                continue;
            };
            if !sources.contains_key(filename) {
                continue;
            }
            let result = item.get("result").and_then(Value::as_i64).unwrap_or(-1);
            let path = item
                .get("wifiurl")
                .or_else(|| item.get("purl"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty());
            let ekey = item
                .get("ekey")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty());
            if result != 0 || path.is_none() || ekey.is_none() {
                continue;
            }
            let source = EncryptedPlaybackSource {
                url: normalize_cdn_url(&sip, path.expect("checked path"))?,
                ekey: EncryptedMediaKey::new(ekey.expect("checked ekey").to_owned())
                    .map_err(|_| QQMusicError::MalformedResponse)?,
            };
            sources.insert(filename.to_owned(), Some(source));
        }
        Ok(sources)
    }

    fn musicu_request(&self, payload: &Value, session: Option<&QQSession>) -> RequestBuilder {
        let request = self
            .http
            .post(QQ_MUSICU_URL)
            .header(header::REFERER, "https://y.qq.com/")
            .header(header::ORIGIN, "https://y.qq.com")
            .json(payload);
        if let Some(session) = session {
            request.header(header::COOKIE, &session.cookie_header)
        } else {
            request
        }
    }

    async fn send_json<T, F>(&self, operation: &str, build: F) -> Result<T, QQMusicError>
    where
        T: DeserializeOwned,
        F: Fn() -> RequestBuilder,
    {
        for attempt in 0..2 {
            tracing::debug!(target: "qqmusic", operation, attempt, "provider request");
            let response = match build().send().await {
                Ok(response) => response,
                Err(error) if error.is_timeout() && attempt == 0 => {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    continue;
                }
                Err(error) if error.is_timeout() => return Err(QQMusicError::Timeout),
                Err(_) if attempt == 0 => {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    continue;
                }
                Err(_) => return Err(QQMusicError::Offline),
            };
            if response.status() == StatusCode::TOO_MANY_REQUESTS {
                if attempt == 0 {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    continue;
                }
                return Err(QQMusicError::RateLimited);
            }
            if response.status().is_server_error() && attempt == 0 {
                tokio::time::sleep(Duration::from_millis(250)).await;
                continue;
            }
            if matches!(
                response.status(),
                StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
            ) {
                return Err(QQMusicError::AuthenticationExpired);
            }
            if response.status() == StatusCode::NOT_FOUND {
                return Err(QQMusicError::NotFound);
            }
            if !response.status().is_success() {
                return Err(QQMusicError::Offline);
            }
            return response
                .json::<T>()
                .await
                .map_err(|_| QQMusicError::MalformedResponse);
        }
        Err(QQMusicError::Offline)
    }
}

fn encrypted_source_payload(
    music_key: &str,
    uin: &str,
    login_type: &str,
    song_mid: &str,
    filenames: Vec<String>,
    musicfiles: Vec<String>,
    guid: String,
) -> Value {
    let candidate_count = filenames.len();
    debug_assert_eq!(candidate_count, musicfiles.len());
    json!({
            "comm": {
                "ct": "11",
                "tmeAppID": "qqmusic",
                "format": "json",
                "inCharset": "utf-8",
                "outCharset": "utf-8",
                "uid": "3931641530",
                "cv": 13020508,
                "v": 13020508,
                "authst": music_key,
                "qq": uin,
                "tmeLoginType": login_type,
            },
            (QQ_EVKEY_MODULE_KEY): {
                "module": "music.vkey.GetEVkey",
                "method": "CgiGetEVkey",
                "param": {
                    "checklimit": 0,
                    "ctx": 1,
                    "downloadfrom": 0,
                    "filename": filenames,
                    "guid": guid,
                    "musicfile": musicfiles,
                    "nettype": "",
                    "referer": "y.qq.com",
                    "scene": 0,
                    "songmid": vec![song_mid; candidate_count],
                    "songtype": vec![1_u8; candidate_count],
                    "uin": uin,
                }
            }
    })
}

fn encrypted_musicfile(filename: &str, song_mid: &str) -> Result<String, QQMusicError> {
    let extension_index = filename
        .rfind('.')
        .filter(|index| *index > 4)
        .ok_or(QQMusicError::Protocol)?;
    let prefix = filename.get(..4).ok_or(QQMusicError::Protocol)?;
    let extension = filename
        .get(extension_index..)
        .ok_or(QQMusicError::Protocol)?;
    if song_mid.is_empty()
        || !song_mid
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'_' | b'-'))
    {
        return Err(QQMusicError::Protocol);
    }
    Ok(format!("{prefix}{song_mid}{extension}"))
}

#[derive(Debug, Default, Deserialize)]
struct SearchResponse {
    #[serde(default)]
    code: i32,
    #[serde(default)]
    data: SearchData,
}

#[derive(Debug, Default, Deserialize)]
struct SearchData {
    #[serde(default)]
    song: Option<SearchSongBlock>,
    #[serde(default)]
    album: Option<SearchAlbumBlock>,
}

#[derive(Debug, Default, Deserialize)]
struct SearchSongBlock {
    #[serde(default)]
    list: Vec<NewSongDto>,
    #[serde(default, rename = "totalnum")]
    total_num: u64,
}

#[derive(Debug, Default, Deserialize)]
struct SearchAlbumBlock {
    #[serde(default)]
    list: Vec<SearchAlbumDto>,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct SearchAlbumDto {
    #[serde(default, rename = "albumMID")]
    album_mid: String,
    #[serde(default, rename = "albumName")]
    album_name: String,
    #[serde(default, rename = "singerMID")]
    singer_mid: String,
    #[serde(default, rename = "singerName")]
    singer_name: String,
    #[serde(default, rename = "publicTime")]
    public_time: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct NewSongDto {
    #[serde(default)]
    id: u64,
    #[serde(default)]
    mid: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    singer: Vec<NewSingerDto>,
    #[serde(default)]
    album: NewAlbumDto,
    #[serde(default)]
    interval: u64,
    #[serde(default, rename = "index_album")]
    track_number: i64,
    #[serde(default)]
    file: NewFileDto,
    #[serde(default)]
    pay: NewPayDto,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct NewSingerDto {
    #[serde(default)]
    mid: String,
    #[serde(default)]
    name: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct NewAlbumDto {
    #[serde(default)]
    mid: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    title: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct NewFileDto {
    #[serde(default)]
    media_mid: String,
    #[serde(default)]
    size_128mp3: u64,
    #[serde(default)]
    size_320mp3: u64,
    #[serde(default)]
    size_192aac: u64,
    #[serde(default)]
    size_flac: u64,
    #[serde(default)]
    size_new: Vec<u64>,
    #[serde(default)]
    size_try: u64,
    #[serde(default)]
    try_begin: u64,
    #[serde(default)]
    try_end: u64,
    #[serde(default)]
    b_30s: u64,
    #[serde(default)]
    e_30s: u64,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct NewPayDto {
    #[serde(default)]
    pay_play: u8,
    #[serde(default)]
    pay_month: u8,
}

#[derive(Debug, Default, Deserialize)]
struct AlbumResponse {
    #[serde(default)]
    code: i32,
    #[serde(default)]
    data: Option<AlbumData>,
}

#[derive(Debug, Default, Deserialize)]
struct AlbumData {
    #[serde(default)]
    name: String,
    #[serde(default, rename = "singername")]
    singer_name: String,
    #[serde(default, rename = "singermid")]
    singer_mid: String,
    #[serde(default, rename = "aDate")]
    date: String,
    #[serde(default)]
    genre: String,
    #[serde(default, rename = "desc")]
    description: String,
    #[serde(default)]
    list: Vec<OldSongDto>,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct OldSongDto {
    #[serde(default, rename = "songid")]
    song_id: u64,
    #[serde(default, rename = "songmid")]
    song_mid: String,
    #[serde(default, rename = "songname")]
    song_name: String,
    #[serde(default, rename = "albumid")]
    album_id: u64,
    #[serde(default, rename = "albummid")]
    album_mid: String,
    #[serde(default, rename = "albumname")]
    album_name: String,
    #[serde(default)]
    singer: Vec<OldSingerDto>,
    #[serde(default)]
    interval: u64,
    #[serde(default, rename = "cdIdx")]
    cd_index: i64,
    #[serde(default, rename = "strMediaMid")]
    media_mid: String,
    #[serde(default, rename = "size128")]
    size_128: u64,
    #[serde(default, rename = "size320")]
    size_320: u64,
    #[serde(default, rename = "sizeflac")]
    size_flac: u64,
    #[serde(default)]
    size_new: Vec<u64>,
    #[serde(default)]
    pay: OldPayDto,
    #[serde(default)]
    preview: OldPreviewDto,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct OldSingerDto {
    #[serde(default)]
    mid: String,
    #[serde(default)]
    name: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct OldPayDto {
    #[serde(default, rename = "payplay")]
    pay_play: u8,
    #[serde(default, rename = "paytrackmouth")]
    pay_month: u8,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct OldPreviewDto {
    #[serde(default, rename = "trybegin")]
    try_begin: u64,
    #[serde(default, rename = "tryend")]
    try_end: u64,
    #[serde(default, rename = "trysize")]
    try_size: u64,
}

#[derive(Debug, Default, Deserialize)]
struct PlaylistResponse {
    #[serde(default)]
    code: i32,
    #[serde(default, rename = "cdlist")]
    cd_list: Vec<PlaylistData>,
}

#[derive(Debug, Default, Deserialize)]
struct PlaylistData {
    #[serde(default, rename = "dissname")]
    name: String,
    #[serde(default, rename = "desc")]
    description: String,
    #[serde(default)]
    logo: String,
    #[serde(default)]
    nickname: String,
    #[serde(default, rename = "mtime")]
    modified_at: u64,
    #[serde(default, rename = "songlist")]
    songs: Vec<OldSongDto>,
}

#[derive(Debug, Deserialize)]
struct ToplistEnvelope {
    code: i32,
    #[serde(rename = "req_1")]
    request: ToplistRequest,
}

#[derive(Debug, Deserialize)]
struct ToplistRequest {
    code: i32,
    data: ToplistData,
}

#[derive(Debug, Deserialize)]
struct ToplistData {
    #[serde(rename = "data")]
    details: ToplistDetails,
    #[serde(default, rename = "songInfoList")]
    song_info_list: Vec<NewSongDto>,
}

#[derive(Debug, Default, Deserialize)]
struct ToplistDetails {
    #[serde(default)]
    title: String,
    #[serde(default, rename = "intro")]
    description: String,
    #[serde(default, rename = "updateTime")]
    update_time: String,
    #[serde(default, rename = "topAlbumURL")]
    artwork: String,
    #[serde(default, rename = "frontPicUrl")]
    front_artwork: String,
    #[serde(default, rename = "headPicUrl")]
    head_artwork: String,
    #[serde(default, rename = "magicColor")]
    magic_color: Option<MagicColor>,
}

#[derive(Debug, Deserialize)]
struct MagicColor {
    r: u8,
    g: u8,
    b: u8,
}

#[derive(Debug, Deserialize)]
struct LyricEnvelope {
    code: i32,
    #[serde(rename = "req_1")]
    request: LyricRequest,
}

#[derive(Debug, Deserialize)]
struct LyricRequest {
    code: i32,
    data: LyricData,
}

#[derive(Debug, Default, Deserialize)]
struct LyricData {
    #[serde(default)]
    lyric: String,
    #[serde(default, rename = "trans")]
    translation: String,
    #[serde(default, rename = "roma")]
    romanization: String,
}

#[derive(Debug, Default, Deserialize)]
struct LegacyLyricResponse {
    #[serde(default)]
    code: i32,
    #[serde(default)]
    lyric: String,
    #[serde(default, rename = "trans")]
    translation: String,
    #[serde(default, rename = "roma")]
    romanization: String,
}

#[derive(Debug, Default, Deserialize)]
struct VkeyEnvelope {
    code: i32,
    #[serde(rename = "req_0")]
    request: VkeyRequest,
}

#[derive(Debug, Default, Deserialize)]
struct VkeyRequest {
    code: i32,
    data: VkeyData,
}

#[derive(Debug, Default, Deserialize)]
struct VkeyData {
    #[serde(default)]
    sip: Vec<String>,
    #[serde(default, rename = "midurlinfo")]
    items: Vec<VkeyItem>,
}

#[derive(Debug, Default, Deserialize)]
struct VkeyItem {
    #[serde(default, rename = "purl")]
    path: String,
    #[serde(default)]
    result: i32,
}

struct EncryptedPlaybackSource {
    url: String,
    ekey: EncryptedMediaKey,
}

fn playback_headers() -> Vec<(String, String)> {
    vec![
        ("Referer".to_owned(), "https://y.qq.com/".to_owned()),
        ("Origin".to_owned(), "https://y.qq.com".to_owned()),
    ]
}

fn cookie_value<'a>(header: &'a str, name: &str) -> Option<&'a str> {
    header.split(';').find_map(|part| {
        let (key, value) = part.trim().split_once('=')?;
        (key == name && !value.is_empty()).then_some(value)
    })
}

fn normalize_new_song(raw: NewSongDto) -> Option<Song> {
    let song_mid = non_empty(raw.mid)?;
    let album_mid = non_empty(raw.album.mid).unwrap_or_else(|| "unknown".to_owned());
    let title = clean_text(&non_empty(raw.title).unwrap_or(raw.name));
    if title.is_empty() {
        return None;
    }
    let artists = raw
        .singer
        .into_iter()
        .filter_map(|singer| {
            let name = clean_text(&singer.name);
            if name.is_empty() {
                return None;
            }
            let mid = non_empty(singer.mid).unwrap_or_else(|| stable_component(&name));
            Some(ArtistSummary {
                id: artist_id(&mid),
                name,
            })
        })
        .collect::<Vec<_>>();
    let album_title = clean_text(&non_empty(raw.album.title).unwrap_or(raw.album.name));
    let formats = new_audio_formats(&raw.file);
    let quality = highest_quality(&formats);
    let (availability, playback_capability) = new_playability(&raw.file, &raw.pay);
    let media_id = non_empty(raw.file.media_mid).unwrap_or_else(|| song_mid.clone());
    Some(Song {
        id: track_id(&song_mid),
        title: title.clone(),
        artists,
        album: AlbumSummary {
            id: album_id(&album_mid),
            title: album_title,
        },
        artwork: artwork_for_album(&album_mid, &title),
        duration_ms: raw.interval.saturating_mul(1_000),
        track_number: u32::try_from(raw.track_number)
            .ok()
            .filter(|number| *number > 0)
            .unwrap_or(1),
        is_favorite: false,
        quality,
        availability,
        audio_formats: formats,
        playback_capability: Some(playback_capability),
        provider: Some(ProviderTrackReference {
            provider_id: "qqmusic".to_owned(),
            track_id: song_mid,
            numeric_id: (raw.id > 0).then_some(raw.id),
            album_id: Some(album_mid),
            media_id: Some(media_id),
        }),
    })
}

fn normalize_old_song(raw: OldSongDto, fallback_track_number: u32) -> Option<Song> {
    let formats = old_audio_formats(&raw);
    let quality = highest_quality(&formats);
    let (availability, playback_capability) = old_playability(&raw.pay, &raw.preview);
    let song_mid = non_empty(raw.song_mid)?;
    let album_mid = non_empty(raw.album_mid).unwrap_or_else(|| "unknown".to_owned());
    let title = clean_text(&raw.song_name);
    if title.is_empty() {
        return None;
    }
    let artists = raw
        .singer
        .into_iter()
        .filter_map(|singer| {
            let name = clean_text(&singer.name);
            if name.is_empty() {
                return None;
            }
            let mid = non_empty(singer.mid).unwrap_or_else(|| stable_component(&name));
            Some(ArtistSummary {
                id: artist_id(&mid),
                name,
            })
        })
        .collect::<Vec<_>>();
    let media_id = non_empty(raw.media_mid).unwrap_or_else(|| song_mid.clone());
    Some(Song {
        id: track_id(&song_mid),
        title: title.clone(),
        artists,
        album: AlbumSummary {
            id: album_id(&album_mid),
            title: clean_text(&raw.album_name),
        },
        artwork: artwork_for_album(&album_mid, &title),
        duration_ms: raw.interval.saturating_mul(1_000),
        track_number: u32::try_from(raw.cd_index)
            .ok()
            .filter(|number| *number > 0)
            .unwrap_or(fallback_track_number),
        is_favorite: false,
        quality,
        availability,
        audio_formats: formats,
        playback_capability: Some(playback_capability),
        provider: Some(ProviderTrackReference {
            provider_id: "qqmusic".to_owned(),
            track_id: song_mid,
            numeric_id: (raw.song_id > 0).then_some(raw.song_id),
            album_id: (raw.album_id > 0).then_some(album_mid),
            media_id: Some(media_id),
        }),
    })
}

fn new_audio_formats(file: &NewFileDto) -> Vec<AudioFormatInfo> {
    let mut formats = Vec::new();
    if file.size_new.first().is_some_and(|size| *size > 0) {
        formats.push(AudioFormatInfo {
            quality: AudioQuality::Master,
            codec: AudioCodec::Flac,
            bitrate_kbps: None,
            sample_rate_hz: None,
            bit_depth: None,
            lossless: true,
        });
    }
    if file.size_128mp3 > 0 {
        formats.push(format_info(
            AudioQuality::Standard,
            AudioCodec::Mp3,
            128,
            false,
        ));
    }
    if file.size_192aac > 0 {
        formats.push(format_info(AudioQuality::High, AudioCodec::Aac, 192, false));
    }
    if file.size_320mp3 > 0 {
        formats.push(format_info(AudioQuality::High, AudioCodec::Mp3, 320, false));
    }
    if file.size_flac > 0 {
        formats.push(format_info(
            AudioQuality::Lossless,
            AudioCodec::Flac,
            0,
            true,
        ));
    }
    formats
}

fn old_audio_formats(song: &OldSongDto) -> Vec<AudioFormatInfo> {
    let mut formats = Vec::new();
    if song.size_new.first().is_some_and(|size| *size > 0) {
        formats.push(AudioFormatInfo {
            quality: AudioQuality::Master,
            codec: AudioCodec::Flac,
            bitrate_kbps: None,
            sample_rate_hz: None,
            bit_depth: None,
            lossless: true,
        });
    }
    if song.size_128 > 0 {
        formats.push(format_info(
            AudioQuality::Standard,
            AudioCodec::Mp3,
            128,
            false,
        ));
    }
    if song.size_320 > 0 {
        formats.push(format_info(AudioQuality::High, AudioCodec::Mp3, 320, false));
    }
    if song.size_flac > 0 {
        formats.push(format_info(
            AudioQuality::Lossless,
            AudioCodec::Flac,
            0,
            true,
        ));
    }
    formats
}

fn format_info(
    quality: AudioQuality,
    codec: AudioCodec,
    bitrate_kbps: u32,
    lossless: bool,
) -> AudioFormatInfo {
    AudioFormatInfo {
        quality,
        codec,
        bitrate_kbps: (bitrate_kbps > 0).then_some(bitrate_kbps),
        sample_rate_hz: None,
        bit_depth: None,
        lossless,
    }
}

fn highest_quality(formats: &[AudioFormatInfo]) -> AudioQuality {
    if formats
        .iter()
        .any(|format| format.quality == AudioQuality::Master)
    {
        AudioQuality::Master
    } else if formats
        .iter()
        .any(|format| format.quality == AudioQuality::Lossless)
    {
        AudioQuality::Lossless
    } else if formats
        .iter()
        .any(|format| format.quality == AudioQuality::High)
    {
        AudioQuality::High
    } else {
        AudioQuality::Standard
    }
}

fn new_playability(file: &NewFileDto, pay: &NewPayDto) -> (SongAvailability, PlaybackCapability) {
    if pay.pay_play == 0 {
        return (SongAvailability::Available, PlaybackCapability::Full);
    }
    let start = file.try_begin;
    let has_preview = file.size_try > 0 || file.try_end > start || file.e_30s > file.b_30s;
    let end = if file.try_end > start {
        file.try_end
    } else if file.e_30s > file.b_30s {
        file.e_30s
    } else {
        start.saturating_add(60_000)
    };
    if has_preview {
        return (
            SongAvailability::Available,
            PlaybackCapability::Preview {
                start_ms: start,
                end_ms: end,
            },
        );
    }
    (
        SongAvailability::EntitlementRequired {
            required_tier: if pay.pay_month > 0 {
                "QQ Music VIP"
            } else {
                "Account access"
            }
            .to_owned(),
        },
        PlaybackCapability::Unavailable {
            reason: "entitlement".to_owned(),
        },
    )
}

fn old_playability(
    pay: &OldPayDto,
    preview: &OldPreviewDto,
) -> (SongAvailability, PlaybackCapability) {
    if pay.pay_play == 0 {
        return (SongAvailability::Available, PlaybackCapability::Full);
    }
    let start = preview.try_begin;
    let end = if preview.try_end > start {
        preview.try_end
    } else {
        start.saturating_add(60_000)
    };
    if preview.try_size > 0 {
        return (
            SongAvailability::Available,
            PlaybackCapability::Preview {
                start_ms: start,
                end_ms: end,
            },
        );
    }
    (
        SongAvailability::EntitlementRequired {
            required_tier: if pay.pay_month > 0 {
                "QQ Music VIP"
            } else {
                "Account access"
            }
            .to_owned(),
        },
        PlaybackCapability::Unavailable {
            reason: "entitlement".to_owned(),
        },
    )
}

fn source_candidates(_track_mid: &str, media_mid: &str) -> Vec<SourceCandidate> {
    let master = SourceCandidate {
        filename: format!("AIM0{media_mid}.mflac"),
        cache_label: "master-mflac",
        format: AudioFormat::Flac,
        codec: AudioCodec::Flac,
        mime_type: "audio/flac",
        bitrate_kbps: None,
        quality: AudioQuality::Master,
        preview: false,
        encrypted: true,
        client_supported: true,
    };
    let encrypted_lossless = SourceCandidate {
        filename: format!("F0M0{media_mid}.mflac"),
        cache_label: "lossless-mflac",
        format: AudioFormat::Flac,
        codec: AudioCodec::Flac,
        mime_type: "audio/flac",
        bitrate_kbps: None,
        quality: AudioQuality::Lossless,
        preview: false,
        encrypted: true,
        client_supported: true,
    };
    let lossless = SourceCandidate {
        filename: format!("F000{media_mid}.flac"),
        cache_label: "lossless-flac",
        format: AudioFormat::Flac,
        codec: AudioCodec::Flac,
        mime_type: "audio/flac",
        bitrate_kbps: None,
        quality: AudioQuality::Lossless,
        preview: false,
        encrypted: false,
        client_supported: true,
    };
    let high = SourceCandidate {
        filename: format!("M800{media_mid}.mp3"),
        cache_label: "high-mp3",
        format: AudioFormat::Mp3,
        codec: AudioCodec::Mp3,
        mime_type: "audio/mpeg",
        bitrate_kbps: Some(320),
        quality: AudioQuality::High,
        preview: false,
        encrypted: false,
        client_supported: true,
    };
    let standard = SourceCandidate {
        filename: format!("M500{media_mid}.mp3"),
        cache_label: "standard-mp3",
        format: AudioFormat::Mp3,
        codec: AudioCodec::Mp3,
        mime_type: "audio/mpeg",
        bitrate_kbps: Some(128),
        quality: AudioQuality::Standard,
        preview: false,
        encrypted: false,
        client_supported: true,
    };
    let aac = SourceCandidate {
        filename: format!("C400{media_mid}.m4a"),
        cache_label: "efficient-aac",
        format: AudioFormat::Aac,
        codec: AudioCodec::Aac,
        mime_type: "audio/mp4",
        bitrate_kbps: Some(96),
        quality: AudioQuality::Standard,
        preview: false,
        encrypted: false,
        client_supported: true,
    };
    let preview = SourceCandidate {
        filename: format!("RS02{media_mid}.mp3"),
        cache_label: "official-preview-mp3",
        format: AudioFormat::Mp3,
        codec: AudioCodec::Mp3,
        mime_type: "audio/mpeg",
        bitrate_kbps: Some(128),
        quality: AudioQuality::Standard,
        preview: true,
        encrypted: false,
        client_supported: true,
    };
    vec![
        master,
        encrypted_lossless,
        lossless,
        high,
        standard,
        aac,
        preview,
    ]
}

fn decrypt_provider_lyric(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if value.starts_with('<') || value.starts_with('[') {
        return Some(value.to_owned());
    }
    decrypt_qrc(value)
}

fn parse_qrc_document(song_mid: &str, raw: &str) -> Option<LyricDocument> {
    let content = extract_qrc_content(raw).unwrap_or_else(|| raw.to_owned());
    let mut lines = Vec::new();
    for (line_number, raw_line) in content.lines().enumerate() {
        let line = raw_line.trim();
        let Some((line_start, line_duration, body)) = parse_qrc_line_header(line) else {
            continue;
        };
        let line_end = line_start.saturating_add(line_duration);
        let words = parse_qrc_words(body, line_start, line_end);
        let text = if words.is_empty() {
            clean_text(body)
        } else {
            words.iter().map(|word| word.text.as_str()).collect()
        };
        if text.trim().is_empty() {
            continue;
        }
        lines.push(LyricLine {
            id: format!("qqmusic:{song_mid}:qrc:{line_number}"),
            start_ms: Some(line_start),
            end_ms: Some(line_end),
            text,
            translation: None,
            romanization: None,
            vocalist_id: None,
            words,
        });
    }
    if lines.is_empty() {
        return None;
    }
    Some(LyricDocument {
        song_id: track_id(song_mid),
        sync_mode: if lines.iter().any(|line| !line.words.is_empty()) {
            LyricSyncMode::Word
        } else {
            LyricSyncMode::Line
        },
        metadata: LyricMetadata {
            source_label: "QQ Music QRC".to_owned(),
            language: None,
            translated_language: None,
            offset_ms: 0,
        },
        vocalists: vec![],
        lines,
    })
}

fn extract_qrc_content(raw: &str) -> Option<String> {
    if !raw.trim_start().starts_with('<') {
        return None;
    }
    let mut reader = Reader::from_str(raw);
    reader.config_mut().trim_text(false);
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element)) => {
                for attribute in element.attributes().flatten() {
                    if attribute.key.as_ref() == b"LyricContent" {
                        return attribute
                            .decode_and_unescape_value(reader.decoder())
                            .ok()
                            .map(|value| value.into_owned());
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => return None,
            _ => {}
        }
    }
}

fn parse_qrc_line_header(line: &str) -> Option<(u64, u64, &str)> {
    let close = line.find(']')?;
    let header = line.strip_prefix('[')?.get(..close - 1)?;
    let mut parts = header.split(',');
    let start = parts.next()?.trim().parse().ok()?;
    let duration = parts.next()?.trim().parse().ok()?;
    Some((start, duration, &line[close + 1..]))
}

fn parse_qrc_words(body: &str, line_start: u64, line_end: u64) -> Vec<LyricWord> {
    let mut words = Vec::new();
    let mut text_start = 0;
    let mut scan = 0;
    while scan < body.len() {
        let Some(open_offset) = body[scan..].find('(') else {
            break;
        };
        let open = scan + open_offset;
        let Some(close_offset) = body[open + 1..].find(')') else {
            break;
        };
        let close = open + 1 + close_offset;
        let timing = &body[open + 1..close];
        let values = timing.split(',').take(3).map(str::trim).collect::<Vec<_>>();
        let parsed = values.len() >= 2
            && values[0]
                .chars()
                .all(|character| character.is_ascii_digit())
            && values[1]
                .chars()
                .all(|character| character.is_ascii_digit());
        if !parsed {
            // A literal parenthesis may immediately wrap a timed word, for example
            // `花田错 ((342,114)Live)`. Resume one byte after the candidate opening
            // parenthesis so the nested timing marker is still considered.
            scan = open + 1;
            continue;
        }
        let start = values[0].parse::<u64>().unwrap_or(line_start);
        let duration = values[1].parse::<u64>().unwrap_or(0);
        let text = &body[text_start..open];
        if !text.is_empty() {
            words.push(LyricWord {
                start_ms: start.max(line_start),
                end_ms: start.saturating_add(duration).min(line_end).max(start),
                text: text.to_owned(),
            });
        }
        text_start = close + 1;
        scan = close + 1;
    }
    if text_start < body.len() {
        let trailing = &body[text_start..];
        if !trailing.is_empty() {
            let start = words.last().map_or(line_start, |word| word.end_ms);
            words.push(LyricWord {
                start_ms: start,
                end_ms: line_end.max(start),
                text: trailing.to_owned(),
            });
        }
    }
    words
}

fn parse_lrc_document(song_mid: &str, raw: &str) -> Option<LyricDocument> {
    let timed = parse_lrc_timed(raw);
    if timed.is_empty() {
        let plain = raw
            .lines()
            .filter(|line| !line.trim_start().starts_with('['))
            .map(clean_text)
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>();
        if plain.is_empty() {
            return None;
        }
        return Some(LyricDocument {
            song_id: track_id(song_mid),
            sync_mode: LyricSyncMode::Unsynchronized,
            metadata: LyricMetadata {
                source_label: "QQ Music lyrics".to_owned(),
                language: None,
                translated_language: None,
                offset_ms: lrc_offset(raw),
            },
            vocalists: vec![],
            lines: plain
                .into_iter()
                .enumerate()
                .map(|(index, text)| LyricLine {
                    id: format!("qqmusic:{song_mid}:plain:{index}"),
                    start_ms: None,
                    end_ms: None,
                    text,
                    translation: None,
                    romanization: None,
                    vocalist_id: None,
                    words: vec![],
                })
                .collect(),
        });
    }
    let mut lines = Vec::with_capacity(timed.len());
    for (index, (start_ms, text)) in timed.iter().enumerate() {
        if text.trim().is_empty() {
            continue;
        }
        lines.push(LyricLine {
            id: format!("qqmusic:{song_mid}:lrc:{index}"),
            start_ms: Some(*start_ms),
            end_ms: timed.get(index + 1).map(|(next, _)| *next),
            text: text.clone(),
            translation: None,
            romanization: None,
            vocalist_id: None,
            words: vec![],
        });
    }
    Some(LyricDocument {
        song_id: track_id(song_mid),
        sync_mode: LyricSyncMode::Line,
        metadata: LyricMetadata {
            source_label: "QQ Music LRC".to_owned(),
            language: None,
            translated_language: None,
            offset_ms: lrc_offset(raw),
        },
        vocalists: vec![],
        lines,
    })
}

fn parse_lrc_timed(raw: &str) -> Vec<(u64, String)> {
    let mut lines = Vec::new();
    for raw_line in raw.lines() {
        let mut remaining = raw_line.trim();
        let mut timestamps = Vec::new();
        while let Some(rest) = remaining.strip_prefix('[') {
            let Some(close) = rest.find(']') else {
                break;
            };
            let tag = &rest[..close];
            if let Some(timestamp) = parse_lrc_timestamp(tag) {
                timestamps.push(timestamp);
            }
            remaining = &rest[close + 1..];
        }
        let text = clean_text(remaining);
        for timestamp in timestamps {
            lines.push((timestamp, text.clone()));
        }
    }
    lines.sort_by_key(|(timestamp, _)| *timestamp);
    lines
}

fn parse_lrc_timestamp(value: &str) -> Option<u64> {
    let (minutes, seconds) = value.split_once(':')?;
    let minutes = minutes.trim().parse::<u64>().ok()?;
    let seconds = seconds.trim().parse::<f64>().ok()?;
    if !seconds.is_finite() || seconds < 0.0 {
        return None;
    }
    Some(
        minutes
            .saturating_mul(60_000)
            .saturating_add((seconds * 1_000.0).round() as u64),
    )
}

fn lrc_offset(raw: &str) -> i64 {
    raw.lines()
        .find_map(|line| {
            line.trim()
                .strip_prefix("[offset:")?
                .strip_suffix(']')?
                .parse()
                .ok()
        })
        .unwrap_or(0)
}

fn attach_companion_lyrics(
    document: &mut LyricDocument,
    translation: Option<&str>,
    romanization: Option<&str>,
) {
    let translation = translation.map(parse_lrc_timed).unwrap_or_default();
    let romanization = romanization.map(parse_lrc_timed).unwrap_or_default();
    for line in &mut document.lines {
        let Some(start) = line.start_ms else {
            continue;
        };
        line.translation = companion_at(&translation, start);
        line.romanization = companion_at(&romanization, start);
    }
    if document.lines.iter().any(|line| line.translation.is_some()) {
        document.metadata.translated_language = Some("provider-supplied".to_owned());
    }
}

fn companion_at(companion: &[(u64, String)], start: u64) -> Option<String> {
    companion
        .iter()
        .min_by_key(|(candidate, _)| candidate.abs_diff(start))
        .filter(|(candidate, _)| candidate.abs_diff(start) <= 500)
        .map(|(_, text)| text.clone())
        .filter(|text| !text.trim().is_empty())
}

fn album_from_songs(summary: &AlbumSummary, artists: &[ArtistSummary], songs: Vec<Song>) -> Album {
    let mid = summary
        .id
        .strip_prefix("qqmusic:album:")
        .unwrap_or(&summary.id);
    Album {
        id: summary.id.clone(),
        title: summary.title.clone(),
        artist: artists.first().cloned().unwrap_or_else(|| ArtistSummary {
            id: "qqmusic:artist:unknown".to_owned(),
            name: "Various artists".to_owned(),
        }),
        artwork: artwork_for_album(mid, &summary.title),
        release_year: 0,
        genre: "QQ Music".to_owned(),
        description: "Live QQ Music catalog metadata.".to_owned(),
        tracks: songs,
    }
}

fn normalize_cdn_base(value: &str) -> Option<String> {
    let upgraded = upgrade_https(value);
    let url = reqwest::Url::parse(&upgraded).ok()?;
    let host = url.host_str()?;
    if url.scheme() != "https"
        || !(host.ends_with(".qqmusic.qq.com") || host.ends_with(".tc.qq.com"))
    {
        return None;
    }
    Some(format!("{}://{}/", url.scheme(), host))
}

fn normalize_cdn_url(base: &str, path: &str) -> Result<String, QQMusicError> {
    let base = reqwest::Url::parse(base).map_err(|_| QQMusicError::MalformedResponse)?;
    let url = base
        .join(path)
        .map_err(|_| QQMusicError::MalformedResponse)?;
    let host = url.host_str().ok_or(QQMusicError::MalformedResponse)?;
    if url.scheme() != "https"
        || !(host.ends_with(".qqmusic.qq.com") || host.ends_with(".tc.qq.com"))
    {
        return Err(QQMusicError::MalformedResponse);
    }
    Ok(url.to_string())
}

fn clean_text(value: &str) -> String {
    let stripped = value
        .replace("<em>", "")
        .replace("</em>", "")
        .replace("<br>", "\n")
        .replace("<br/>", "\n")
        .replace("<br />", "\n");
    unescape(stripped.trim())
        .map(|value| value.into_owned())
        .unwrap_or_else(|_| stripped.trim().to_owned())
}

fn non_empty(value: String) -> Option<String> {
    (!value.trim().is_empty()).then(|| value.trim().to_owned())
}

fn parse_year(value: &str) -> u32 {
    value
        .get(..4)
        .and_then(|year| year.parse().ok())
        .unwrap_or(0)
}

fn color_for(value: &str) -> String {
    const PALETTE: [&str; 8] = [
        "#6b4f46", "#53606f", "#4c6259", "#705f48", "#5a526f", "#44636d", "#6d4e5d", "#59624a",
    ];
    let index = value.bytes().fold(0_usize, |hash, byte| {
        hash.wrapping_mul(31).wrapping_add(byte as usize)
    }) % PALETTE.len();
    PALETTE[index].to_owned()
}

fn track_id(mid: &str) -> String {
    format!("qqmusic:track:{mid}")
}

fn album_id(mid: &str) -> String {
    format!("qqmusic:album:{mid}")
}

fn artist_id(mid: &str) -> String {
    format!("qqmusic:artist:{mid}")
}

fn playlist_id(id: &str) -> String {
    format!("qqmusic:playlist:{id}")
}

fn strip_entity_prefix<'a>(value: &'a str, prefix: &str) -> &'a str {
    value.strip_prefix(prefix).unwrap_or(value)
}

fn stable_component(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .take(80)
        .collect()
}

fn recent_history_fallback_eligible(error: &QQMusicError) -> bool {
    matches!(
        error,
        QQMusicError::Offline
            | QQMusicError::Timeout
            | QQMusicError::RateLimited
            | QQMusicError::SchemaChanged
            | QQMusicError::MalformedResponse
            | QQMusicError::Protocol
            | QQMusicError::UnsupportedOperation
    )
}

fn merge_recent_history(
    mut remote: Page<RemotePlayHistoryItem>,
    local: Vec<RemotePlayHistoryItem>,
    limit: u32,
) -> Page<RemotePlayHistoryItem> {
    let mut by_song = HashMap::<String, RemotePlayHistoryItem>::new();
    for item in remote.items.drain(..).chain(local) {
        let song_id = item.song.id.clone();
        let replace = by_song.get(&song_id).is_none_or(|existing| {
            item.played_at_ms.unwrap_or_default() > existing.played_at_ms.unwrap_or_default()
        });
        if replace {
            by_song.insert(song_id, item);
        }
    }
    let mut items = by_song.into_values().collect::<Vec<_>>();
    items.sort_by_key(|item| std::cmp::Reverse(item.played_at_ms.unwrap_or_default()));
    items.truncate(limit as usize);
    remote.total = remote.total.map(|total| total.max(items.len() as u64));
    remote.items = items;
    remote
}

fn stable_guid() -> String {
    let value = unix_timestamp_ms() % 9_000_000_000 + 1_000_000_000;
    value.to_string()
}

fn qq_request_signature(body: &[u8]) -> String {
    const HEAD: [usize; 8] = [21, 4, 9, 26, 16, 20, 27, 30];
    const TAIL: [usize; 8] = [18, 11, 3, 2, 1, 7, 6, 25];
    const XOR: [u8; 16] = [
        212, 45, 80, 68, 195, 163, 163, 203, 157, 220, 254, 91, 204, 79, 104, 6,
    ];
    let digest = Md5::digest(body);
    let hexadecimal = format!("{digest:X}");
    let bytes = hexadecimal.as_bytes();
    let head = HEAD
        .map(|index| bytes[index] as char)
        .iter()
        .collect::<String>();
    let tail = TAIL
        .map(|index| bytes[index] as char)
        .iter()
        .collect::<String>();
    let middle = digest
        .iter()
        .zip(XOR)
        .map(|(byte, mask)| byte ^ mask)
        .collect::<Vec<_>>();
    let middle = base64::engine::general_purpose::STANDARD.encode(middle);
    format!("zzb{head}{middle}{tail}")
        .to_ascii_lowercase()
        .replace(['/', '+', '='], "")
}

fn map_encrypted_source_code(code: i64) -> QQMusicError {
    match code {
        1_000 | 4_000 => QQMusicError::AuthenticationExpired,
        2_000 => QQMusicError::Protocol,
        _ => QQMusicError::NotFound,
    }
}

fn upgrade_https(value: &str) -> String {
    value.trim().replacen("http://", "https://", 1)
}

fn unix_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::account::AccountState;
    use super::transport::{TransportRequest, TransportResponse};
    use super::*;
    use crate::{
        audio::{AudioEngine, RodioAudioEngine},
        credentials::MemoryCredentialStore,
        media::{CachedMediaPreparer, MediaPreparer, PlaybackSourceResolver},
    };
    use axum::{response::Redirect, routing::get, Router};
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct RecordingAccountTransport {
        calls: Arc<AtomicUsize>,
    }

    #[async_trait::async_trait]
    impl QqTransport for RecordingAccountTransport {
        async fn execute(
            &self,
            _request: TransportRequest,
        ) -> Result<TransportResponse, QQMusicError> {
            self.calls.fetch_add(1, Ordering::AcqRel);
            Err(QQMusicError::Protocol)
        }
    }

    #[test]
    fn signed_endpoint_signature_matches_published_vector() {
        let body = br#"{"module":"music.search.SearchCgiService","method":"DoSearchForQQMusicMobile","param":{"searchid":"xxx","query":"asdfsadf","search_type":0,"num_per_page":10,"page_num":1,"highlight":1,"grp":1}}"#;
        assert_eq!(
            qq_request_signature(body),
            "zzb226c4cd6u6x73owgk9ltzzy8yktygb3187a9d"
        );
    }

    #[test]
    fn encrypted_source_payload_uses_the_exact_dynamic_module_key() {
        let payload = encrypted_source_payload(
            "fixture-auth",
            "10001",
            "2",
            "TRACKMID",
            vec!["AIM0INTERNALMID.mflac".to_owned()],
            vec!["AIM0TRACKMID.mflac".to_owned()],
            "1234567890".to_owned(),
        );

        assert!(payload.get(QQ_EVKEY_MODULE_KEY).is_some());
        assert!(payload.get("module_key").is_none());
        assert_eq!(
            payload.pointer(&format!("/{QQ_EVKEY_MODULE_KEY}/method")),
            Some(&Value::String("CgiGetEVkey".to_owned()))
        );
        assert_eq!(
            payload
                .pointer(&format!("/{QQ_EVKEY_MODULE_KEY}/param/filename/0"))
                .and_then(Value::as_str),
            Some("AIM0INTERNALMID.mflac")
        );
        assert_eq!(
            payload
                .pointer(&format!("/{QQ_EVKEY_MODULE_KEY}/param/musicfile/0"))
                .and_then(Value::as_str),
            Some("AIM0TRACKMID.mflac")
        );
        assert_eq!(
            payload
                .pointer(&format!("/{QQ_EVKEY_MODULE_KEY}/param/songmid/0"))
                .and_then(Value::as_str),
            Some("TRACKMID")
        );
        assert_eq!(
            payload
                .pointer(&format!("/{QQ_EVKEY_MODULE_KEY}/param/songtype/0"))
                .and_then(Value::as_u64),
            Some(1)
        );
        assert_eq!(
            payload
                .pointer(&format!("/{QQ_EVKEY_MODULE_KEY}/param/uin"))
                .and_then(Value::as_str),
            Some("10001")
        );
    }

    #[test]
    fn encrypted_source_codes_only_expire_explicitly_invalid_sessions() {
        assert!(matches!(
            map_encrypted_source_code(1_000),
            QQMusicError::AuthenticationExpired
        ));
        assert!(matches!(
            map_encrypted_source_code(4_000),
            QQMusicError::AuthenticationExpired
        ));
        assert!(matches!(
            map_encrypted_source_code(2_000),
            QQMusicError::Protocol
        ));
        assert!(matches!(
            map_encrypted_source_code(104_003),
            QQMusicError::NotFound
        ));
    }

    #[tokio::test]
    async fn current_track_quality_override_is_scoped_and_does_not_replace_the_default() {
        let root = tempfile::tempdir().expect("temp root");
        let storage = Arc::new(
            StorageService::open(root.path().join("data"), root.path().join("cache"))
                .expect("storage"),
        );
        let service = QQMusicService::new(
            storage,
            Arc::new(MemoryCredentialStore::default()),
            root.path().join("fixtures"),
        )
        .expect("service");
        *service.preferred_quality.write().await = AudioQualityPreference::High;

        service
            .set_current_quality("TRACK_A".to_owned(), AudioQualityPreference::Master)
            .await
            .expect("set current quality");

        assert_eq!(
            service.playback_quality_for("TRACK_A").await,
            AudioQualityPreference::Master
        );
        assert_eq!(
            service.playback_quality_for("TRACK_B").await,
            AudioQualityPreference::High
        );
        assert_eq!(
            service.playback_quality_for("TRACK_A").await,
            AudioQualityPreference::High
        );
    }

    #[test]
    fn encrypted_lossless_and_master_candidates_use_internal_media_mid_filenames() {
        let candidates = source_candidates("TRACK_MID", "MEDIA_MID");
        let encrypted = candidates
            .iter()
            .filter(|candidate| candidate.encrypted)
            .map(|candidate| (candidate.quality, candidate.filename.as_str()))
            .collect::<Vec<_>>();

        assert_eq!(
            encrypted,
            vec![
                (AudioQuality::Master, "AIM0MEDIA_MID.mflac"),
                (AudioQuality::Lossless, "F0M0MEDIA_MID.mflac"),
            ]
        );
    }

    #[test]
    fn encrypted_musicfile_uses_song_mid_and_preserves_format() {
        assert_eq!(
            encrypted_musicfile("AIM0INTERNAL_MID.mflac", "TRACK_MID").expect("valid filename"),
            "AIM0TRACK_MID.mflac"
        );
        assert!(encrypted_musicfile("invalid", "TRACK_MID").is_err());
        assert!(encrypted_musicfile("AIM0INTERNAL.mflac", "../secret").is_err());
    }

    #[test]
    fn catalog_status_serialization_contains_no_account_projection() {
        let value = serde_json::to_value(ProviderStatus {
            provider_id: "qqmusic".to_owned(),
            display_name: "QQ Music".to_owned(),
            connection: "online".to_owned(),
            message: "Public catalog access is available.".to_owned(),
            preferred_quality: AudioQualityPreference::Automatic,
            capabilities: CatalogProviderCapabilities {
                search: true,
                album: true,
                artist: true,
                playlist: true,
                lyrics: true,
                word_timed_lyrics: true,
                streaming: true,
                quality_selection: true,
            },
        })
        .expect("catalog status serializes");

        assert!(value.get("account").is_none());
        let capabilities = value["capabilities"]
            .as_object()
            .expect("capabilities object");
        assert_eq!(capabilities.len(), 8);
        for forbidden in [
            "account",
            "favoriteRead",
            "favoriteWrite",
            "playlistRead",
            "playlistWrite",
            "qrLogin",
        ] {
            assert!(capabilities.get(forbidden).is_none());
        }
    }

    #[test]
    fn local_recent_history_replaces_older_remote_duplicates_and_keeps_time_order() {
        let mut remote_song = normalize_new_song(
            serde_json::from_str::<SearchResponse>(include_str!(
                "../tests/fixtures/qqmusic/search-song.json"
            ))
            .expect("search fixture")
            .data
            .song
            .expect("song block")
            .list
            .remove(0),
        )
        .expect("song normalizes");
        let mut local_song = remote_song.clone();
        local_song.title = "Locally remembered title".to_owned();
        let second_song = Song {
            id: "qqmusic:track:SECOND".to_owned(),
            title: "Second".to_owned(),
            ..remote_song.clone()
        };
        remote_song.title = "Older remote title".to_owned();
        let remote = Page {
            items: vec![RemotePlayHistoryItem {
                song: remote_song,
                played_at_ms: Some(100),
                source: RemotePlayHistorySource::QqmusicAccount,
            }],
            next_cursor: None,
            total: Some(1),
            fetched_at_ms: 1,
            stale: false,
            auth_revision: 3,
        };
        let merged = merge_recent_history(
            remote,
            vec![
                RemotePlayHistoryItem {
                    song: local_song,
                    played_at_ms: Some(300),
                    source: RemotePlayHistorySource::LocalPlayback,
                },
                RemotePlayHistoryItem {
                    song: second_song,
                    played_at_ms: Some(200),
                    source: RemotePlayHistorySource::LocalPlayback,
                },
            ],
            100,
        );

        assert_eq!(merged.items.len(), 2);
        assert_eq!(merged.items[0].song.title, "Locally remembered title");
        assert_eq!(
            merged.items[0].source,
            RemotePlayHistorySource::LocalPlayback
        );
        assert_eq!(merged.items[1].song.id, "qqmusic:track:SECOND");
    }

    #[test]
    fn recent_history_falls_back_only_for_provider_availability_and_shape_failures() {
        for error in [
            QQMusicError::Offline,
            QQMusicError::Timeout,
            QQMusicError::RateLimited,
            QQMusicError::SchemaChanged,
            QQMusicError::MalformedResponse,
            QQMusicError::Protocol,
            QQMusicError::UnsupportedOperation,
        ] {
            assert!(recent_history_fallback_eligible(&error));
        }
        assert!(!recent_history_fallback_eligible(
            &QQMusicError::AuthenticationExpired
        ));
        assert!(!recent_history_fallback_eligible(&QQMusicError::Storage));
    }

    #[tokio::test]
    async fn public_catalog_does_not_use_the_account_transport() {
        let root = tempfile::tempdir().expect("temp root");
        let storage = Arc::new(
            StorageService::open(root.path().join("data"), root.path().join("cache"))
                .expect("storage"),
        );
        let album = Album {
            id: "qqmusic:album:fixture".to_owned(),
            title: "Fixture album".to_owned(),
            artist: ArtistSummary {
                id: "qqmusic:artist:fixture".to_owned(),
                name: "Fixture artist".to_owned(),
            },
            artwork: Artwork {
                src: "/cover.svg".to_owned(),
                alt: "Fixture cover".to_owned(),
                dominant_color: "#000000".to_owned(),
                variants: Vec::new(),
            },
            release_year: 2026,
            genre: "Fixture".to_owned(),
            description: "Cached public catalog fixture".to_owned(),
            tracks: Vec::new(),
        };
        storage
            .put_json(
                "qqmusic:home",
                "metadata",
                &HomeFeed {
                    featured: FeaturedRelease {
                        eyebrow: "FIXTURE".to_owned(),
                        album,
                    },
                    recently_played: Vec::new(),
                    made_for_you: Vec::new(),
                    new_releases: Vec::new(),
                },
                METADATA_TTL_MS,
            )
            .expect("cache fixture");
        let calls = Arc::new(AtomicUsize::new(0));
        let account_transport: Arc<dyn QqTransport> = Arc::new(RecordingAccountTransport {
            calls: Arc::clone(&calls),
        });
        let clock: Arc<dyn Clock> = Arc::new(clock::ManualClock::new(4_200));
        let service = QQMusicService::new_with_runtime(
            Arc::clone(&storage),
            Arc::new(MemoryCredentialStore::default()),
            root.path().join("fixtures"),
            account_transport,
            clock,
        )
        .expect("service");

        let home = service.home().await.expect("cached public home");

        assert_eq!(home.featured.album.id, "qqmusic:album:fixture");
        assert_eq!(calls.load(Ordering::Acquire), 0);
        assert_eq!(service.clock.now_ms(), 4_200);
        assert!(Arc::strong_count(&service.account_transport) >= 1);
    }

    #[test]
    fn sanitized_search_fixture_normalizes_provider_identity_and_formats() {
        let response: SearchResponse =
            serde_json::from_str(include_str!("../tests/fixtures/qqmusic/search-song.json"))
                .expect("sanitized fixture parses");
        let raw = response.data.song.expect("song block").list.remove(0);
        let song = normalize_new_song(raw).expect("song normalizes");
        assert_eq!(song.id, "qqmusic:track:SANITIZED_TRACK_MID");
        assert_eq!(song.title, "Fixture & Song");
        assert_eq!(
            song.provider
                .as_ref()
                .expect("provider")
                .media_id
                .as_deref(),
            Some("SANITIZED_MEDIA_MID")
        );
        assert!(song
            .audio_formats
            .iter()
            .any(|format| format.codec == AudioCodec::Flac));
        assert_eq!(song.playback_capability, Some(PlaybackCapability::Full));
    }

    #[test]
    fn partial_album_fixture_preserves_official_preview_entitlement() {
        let response: AlbumResponse =
            serde_json::from_str(include_str!("../tests/fixtures/qqmusic/album-partial.json"))
                .expect("partial fixture parses");
        let song = normalize_old_song(response.data.expect("album").list.remove(0), 1)
            .expect("partial song normalizes");
        assert_eq!(
            song.playback_capability,
            Some(PlaybackCapability::Preview {
                start_ms: 30_000,
                end_ms: 90_000,
            })
        );
        assert!(matches!(song.availability, SongAvailability::Available));
    }

    #[test]
    fn paid_track_without_preview_is_not_marked_playable() {
        let file = NewFileDto::default();
        let pay = NewPayDto {
            pay_play: 1,
            pay_month: 1,
        };
        let (availability, capability) = new_playability(&file, &pay);
        assert!(matches!(
            availability,
            SongAvailability::EntitlementRequired { .. }
        ));
        assert!(matches!(capability, PlaybackCapability::Unavailable { .. }));
    }

    #[test]
    fn malformed_negative_track_number_does_not_reject_a_search_page() {
        let raw: NewSongDto = serde_json::from_str(
            r#"{
                "mid":"TRACK",
                "title":"Fixture",
                "index_album":-31073,
                "singer":[{"mid":"ARTIST","name":"Artist"}],
                "album":{"mid":"ALBUM","name":"Album"},
                "file":{"media_mid":"MEDIA","size_128mp3":1024},
                "pay":{"pay_play":0}
            }"#,
        )
        .expect("negative provider value remains parseable");
        let song = normalize_new_song(raw).expect("song normalizes");

        assert_eq!(song.track_number, 1);
    }

    #[test]
    fn qrc_and_companion_lyrics_normalize_to_word_timing() {
        let raw = r#"<QrcInfos><LyricInfo LyricContent="[0,2000]Fixture(0,900) lyric(900,1100)&#10;[2500,1500]Second(2500,1500)" /></QrcInfos>"#;
        let mut document = parse_qrc_document("TRACK", raw).expect("QRC parses");
        attach_companion_lyrics(
            &mut document,
            Some("[00:00.00]Translation\n[00:02.50]Second translation"),
            Some("[00:00.00]Romanization"),
        );
        assert_eq!(document.sync_mode, LyricSyncMode::Word);
        assert_eq!(document.lines.len(), 2);
        assert_eq!(document.lines[0].words[1].start_ms, 900);
        assert_eq!(
            document.lines[0].translation.as_deref(),
            Some("Translation")
        );
        assert_eq!(
            document.lines[0].romanization.as_deref(),
            Some("Romanization")
        );
    }

    #[test]
    fn qrc_parser_preserves_literal_parentheses_around_timed_words() {
        let raw = r#"[0,1000]Title ((100,400)Live)(500,500)"#;
        let document = parse_qrc_document("TRACK", raw).expect("QRC parses");

        assert_eq!(document.lines[0].text, "Title (Live)");
        assert_eq!(document.lines[0].words.len(), 2);
        assert_eq!(document.lines[0].words[1].text, "Live)");
    }

    #[test]
    fn lrc_parser_handles_offsets_multiple_timestamps_and_gaps() {
        let document = parse_lrc_document(
            "TRACK",
            "[offset:-120]\n[00:01.00][00:02.00]Repeated\n[00:04.50]Final",
        )
        .expect("LRC parses");
        assert_eq!(document.metadata.offset_ms, -120);
        assert_eq!(document.lines.len(), 3);
        assert_eq!(document.lines[1].start_ms, Some(2_000));
        assert_eq!(document.lines[2].start_ms, Some(4_500));
    }

    #[test]
    fn playback_urls_accept_only_known_https_cdn_hosts() {
        assert!(normalize_cdn_url(
            "https://aqqmusic.tc.qq.com/amobile.music.tc.qq.com/",
            "C400fixture.m4a?vkey=redacted"
        )
        .is_ok());
        assert!(
            normalize_cdn_url("https://example.invalid/", "C400fixture.m4a?vkey=redacted").is_err()
        );
    }

    #[test]
    fn artwork_urls_accept_only_exact_https_origins_without_credentials() {
        for value in [
            "https://y.gtimg.cn/a.jpg",
            "https://y.gtimg.cn:443/a.jpg",
            "https://qpic.y.qq.com/a.jpg",
        ] {
            assert!(is_allowed_artwork_url(value), "expected allowed: {value}");
        }
        for value in [
            "http://y.gtimg.cn/a.jpg",
            "https://sub.y.gtimg.cn/a.jpg",
            "https://user:password@y.gtimg.cn/a.jpg",
            "https://y.gtimg.cn:444/a.jpg",
            "https://aqqmusic.tc.qq.com/a.jpg",
            "https://music.tc.qq.com/a.jpg",
            "https://example.com/a.jpg",
        ] {
            assert!(!is_allowed_artwork_url(value), "expected rejected: {value}");
        }
    }

    #[tokio::test]
    async fn artwork_http_client_does_not_follow_redirects() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("loopback listener");
        let address = listener.local_addr().expect("loopback address");
        let redirected_hits = Arc::new(AtomicUsize::new(0));
        let target_hits = Arc::clone(&redirected_hits);
        let redirect_target = format!("http://{address}/redirected");
        let app = Router::new()
            .route(
                "/artwork",
                get(move || {
                    let redirect_target = redirect_target.clone();
                    async move { Redirect::temporary(&redirect_target) }
                }),
            )
            .route(
                "/redirected",
                get(move || {
                    let target_hits = Arc::clone(&target_hits);
                    async move {
                        target_hits.fetch_add(1, Ordering::SeqCst);
                        "unexpected redirect target"
                    }
                }),
            );
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("redirect test server");
        });
        let client = QQMusicClient::new().expect("QQ Music client");

        let response = client
            .artwork_http
            .get(format!("http://{address}/artwork"))
            .send()
            .await
            .expect("redirect response");

        assert!(response.status().is_redirection());
        assert_eq!(redirected_hits.load(Ordering::SeqCst), 0);
        server.abort();
    }

    #[tokio::test]
    #[ignore = "opt-in current QQ Music network contract check"]
    async fn live_search_second_page_contract() {
        let client = QQMusicClient::new().expect("client");
        let result = client
            .search("花田错", 2, 20)
            .await
            .expect("second search page");

        assert_eq!(result.page, 2);
        assert!(!result.songs.is_empty());
    }

    #[tokio::test]
    #[ignore = "opt-in current QQ Music network contract check"]
    async fn live_public_catalog_search_and_lyrics() {
        let root = tempfile::tempdir().expect("temp root");
        let storage = Arc::new(
            StorageService::open(root.path().join("data"), root.path().join("cache"))
                .expect("storage"),
        );
        let service = QQMusicService::new(
            storage,
            Arc::new(MemoryCredentialStore::default()),
            root.path().join("fixtures"),
        )
        .expect("service");
        let result = service
            .search("晴天".to_owned(), 1, 5)
            .await
            .expect("live search");
        let song = result.songs.first().expect("at least one song");
        let album = service
            .album(song.album.id.clone())
            .await
            .expect("live album metadata");
        assert!(!album.tracks.is_empty());
        let chart = service
            .playlist("qqmusic:toplist:62".to_owned())
            .await
            .expect("live playlist metadata");
        assert!(!chart.tracks.is_empty());
        let lyrics = service
            .lyrics(song.id.clone())
            .await
            .expect("live lyrics")
            .expect("lyrics present");
        assert!(!lyrics.lines.is_empty());
        let artwork = service
            .artwork_data_uri(song.artwork.src.clone())
            .await
            .expect("artwork cache");
        assert!(artwork.starts_with("data:image/"));
    }

    #[tokio::test]
    #[ignore = "opt-in audible QQ Music playback acceptance"]
    async fn live_guest_source_downloads_decodes_and_uses_real_audio_clock() {
        let root = tempfile::tempdir().expect("temp root");
        let storage = Arc::new(
            StorageService::open(root.path().join("data"), root.path().join("cache"))
                .expect("storage"),
        );
        let service = Arc::new(
            QQMusicService::new(
                Arc::clone(&storage),
                Arc::new(MemoryCredentialStore::default()),
                root.path().join("fixtures"),
            )
            .expect("service"),
        );
        let home = service.home().await.expect("live home feed");
        let tracks = home
            .made_for_you
            .into_iter()
            .flat_map(|playlist| playlist.tracks)
            .collect::<Vec<_>>();
        let mut resolved = None;
        for song in tracks {
            if !matches!(song.availability, SongAvailability::Available) {
                continue;
            }
            if let Ok(source) = service.resolve(&song).await {
                resolved = Some((song, source));
                break;
            }
        }
        let (song, source) = resolved.expect("at least one legitimately playable guest track");
        eprintln!(
            "guest acceptance: title={:?}, quality={}, format={:?}, preview={}",
            song.title, source.quality_label, source.format, source.is_preview
        );
        let preparer = CachedMediaPreparer::new(service.http_client(), storage);
        let prepared = preparer.prepare(source).await.expect("media downloads");
        let engine = RodioAudioEngine::open_default().expect("default audio output opens");
        engine.set_volume(0.08).expect("volume");
        let metadata = engine.load(&prepared).expect("provider media decodes");
        engine.play().expect("play starts");
        tokio::time::sleep(Duration::from_millis(1_500)).await;
        let playing = engine.snapshot();
        assert!(playing.playing, "native engine should be outputting audio");
        assert!(
            playing.position_ms >= 1_000,
            "real player position should advance"
        );

        engine.pause().expect("pause");
        let paused_at = engine.snapshot().position_ms;
        tokio::time::sleep(Duration::from_millis(350)).await;
        assert!(engine.snapshot().position_ms.abs_diff(paused_at) < 100);

        let seek_target = metadata.duration_ms.unwrap_or(song.duration_ms).min(8_000) / 2;
        engine
            .seek(Duration::from_millis(seek_target))
            .expect("provider media seeks");
        assert!(engine.snapshot().position_ms.abs_diff(seek_target) < 250);
        engine.stop().expect("stop");
    }

    #[tokio::test]
    #[ignore = "opt-in authenticated source acceptance; reads but never mutates the secure session"]
    async fn live_authenticated_source_resolves_without_secret_output() {
        let root = tempfile::tempdir().expect("temp root");
        let storage = Arc::new(
            StorageService::open(root.path().join("data"), root.path().join("cache"))
                .expect("storage"),
        );
        let service = Arc::new(
            QQMusicService::new(
                Arc::clone(&storage),
                Arc::new(crate::credentials::PlatformCredentialStore::new()),
                root.path().join("fixtures"),
            )
            .expect("service"),
        );
        service.restore_session().await;
        let snapshot = service.account_snapshot().await;
        assert_eq!(snapshot.state_name(), "authenticated");
        let page = service
            .favorite_songs(None, 20)
            .await
            .expect("authenticated favorites page");
        let mut songs = page.items;
        songs.extend(
            service
                .search("喜欢你".to_owned(), 1, 20)
                .await
                .expect("authenticated catalog search")
                .songs,
        );
        let preferred = match &snapshot.account {
            AccountState::Authenticated { entitlement, .. }
                if entitlement
                    .permitted_qualities
                    .contains(&AudioQuality::Master) =>
            {
                AudioQualityPreference::Master
            }
            AccountState::Authenticated { entitlement, .. }
                if entitlement
                    .permitted_qualities
                    .contains(&AudioQuality::Lossless) =>
            {
                AudioQualityPreference::Lossless
            }
            _ => AudioQualityPreference::High,
        };
        let requested_quality = match preferred {
            AudioQualityPreference::Master => AudioQuality::Master,
            AudioQualityPreference::Lossless => AudioQuality::Lossless,
            AudioQualityPreference::High => AudioQuality::High,
            AudioQualityPreference::Standard => AudioQuality::Standard,
            AudioQualityPreference::Automatic => unreachable!("explicit acceptance quality"),
        };
        let song = songs
            .iter()
            .find(|song| {
                song.audio_formats
                    .iter()
                    .any(|format| format.quality == requested_quality)
            })
            .or_else(|| songs.first())
            .cloned()
            .expect("at least one authenticated catalog song");
        service
            .set_current_quality(
                song.provider
                    .as_ref()
                    .expect("QQ Music provider reference")
                    .track_id
                    .clone(),
                preferred,
            )
            .await
            .expect("current quality override");
        let source = service.resolve(&song).await.expect("authorized source");
        eprintln!(
            "authenticated source acceptance: quality={}, encrypted={}, preview={}",
            source.quality_label,
            matches!(&source.location, PlaybackLocation::EncryptedHttp { .. }),
            source.is_preview
        );
        let expected_encrypted = matches!(&source.location, PlaybackLocation::EncryptedHttp { .. });
        if matches!(
            preferred,
            AudioQualityPreference::Master | AudioQualityPreference::Lossless
        ) && song
            .audio_formats
            .iter()
            .any(|format| format.quality == requested_quality)
        {
            assert!(
                expected_encrypted,
                "an entitled encrypted candidate must not silently pass via a clear fallback"
            );
        }
        let preparer = CachedMediaPreparer::new(service.http_client(), storage);
        let prepared = preparer.prepare(source).await.expect("media preparation");
        assert_eq!(
            matches!(
                &prepared.location,
                crate::audio::PreparedPlaybackLocation::EncryptedLocal { .. }
                    | crate::audio::PreparedPlaybackLocation::EncryptedProgressive { .. }
            ),
            expected_encrypted
        );
        let engine = RodioAudioEngine::open_default().expect("default audio output opens");
        let metadata = engine.load(&prepared).expect("resolved media decodes");
        assert!(metadata.duration_ms.unwrap_or_default() > 1_000);
    }
}
