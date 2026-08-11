use crate::{
    audio::{write_fixture_wav, AudioFormat},
    credentials::CredentialStore,
    media::{
        PlaybackLocation, PlaybackSourceError, PlaybackSourceResolver, ResolvedPlaybackSource,
    },
    player::{
        AlbumSummary, ArtistSummary, Artwork, AudioCodec, AudioFormatInfo, AudioQuality,
        LyricDocument, LyricLine, LyricMetadata, LyricSyncMode, LyricWord, PlaybackCapability,
        ProviderTrackReference, Song, SongAvailability,
    },
    storage::{CacheStats, StorageService},
};
use async_trait::async_trait;
use lyrics_crypto::decrypter::qrc::decrypter::decrypt_lyrics as decrypt_qrc;
use quick_xml::{escape::unescape, events::Event, Reader};
use reqwest::{header, Client, RequestBuilder, StatusCode};
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

mod clock;
mod redaction;
mod transport;

use clock::{Clock, SystemClock};
use transport::{QqTransport, ReqwestQqTransport};

const QQ_MUSICU_URL: &str = "https://u.y.qq.com/cgi-bin/musicu.fcg";
const QQ_SEARCH_URL: &str = "https://c.y.qq.com/soso/fcgi-bin/client_search_cp";
const QQ_ALBUM_URL: &str = "https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg";
const QQ_PLAYLIST_URL: &str = "https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg";
const QQ_LRC_URL: &str = "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg";
const DEFAULT_TOPLIST_ID: u64 = 62;
const METADATA_TTL_MS: u64 = 15 * 60 * 1_000;
const ENTITY_TTL_MS: u64 = 24 * 60 * 60 * 1_000;
const LYRIC_TTL_MS: u64 = 30 * 24 * 60 * 60 * 1_000;
const SESSION_ACCOUNT: &str = "qqmusic-session";

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

#[derive(Clone, Debug, Deserialize, Serialize)]
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

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PreferredQuality {
    Automatic,
    Standard,
    High,
    Lossless,
}

impl PreferredQuality {
    fn from_setting(value: Option<String>) -> Self {
        match value.as_deref() {
            Some("standard") => Self::Standard,
            Some("high") => Self::High,
            Some("lossless") => Self::Lossless,
            _ => Self::Automatic,
        }
    }

    fn as_setting(self) -> &'static str {
        match self {
            Self::Automatic => "automatic",
            Self::Standard => "standard",
            Self::High => "high",
            Self::Lossless => "lossless",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilities {
    pub search: bool,
    pub album: bool,
    pub artist: bool,
    pub playlist: bool,
    pub lyrics: bool,
    pub word_timed_lyrics: bool,
    pub account: bool,
    pub favorites_read: bool,
    pub favorites_write: bool,
    pub playlist_read: bool,
    pub playlist_write: bool,
    pub streaming: bool,
    pub quality_selection: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum AccountStatus {
    Guest,
    Authenticated {
        #[serde(rename = "accountLabel")]
        account_label: String,
    },
    ReauthenticationRequired,
    SecureStoreUnavailable,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider_id: String,
    pub display_name: String,
    pub connection: String,
    pub message: String,
    pub account: AccountStatus,
    pub preferred_quality: PreferredQuality,
    pub capabilities: ProviderCapabilities,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct QQSession {
    uin: String,
    cookie_header: String,
    expires_at_ms: Option<u64>,
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
    #[error("the account is not entitled to this media")]
    EntitlementUnavailable,
    #[error("local provider storage failed")]
    Storage,
}

impl QQMusicError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Offline => "offline",
            Self::Timeout => "timeout",
            Self::RateLimited => "rate-limited",
            Self::SchemaChanged => "schema-changed",
            Self::MalformedResponse => "malformed-response",
            Self::NotFound => "song-unavailable",
            Self::AuthenticationExpired => "authentication-expired",
            Self::AuthorizationRejected => "authorization-rejected",
            Self::Protocol => "protocol-error",
            Self::OutcomeUnknown => "outcome-unknown",
            Self::Cancelled => "cancelled",
            Self::EntitlementUnavailable => "entitlement-unavailable",
            Self::Storage => "provider-failure",
        }
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
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "used by the QQ account services introduced in later tasks"
        )
    )]
    account_transport: Arc<dyn QqTransport>,
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "used by the QQ account services introduced in later tasks"
        )
    )]
    clock: Arc<dyn Clock>,
    storage: Arc<StorageService>,
    credentials: Arc<dyn CredentialStore>,
    preferred_quality: RwLock<PreferredQuality>,
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
        let preferred_quality = PreferredQuality::from_setting(
            storage
                .get_setting("preferred-quality")
                .map_err(|_| QQMusicError::Storage)?,
        );
        Ok(Self {
            client: QQMusicClient::new()?,
            account_transport,
            clock,
            storage,
            credentials,
            preferred_quality: RwLock::new(preferred_quality),
            fixture_root,
            fixture_guard: AsyncMutex::new(()),
            session_invalid: AtomicBool::new(false),
        })
    }

    pub fn http_client(&self) -> Client {
        self.client.http.clone()
    }

    pub fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            search: true,
            album: true,
            artist: true,
            playlist: true,
            lyrics: true,
            word_timed_lyrics: true,
            account: false,
            favorites_read: false,
            favorites_write: false,
            playlist_read: true,
            playlist_write: false,
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
        let account = self.account_status();
        ProviderStatus {
            provider_id: "qqmusic".to_owned(),
            display_name: "QQ Music".to_owned(),
            connection: connection.to_owned(),
            message: match connection {
                "online" => "Public catalog access is available. Account-only features require an approved authorization path.",
                "cached" => "QQ Music is unreachable; cached catalog data remains available.",
                _ => "QQ Music is currently unreachable. Offline fixtures remain available for development.",
            }
            .to_owned(),
            account,
            preferred_quality: *self.preferred_quality.read().await,
            capabilities: self.capabilities(),
        }
    }

    pub async fn set_preferred_quality(
        &self,
        quality: PreferredQuality,
    ) -> Result<ProviderStatus, QQMusicError> {
        self.storage
            .set_setting("preferred-quality", quality.as_setting())
            .map_err(|_| QQMusicError::Storage)?;
        *self.preferred_quality.write().await = quality;
        Ok(self.status().await)
    }

    pub async fn sign_out(&self) -> Result<ProviderStatus, QQMusicError> {
        self.credentials
            .delete(SESSION_ACCOUNT)
            .map_err(|_| QQMusicError::Storage)?;
        self.session_invalid.store(false, Ordering::Release);
        Ok(self.status().await)
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
            .get_json(&key, false)
            .map_err(|_| QQMusicError::Storage)?
        {
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
                Ok(result)
            }
            Err(error) => self
                .storage
                .get_json(&key, true)
                .map_err(|_| QQMusicError::Storage)?
                .ok_or(error),
        }
    }

    pub async fn album(&self, id: String) -> Result<Album, QQMusicError> {
        let mid = strip_entity_prefix(&id, "qqmusic:album:");
        let key = format!("qqmusic:album:{mid}");
        if let Some(album) = self
            .storage
            .get_json(&key, false)
            .map_err(|_| QQMusicError::Storage)?
        {
            return Ok(album);
        }
        match self.client.album(mid).await {
            Ok(album) => {
                self.storage
                    .put_json(&key, "metadata", &album, ENTITY_TTL_MS)
                    .map_err(|_| QQMusicError::Storage)?;
                Ok(album)
            }
            Err(error) => self
                .storage
                .get_json(&key, true)
                .map_err(|_| QQMusicError::Storage)?
                .ok_or(error),
        }
    }

    pub async fn playlist(&self, id: String) -> Result<Playlist, QQMusicError> {
        let key = id.clone();
        if let Some(playlist) = self
            .storage
            .get_json(&key, false)
            .map_err(|_| QQMusicError::Storage)?
        {
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
                Ok(playlist)
            }
            Err(error) => self
                .storage
                .get_json(&key, true)
                .map_err(|_| QQMusicError::Storage)?
                .ok_or(error),
        }
    }

    pub async fn home(&self) -> Result<HomeFeed, QQMusicError> {
        if let Some(feed) = self
            .storage
            .get_json("qqmusic:home", false)
            .map_err(|_| QQMusicError::Storage)?
        {
            return Ok(feed);
        }
        match self.build_home().await {
            Ok(feed) => {
                self.storage
                    .put_json("qqmusic:home", "metadata", &feed, METADATA_TTL_MS)
                    .map_err(|_| QQMusicError::Storage)?;
                Ok(feed)
            }
            Err(error) => self
                .storage
                .get_json("qqmusic:home", true)
                .map_err(|_| QQMusicError::Storage)?
                .ok_or(error),
        }
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

    fn account_status(&self) -> AccountStatus {
        match self.credentials.load(SESSION_ACCOUNT) {
            Ok(None) => AccountStatus::Guest,
            Ok(Some(_)) if self.session_invalid.load(Ordering::Acquire) => {
                AccountStatus::ReauthenticationRequired
            }
            Ok(Some(raw)) => match serde_json::from_str::<QQSession>(&raw) {
                Ok(session)
                    if session
                        .expires_at_ms
                        .is_some_and(|expires| expires <= unix_timestamp_ms()) =>
                {
                    self.session_invalid.store(true, Ordering::Release);
                    AccountStatus::ReauthenticationRequired
                }
                Ok(session) => AccountStatus::Authenticated {
                    account_label: mask_account(&session.uin),
                },
                Err(_) => AccountStatus::ReauthenticationRequired,
            },
            Err(_) => AccountStatus::SecureStoreUnavailable,
        }
    }

    fn active_session(&self) -> Result<Option<QQSession>, QQMusicError> {
        let Some(raw) = self
            .credentials
            .load(SESSION_ACCOUNT)
            .map_err(|_| QQMusicError::AuthenticationExpired)?
        else {
            return Ok(None);
        };
        let session: QQSession =
            serde_json::from_str(&raw).map_err(|_| QQMusicError::AuthenticationExpired)?;
        if session
            .expires_at_ms
            .is_some_and(|expires| expires <= unix_timestamp_ms())
        {
            self.session_invalid.store(true, Ordering::Release);
            return Err(QQMusicError::AuthenticationExpired);
        }
        Ok(Some(session))
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
            let quality = *self.preferred_quality.read().await;
            let session = self.active_session().map_err(map_provider_source_error)?;
            let source = self
                .client
                .resolve_source(song, quality, session.as_ref())
                .await;
            if matches!(&source, Err(QQMusicError::AuthenticationExpired)) {
                self.session_invalid.store(true, Ordering::Release);
            }
            let source = source.map_err(map_provider_source_error)?;
            if let Some(provider) = &song.provider {
                let _ = self
                    .storage
                    .record_playback(&provider.provider_id, &provider.track_id);
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
        })
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
        QQMusicError::NotFound => PlaybackSourceError::TrackUnavailable,
        QQMusicError::SchemaChanged
        | QQMusicError::MalformedResponse
        | QQMusicError::Protocol
        | QQMusicError::OutcomeUnknown
        | QQMusicError::Cancelled
        | QQMusicError::Storage => PlaybackSourceError::UrlUnavailable,
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
        let artwork_url = upgrade_https(&data.logo);
        Ok(Playlist {
            id: playlist_id(diss_id),
            title: title.clone(),
            description: clean_text(&data.description),
            owner: PlaylistOwner {
                id: format!("qqmusic:user:{}", stable_component(&data.nickname)),
                display_name: clean_text(&data.nickname),
            },
            artwork: Artwork {
                src: if artwork_url.is_empty() {
                    fallback_artwork()
                } else {
                    artwork_url
                },
                alt: format!("Cover for {title}"),
                dominant_color: color_for(diss_id),
            },
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
        let artwork_url = upgrade_https(
            non_empty(details.artwork)
                .or_else(|| non_empty(details.front_artwork))
                .unwrap_or_default()
                .as_str(),
        );
        Ok(Playlist {
            id: format!("qqmusic:toplist:{top_id}"),
            title: title.clone(),
            description: clean_text(&details.description),
            owner: PlaylistOwner {
                id: "qqmusic".to_owned(),
                display_name: "QQ Music".to_owned(),
            },
            artwork: Artwork {
                src: if artwork_url.is_empty() {
                    fallback_artwork()
                } else {
                    artwork_url
                },
                alt: format!("Cover for {title}"),
                dominant_color: details
                    .magic_color
                    .map(|color| format!("#{:02x}{:02x}{:02x}", color.r, color.g, color.b))
                    .unwrap_or_else(|| color_for(&top_id.to_string())),
            },
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
        preferred: PreferredQuality,
        session: Option<&QQSession>,
    ) -> Result<ResolvedPlaybackSource, QQMusicError> {
        let provider = song.provider.as_ref().ok_or(QQMusicError::NotFound)?;
        let media_mid = provider
            .media_id
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or(&provider.track_id);
        let candidates = source_candidates(media_mid, preferred);
        let filenames = candidates
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
        let response: VkeyEnvelope = self
            .send_json("playback.resolve", || {
                self.musicu_request(&payload, session)
            })
            .await?;
        if response.code != 0 || response.request.code != 0 {
            return Err(QQMusicError::SchemaChanged);
        }
        let sip = response
            .request
            .data
            .sip
            .into_iter()
            .find_map(|value| normalize_cdn_base(&value))
            .ok_or(QQMusicError::MalformedResponse)?;

        for (candidate, item) in candidates.iter().zip(response.request.data.items) {
            if item.result != 0 || item.path.is_empty() {
                continue;
            }
            let url = normalize_cdn_url(&sip, &item.path)?;
            let preview_range = match &song.playback_capability {
                Some(PlaybackCapability::Preview { start_ms, end_ms }) => {
                    Some((*start_ms, *end_ms))
                }
                _ => None,
            };
            let is_preview = candidate.preview;
            let (timeline_offset_ms, timeline_end_ms) = if is_preview {
                preview_range.unwrap_or((0, 60_000))
            } else {
                (0, song.duration_ms)
            };
            return Ok(ResolvedPlaybackSource {
                cache_key: format!(
                    "qqmusic:{}:{}:{}",
                    provider.track_id, candidate.cache_label, media_mid
                ),
                location: PlaybackLocation::Http {
                    url,
                    headers: vec![
                        ("Referer".to_owned(), "https://y.qq.com/".to_owned()),
                        ("Origin".to_owned(), "https://y.qq.com".to_owned()),
                    ],
                },
                format: candidate.format,
                mime_type: Some(candidate.mime_type.to_owned()),
                quality_label: candidate.cache_label.to_owned(),
                bitrate_kbps: candidate.bitrate_kbps,
                sample_rate_hz: None,
                bit_depth: if candidate.format == AudioFormat::Flac {
                    Some(16)
                } else {
                    None
                },
                content_length: candidate.content_length(song),
                supports_range: true,
                expires_at_ms: Some(unix_timestamp_ms().saturating_add(15 * 60 * 1_000)),
                timeline_offset_ms,
                timeline_end_ms: Some(timeline_end_ms),
                is_preview,
            });
        }

        if matches!(
            song.playback_capability,
            Some(PlaybackCapability::Preview { .. })
        ) {
            Err(QQMusicError::EntitlementUnavailable)
        } else {
            Err(QQMusicError::NotFound)
        }
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

#[derive(Debug, Deserialize)]
struct VkeyEnvelope {
    code: i32,
    #[serde(rename = "req_0")]
    request: VkeyRequest,
}

#[derive(Debug, Deserialize)]
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

#[derive(Clone, Debug)]
struct SourceCandidate {
    filename: String,
    cache_label: &'static str,
    format: AudioFormat,
    mime_type: &'static str,
    bitrate_kbps: Option<u32>,
    preview: bool,
}

impl SourceCandidate {
    fn content_length(&self, _song: &Song) -> Option<u64> {
        None
    }
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

fn source_candidates(media_mid: &str, preferred: PreferredQuality) -> Vec<SourceCandidate> {
    let lossless = SourceCandidate {
        filename: format!("F000{media_mid}.flac"),
        cache_label: "lossless-flac",
        format: AudioFormat::Flac,
        mime_type: "audio/flac",
        bitrate_kbps: None,
        preview: false,
    };
    let high = SourceCandidate {
        filename: format!("M800{media_mid}.mp3"),
        cache_label: "high-mp3",
        format: AudioFormat::Mp3,
        mime_type: "audio/mpeg",
        bitrate_kbps: Some(320),
        preview: false,
    };
    let standard = SourceCandidate {
        filename: format!("M500{media_mid}.mp3"),
        cache_label: "standard-mp3",
        format: AudioFormat::Mp3,
        mime_type: "audio/mpeg",
        bitrate_kbps: Some(128),
        preview: false,
    };
    let aac = SourceCandidate {
        filename: format!("C400{media_mid}.m4a"),
        cache_label: "efficient-aac",
        format: AudioFormat::Aac,
        mime_type: "audio/mp4",
        bitrate_kbps: Some(96),
        preview: false,
    };
    let preview = SourceCandidate {
        filename: format!("RS02{media_mid}.mp3"),
        cache_label: "official-preview-mp3",
        format: AudioFormat::Mp3,
        mime_type: "audio/mpeg",
        bitrate_kbps: Some(128),
        preview: true,
    };
    match preferred {
        PreferredQuality::Lossless => vec![lossless, high, standard, aac, preview],
        PreferredQuality::High => vec![high, standard, aac, preview],
        PreferredQuality::Standard => vec![standard, aac, preview],
        PreferredQuality::Automatic => vec![high, standard, aac, preview],
    }
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

fn artwork_for_album(mid: &str, title: &str) -> Artwork {
    Artwork {
        src: if mid == "unknown" || mid.is_empty() {
            fallback_artwork()
        } else {
            format!("https://y.gtimg.cn/music/photo_new/T002R300x300M000{mid}.jpg?max_age=2592000")
        },
        alt: format!("Cover for {}", clean_text(title)),
        dominant_color: color_for(mid),
    }
}

fn fallback_artwork() -> String {
    "/artwork/stillness.svg".to_owned()
}

fn is_allowed_artwork_url(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && url
            .host_str()
            .is_some_and(|host| host == "y.gtimg.cn" || host == "qpic.y.qq.com")
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

fn stable_guid() -> String {
    let value = unix_timestamp_ms() % 9_000_000_000 + 1_000_000_000;
    value.to_string()
}

fn upgrade_https(value: &str) -> String {
    value.trim().replacen("http://", "https://", 1)
}

fn mask_account(value: &str) -> String {
    if value.len() <= 4 {
        "Connected account".to_owned()
    } else {
        format!("{}••{}", &value[..2], &value[value.len() - 2..])
    }
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
}
