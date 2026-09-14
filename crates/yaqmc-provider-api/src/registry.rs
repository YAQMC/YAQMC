//! Runtime-ID provider registry and legacy capability façade.

use crate::{
    AccountLoginFlow, AccountLoginMethodDescriptor, AccountPlaylistDetail, AccountPlaylistSummary,
    AccountProvider, AccountSnapshot, AccountState, Album, AreaFeed, Artist, ArtistCatalogKind,
    ArtistCatalogPage, AudioQualityPreference, CacheStats, CatalogProvider,
    CatalogProviderCapabilities, CatalogSearchKind, CollectPlaylistRequest, CreatePlaylistRequest,
    DeletePlaylistRequest, DiscoverFeed, FavoriteMutationRequest, FavoriteMutationResult, HomeFeed,
    LibrarySnapshot, LyricDocument, LyricsProvider, MusicProvider, OAuthLoginProvider,
    OAuthPrepareResult, Page, PlaybackSourceError, PlaybackSourceProvider, PlaybackSourceResolver,
    PlaybackSourceSelection, Playlist, PlaylistMutationResult, PlaylistTrackMutationRequest,
    ProviderAccount, ProviderCommandError, ProviderProfileKey, ProviderProfileKeyError,
    ProviderResult, ProviderScopedOutput, ProviderStatus, RecommendationBatch,
    RecommendationProvider, RecommendationRequest, RemotePlayHistoryItem, RenamePlaylistRequest,
    ResolvedPlaybackSource, SearchResult, ShareProvider, ShareTarget, Song, DEFAULT_PROFILE_ID,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::{
    borrow::Borrow,
    collections::HashMap,
    fmt,
    sync::{Arc, RwLock},
};

pub const MAX_PROVIDER_ID_BYTES: usize = 64;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilitySummary {
    pub catalog: bool,
    pub playback: bool,
    pub recommendations: bool,
    pub lyrics: bool,
    pub share: bool,
    pub account: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDescriptor {
    pub provider_id: String,
    pub display_name: String,
    pub is_default: bool,
    pub available: bool,
    pub capabilities: ProviderCapabilitySummary,
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ProviderId(String);

impl ProviderId {
    pub fn parse(value: impl AsRef<str>) -> Result<Self, ProviderIdError> {
        let value = value.as_ref();
        if value.is_empty() {
            return Err(ProviderIdError::Empty);
        }
        if value.len() > MAX_PROVIDER_ID_BYTES {
            return Err(ProviderIdError::TooLong);
        }
        let mut bytes = value.bytes();
        if !bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        {
            return Err(ProviderIdError::InvalidCharacter);
        }
        if !bytes.all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_' | b'.')
        }) {
            return Err(ProviderIdError::InvalidCharacter);
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl AsRef<str> for ProviderId {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl Borrow<str> for ProviderId {
    fn borrow(&self) -> &str {
        self.as_str()
    }
}

impl fmt::Display for ProviderId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderIdError {
    Empty,
    TooLong,
    InvalidCharacter,
}

impl fmt::Display for ProviderIdError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => formatter.write_str("music provider ID must not be empty"),
            Self::TooLong => write!(
                formatter,
                "music provider ID exceeds the {MAX_PROVIDER_ID_BYTES}-byte limit"
            ),
            Self::InvalidCharacter => formatter.write_str(
                "music provider ID must use lowercase ASCII letters, digits, dots, underscores, or hyphens",
            ),
        }
    }
}

impl std::error::Error for ProviderIdError {}

#[derive(Debug, Eq, PartialEq)]
pub enum ProviderRegistryError {
    Empty,
    InvalidId(ProviderIdError),
    InvalidProfile(ProviderProfileKeyError),
    DuplicateId(ProviderId),
    DuplicateProfile(ProviderProfileKey),
    MissingProvider(ProviderId),
    MissingDefault(ProviderId),
    EmptyCapabilities,
    ProtectedDefault(ProviderId),
    ProtectedDefaultProfile(ProviderProfileKey),
}

impl fmt::Display for ProviderRegistryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => formatter.write_str("at least one music provider is required"),
            Self::InvalidId(error) => error.fmt(formatter),
            Self::InvalidProfile(error) => error.fmt(formatter),
            Self::DuplicateId(id) => write!(formatter, "duplicate music provider id: {id}"),
            Self::DuplicateProfile(key) => write!(
                formatter,
                "duplicate music provider profile: {}/{}",
                key.provider_id, key.profile_id
            ),
            Self::MissingProvider(id) => write!(formatter, "music provider is missing: {id}"),
            Self::MissingDefault(id) => {
                write!(formatter, "default music provider is missing: {id}")
            }
            Self::EmptyCapabilities => {
                formatter.write_str("a music provider must expose at least one capability")
            }
            Self::ProtectedDefault(id) => {
                write!(
                    formatter,
                    "the default music provider cannot be removed: {id}"
                )
            }
            Self::ProtectedDefaultProfile(key) => write!(
                formatter,
                "the default music provider profile cannot be removed: {}/{}",
                key.provider_id, key.profile_id
            ),
        }
    }
}

impl std::error::Error for ProviderRegistryError {}

struct LegacyCapabilityAdapter {
    provider: Arc<dyn MusicProvider>,
    provider_id: String,
}

impl LegacyCapabilityAdapter {
    fn validate<T: ProviderScopedOutput>(&self, value: T) -> ProviderResult<T> {
        value.validate_scope(&self.provider_id)
    }

    fn fallback_snapshot(&self) -> AccountSnapshot {
        AccountSnapshot {
            account: AccountState::Guest {
                profile: (),
                entitlement: (),
            },
            provider_id: self.provider_id.clone(),
            profile_id: DEFAULT_PROFILE_ID.to_owned(),
            revision: 0,
            capabilities: crate::AccountCapabilities {
                qr_login: false,
                favorite_read: false,
                favorite_write: false,
                playlist_read: false,
                playlist_write: false,
                recent_history_read: false,
            },
        }
    }

    fn fallback_status(&self) -> ProviderStatus {
        ProviderStatus {
            provider_id: self.provider_id.clone(),
            profile_id: DEFAULT_PROFILE_ID.to_owned(),
            display_name: self.provider.display_name().to_owned(),
            connection: "invalid-provider-response".to_owned(),
            message: "the provider returned an invalid scope".to_owned(),
            preferred_quality: AudioQualityPreference::Automatic,
            capabilities: self.provider.capabilities(),
        }
    }
}

#[async_trait]
impl CatalogProvider for LegacyCapabilityAdapter {
    fn catalog_capabilities(&self) -> CatalogProviderCapabilities {
        self.provider.capabilities()
    }

    async fn catalog_status(&self) -> ProviderStatus {
        let status = self.provider.status().await;
        self.validate(status)
            .unwrap_or_else(|_| self.fallback_status())
    }

    async fn catalog_search(
        &self,
        query: String,
        kind: CatalogSearchKind,
        page: u32,
        limit: u32,
    ) -> ProviderResult<SearchResult> {
        self.provider
            .search(query, kind, page, limit)
            .await
            .and_then(|value| self.validate(value))
    }

    async fn catalog_song(&self, id: String) -> ProviderResult<Song> {
        self.provider
            .song(id)
            .await
            .and_then(|value| self.validate(value))
    }

    async fn catalog_album(&self, id: String) -> ProviderResult<Album> {
        self.provider
            .album(id)
            .await
            .and_then(|value| self.validate(value))
    }

    async fn catalog_artist(&self, id: String) -> ProviderResult<Artist> {
        self.provider
            .artist(id)
            .await
            .and_then(|value| self.validate(value))
    }

    async fn catalog_artist_page(
        &self,
        id: String,
        kind: ArtistCatalogKind,
        page: u32,
        limit: u32,
    ) -> ProviderResult<ArtistCatalogPage> {
        self.provider
            .artist_catalog(id, kind, page, limit)
            .await
            .and_then(|value| self.validate(value))
    }

    async fn catalog_playlist(&self, id: String) -> ProviderResult<Playlist> {
        self.provider
            .playlist(id)
            .await
            .and_then(|value| self.validate(value))
    }

    async fn catalog_home(&self, refresh: bool) -> ProviderResult<HomeFeed> {
        self.provider
            .home(refresh)
            .await
            .and_then(|value| self.validate(value))
    }

    async fn catalog_discover(&self, refresh: bool) -> ProviderResult<DiscoverFeed> {
        self.provider
            .discover(refresh)
            .await
            .and_then(|value| self.validate(value))
    }

    async fn catalog_area(&self, enc_area: String) -> ProviderResult<AreaFeed> {
        self.provider
            .area(enc_area)
            .await
            .and_then(|value| self.validate(value))
    }

    fn catalog_library(&self) -> LibrarySnapshot {
        self.validate(self.provider.library()).unwrap_or_default()
    }

    async fn catalog_artwork_data_uri(&self, url: String) -> ProviderResult<String> {
        self.provider.artwork_data_uri(url).await
    }

    fn catalog_cache_stats(&self) -> ProviderResult<CacheStats> {
        self.provider.cache_stats()
    }

    fn catalog_clear_cache(&self) -> ProviderResult<CacheStats> {
        self.provider.clear_cache()
    }

    async fn catalog_remember_songs(&self, songs: &[Song]) {
        let Ok(songs) = songs
            .iter()
            .cloned()
            .map(|song| self.validate(song))
            .collect::<ProviderResult<Vec<_>>>()
        else {
            return;
        };
        self.provider.remember_songs(&songs).await;
    }
}

#[async_trait]
impl PlaybackSourceResolver for LegacyCapabilityAdapter {
    async fn resolve(&self, song: &Song) -> Result<ResolvedPlaybackSource, PlaybackSourceError> {
        if self.validate(song.clone()).is_err() {
            return Err(PlaybackSourceError::TrackUnavailable);
        }
        self.provider.resolve(song).await
    }

    async fn resolve_client_fallback(
        &self,
        song: &Song,
        failed: &PlaybackSourceSelection,
    ) -> Result<ResolvedPlaybackSource, PlaybackSourceError> {
        if self.validate(song.clone()).is_err() {
            return Err(PlaybackSourceError::TrackUnavailable);
        }
        self.provider.resolve_client_fallback(song, failed).await
    }
}

#[async_trait]
impl PlaybackSourceProvider for LegacyCapabilityAdapter {
    fn playback_media_http_client(&self) -> reqwest::Client {
        self.provider.media_http_client()
    }

    async fn playback_set_preferred_quality(
        &self,
        quality: AudioQualityPreference,
    ) -> ProviderResult<ProviderStatus> {
        self.provider
            .set_preferred_quality(quality)
            .await
            .and_then(|value| self.validate(value))
    }

    async fn playback_set_current_quality(
        &self,
        track_id: String,
        quality: AudioQualityPreference,
    ) -> ProviderResult<()> {
        self.provider.set_current_quality(track_id, quality).await
    }
}

#[async_trait]
impl RecommendationProvider for LegacyCapabilityAdapter {
    async fn recommendation_next(
        &self,
        request: RecommendationRequest,
    ) -> ProviderResult<RecommendationBatch> {
        self.provider
            .recommendation_next(request)
            .await
            .and_then(|value| self.validate(value))
    }
}

#[async_trait]
impl LyricsProvider for LegacyCapabilityAdapter {
    async fn lyrics_for_song(&self, song_id: String) -> ProviderResult<Option<LyricDocument>> {
        self.provider.lyrics(song_id).await
    }
}

#[async_trait]
impl ProviderAccount for LegacyCapabilityAdapter {
    fn account_generation(&self) -> u64 {
        self.provider.account_generation()
    }

    async fn account_snapshot(&self) -> AccountSnapshot {
        self.validate(self.provider.account_snapshot().await)
            .unwrap_or_else(|_| self.fallback_snapshot())
    }

    async fn refresh_account(&self) -> ProviderResult<AccountSnapshot> {
        self.provider
            .refresh_account()
            .await
            .and_then(|value| self.validate(value))
    }

    async fn favorite_songs(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> ProviderResult<Page<Song>> {
        self.provider
            .favorite_songs(cursor, limit)
            .await
            .and_then(|value| self.validate(value))
    }

    async fn account_playlists(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> ProviderResult<Page<AccountPlaylistSummary>> {
        self.provider
            .account_playlists(cursor, limit)
            .await
            .and_then(|value| self.validate(value))
    }

    async fn account_playlist_tracks(
        &self,
        playlist: AccountPlaylistSummary,
        cursor: Option<String>,
        limit: u32,
    ) -> ProviderResult<AccountPlaylistDetail> {
        self.validate(playlist.clone())?;
        self.provider
            .account_playlist_tracks(playlist, cursor, limit)
            .await
            .and_then(|value| self.validate(value))
    }

    async fn account_recently_played(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> ProviderResult<Page<RemotePlayHistoryItem>> {
        self.provider
            .account_recently_played(cursor, limit)
            .await
            .and_then(|value| self.validate(value))
    }

    async fn set_favorite(
        &self,
        request: FavoriteMutationRequest,
    ) -> ProviderResult<FavoriteMutationResult> {
        self.provider.set_favorite(request).await
    }

    async fn create_playlist(
        &self,
        request: CreatePlaylistRequest,
    ) -> ProviderResult<PlaylistMutationResult> {
        self.provider
            .create_playlist(request)
            .await
            .and_then(|value| self.validate(value))
    }

    async fn rename_playlist(
        &self,
        request: RenamePlaylistRequest,
    ) -> ProviderResult<PlaylistMutationResult> {
        self.provider
            .rename_playlist(request)
            .await
            .and_then(|value| self.validate(value))
    }

    async fn add_playlist_track(
        &self,
        request: PlaylistTrackMutationRequest,
    ) -> ProviderResult<PlaylistMutationResult> {
        self.provider
            .add_playlist_track(request)
            .await
            .and_then(|value| self.validate(value))
    }

    async fn remove_playlist_track(
        &self,
        request: PlaylistTrackMutationRequest,
    ) -> ProviderResult<PlaylistMutationResult> {
        self.provider
            .remove_playlist_track(request)
            .await
            .and_then(|value| self.validate(value))
    }

    async fn delete_playlist(
        &self,
        request: DeletePlaylistRequest,
    ) -> ProviderResult<PlaylistMutationResult> {
        self.provider
            .delete_playlist(request)
            .await
            .and_then(|value| self.validate(value))
    }

    async fn set_playlist_collected(
        &self,
        request: CollectPlaylistRequest,
    ) -> ProviderResult<PlaylistMutationResult> {
        self.provider
            .set_playlist_collected(request)
            .await
            .and_then(|value| self.validate(value))
    }

    async fn start_qr_login(&self) -> ProviderResult<AccountSnapshot> {
        self.provider
            .start_qr_login()
            .await
            .and_then(|value| self.validate(value))
    }

    async fn start_mobile_login(&self) -> ProviderResult<AccountSnapshot> {
        self.provider
            .start_mobile_login()
            .await
            .and_then(|value| self.validate(value))
    }

    async fn prepare_oauth_login(
        &self,
        provider: OAuthLoginProvider,
    ) -> ProviderResult<OAuthPrepareResult> {
        self.provider.prepare_oauth_login(provider).await
    }

    async fn complete_oauth_login(
        &self,
        attempt_id: &str,
        callback_url: reqwest::Url,
    ) -> ProviderResult<AccountSnapshot> {
        self.provider
            .complete_oauth_login(attempt_id, callback_url)
            .await
            .and_then(|value| self.validate(value))
    }

    async fn cancel_oauth_login(&self, attempt_id: &str) -> ProviderResult<AccountSnapshot> {
        self.provider
            .cancel_oauth_login(attempt_id)
            .await
            .and_then(|value| self.validate(value))
    }

    async fn heartbeat_qr_login(
        &self,
        attempt_id: String,
        owner_lease_id: String,
    ) -> ProviderResult<AccountSnapshot> {
        self.provider
            .heartbeat_qr_login(attempt_id, owner_lease_id)
            .await
            .and_then(|value| self.validate(value))
    }

    async fn is_oauth_login(&self, attempt_id: &str) -> bool {
        self.provider.is_oauth_login(attempt_id).await
    }

    async fn cancel_qr_login(&self, attempt_id: String) -> ProviderResult<AccountSnapshot> {
        self.provider
            .cancel_qr_login(attempt_id)
            .await
            .and_then(|value| self.validate(value))
    }

    async fn refresh_qr_login(
        &self,
        attempt_id: Option<String>,
    ) -> ProviderResult<AccountSnapshot> {
        self.provider
            .refresh_qr_login(attempt_id)
            .await
            .and_then(|value| self.validate(value))
    }

    async fn restore_session(&self) {
        self.provider.restore_session().await
    }

    async fn sign_out(&self) -> ProviderResult<AccountSnapshot> {
        self.provider
            .sign_out()
            .await
            .and_then(|value| self.validate(value))
    }
}

#[async_trait]
impl ShareProvider for LegacyCapabilityAdapter {
    async fn share_song(&self, id: String) -> ProviderResult<ShareTarget> {
        self.provider
            .share_song(id)
            .await
            .and_then(|value| self.validate(value))
    }
}

#[async_trait]
impl AccountProvider for LegacyCapabilityAdapter {
    fn provider_account(&self) -> &dyn ProviderAccount {
        self
    }

    async fn account_login_methods(&self) -> ProviderResult<Vec<AccountLoginMethodDescriptor>> {
        Ok(vec![
            AccountLoginMethodDescriptor {
                id: "qq".to_owned(),
                label: "QQ".to_owned(),
                flow: AccountLoginFlow::OAuth,
            },
            AccountLoginMethodDescriptor {
                id: "wechat".to_owned(),
                label: "WeChat".to_owned(),
                flow: AccountLoginFlow::OAuth,
            },
        ])
    }

    async fn account_prepare_login(
        &self,
        method_id: &str,
    ) -> ProviderResult<crate::OAuthPrepareResult> {
        let method = match method_id {
            "qq" => crate::OAuthLoginProvider::Qq,
            "wechat" => crate::OAuthLoginProvider::Wechat,
            _ => {
                return Err(ProviderCommandError::invalid_request(
                    "account login method is unavailable",
                ));
            }
        };
        self.provider
            .prepare_oauth_login(method)
            .await
            .and_then(|mut value| {
                value.snapshot = self.validate(value.snapshot)?;
                Ok(value)
            })
    }
}

/// Capability view over the current monolithic provider contract.
///
/// Every view is present for a legacy provider. Future provider instances can
/// make capabilities optional without forcing existing Core consumers to move
/// in one change.
#[derive(Default)]
pub struct ProviderCapabilities {
    pub display_name: Option<String>,
    pub catalog: Option<Arc<dyn CatalogProvider>>,
    pub playback: Option<Arc<dyn PlaybackSourceProvider>>,
    pub recommendations: Option<Arc<dyn RecommendationProvider>>,
    pub lyrics: Option<Arc<dyn LyricsProvider>>,
    pub share: Option<Arc<dyn ShareProvider>>,
    pub account: Option<Arc<dyn AccountProvider>>,
}

impl ProviderCapabilities {
    pub fn is_empty(&self) -> bool {
        self.catalog.is_none()
            && self.playback.is_none()
            && self.recommendations.is_none()
            && self.lyrics.is_none()
            && self.share.is_none()
            && self.account.is_none()
    }
}

pub struct MusicProviderCapabilityFacade {
    id: ProviderId,
    display_name: String,
    catalog: Option<Arc<dyn CatalogProvider>>,
    playback: Option<Arc<dyn PlaybackSourceProvider>>,
    recommendations: Option<Arc<dyn RecommendationProvider>>,
    lyrics: Option<Arc<dyn LyricsProvider>>,
    share: Option<Arc<dyn ShareProvider>>,
    account: Option<Arc<dyn AccountProvider>>,
    legacy_provider: Option<Arc<dyn MusicProvider>>,
}

impl fmt::Debug for MusicProviderCapabilityFacade {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MusicProviderCapabilityFacade")
            .field("id", &self.id)
            .field("catalog", &self.catalog.is_some())
            .field("playback", &self.playback.is_some())
            .field("recommendations", &self.recommendations.is_some())
            .field("lyrics", &self.lyrics.is_some())
            .field("share", &self.share.is_some())
            .field("account", &self.account.is_some())
            .field("legacy", &self.legacy_provider.is_some())
            .finish()
    }
}

impl MusicProviderCapabilityFacade {
    fn from_legacy(id: ProviderId, provider: Arc<dyn MusicProvider>) -> Self {
        let display_name = provider.display_name().to_owned();
        let adapter = Arc::new(LegacyCapabilityAdapter {
            provider_id: id.to_string(),
            provider: Arc::clone(&provider),
        });
        Self {
            id,
            display_name,
            catalog: Some(adapter.clone()),
            playback: Some(adapter.clone()),
            recommendations: Some(adapter.clone()),
            lyrics: Some(adapter.clone()),
            share: Some(adapter.clone()),
            account: Some(adapter),
            legacy_provider: Some(provider),
        }
    }

    fn from_capabilities(id: ProviderId, capabilities: ProviderCapabilities) -> Self {
        let display_name = capabilities
            .display_name
            .unwrap_or_else(|| id.as_str().to_owned());
        Self {
            id,
            display_name,
            catalog: capabilities.catalog,
            playback: capabilities.playback,
            recommendations: capabilities.recommendations,
            lyrics: capabilities.lyrics,
            share: capabilities.share,
            account: capabilities.account,
            legacy_provider: None,
        }
    }

    pub fn id(&self) -> &ProviderId {
        &self.id
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    pub fn descriptor(&self, is_default: bool, available: bool) -> ProviderDescriptor {
        ProviderDescriptor {
            provider_id: self.id.to_string(),
            display_name: self.display_name.clone(),
            is_default,
            available,
            capabilities: ProviderCapabilitySummary {
                catalog: self.catalog.is_some(),
                playback: self.playback.is_some(),
                recommendations: self.recommendations.is_some(),
                lyrics: self.lyrics.is_some(),
                share: self.share.is_some(),
                account: self.account.is_some(),
            },
        }
    }

    pub fn catalog(&self) -> Option<&dyn CatalogProvider> {
        self.catalog.as_deref()
    }

    pub fn playback(&self) -> Option<&dyn PlaybackSourceProvider> {
        self.playback.as_deref()
    }

    pub fn recommendations(&self) -> Option<&dyn RecommendationProvider> {
        self.recommendations.as_deref()
    }

    pub fn lyrics(&self) -> Option<&dyn LyricsProvider> {
        self.lyrics.as_deref()
    }

    pub fn share(&self) -> Option<&dyn ShareProvider> {
        self.share.as_deref()
    }

    pub fn account(&self) -> Option<&dyn AccountProvider> {
        self.account.as_deref()
    }

    pub fn legacy_provider(&self) -> Option<Arc<dyn MusicProvider>> {
        self.legacy_provider.as_ref().map(Arc::clone)
    }

    fn playback_arc(&self) -> Option<Arc<dyn PlaybackSourceProvider>> {
        self.playback.as_ref().map(Arc::clone)
    }

    fn catalog_arc(&self) -> Option<Arc<dyn CatalogProvider>> {
        self.catalog.as_ref().map(Arc::clone)
    }

    fn lyrics_arc(&self) -> Option<Arc<dyn LyricsProvider>> {
        self.lyrics.as_ref().map(Arc::clone)
    }

    fn recommendations_arc(&self) -> Option<Arc<dyn RecommendationProvider>> {
        self.recommendations.as_ref().map(Arc::clone)
    }

    fn share_arc(&self) -> Option<Arc<dyn ShareProvider>> {
        self.share.as_ref().map(Arc::clone)
    }

    fn account_arc(&self) -> Option<Arc<dyn AccountProvider>> {
        self.account.as_ref().map(Arc::clone)
    }
}

struct RegistryState {
    /// Every live provider instance, keyed by its platform ID and local
    /// profile. The default profile is the compatibility entry point used by
    /// the pre-profile API.
    profiles: HashMap<ProviderProfileKey, Arc<MusicProviderCapabilityFacade>>,
    inactive: HashMap<ProviderId, ProviderDescriptor>,
}

pub struct ProviderRegistry {
    /// Profile and descriptor transitions share this one lock. In particular,
    /// a platform cannot be visible as both active and inactive between an
    /// unregister/register hand-off.
    state: RwLock<RegistryState>,
    default_id: ProviderId,
}

impl ProviderRegistry {
    pub fn new(
        default_id: impl AsRef<str>,
        providers: impl IntoIterator<Item = Arc<dyn MusicProvider>>,
    ) -> Result<Self, ProviderRegistryError> {
        let default_id = ProviderId::parse(default_id).map_err(ProviderRegistryError::InvalidId)?;
        let mut profiles = HashMap::new();
        for provider in providers {
            let id = ProviderId::parse(provider.id()).map_err(ProviderRegistryError::InvalidId)?;
            let facade = Arc::new(MusicProviderCapabilityFacade::from_legacy(
                id.clone(),
                provider,
            ));
            let key = ProviderProfileKey::default_profile(id.as_str())
                .expect("ProviderId is valid, so its default profile key is valid");
            if profiles.insert(key, facade).is_some() {
                return Err(ProviderRegistryError::DuplicateId(id));
            }
        }
        if profiles.is_empty() {
            return Err(ProviderRegistryError::Empty);
        }
        if !profiles.contains_key(
            &ProviderProfileKey::default_profile(default_id.as_str())
                .expect("ProviderId is valid, so its default profile key is valid"),
        ) {
            return Err(ProviderRegistryError::MissingDefault(default_id));
        }
        Ok(Self {
            state: RwLock::new(RegistryState {
                profiles,
                inactive: HashMap::new(),
            }),
            default_id,
        })
    }

    pub fn provider(&self, id: &str) -> Option<Arc<dyn MusicProvider>> {
        self.capabilities(id)
            .and_then(|provider| provider.legacy_provider())
    }

    pub fn capabilities(&self, id: &str) -> Option<Arc<MusicProviderCapabilityFacade>> {
        self.capabilities_for_profile(id, DEFAULT_PROFILE_ID)
    }

    pub fn provider_ids(&self) -> impl Iterator<Item = ProviderId> {
        let mut ids = self
            .read_state()
            .profiles
            .keys()
            .filter(|key| key.profile_id == DEFAULT_PROFILE_ID)
            .map(|key| {
                ProviderId::parse(&key.provider_id).expect("registered profile key is valid")
            })
            .collect::<Vec<_>>();
        ids.sort();
        ids.into_iter()
    }

    /// Return all live provider/profile keys. A platform appears once for each
    /// registered profile; descriptors intentionally remain platform-level.
    pub fn profile_keys(&self) -> Vec<ProviderProfileKey> {
        let mut keys = self
            .read_state()
            .profiles
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        keys.sort();
        keys
    }

    pub fn descriptors(&self) -> Vec<ProviderDescriptor> {
        let state = self.read_state();
        let mut descriptors = state
            .profiles
            .iter()
            .filter(|(key, _)| key.profile_id == DEFAULT_PROFILE_ID)
            .map(|(_, provider)| provider)
            .map(|provider| provider.descriptor(provider.id() == &self.default_id, true))
            .collect::<Vec<_>>();
        descriptors.extend(state.inactive.values().cloned());
        descriptors.sort_by(|left, right| left.provider_id.cmp(&right.provider_id));
        descriptors
    }

    pub fn register_inactive(
        &self,
        id: impl AsRef<str>,
        display_name: impl Into<String>,
        capabilities: ProviderCapabilitySummary,
    ) -> Result<(), ProviderRegistryError> {
        let id = ProviderId::parse(id).map_err(ProviderRegistryError::InvalidId)?;
        let mut state = self.write_state();
        if Self::state_contains_default_profile(&state, id.as_str()) {
            return Ok(());
        }
        state.inactive.insert(
            id.clone(),
            ProviderDescriptor {
                provider_id: id.to_string(),
                display_name: display_name.into(),
                is_default: id == self.default_id,
                available: false,
                capabilities,
            },
        );
        Ok(())
    }

    pub fn forget_inactive(&self, id: &str) {
        self.write_state().inactive.remove(id);
    }

    pub fn default_id(&self) -> &ProviderId {
        &self.default_id
    }

    pub fn default_provider(&self) -> Arc<dyn MusicProvider> {
        self.capabilities(self.default_id.as_str())
            .expect("ProviderRegistry validates its default provider")
            .legacy_provider()
            .expect("ProviderRegistry default is a legacy provider")
    }

    pub fn register_capabilities(
        &self,
        id: impl AsRef<str>,
        capabilities: ProviderCapabilities,
    ) -> Result<Arc<MusicProviderCapabilityFacade>, ProviderRegistryError> {
        if capabilities.is_empty() {
            return Err(ProviderRegistryError::EmptyCapabilities);
        }
        let id = ProviderId::parse(id).map_err(ProviderRegistryError::InvalidId)?;
        let facade = Arc::new(MusicProviderCapabilityFacade::from_capabilities(
            id.clone(),
            capabilities,
        ));
        let key = ProviderProfileKey::default_profile(id.as_str())
            .expect("ProviderId is valid, so its default profile key is valid");
        let mut state = self.write_state();
        if state.profiles.contains_key(&key) {
            return Err(ProviderRegistryError::DuplicateId(id));
        }
        state.profiles.insert(key, Arc::clone(&facade));
        state.inactive.remove(&id);
        Ok(facade)
    }

    /// Register a second local profile for an existing platform provider.
    /// The platform descriptor remains owned by the default profile, so a
    /// profile cannot appear as a separate provider in discovery UI.
    pub fn register_profile(
        &self,
        provider_id: impl AsRef<str>,
        profile_id: impl AsRef<str>,
        capabilities: ProviderCapabilities,
    ) -> Result<Arc<MusicProviderCapabilityFacade>, ProviderRegistryError> {
        if capabilities.is_empty() {
            return Err(ProviderRegistryError::EmptyCapabilities);
        }
        let key = ProviderProfileKey::new(provider_id, profile_id)
            .map_err(ProviderRegistryError::InvalidProfile)?;
        let id =
            ProviderId::parse(&key.provider_id).expect("profile key validates its provider ID");
        let default_key = ProviderProfileKey::default_profile(id.as_str())
            .expect("ProviderId is valid, so its default profile key is valid");
        let facade = Arc::new(MusicProviderCapabilityFacade::from_capabilities(
            id.clone(),
            capabilities,
        ));
        let mut state = self.write_state();
        if !state.profiles.contains_key(&default_key) {
            return Err(ProviderRegistryError::MissingProvider(id));
        }
        if state.profiles.contains_key(&key) {
            return Err(ProviderRegistryError::DuplicateProfile(key));
        }
        state.profiles.insert(key, Arc::clone(&facade));
        Ok(facade)
    }

    pub fn unregister(
        &self,
        id: &str,
    ) -> Result<Option<Arc<MusicProviderCapabilityFacade>>, ProviderRegistryError> {
        if id == self.default_id.as_str() {
            return Err(ProviderRegistryError::ProtectedDefault(
                self.default_id.clone(),
            ));
        }
        let key = match ProviderProfileKey::default_profile(id) {
            Ok(key) => key,
            Err(_) => return Ok(None),
        };
        let mut state = self.write_state();
        let removed = state.profiles.remove(&key);
        if removed.is_some() {
            state
                .profiles
                .retain(|profile, _| profile.provider_id != id);
        }
        if let Some(provider) = &removed {
            state
                .inactive
                .insert(provider.id().clone(), provider.descriptor(false, false));
        }
        Ok(removed)
    }

    /// Remove one non-default profile without affecting the compatibility
    /// default profile or the platform descriptor.
    pub fn unregister_profile(
        &self,
        provider_id: &str,
        profile_id: &str,
    ) -> Result<Option<Arc<MusicProviderCapabilityFacade>>, ProviderRegistryError> {
        let key = ProviderProfileKey::new(provider_id, profile_id)
            .map_err(ProviderRegistryError::InvalidProfile)?;
        if key.profile_id == DEFAULT_PROFILE_ID {
            return Err(ProviderRegistryError::ProtectedDefaultProfile(key));
        }
        Ok(self.write_state().profiles.remove(&key))
    }

    pub fn contains(&self, id: &str) -> bool {
        self.capabilities(id).is_some()
    }

    pub fn capabilities_for_profile(
        &self,
        provider_id: &str,
        profile_id: &str,
    ) -> Option<Arc<MusicProviderCapabilityFacade>> {
        let key = ProviderProfileKey::new(provider_id, profile_id).ok()?;
        self.read_state().profiles.get(&key).map(Arc::clone)
    }

    pub fn catalog_provider(&self, id: &str) -> Option<Arc<dyn CatalogProvider>> {
        self.capabilities(id)
            .and_then(|provider| provider.catalog_arc())
    }

    pub fn require_catalog_provider(&self, id: &str) -> ProviderResult<Arc<dyn CatalogProvider>> {
        let provider = self.require_provider(id)?;
        provider
            .catalog_arc()
            .ok_or_else(|| unsupported_provider_capability("catalog"))
    }

    pub fn require_lyrics_provider(&self, id: &str) -> ProviderResult<Arc<dyn LyricsProvider>> {
        let provider = self.require_provider(id)?;
        provider
            .lyrics_arc()
            .ok_or_else(|| unsupported_provider_capability("lyrics"))
    }

    pub fn require_playback_provider(
        &self,
        id: &str,
    ) -> ProviderResult<Arc<dyn PlaybackSourceProvider>> {
        let provider = self.require_provider(id)?;
        provider
            .playback_arc()
            .ok_or_else(|| unsupported_provider_capability("playback"))
    }

    pub fn require_account_provider(&self, id: &str) -> ProviderResult<Arc<dyn AccountProvider>> {
        let provider = self.require_provider(id)?;
        provider
            .account_arc()
            .ok_or_else(|| unsupported_provider_capability("account"))
    }

    pub fn require_catalog_provider_for_profile(
        &self,
        provider_id: Option<&str>,
        profile_id: Option<&str>,
    ) -> ProviderResult<Arc<dyn CatalogProvider>> {
        self.require_provider_profile(provider_id, profile_id)?
            .catalog_arc()
            .ok_or_else(|| unsupported_provider_capability("catalog"))
    }

    pub fn require_lyrics_provider_for_profile(
        &self,
        provider_id: Option<&str>,
        profile_id: Option<&str>,
    ) -> ProviderResult<Arc<dyn LyricsProvider>> {
        self.require_provider_profile(provider_id, profile_id)?
            .lyrics_arc()
            .ok_or_else(|| unsupported_provider_capability("lyrics"))
    }

    pub fn require_playback_provider_for_profile(
        &self,
        provider_id: Option<&str>,
        profile_id: Option<&str>,
    ) -> ProviderResult<Arc<dyn PlaybackSourceProvider>> {
        self.require_provider_profile(provider_id, profile_id)?
            .playback_arc()
            .ok_or_else(|| unsupported_provider_capability("playback"))
    }

    pub fn require_account_provider_for_profile(
        &self,
        provider_id: Option<&str>,
        profile_id: Option<&str>,
    ) -> ProviderResult<Arc<dyn AccountProvider>> {
        self.require_provider_profile(provider_id, profile_id)?
            .account_arc()
            .ok_or_else(|| unsupported_provider_capability("account"))
    }

    pub fn require_recommendation_provider_for_profile(
        &self,
        provider_id: Option<&str>,
        profile_id: Option<&str>,
    ) -> ProviderResult<Arc<dyn RecommendationProvider>> {
        self.require_provider_profile(provider_id, profile_id)?
            .recommendations_arc()
            .ok_or_else(|| unsupported_provider_capability("recommendations"))
    }

    pub fn require_share_provider_for_profile(
        &self,
        provider_id: Option<&str>,
        profile_id: Option<&str>,
    ) -> ProviderResult<Arc<dyn ShareProvider>> {
        self.require_provider_profile(provider_id, profile_id)?
            .share_arc()
            .ok_or_else(|| unsupported_provider_capability("sharing"))
    }

    pub async fn remember_songs(&self, id: &str, songs: &[Song]) {
        if let Some(provider) = self.catalog_provider(id) {
            provider.catalog_remember_songs(songs).await;
        }
    }

    /// Route queue/catalog hydration to the provider that owns each song.
    /// Unknown or currently unavailable profiles remain in the queue but do
    /// not leak their metadata into another provider's cache.
    pub async fn remember_scoped_songs(&self, songs: &[Song]) {
        let mut grouped = HashMap::<ProviderProfileKey, Vec<Song>>::new();
        for song in songs {
            let (provider_id, profile_id) = song.provider.as_ref().map_or_else(
                || (self.default_id.as_str(), DEFAULT_PROFILE_ID),
                |reference| {
                    (
                        reference.provider_id.as_str(),
                        reference.profile_id.as_str(),
                    )
                },
            );
            if self
                .resolve_profile(Some(provider_id), Some(profile_id))
                .is_ok()
            {
                let key = ProviderProfileKey::new(provider_id, profile_id)
                    .expect("resolve_profile validates the provider/profile key");
                grouped.entry(key).or_default().push(song.clone());
            }
        }
        for (profile, songs) in grouped {
            if let Ok(provider) = self.require_catalog_provider_for_profile(
                Some(&profile.provider_id),
                Some(&profile.profile_id),
            ) {
                provider.catalog_remember_songs(&songs).await;
            }
        }
    }

    pub async fn remember_songs_for_profile(
        &self,
        profile: &ProviderProfileKey,
        songs: &[Song],
    ) -> ProviderResult<()> {
        self.resolve_profile(Some(&profile.provider_id), Some(&profile.profile_id))?;
        for song in songs {
            let song_profile = song
                .provider
                .as_ref()
                .map_or_else(
                    || ProviderProfileKey::default_profile(&profile.provider_id),
                    |reference| {
                        ProviderProfileKey::new(&reference.provider_id, &reference.profile_id)
                    },
                )
                .map_err(|_| {
                    ProviderCommandError::invalid_request("song provider scope is invalid")
                })?;
            if song_profile != *profile {
                return Err(ProviderCommandError::invalid_request(
                    "song provider scope does not match the requested profile",
                ));
            }
        }
        if let Ok(provider) = self.require_catalog_provider_for_profile(
            Some(&profile.provider_id),
            Some(&profile.profile_id),
        ) {
            provider.catalog_remember_songs(songs).await;
        }
        Ok(())
    }

    pub async fn share_song(
        &self,
        provider_id: &str,
        profile_id: Option<&str>,
        id: String,
    ) -> ProviderResult<ShareTarget> {
        let expected_scope = self.resolve_profile(Some(provider_id), profile_id)?;
        let share = self.require_share_provider_for_profile(
            Some(provider_id),
            Some(&expected_scope.profile_id),
        )?;
        let target = share.share_song(id).await?;
        let returned_scope = ProviderProfileKey::new(&target.provider_id, &target.profile_id)
            .map_err(|_| {
                ProviderCommandError::adapter("provider returned an invalid share scope")
            })?;
        if returned_scope != expected_scope {
            return Err(ProviderCommandError::adapter(
                "provider returned a mismatched share scope",
            ));
        }
        Ok(target)
    }

    pub fn account_generation(&self, provider_id: &str) -> Option<u64> {
        let provider = self.capabilities(provider_id)?;
        Some(
            provider
                .account()
                .map_or(0, |account| account.provider_account().account_generation()),
        )
    }

    pub fn account_generation_for_profile(
        &self,
        profile: &ProviderProfileKey,
    ) -> ProviderResult<Option<u64>> {
        let provider =
            self.require_provider_profile(Some(&profile.provider_id), Some(&profile.profile_id))?;
        Ok(Some(provider.account().map_or(0, |account| {
            account.provider_account().account_generation()
        })))
    }

    pub async fn recommendation_next(
        &self,
        provider_id: &str,
        request: RecommendationRequest,
    ) -> ProviderResult<RecommendationBatch> {
        let profile = self.resolve_profile(Some(provider_id), None)?;
        let batch = self
            .require_recommendation_provider_for_profile(
                Some(&profile.provider_id),
                Some(&profile.profile_id),
            )?
            .recommendation_next(request)
            .await?;
        validate_recommendation_batch_scope(batch, &profile)
    }

    pub async fn recommendation_next_for_profile(
        &self,
        profile: &ProviderProfileKey,
        request: RecommendationRequest,
    ) -> ProviderResult<RecommendationBatch> {
        let expected =
            self.resolve_profile(Some(&profile.provider_id), Some(&profile.profile_id))?;
        let batch = self
            .require_recommendation_provider_for_profile(
                Some(&profile.provider_id),
                Some(&profile.profile_id),
            )?
            .recommendation_next(request)
            .await?;
        validate_recommendation_batch_scope(batch, &expected)
    }

    fn require_provider(&self, id: &str) -> ProviderResult<Arc<MusicProviderCapabilityFacade>> {
        self.capabilities(id).ok_or_else(|| ProviderCommandError {
            code: "provider-unavailable".to_owned(),
            message: "music provider is unavailable".to_owned(),
            retryable: false,
        })
    }

    /// Resolve a provider/profile pair at the registry boundary.
    ///
    /// Missing profile IDs retain the legacy default. Explicit profile IDs
    /// must name a currently registered instance; there is no fallback from a
    /// missing scoped profile to the default instance.
    pub fn resolve_profile(
        &self,
        provider_id: Option<&str>,
        profile_id: Option<&str>,
    ) -> ProviderResult<ProviderProfileKey> {
        let provider_id = provider_id.ok_or_else(|| ProviderCommandError {
            code: "provider-unavailable".to_owned(),
            message: "music provider is unavailable".to_owned(),
            retryable: false,
        })?;
        let profile_id = profile_id.unwrap_or(DEFAULT_PROFILE_ID);
        let key = ProviderProfileKey::new(provider_id, profile_id).map_err(|error| {
            ProviderCommandError::invalid_request(format!("invalid provider profile: {error}"))
        })?;
        if !self.contains(provider_id) {
            return Err(ProviderCommandError {
                code: "provider-unavailable".to_owned(),
                message: "music provider is unavailable".to_owned(),
                retryable: false,
            });
        }
        if self.read_state().profiles.contains_key(&key) {
            Ok(key)
        } else {
            Err(ProviderCommandError {
                code: "profile-unavailable".to_owned(),
                message: "music provider profile is unavailable".to_owned(),
                retryable: false,
            })
        }
    }

    /// Resolve and return a provider capability façade for a profile-aware
    /// command. This is the profile-aware counterpart to `require_provider`.
    pub fn require_provider_profile(
        &self,
        provider_id: Option<&str>,
        profile_id: Option<&str>,
    ) -> ProviderResult<Arc<MusicProviderCapabilityFacade>> {
        let key = self.resolve_profile(provider_id, profile_id)?;
        self.capabilities_for_profile(&key.provider_id, &key.profile_id)
            .ok_or_else(|| ProviderCommandError {
                code: "profile-unavailable".to_owned(),
                message: "music provider profile is unavailable".to_owned(),
                retryable: false,
            })
    }

    fn playback_for_song(
        &self,
        song: &Song,
    ) -> Result<Arc<dyn PlaybackSourceProvider>, PlaybackSourceError> {
        match song.provider.as_ref() {
            Some(reference) => {
                self.resolve_profile(Some(&reference.provider_id), Some(&reference.profile_id))
                    .map_err(|_| PlaybackSourceError::TrackUnavailable)?;
                self.capabilities_for_profile(&reference.provider_id, &reference.profile_id)
                    .and_then(|provider| provider.playback_arc())
                    .ok_or(PlaybackSourceError::TrackUnavailable)
            }
            None => self
                .capabilities(self.default_id.as_str())
                .and_then(|provider| provider.playback_arc())
                .ok_or(PlaybackSourceError::TrackUnavailable),
        }
    }

    fn state_contains_default_profile(state: &RegistryState, id: &str) -> bool {
        ProviderProfileKey::default_profile(id)
            .ok()
            .is_some_and(|key| state.profiles.contains_key(&key))
    }

    fn read_state(&self) -> std::sync::RwLockReadGuard<'_, RegistryState> {
        self.state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn write_state(&self) -> std::sync::RwLockWriteGuard<'_, RegistryState> {
        self.state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn unsupported_provider_capability(capability: &str) -> ProviderCommandError {
    ProviderCommandError {
        code: "unsupported-operation".to_owned(),
        message: format!("this music provider does not support {capability}"),
        retryable: false,
    }
}

fn validate_recommendation_batch_scope(
    mut batch: RecommendationBatch,
    expected: &ProviderProfileKey,
) -> ProviderResult<RecommendationBatch> {
    for song in &mut batch.songs {
        match &song.provider {
            Some(reference) => {
                let actual = ProviderProfileKey::new(&reference.provider_id, &reference.profile_id)
                    .map_err(|_| {
                        ProviderCommandError::adapter(
                            "provider returned an invalid recommendation song scope",
                        )
                    })?;
                if actual != *expected {
                    return Err(ProviderCommandError::adapter(
                        "provider returned a mismatched recommendation song scope",
                    ));
                }
            }
            None if expected.profile_id == DEFAULT_PROFILE_ID => {
                song.provider = Some(crate::ProviderTrackReference {
                    provider_id: expected.provider_id.clone(),
                    profile_id: expected.profile_id.clone(),
                    track_id: song.id.clone(),
                    numeric_id: None,
                    album_id: None,
                    media_id: None,
                });
            }
            None => {
                return Err(ProviderCommandError::adapter(
                    "provider returned an unscoped recommendation for a non-default profile",
                ));
            }
        }
    }
    Ok(batch)
}

#[async_trait]
impl PlaybackSourceResolver for ProviderRegistry {
    async fn resolve(&self, song: &Song) -> Result<ResolvedPlaybackSource, PlaybackSourceError> {
        self.playback_for_song(song)?.resolve(song).await
    }

    async fn resolve_client_fallback(
        &self,
        song: &Song,
        failed: &PlaybackSourceSelection,
    ) -> Result<ResolvedPlaybackSource, PlaybackSourceError> {
        self.playback_for_song(song)?
            .resolve_client_fallback(song, failed)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        AlbumSummary, ArtistSummary, Artwork, AudioFormat, AudioQuality, PlaybackEpochGuard,
        PlaybackLocation, PlaybackSourceSelection, ProviderTrackReference, RecommendationKind,
        SongAvailability,
    };
    use std::{path::PathBuf, sync::Barrier, thread};

    struct ProfilePlayback {
        label: &'static str,
    }

    struct ProfileRecommendations {
        song: Song,
    }

    #[async_trait]
    impl RecommendationProvider for ProfileRecommendations {
        async fn recommendation_next(
            &self,
            _request: RecommendationRequest,
        ) -> ProviderResult<RecommendationBatch> {
            Ok(RecommendationBatch {
                songs: vec![self.song.clone()],
                next_cursor: None,
                ended: true,
            })
        }
    }

    #[async_trait]
    impl PlaybackSourceResolver for ProfilePlayback {
        async fn resolve(
            &self,
            song: &Song,
        ) -> Result<ResolvedPlaybackSource, PlaybackSourceError> {
            Ok(ResolvedPlaybackSource {
                cache_key: format!("{}:{}", self.label, song.id),
                location: PlaybackLocation::Local(PathBuf::from("profile-test.wav")),
                format: AudioFormat::Wav,
                mime_type: Some("audio/wav".to_owned()),
                quality_label: self.label.to_owned(),
                bitrate_kbps: None,
                sample_rate_hz: None,
                bit_depth: None,
                content_length: None,
                supports_range: true,
                expires_at_ms: None,
                timeline_offset_ms: 0,
                timeline_end_ms: Some(song.duration_ms),
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
    }

    #[async_trait]
    impl PlaybackSourceProvider for ProfilePlayback {
        fn playback_media_http_client(&self) -> reqwest::Client {
            reqwest::Client::new()
        }

        async fn playback_set_preferred_quality(
            &self,
            _quality: AudioQualityPreference,
        ) -> ProviderResult<ProviderStatus> {
            Err(ProviderCommandError::invalid_request(
                "not used by this test",
            ))
        }

        async fn playback_set_current_quality(
            &self,
            _track_id: String,
            _quality: AudioQualityPreference,
        ) -> ProviderResult<()> {
            Ok(())
        }
    }

    fn playback_capabilities(label: &'static str) -> ProviderCapabilities {
        ProviderCapabilities {
            playback: Some(Arc::new(ProfilePlayback { label })),
            ..ProviderCapabilities::default()
        }
    }

    fn recommendation_capabilities(song: Song) -> ProviderCapabilities {
        ProviderCapabilities {
            recommendations: Some(Arc::new(ProfileRecommendations { song })),
            ..ProviderCapabilities::default()
        }
    }

    fn scoped_song(profile_id: Option<&str>) -> Song {
        Song {
            id: "same-track".to_owned(),
            title: "Test song".to_owned(),
            artists: vec![ArtistSummary {
                id: "artist".to_owned(),
                name: "Artist".to_owned(),
            }],
            album: AlbumSummary {
                id: "album".to_owned(),
                title: "Album".to_owned(),
            },
            artwork: Artwork {
                src: String::new(),
                alt: String::new(),
                dominant_color: String::new(),
                variants: Vec::new(),
            },
            duration_ms: 1,
            track_number: 1,
            is_favorite: false,
            quality: AudioQuality::Standard,
            availability: SongAvailability::Available,
            audio_formats: Vec::new(),
            playback_capability: None,
            provider: profile_id.map(|profile_id| ProviderTrackReference {
                provider_id: "qqmusic".to_owned(),
                profile_id: profile_id.to_owned(),
                track_id: "same-track".to_owned(),
                numeric_id: None,
                album_id: None,
                media_id: None,
            }),
        }
    }

    fn test_registry() -> ProviderRegistry {
        let id = ProviderId::parse("qqmusic").expect("test provider ID");
        let facade = Arc::new(MusicProviderCapabilityFacade::from_capabilities(
            id.clone(),
            ProviderCapabilities::default(),
        ));
        let mut profiles = HashMap::new();
        profiles.insert(
            ProviderProfileKey::default_profile(id.as_str()).expect("default profile key"),
            facade,
        );
        ProviderRegistry {
            state: RwLock::new(RegistryState {
                profiles,
                inactive: HashMap::new(),
            }),
            default_id: id,
        }
    }

    fn playback_registry() -> ProviderRegistry {
        let id = ProviderId::parse("qqmusic").expect("test provider ID");
        let facade = Arc::new(MusicProviderCapabilityFacade::from_capabilities(
            id.clone(),
            playback_capabilities("default"),
        ));
        let mut profiles = HashMap::new();
        profiles.insert(
            ProviderProfileKey::default_profile(id.as_str()).expect("default profile key"),
            facade,
        );
        ProviderRegistry {
            state: RwLock::new(RegistryState {
                profiles,
                inactive: HashMap::new(),
            }),
            default_id: id,
        }
    }

    fn recommendation_registry(song: Song) -> ProviderRegistry {
        let id = ProviderId::parse("qqmusic").expect("test provider ID");
        let facade = Arc::new(MusicProviderCapabilityFacade::from_capabilities(
            id.clone(),
            recommendation_capabilities(song),
        ));
        let mut profiles = HashMap::new();
        profiles.insert(
            ProviderProfileKey::default_profile(id.as_str()).expect("default profile key"),
            facade,
        );
        ProviderRegistry {
            state: RwLock::new(RegistryState {
                profiles,
                inactive: HashMap::new(),
            }),
            default_id: id,
        }
    }

    fn recommendation_request() -> RecommendationRequest {
        RecommendationRequest {
            kind: RecommendationKind::Guess,
            limit: 1,
            cursor: None,
            seeds: Vec::new(),
        }
    }

    #[test]
    fn runtime_provider_ids_are_owned_and_validated() {
        let source = String::from("plugin.example-source_2");
        let id = ProviderId::parse(&source).expect("valid runtime provider ID");
        drop(source);
        assert_eq!(id.as_str(), "plugin.example-source_2");
        assert_eq!(id.to_string(), "plugin.example-source_2");
    }

    #[test]
    fn provider_ids_reject_unsafe_or_ambiguous_inputs() {
        assert_eq!(ProviderId::parse(""), Err(ProviderIdError::Empty));
        assert_eq!(
            ProviderId::parse("Uppercase"),
            Err(ProviderIdError::InvalidCharacter)
        );
        assert_eq!(
            ProviderId::parse("plugin/escape"),
            Err(ProviderIdError::InvalidCharacter)
        );
        assert_eq!(
            ProviderId::parse("plugin:account"),
            Err(ProviderIdError::InvalidCharacter)
        );
        assert_eq!(
            ProviderId::parse("a".repeat(MAX_PROVIDER_ID_BYTES + 1)),
            Err(ProviderIdError::TooLong)
        );
    }

    #[test]
    fn profile_resolution_defaults_missing_values_to_legacy_profile() {
        let registry = test_registry();

        let missing = registry
            .resolve_profile(Some("qqmusic"), None)
            .expect("missing profile uses the default");
        assert_eq!(missing.profile_id, DEFAULT_PROFILE_ID);

        let explicit = registry
            .resolve_profile(Some("qqmusic"), Some(DEFAULT_PROFILE_ID))
            .expect("explicit default profile is available");
        assert_eq!(explicit, missing);
    }

    #[test]
    fn profile_resolution_classifies_provider_and_profile_failures() {
        let registry = test_registry();

        assert_eq!(
            registry
                .resolve_profile(None, None)
                .expect_err("missing provider must fail closed")
                .code,
            "provider-unavailable"
        );
        assert_eq!(
            registry
                .resolve_profile(Some("qqmusic"), Some("bad profile"))
                .expect_err("malformed profile must be rejected")
                .code,
            "invalid-request"
        );
        assert_eq!(
            registry
                .resolve_profile(Some("missing"), None)
                .expect_err("unknown provider must be unavailable")
                .code,
            "provider-unavailable"
        );
        assert_eq!(
            registry
                .resolve_profile(Some("qqmusic"), Some("secondary"))
                .expect_err("B1 has no non-default profiles")
                .code,
            "profile-unavailable"
        );
    }

    #[test]
    fn profile_scoped_continuation_routes_reject_non_default_profiles() {
        let registry = test_registry();
        let alternate = ProviderProfileKey::new("qqmusic", "alternate").expect("profile key");

        assert_eq!(
            registry
                .account_generation_for_profile(&alternate)
                .expect_err("B1 does not expose alternate profiles")
                .code,
            "profile-unavailable"
        );
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("test runtime");
        let error = runtime.block_on(registry.recommendation_next_for_profile(
            &alternate,
            RecommendationRequest {
                kind: RecommendationKind::Guess,
                limit: 1,
                cursor: None,
                seeds: Vec::new(),
            },
        ));
        assert_eq!(
            error
                .expect_err("B1 does not expose alternate profiles")
                .code,
            "profile-unavailable"
        );
    }

    #[test]
    fn profile_registration_routes_default_and_work_instances_exactly() {
        let registry = playback_registry();
        let work = registry
            .register_profile("qqmusic", "work", playback_capabilities("work"))
            .expect("register work profile");

        assert!(Arc::ptr_eq(
            &work,
            &registry
                .require_provider_profile(Some("qqmusic"), Some("work"))
                .expect("work profile")
        ));
        assert_eq!(
            registry
                .resolve_profile(Some("qqmusic"), None)
                .expect("legacy default")
                .profile_id,
            DEFAULT_PROFILE_ID
        );
        assert_eq!(
            registry
                .profile_keys()
                .into_iter()
                .map(|key| key.profile_id)
                .collect::<Vec<_>>(),
            vec![DEFAULT_PROFILE_ID.to_owned(), "work".to_owned()]
        );
        assert_eq!(registry.descriptors().len(), 1);
    }

    #[test]
    fn profile_registration_fails_closed_and_default_profile_is_protected() {
        let registry = playback_registry();
        registry
            .register_profile("qqmusic", "work", playback_capabilities("work"))
            .expect("register work profile");

        assert!(matches!(
            registry.register_profile("qqmusic", "work", playback_capabilities("other")),
            Err(ProviderRegistryError::DuplicateProfile(_))
        ));
        assert!(matches!(
            registry.register_profile("missing", "work", playback_capabilities("other")),
            Err(ProviderRegistryError::MissingProvider(_))
        ));
        assert_eq!(
            registry
                .resolve_profile(Some("qqmusic"), Some("unknown"))
                .expect_err("unknown profile fails closed")
                .code,
            "profile-unavailable"
        );
        assert_eq!(
            registry
                .resolve_profile(Some("qqmusic"), Some("bad profile"))
                .expect_err("invalid profile fails closed")
                .code,
            "invalid-request"
        );
        assert!(matches!(
            registry.unregister_profile("qqmusic", DEFAULT_PROFILE_ID),
            Err(ProviderRegistryError::ProtectedDefaultProfile(_))
        ));
    }

    #[test]
    fn unregistering_work_profile_preserves_default_profile() {
        let registry = playback_registry();
        registry
            .register_profile("qqmusic", "work", playback_capabilities("work"))
            .expect("register work profile");

        assert!(registry
            .unregister_profile("qqmusic", "work")
            .expect("unregister work")
            .is_some());
        assert!(registry.contains("qqmusic"));
        assert!(registry.resolve_profile(Some("qqmusic"), None).is_ok());
        assert_eq!(
            registry
                .resolve_profile(Some("qqmusic"), Some("work"))
                .expect_err("removed profile is unavailable")
                .code,
            "profile-unavailable"
        );
    }

    #[test]
    fn capability_and_playback_lookup_keep_profile_scope() {
        let registry = playback_registry();
        registry
            .register_profile("qqmusic", "work", playback_capabilities("work"))
            .expect("register work profile");

        assert!(registry
            .require_playback_provider_for_profile(Some("qqmusic"), Some("work"))
            .is_ok());
        let catalog_error =
            match registry.require_catalog_provider_for_profile(Some("qqmusic"), Some("work")) {
                Ok(_) => panic!("work has no catalog capability"),
                Err(error) => error,
            };
        assert_eq!(catalog_error.code, "unsupported-operation");

        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("test runtime");
        let default = runtime
            .block_on(registry.resolve(&scoped_song(Some(DEFAULT_PROFILE_ID))))
            .expect("default playback route");
        let work = runtime
            .block_on(registry.resolve(&scoped_song(Some("work"))))
            .expect("work playback route");
        let legacy = runtime
            .block_on(registry.resolve(&scoped_song(None)))
            .expect("legacy playback route");
        assert_eq!(default.cache_key, "default:same-track");
        assert_eq!(work.cache_key, "work:same-track");
        assert_eq!(legacy.cache_key, "default:same-track");
    }

    #[test]
    fn active_and_inactive_descriptor_transition_is_atomic() {
        let registry = Arc::new(playback_registry());
        registry
            .register_capabilities("netease", playback_capabilities("netease"))
            .expect("register secondary provider");
        let barrier = Arc::new(Barrier::new(3));

        let unregister_registry = Arc::clone(&registry);
        let unregister_barrier = Arc::clone(&barrier);
        let unregister = thread::spawn(move || {
            unregister_barrier.wait();
            unregister_registry
                .unregister("netease")
                .expect("unregister secondary provider");
        });
        let register_registry = Arc::clone(&registry);
        let register_barrier = Arc::clone(&barrier);
        let register = thread::spawn(move || {
            register_barrier.wait();
            let _ = register_registry
                .register_capabilities("netease", playback_capabilities("netease-replacement"));
        });
        barrier.wait();
        unregister.join().expect("unregister thread");
        register.join().expect("register thread");

        let netease = registry
            .descriptors()
            .into_iter()
            .filter(|descriptor| descriptor.provider_id == "netease")
            .collect::<Vec<_>>();
        assert_eq!(
            netease.len(),
            1,
            "a platform has one active-or-inactive descriptor"
        );
        assert_eq!(netease[0].available, registry.contains("netease"));
    }

    #[test]
    fn recommendations_keep_default_and_work_profile_scope() {
        let registry = recommendation_registry(scoped_song(None));
        registry
            .register_profile(
                "qqmusic",
                "work",
                recommendation_capabilities(scoped_song(Some("work"))),
            )
            .expect("register work recommendation provider");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("test runtime");

        let default = runtime
            .block_on(registry.recommendation_next("qqmusic", recommendation_request()))
            .expect("legacy default output is materialized");
        let default_scope = default.songs[0]
            .provider
            .as_ref()
            .expect("materialized scope");
        assert_eq!(default_scope.provider_id, "qqmusic");
        assert_eq!(default_scope.profile_id, DEFAULT_PROFILE_ID);

        let work_profile = ProviderProfileKey::new("qqmusic", "work").expect("work key");
        let work = runtime
            .block_on(
                registry.recommendation_next_for_profile(&work_profile, recommendation_request()),
            )
            .expect("work output has exact scope");
        assert_eq!(
            work.songs[0]
                .provider
                .as_ref()
                .expect("work scope")
                .profile_id,
            "work"
        );
    }

    #[test]
    fn recommendations_reject_foreign_provider_and_profile_scope() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("test runtime");

        let mut foreign_provider_song = scoped_song(Some(DEFAULT_PROFILE_ID));
        foreign_provider_song
            .provider
            .as_mut()
            .expect("scoped song")
            .provider_id = "netease".to_owned();
        let foreign_provider = recommendation_registry(foreign_provider_song);
        assert_eq!(
            runtime
                .block_on(foreign_provider.recommendation_next("qqmusic", recommendation_request()))
                .expect_err("foreign recommendation provider must fail closed")
                .code,
            "provider-failure"
        );

        let foreign_profile = recommendation_registry(scoped_song(Some("other")));
        assert_eq!(
            runtime
                .block_on(foreign_profile.recommendation_next("qqmusic", recommendation_request()))
                .expect_err("foreign recommendation profile must fail closed")
                .code,
            "provider-failure"
        );
    }
}
