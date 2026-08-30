//! Object-safe music-provider contracts derived from the current QQMusic service.

use crate::{
    AccountPlaylistDetail, AccountPlaylistSummary, AccountSnapshot, Album, AreaFeed, Artist,
    ArtistCatalogKind, ArtistCatalogPage, AudioQualityPreference, CacheStats,
    CatalogProviderCapabilities, CatalogSearchKind, CollectPlaylistRequest, CreatePlaylistRequest,
    DeletePlaylistRequest, DiscoverFeed, FavoriteMutationRequest, FavoriteMutationResult, HomeFeed,
    LibrarySnapshot, LyricDocument, OAuthLoginProvider, OAuthPrepareResult, Page,
    PlaybackSourceResolver, Playlist, PlaylistMutationResult, PlaylistTrackMutationRequest,
    ProviderResult, ProviderStatus, RemotePlayHistoryItem, RenamePlaylistRequest, SearchResult,
    Song,
};
use async_trait::async_trait;

#[async_trait]
pub trait ProviderAccount: Send + Sync {
    async fn account_snapshot(&self) -> AccountSnapshot;
    async fn favorite_songs(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> ProviderResult<Page<Song>>;
    async fn account_playlists(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> ProviderResult<Page<AccountPlaylistSummary>>;
    async fn account_playlist_tracks(
        &self,
        playlist: AccountPlaylistSummary,
        cursor: Option<String>,
        limit: u32,
    ) -> ProviderResult<AccountPlaylistDetail>;
    async fn account_recently_played(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> ProviderResult<Page<RemotePlayHistoryItem>>;
    async fn set_favorite(
        &self,
        request: FavoriteMutationRequest,
    ) -> ProviderResult<FavoriteMutationResult>;
    async fn create_playlist(
        &self,
        request: CreatePlaylistRequest,
    ) -> ProviderResult<PlaylistMutationResult>;
    async fn rename_playlist(
        &self,
        request: RenamePlaylistRequest,
    ) -> ProviderResult<PlaylistMutationResult>;
    async fn add_playlist_track(
        &self,
        request: PlaylistTrackMutationRequest,
    ) -> ProviderResult<PlaylistMutationResult>;
    async fn remove_playlist_track(
        &self,
        request: PlaylistTrackMutationRequest,
    ) -> ProviderResult<PlaylistMutationResult>;
    async fn delete_playlist(
        &self,
        request: DeletePlaylistRequest,
    ) -> ProviderResult<PlaylistMutationResult>;
    async fn set_playlist_collected(
        &self,
        request: CollectPlaylistRequest,
    ) -> ProviderResult<PlaylistMutationResult>;

    async fn start_qr_login(&self) -> ProviderResult<AccountSnapshot>;
    async fn prepare_oauth_login(
        &self,
        provider: OAuthLoginProvider,
    ) -> ProviderResult<OAuthPrepareResult>;
    async fn complete_oauth_login(
        &self,
        attempt_id: &str,
        callback_url: reqwest::Url,
    ) -> ProviderResult<AccountSnapshot>;
    async fn cancel_oauth_login(&self, attempt_id: &str) -> ProviderResult<AccountSnapshot>;
    async fn heartbeat_qr_login(
        &self,
        attempt_id: String,
        owner_lease_id: String,
    ) -> ProviderResult<AccountSnapshot>;
    async fn is_oauth_login(&self, attempt_id: &str) -> bool;
    async fn cancel_qr_login(&self, attempt_id: String) -> ProviderResult<AccountSnapshot>;
    async fn refresh_qr_login(&self, attempt_id: Option<String>)
        -> ProviderResult<AccountSnapshot>;
    async fn restore_session(&self);
    async fn sign_out(&self) -> ProviderResult<AccountSnapshot>;
}

/// Provider-neutral catalog capability exposed by the compatibility façade.
///
/// Method names are intentionally capability-prefixed while the monolithic
/// [`MusicProvider`] remains public, avoiding ambiguous method resolution for
/// existing consumers during the incremental migration.
#[async_trait]
pub trait CatalogProvider: Send + Sync {
    fn catalog_capabilities(&self) -> CatalogProviderCapabilities;
    async fn catalog_status(&self) -> ProviderStatus;
    async fn catalog_search(
        &self,
        query: String,
        kind: CatalogSearchKind,
        page: u32,
        limit: u32,
    ) -> ProviderResult<SearchResult>;
    async fn catalog_song(&self, id: String) -> ProviderResult<Song>;
    async fn catalog_album(&self, id: String) -> ProviderResult<Album>;
    async fn catalog_artist(&self, id: String) -> ProviderResult<Artist>;
    async fn catalog_artist_page(
        &self,
        id: String,
        kind: ArtistCatalogKind,
        page: u32,
        limit: u32,
    ) -> ProviderResult<ArtistCatalogPage>;
    async fn catalog_playlist(&self, id: String) -> ProviderResult<Playlist>;
    async fn catalog_home(&self, refresh: bool) -> ProviderResult<HomeFeed>;
    async fn catalog_discover(&self, refresh: bool) -> ProviderResult<DiscoverFeed>;
    async fn catalog_area(&self, enc_area: String) -> ProviderResult<AreaFeed>;
    fn catalog_library(&self) -> LibrarySnapshot;
    async fn catalog_artwork_data_uri(&self, url: String) -> ProviderResult<String>;
    fn catalog_cache_stats(&self) -> ProviderResult<CacheStats>;
    fn catalog_clear_cache(&self) -> ProviderResult<CacheStats>;
    async fn catalog_remember_songs(&self, songs: &[Song]);
}

/// Playback-source capability. Sensitive URLs and headers remain behind this
/// Core-side trait object and never cross into the renderer.
#[async_trait]
pub trait PlaybackSourceProvider: PlaybackSourceResolver + Send + Sync {
    fn playback_media_http_client(&self) -> reqwest::Client;
    async fn playback_set_preferred_quality(
        &self,
        quality: AudioQualityPreference,
    ) -> ProviderResult<ProviderStatus>;
    async fn playback_set_current_quality(
        &self,
        track_id: String,
        quality: AudioQualityPreference,
    ) -> ProviderResult<()>;
}

#[async_trait]
pub trait RecommendationProvider: Send + Sync {
    async fn recommendation_next(&self, limit: u32) -> ProviderResult<Vec<Song>>;
}

#[async_trait]
pub trait LyricsProvider: Send + Sync {
    async fn lyrics_for_song(&self, song_id: String) -> ProviderResult<Option<LyricDocument>>;
}

/// Optional account capability. It deliberately wraps the existing account
/// contract so catalog-only providers do not have to implement login or
/// mutation methods.
pub trait AccountProvider: Send + Sync {
    fn provider_account(&self) -> &dyn ProviderAccount;
}

#[async_trait]
pub trait MusicProvider: PlaybackSourceResolver + ProviderAccount + Send + Sync {
    /// Stable runtime ID. The registry validates and owns a copy, so providers
    /// loaded from configuration or plugins do not require leaked static data.
    fn id(&self) -> &str;
    fn account(&self) -> &dyn ProviderAccount;
    fn media_http_client(&self) -> reqwest::Client;
    fn capabilities(&self) -> CatalogProviderCapabilities;
    async fn status(&self) -> ProviderStatus;
    async fn set_preferred_quality(
        &self,
        quality: AudioQualityPreference,
    ) -> ProviderResult<ProviderStatus>;
    async fn set_current_quality(
        &self,
        track_id: String,
        quality: AudioQualityPreference,
    ) -> ProviderResult<()>;
    async fn search(
        &self,
        query: String,
        kind: CatalogSearchKind,
        page: u32,
        limit: u32,
    ) -> ProviderResult<SearchResult>;
    async fn song(&self, id: String) -> ProviderResult<Song>;
    async fn album(&self, id: String) -> ProviderResult<Album>;
    async fn artist(&self, id: String) -> ProviderResult<Artist>;
    async fn artist_catalog(
        &self,
        id: String,
        kind: ArtistCatalogKind,
        page: u32,
        limit: u32,
    ) -> ProviderResult<ArtistCatalogPage>;
    async fn playlist(&self, id: String) -> ProviderResult<Playlist>;
    async fn home(&self, refresh: bool) -> ProviderResult<HomeFeed>;
    async fn discover(&self, refresh: bool) -> ProviderResult<DiscoverFeed>;
    async fn area(&self, enc_area: String) -> ProviderResult<AreaFeed>;
    fn library(&self) -> LibrarySnapshot;
    async fn lyrics(&self, song_id: String) -> ProviderResult<Option<LyricDocument>>;
    async fn guess_next(&self, limit: u32) -> ProviderResult<Vec<Song>>;
    async fn artwork_data_uri(&self, url: String) -> ProviderResult<String>;
    fn cache_stats(&self) -> ProviderResult<CacheStats>;
    fn clear_cache(&self) -> ProviderResult<CacheStats>;
    async fn remember_songs(&self, songs: &[Song]);
}
