//! P14-A adapter from the retained in-tree implementation to provider-api.

use crate::qqmusic::{self, account as local_account, QQMusicError, QQMusicService};
use async_trait::async_trait;
use serde::{de::DeserializeOwned, Serialize};
use yaqmc_provider_api as api;

fn provider_error(error: QQMusicError) -> api::ProviderCommandError {
    api::ProviderCommandError {
        code: error.code().to_owned(),
        message: error.to_string(),
        retryable: error.retryable(),
    }
}

fn map_output<Source, Target>(value: Source) -> api::ProviderResult<Target>
where
    Source: Serialize,
    Target: DeserializeOwned,
{
    serde_json::to_value(value)
        .and_then(serde_json::from_value)
        .map_err(|_| api::ProviderCommandError::adapter("provider DTO mapping failed"))
}

fn map_input<Source, Target>(value: Source) -> api::ProviderResult<Target>
where
    Source: Serialize,
    Target: DeserializeOwned,
{
    serde_json::to_value(value)
        .and_then(serde_json::from_value)
        .map_err(|_| api::ProviderCommandError::invalid_request("provider request is invalid"))
}

fn local_oauth_provider(provider: api::OAuthLoginProvider) -> qqmusic::OAuthLoginProvider {
    match provider {
        api::OAuthLoginProvider::Qq => qqmusic::OAuthLoginProvider::Qq,
        api::OAuthLoginProvider::Wechat => qqmusic::OAuthLoginProvider::Wechat,
    }
}

#[async_trait]
impl api::ProviderAccount for QQMusicService {
    async fn account_snapshot(&self) -> api::AccountSnapshot {
        map_output(QQMusicService::account_snapshot(self).await)
            .expect("QQMusic account snapshot and provider-api DTOs share the frozen wire schema")
    }

    async fn favorite_songs(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> api::ProviderResult<api::Page<api::Song>> {
        let value = QQMusicService::favorite_songs(self, cursor, limit)
            .await
            .map_err(provider_error)?;
        map_output(value)
    }

    async fn account_playlists(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> api::ProviderResult<api::Page<api::AccountPlaylistSummary>> {
        let value = QQMusicService::account_playlists(self, cursor, limit)
            .await
            .map_err(provider_error)?;
        map_output(value)
    }

    async fn account_playlist_tracks(
        &self,
        playlist: api::AccountPlaylistSummary,
        cursor: Option<String>,
        limit: u32,
    ) -> api::ProviderResult<api::AccountPlaylistDetail> {
        let playlist: local_account::AccountPlaylistSummary = map_input(playlist)?;
        let value = QQMusicService::account_playlist_tracks(self, playlist, cursor, limit)
            .await
            .map_err(provider_error)?;
        map_output(value)
    }

    async fn account_recently_played(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> api::ProviderResult<api::Page<api::RemotePlayHistoryItem>> {
        let value = QQMusicService::account_recently_played(self, cursor, limit)
            .await
            .map_err(provider_error)?;
        map_output(value)
    }

    async fn set_favorite(
        &self,
        request: api::FavoriteMutationRequest,
    ) -> api::ProviderResult<api::FavoriteMutationResult> {
        let request: local_account::FavoriteMutationRequest = map_input(request)?;
        let value = QQMusicService::set_favorite(self, request)
            .await
            .map_err(provider_error)?;
        map_output(value)
    }

    async fn create_playlist(
        &self,
        request: api::CreatePlaylistRequest,
    ) -> api::ProviderResult<api::PlaylistMutationResult> {
        let request: local_account::CreatePlaylistRequest = map_input(request)?;
        let value = QQMusicService::create_playlist(self, request)
            .await
            .map_err(provider_error)?;
        map_output(value)
    }

    async fn rename_playlist(
        &self,
        request: api::RenamePlaylistRequest,
    ) -> api::ProviderResult<api::PlaylistMutationResult> {
        let request: local_account::RenamePlaylistRequest = map_input(request)?;
        let value = QQMusicService::rename_playlist(self, request)
            .await
            .map_err(provider_error)?;
        map_output(value)
    }

    async fn add_playlist_track(
        &self,
        request: api::PlaylistTrackMutationRequest,
    ) -> api::ProviderResult<api::PlaylistMutationResult> {
        let request: local_account::PlaylistTrackMutationRequest = map_input(request)?;
        let value = QQMusicService::add_playlist_track(self, request)
            .await
            .map_err(provider_error)?;
        map_output(value)
    }

    async fn remove_playlist_track(
        &self,
        request: api::PlaylistTrackMutationRequest,
    ) -> api::ProviderResult<api::PlaylistMutationResult> {
        let request: local_account::PlaylistTrackMutationRequest = map_input(request)?;
        let value = QQMusicService::remove_playlist_track(self, request)
            .await
            .map_err(provider_error)?;
        map_output(value)
    }

    async fn delete_playlist(
        &self,
        request: api::DeletePlaylistRequest,
    ) -> api::ProviderResult<api::PlaylistMutationResult> {
        let request: local_account::DeletePlaylistRequest = map_input(request)?;
        let value = QQMusicService::delete_playlist(self, request)
            .await
            .map_err(provider_error)?;
        map_output(value)
    }

    async fn set_playlist_collected(
        &self,
        request: api::CollectPlaylistRequest,
    ) -> api::ProviderResult<api::PlaylistMutationResult> {
        let request: local_account::CollectPlaylistRequest = map_input(request)?;
        let value = QQMusicService::set_playlist_collected(self, request)
            .await
            .map_err(provider_error)?;
        map_output(value)
    }

    async fn start_qr_login(&self) -> api::ProviderResult<api::AccountSnapshot> {
        let value = QQMusicService::start_qr_login(self)
            .await
            .map_err(provider_error)?;
        map_output(value)
    }

    async fn prepare_oauth_login(
        &self,
        provider: api::OAuthLoginProvider,
    ) -> api::ProviderResult<api::OAuthPrepareResult> {
        let local_provider = local_oauth_provider(provider);
        let launch = QQMusicService::start_oauth_login(self, local_provider)
            .await
            .map_err(provider_error)?;
        let result = qqmusic::OAuthPrepareResult::from_launch(local_provider, launch);
        Ok(api::OAuthPrepareResult {
            attempt_id: result.attempt_id,
            url: result.url,
            navigation_allowlist: result.navigation_allowlist,
            callback_matcher: api::OAuthCallbackMatcher {
                url_prefix: result.callback_matcher.url_prefix,
            },
            snapshot: map_output(result.snapshot)?,
        })
    }

    async fn complete_oauth_login(
        &self,
        attempt_id: &str,
        callback_url: reqwest::Url,
    ) -> api::ProviderResult<api::AccountSnapshot> {
        let value = QQMusicService::complete_oauth_login_callback(self, attempt_id, callback_url)
            .await
            .map_err(provider_error)?;
        map_output(value)
    }

    async fn cancel_oauth_login(
        &self,
        attempt_id: &str,
    ) -> api::ProviderResult<api::AccountSnapshot> {
        let value = QQMusicService::cancel_oauth_login(self, attempt_id)
            .await
            .map_err(provider_error)?;
        map_output(value)
    }

    async fn heartbeat_qr_login(
        &self,
        attempt_id: String,
        owner_lease_id: String,
    ) -> api::ProviderResult<api::AccountSnapshot> {
        let value = QQMusicService::heartbeat_qr_login(self, attempt_id, owner_lease_id)
            .await
            .map_err(provider_error)?;
        map_output(value)
    }

    async fn is_oauth_login(&self, attempt_id: &str) -> bool {
        QQMusicService::is_oauth_login(self, attempt_id).await
    }

    async fn cancel_qr_login(
        &self,
        attempt_id: String,
    ) -> api::ProviderResult<api::AccountSnapshot> {
        let value = QQMusicService::cancel_qr_login(self, attempt_id)
            .await
            .map_err(provider_error)?;
        map_output(value)
    }

    async fn refresh_qr_login(
        &self,
        attempt_id: Option<String>,
    ) -> api::ProviderResult<api::AccountSnapshot> {
        let value = QQMusicService::refresh_qr_login(self, attempt_id)
            .await
            .map_err(provider_error)?;
        map_output(value)
    }

    async fn restore_session(&self) {
        QQMusicService::restore_session(self).await;
    }

    async fn sign_out(&self) -> api::ProviderResult<api::AccountSnapshot> {
        let value = QQMusicService::sign_out(self)
            .await
            .map_err(provider_error)?;
        map_output(value)
    }
}

#[async_trait]
impl api::MusicProvider for QQMusicService {
    fn id(&self) -> &'static str {
        "qqmusic"
    }

    fn account(&self) -> &dyn api::ProviderAccount {
        self
    }

    fn media_http_client(&self) -> reqwest::Client {
        QQMusicService::http_client(self)
    }

    fn capabilities(&self) -> api::CatalogProviderCapabilities {
        map_output(QQMusicService::capabilities(self))
            .expect("QQMusic capabilities and provider-api DTOs share the frozen wire schema")
    }

    async fn status(&self) -> api::ProviderStatus {
        map_output(QQMusicService::status(self).await)
            .expect("QQMusic status and provider-api DTOs share the frozen wire schema")
    }

    async fn set_preferred_quality(
        &self,
        quality: api::AudioQualityPreference,
    ) -> api::ProviderResult<api::ProviderStatus> {
        let value = QQMusicService::set_preferred_quality(self, quality)
            .await
            .map_err(provider_error)?;
        map_output(value)
    }

    async fn set_current_quality(
        &self,
        track_id: String,
        quality: api::AudioQualityPreference,
    ) -> api::ProviderResult<()> {
        QQMusicService::set_current_quality(self, track_id, quality)
            .await
            .map_err(provider_error)
    }

    async fn search(
        &self,
        query: String,
        page: u32,
        limit: u32,
    ) -> api::ProviderResult<api::SearchResult> {
        let value = QQMusicService::search(self, query, page, limit)
            .await
            .map_err(provider_error)?;
        map_output(value)
    }

    async fn album(&self, id: String) -> api::ProviderResult<api::Album> {
        let value = QQMusicService::album(self, id)
            .await
            .map_err(provider_error)?;
        map_output(value)
    }

    async fn playlist(&self, id: String) -> api::ProviderResult<api::Playlist> {
        let value = QQMusicService::playlist(self, id)
            .await
            .map_err(provider_error)?;
        map_output(value)
    }

    async fn home(&self, refresh: bool) -> api::ProviderResult<api::HomeFeed> {
        let value = QQMusicService::home(self, refresh)
            .await
            .map_err(provider_error)?;
        map_output(value)
    }

    async fn discover(&self, refresh: bool) -> api::ProviderResult<api::DiscoverFeed> {
        let value = QQMusicService::discover(self, refresh)
            .await
            .map_err(provider_error)?;
        map_output(value)
    }

    async fn area(&self, enc_area: String) -> api::ProviderResult<api::AreaFeed> {
        let value = QQMusicService::area(self, enc_area)
            .await
            .map_err(provider_error)?;
        map_output(value)
    }

    fn library(&self) -> api::LibrarySnapshot {
        map_output(QQMusicService::library(self))
            .expect("QQMusic library and provider-api DTOs share the frozen wire schema")
    }

    async fn lyrics(&self, song_id: String) -> api::ProviderResult<Option<api::LyricDocument>> {
        QQMusicService::lyrics(self, song_id)
            .await
            .map_err(provider_error)
    }

    async fn guess_next(&self, limit: u32) -> api::ProviderResult<Vec<api::Song>> {
        QQMusicService::guess_next(self, limit)
            .await
            .map_err(provider_error)
    }

    async fn artwork_data_uri(&self, url: String) -> api::ProviderResult<String> {
        QQMusicService::artwork_data_uri(self, url)
            .await
            .map_err(provider_error)
    }

    fn cache_stats(&self) -> api::ProviderResult<api::CacheStats> {
        QQMusicService::cache_stats(self).map_err(provider_error)
    }

    fn clear_cache(&self) -> api::ProviderResult<api::CacheStats> {
        QQMusicService::clear_cache(self).map_err(provider_error)
    }

    async fn remember_songs(&self, songs: &[api::Song]) {
        QQMusicService::remember_songs(self, songs).await;
    }
}
