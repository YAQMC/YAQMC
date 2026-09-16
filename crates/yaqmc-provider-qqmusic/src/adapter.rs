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

/// Materialize the service-owned provider/profile scope on every API DTO.
/// Local QQMusic DTOs predate profiles and therefore omit profile IDs (or use
/// the legacy default).  Applying the scope after conversion also covers
/// nested songs inside pages, albums, playlists, feeds, and history records.
fn map_output_for_profile<Source, Target>(
    value: Source,
    profile: &api::ProviderProfileKey,
) -> api::ProviderResult<Target>
where
    Source: Serialize,
    Target: DeserializeOwned + Serialize,
{
    let target: Target = serde_json::to_value(value)
        .and_then(serde_json::from_value)
        .map_err(|_| api::ProviderCommandError::adapter("provider DTO mapping failed"))?;
    let mut value = serde_json::to_value(target)
        .map_err(|_| api::ProviderCommandError::adapter("provider DTO mapping failed"))?;
    fn rewrite(value: &mut serde_json::Value, profile: &api::ProviderProfileKey) {
        match value {
            serde_json::Value::Object(object) => {
                if object.get("providerId").and_then(serde_json::Value::as_str)
                    == Some(profile.provider_id.as_str())
                    && object.contains_key("profileId")
                {
                    object.insert(
                        "profileId".to_owned(),
                        serde_json::Value::String(profile.profile_id.clone()),
                    );
                }
                for child in object.values_mut() {
                    rewrite(child, profile);
                }
            }
            serde_json::Value::Array(items) => {
                for child in items {
                    rewrite(child, profile);
                }
            }
            _ => {}
        }
    }
    fn validate(value: &serde_json::Value, profile: &api::ProviderProfileKey) -> bool {
        match value {
            serde_json::Value::Object(object) => {
                let scoped = object.get("providerId").and_then(serde_json::Value::as_str)
                    == Some(profile.provider_id.as_str());
                (!scoped
                    || object.get("profileId").and_then(serde_json::Value::as_str)
                        == Some(profile.profile_id.as_str()))
                    && object.values().all(|child| validate(child, profile))
            }
            serde_json::Value::Array(items) => items.iter().all(|child| validate(child, profile)),
            _ => true,
        }
    }
    // Add the top-level scope where the target DTO exposes provider identity;
    // nested provider references are rewritten by the same walk.
    rewrite(&mut value, profile);
    if !validate(&value, profile) {
        return Err(api::ProviderCommandError::adapter(
            "provider DTO profile scope is invalid",
        ));
    }
    serde_json::from_value(value)
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

fn map_recommendation_songs(
    songs: Vec<api::Song>,
    profile: &api::ProviderProfileKey,
) -> api::ProviderResult<Vec<api::Song>> {
    let songs: Vec<api::Song> = map_output_for_profile(songs, profile)?;
    if songs.iter().any(|song| {
        song.provider.as_ref().is_none_or(|provider| {
            provider.provider_id != profile.provider_id || provider.profile_id != profile.profile_id
        })
    }) {
        return Err(api::ProviderCommandError::invalid_request(
            "recommendation returned a foreign provider profile",
        ));
    }
    Ok(songs)
}

fn local_oauth_provider(provider: api::OAuthLoginProvider) -> qqmusic::OAuthLoginProvider {
    match provider {
        api::OAuthLoginProvider::Qq => qqmusic::OAuthLoginProvider::Qq,
        api::OAuthLoginProvider::Wechat => qqmusic::OAuthLoginProvider::Wechat,
    }
}

fn share_target_for_song(
    song: api::Song,
    profile_id: &str,
) -> api::ProviderResult<api::ShareTarget> {
    let entity_id = song.id.trim();
    let title = song.title.trim();
    if entity_id.is_empty() || entity_id.len() > 256 || title.is_empty() {
        return Err(api::ProviderCommandError::invalid_request(
            "the song cannot be shared",
        ));
    }
    let provider = song
        .provider
        .as_ref()
        .filter(|provider| provider.provider_id == "qqmusic");
    if let Some(provider) = provider {
        let input_profile = api::ProviderProfileKey::new("qqmusic", &provider.profile_id)
            .map_err(|_| api::ProviderCommandError::invalid_request("song profile is invalid"))?;
        if input_profile.profile_id != profile_id {
            return Err(api::ProviderCommandError::invalid_request(
                "song belongs to a different QQ Music profile",
            ));
        }
    }
    let canonical_https_url =
        provider.and_then(|provider| qqmusic_api::canonical_song_url(&provider.track_id));
    Ok(api::ShareTarget {
        provider_id: "qqmusic".to_owned(),
        profile_id: profile_id.to_owned(),
        entity_kind: api::ShareEntityKind::Song,
        entity_id: entity_id.to_owned(),
        title: title.to_owned(),
        artists: song
            .artists
            .into_iter()
            .map(|artist| artist.name.trim().to_owned())
            .filter(|name| !name.is_empty())
            .collect(),
        album: (!song.album.title.trim().is_empty()).then(|| song.album.title.trim().to_owned()),
        canonical_https_url,
    })
}

#[async_trait]
impl api::ProviderAccount for QQMusicService {
    fn account_generation(&self) -> u64 {
        QQMusicService::account_generation(self)
    }

    async fn account_snapshot(&self) -> api::AccountSnapshot {
        map_output_for_profile(
            QQMusicService::account_snapshot(self).await,
            self.profile_key(),
        )
        .expect("QQMusic account snapshot and provider-api DTOs share the frozen wire schema")
    }

    async fn refresh_account(&self) -> api::ProviderResult<api::AccountSnapshot> {
        let value = QQMusicService::refresh_account(self)
            .await
            .map_err(provider_error)?;
        map_output_for_profile(value, self.profile_key())
    }

    async fn favorite_songs(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> api::ProviderResult<api::Page<api::Song>> {
        let value = QQMusicService::favorite_songs(self, cursor, limit)
            .await
            .map_err(provider_error)?;
        map_output_for_profile(value, self.profile_key())
    }

    async fn account_playlists(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> api::ProviderResult<api::Page<api::AccountPlaylistSummary>> {
        let value = QQMusicService::account_playlists(self, cursor, limit)
            .await
            .map_err(provider_error)?;
        map_output_for_profile(value, self.profile_key())
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
        map_output_for_profile(value, self.profile_key())
    }

    async fn account_recently_played(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> api::ProviderResult<api::Page<api::RemotePlayHistoryItem>> {
        let value = QQMusicService::account_recently_played(self, cursor, limit)
            .await
            .map_err(provider_error)?;
        map_output_for_profile(value, self.profile_key())
    }

    async fn set_favorite(
        &self,
        request: api::FavoriteMutationRequest,
    ) -> api::ProviderResult<api::FavoriteMutationResult> {
        let request: local_account::FavoriteMutationRequest = map_input(request)?;
        let value = QQMusicService::set_favorite(self, request)
            .await
            .map_err(provider_error)?;
        map_output_for_profile(value, self.profile_key())
    }

    async fn create_playlist(
        &self,
        request: api::CreatePlaylistRequest,
    ) -> api::ProviderResult<api::PlaylistMutationResult> {
        let request: local_account::CreatePlaylistRequest = map_input(request)?;
        let value = QQMusicService::create_playlist(self, request)
            .await
            .map_err(provider_error)?;
        map_output_for_profile(value, self.profile_key())
    }

    async fn rename_playlist(
        &self,
        request: api::RenamePlaylistRequest,
    ) -> api::ProviderResult<api::PlaylistMutationResult> {
        let request: local_account::RenamePlaylistRequest = map_input(request)?;
        let value = QQMusicService::rename_playlist(self, request)
            .await
            .map_err(provider_error)?;
        map_output_for_profile(value, self.profile_key())
    }

    async fn add_playlist_track(
        &self,
        request: api::PlaylistTrackMutationRequest,
    ) -> api::ProviderResult<api::PlaylistMutationResult> {
        let request: local_account::PlaylistTrackMutationRequest = map_input(request)?;
        let value = QQMusicService::add_playlist_track(self, request)
            .await
            .map_err(provider_error)?;
        map_output_for_profile(value, self.profile_key())
    }

    async fn remove_playlist_track(
        &self,
        request: api::PlaylistTrackMutationRequest,
    ) -> api::ProviderResult<api::PlaylistMutationResult> {
        let request: local_account::PlaylistTrackMutationRequest = map_input(request)?;
        let value = QQMusicService::remove_playlist_track(self, request)
            .await
            .map_err(provider_error)?;
        map_output_for_profile(value, self.profile_key())
    }

    async fn delete_playlist(
        &self,
        request: api::DeletePlaylistRequest,
    ) -> api::ProviderResult<api::PlaylistMutationResult> {
        let request: local_account::DeletePlaylistRequest = map_input(request)?;
        let value = QQMusicService::delete_playlist(self, request)
            .await
            .map_err(provider_error)?;
        map_output_for_profile(value, self.profile_key())
    }

    async fn set_playlist_collected(
        &self,
        request: api::CollectPlaylistRequest,
    ) -> api::ProviderResult<api::PlaylistMutationResult> {
        let request: local_account::CollectPlaylistRequest = map_input(request)?;
        let value = QQMusicService::set_playlist_collected(self, request)
            .await
            .map_err(provider_error)?;
        map_output_for_profile(value, self.profile_key())
    }

    async fn start_qr_login(&self) -> api::ProviderResult<api::AccountSnapshot> {
        let value = QQMusicService::start_qr_login(self)
            .await
            .map_err(provider_error)?;
        map_output_for_profile(value, self.profile_key())
    }

    async fn start_mobile_login(&self) -> api::ProviderResult<api::AccountSnapshot> {
        let value = QQMusicService::start_mobile_login(self)
            .await
            .map_err(provider_error)?;
        map_output_for_profile(value, self.profile_key())
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
            mobile_url: result.mobile_url,
            navigation_allowlist: result.navigation_allowlist,
            external_navigation_rules: result
                .external_navigation_rules
                .into_iter()
                .map(|rule| api::OAuthExternalNavigationRule {
                    scheme: rule.scheme,
                    host: rule.host,
                    path: rule.path,
                    android_packages: rule.android_packages,
                })
                .collect(),
            callback_matcher: api::OAuthCallbackMatcher {
                url_prefix: result.callback_matcher.url_prefix,
            },
            snapshot: map_output_for_profile(result.snapshot, self.profile_key())?,
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
        map_output_for_profile(value, self.profile_key())
    }

    async fn cancel_oauth_login(
        &self,
        attempt_id: &str,
    ) -> api::ProviderResult<api::AccountSnapshot> {
        let value = QQMusicService::cancel_oauth_login(self, attempt_id)
            .await
            .map_err(provider_error)?;
        map_output_for_profile(value, self.profile_key())
    }

    async fn heartbeat_qr_login(
        &self,
        attempt_id: String,
        owner_lease_id: String,
    ) -> api::ProviderResult<api::AccountSnapshot> {
        let value = QQMusicService::heartbeat_qr_login(self, attempt_id, owner_lease_id)
            .await
            .map_err(provider_error)?;
        map_output_for_profile(value, self.profile_key())
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
        map_output_for_profile(value, self.profile_key())
    }

    async fn refresh_qr_login(
        &self,
        attempt_id: Option<String>,
    ) -> api::ProviderResult<api::AccountSnapshot> {
        let value = QQMusicService::refresh_qr_login(self, attempt_id)
            .await
            .map_err(provider_error)?;
        map_output_for_profile(value, self.profile_key())
    }

    async fn restore_session(&self) {
        QQMusicService::restore_session(self).await;
    }

    async fn sign_out(&self) -> api::ProviderResult<api::AccountSnapshot> {
        let value = QQMusicService::sign_out(self)
            .await
            .map_err(provider_error)?;
        map_output_for_profile(value, self.profile_key())
    }
}

#[async_trait]
impl api::MusicProvider for QQMusicService {
    fn id(&self) -> &str {
        "qqmusic"
    }

    fn profile_key(&self) -> api::ProviderProfileKey {
        self.profile_key().clone()
    }

    fn display_name(&self) -> &str {
        "QQ Music"
    }

    fn account(&self) -> &dyn api::ProviderAccount {
        self
    }

    fn media_http_client(&self) -> reqwest::Client {
        QQMusicService::http_client(self)
    }

    fn capabilities(&self) -> api::CatalogProviderCapabilities {
        map_output_for_profile(QQMusicService::capabilities(self), self.profile_key())
            .expect("QQMusic capabilities and provider-api DTOs share the frozen wire schema")
    }

    async fn status(&self) -> api::ProviderStatus {
        map_output_for_profile(QQMusicService::status(self).await, self.profile_key())
            .expect("QQMusic status and provider-api DTOs share the frozen wire schema")
    }

    async fn set_preferred_quality(
        &self,
        quality: api::AudioQualityPreference,
    ) -> api::ProviderResult<api::ProviderStatus> {
        let value = QQMusicService::set_preferred_quality(self, quality)
            .await
            .map_err(provider_error)?;
        map_output_for_profile(value, self.profile_key())
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
        kind: api::CatalogSearchKind,
        page: u32,
        limit: u32,
    ) -> api::ProviderResult<api::SearchResult> {
        let value = QQMusicService::search(self, query, kind, page, limit)
            .await
            .map_err(provider_error)?;
        map_output_for_profile(value, self.profile_key())
    }

    async fn song(&self, id: String) -> api::ProviderResult<api::Song> {
        let value = QQMusicService::song(self, id)
            .await
            .map_err(provider_error)?;
        map_output_for_profile(value, self.profile_key())
    }

    async fn album(&self, id: String) -> api::ProviderResult<api::Album> {
        let value = QQMusicService::album(self, id)
            .await
            .map_err(provider_error)?;
        map_output_for_profile(value, self.profile_key())
    }

    async fn artist(&self, id: String) -> api::ProviderResult<api::Artist> {
        let value = QQMusicService::artist(self, id)
            .await
            .map_err(provider_error)?;
        map_output_for_profile(value, self.profile_key())
    }

    async fn artist_catalog(
        &self,
        id: String,
        kind: api::ArtistCatalogKind,
        page: u32,
        limit: u32,
    ) -> api::ProviderResult<api::ArtistCatalogPage> {
        let value = QQMusicService::artist_catalog(self, id, kind, page, limit)
            .await
            .map_err(provider_error)?;
        map_output_for_profile(value, self.profile_key())
    }

    async fn playlist(&self, id: String) -> api::ProviderResult<api::Playlist> {
        let value = QQMusicService::playlist(self, id)
            .await
            .map_err(provider_error)?;
        map_output_for_profile(value, self.profile_key())
    }

    async fn home(&self, refresh: bool) -> api::ProviderResult<api::HomeFeed> {
        let value = QQMusicService::home(self, refresh)
            .await
            .map_err(provider_error)?;
        map_output_for_profile(value, self.profile_key())
    }

    async fn discover(&self, refresh: bool) -> api::ProviderResult<api::DiscoverFeed> {
        let value = QQMusicService::discover(self, refresh)
            .await
            .map_err(provider_error)?;
        map_output_for_profile(value, self.profile_key())
    }

    async fn area(&self, enc_area: String) -> api::ProviderResult<api::AreaFeed> {
        let value = QQMusicService::area(self, enc_area)
            .await
            .map_err(provider_error)?;
        map_output_for_profile(value, self.profile_key())
    }

    fn library(&self) -> api::LibrarySnapshot {
        map_output_for_profile(QQMusicService::library(self), self.profile_key())
            .expect("QQMusic library and provider-api DTOs share the frozen wire schema")
    }

    async fn lyrics(&self, song_id: String) -> api::ProviderResult<Option<api::LyricDocument>> {
        QQMusicService::lyrics(self, song_id)
            .await
            .map_err(provider_error)
    }

    async fn recommendation_next(
        &self,
        request: api::RecommendationRequest,
    ) -> api::ProviderResult<api::RecommendationBatch> {
        let limit = request.limit.clamp(1, 30);
        let cursor = request
            .cursor
            .as_deref()
            .unwrap_or(match request.kind {
                api::RecommendationKind::Guess => "0",
                api::RecommendationKind::Radar => "1",
            })
            .parse::<u32>()
            .map_err(|_| {
                api::ProviderCommandError::invalid_request("recommendation cursor is invalid")
            })?;
        let seed_ids = request
            .seeds
            .iter()
            .filter_map(|seed| seed.numeric_id)
            .collect::<Vec<_>>();
        let songs = match request.kind {
            api::RecommendationKind::Guess => {
                QQMusicService::guess_recommendation_page(self, limit, cursor, &seed_ids).await
            }
            api::RecommendationKind::Radar => {
                if seed_ids.is_empty() {
                    return Err(api::ProviderCommandError::invalid_request(
                        "radar recommendations require a numeric entrance track",
                    ));
                }
                QQMusicService::radar_next_with_context(self, cursor.max(1), limit, &seed_ids).await
            }
        }
        .map_err(provider_error)?;
        let songs = map_recommendation_songs(songs, self.profile_key())?;
        let next_cursor = match request.kind {
            api::RecommendationKind::Guess => cursor.saturating_add(songs.len() as u32),
            api::RecommendationKind::Radar => cursor.max(1).saturating_add(1),
        };
        Ok(api::RecommendationBatch {
            songs,
            next_cursor: Some(next_cursor.to_string()),
            ended: false,
        })
    }

    async fn share_song(&self, id: String) -> api::ProviderResult<api::ShareTarget> {
        let song = QQMusicService::song(self, id)
            .await
            .map_err(provider_error)?;
        share_target_for_song(
            map_output_for_profile(song, self.profile_key())?,
            &self.profile_key().profile_id,
        )
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

#[cfg(test)]
mod share_tests {
    use super::*;

    fn song(track_id: &str) -> api::Song {
        api::Song {
            id: "qqmusic:track:001X3HEN1oK0Jr".to_owned(),
            title: "Quiet Light".to_owned(),
            artists: vec![api::ArtistSummary {
                id: "qqmusic:artist:test".to_owned(),
                name: "Mira Vale".to_owned(),
            }],
            album: api::AlbumSummary {
                id: "qqmusic:album:test".to_owned(),
                title: "Paper Sun".to_owned(),
            },
            artwork: api::Artwork {
                src: "/cover.svg".to_owned(),
                alt: "Cover".to_owned(),
                dominant_color: "#000000".to_owned(),
                variants: Vec::new(),
            },
            duration_ms: 120_000,
            track_number: 1,
            is_favorite: false,
            quality: api::AudioQuality::High,
            availability: api::SongAvailability::Available,
            audio_formats: Vec::new(),
            playback_capability: None,
            provider: Some(api::ProviderTrackReference {
                provider_id: "qqmusic".to_owned(),
                profile_id: api::DEFAULT_PROFILE_ID.to_owned(),
                track_id: track_id.to_owned(),
                numeric_id: None,
                album_id: None,
                media_id: None,
            }),
        }
    }

    #[test]
    fn share_target_uses_the_pinned_public_link_helper() {
        let target = share_target_for_song(song("001X3HEN1oK0Jr"), api::DEFAULT_PROFILE_ID)
            .expect("share target");
        assert_eq!(target.provider_id, "qqmusic");
        assert_eq!(target.entity_kind, api::ShareEntityKind::Song);
        assert_eq!(target.entity_id, "qqmusic:track:001X3HEN1oK0Jr");
        assert_eq!(
            target.canonical_https_url.as_deref(),
            Some("https://y.qq.com/n/ryqq/songDetail/001X3HEN1oK0Jr")
        );
    }

    #[test]
    fn invalid_provider_track_id_keeps_text_and_internal_link_metadata_only() {
        let target =
            share_target_for_song(song("../escape"), api::DEFAULT_PROFILE_ID).expect("text target");
        assert_eq!(target.canonical_https_url, None);
        assert_eq!(target.title, "Quiet Light");
        assert_eq!(target.artists, ["Mira Vale"]);
    }

    #[test]
    fn output_mapping_rewrites_nested_song_profile() {
        let mut value = song("001X3HEN1oK0Jr");
        value
            .provider
            .as_mut()
            .expect("provider reference")
            .profile_id = api::DEFAULT_PROFILE_ID.to_owned();
        let profile = api::ProviderProfileKey::new("qqmusic", "work").expect("profile key");

        let mapped: api::Song = map_output_for_profile(value, &profile).expect("mapped song");

        assert_eq!(
            mapped.provider.expect("provider reference").profile_id,
            "work"
        );
    }

    #[test]
    fn share_target_accepts_the_current_non_default_profile() {
        let mut value = song("001X3HEN1oK0Jr");
        value
            .provider
            .as_mut()
            .expect("provider reference")
            .profile_id = "work".to_owned();

        let target = share_target_for_song(value, "work").expect("share target");

        assert_eq!(target.profile_id, "work");
    }

    #[test]
    fn guess_and_radar_recommendations_materialize_the_work_profile() {
        let profile = api::ProviderProfileKey::new("qqmusic", "work").expect("profile key");
        for _kind in [
            api::RecommendationKind::Guess,
            api::RecommendationKind::Radar,
        ] {
            let songs = map_recommendation_songs(vec![song("001X3HEN1oK0Jr")], &profile)
                .expect("scoped recommendation songs");
            assert_eq!(
                songs[0].provider.as_ref().expect("song scope").profile_id,
                "work"
            );
        }
    }

    #[test]
    fn recommendations_reject_foreign_provider_profiles() {
        let profile = api::ProviderProfileKey::new("qqmusic", "work").expect("profile key");
        let mut foreign = song("001X3HEN1oK0Jr");
        let provider = foreign.provider.as_mut().expect("song scope");
        provider.provider_id = "other-provider".to_owned();

        assert!(map_recommendation_songs(vec![foreign], &profile).is_err());
    }
}
