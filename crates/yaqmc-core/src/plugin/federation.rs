use async_trait::async_trait;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use yaqmc_provider_api::{
    Album, AlbumPreview, AreaFeed, Artist, ArtistCatalogKind, ArtistCatalogPage, ArtistPreview,
    AudioQualityPreference, CacheStats, CatalogProvider, CatalogProviderCapabilities,
    CatalogSearchKind, DiscoverFeed, FeaturedCard, FeaturedRelease, HomeFeed, LibrarySnapshot,
    LyricsProvider, MediaCollection, PlaybackSourceError, PlaybackSourceProvider,
    PlaybackSourceResolver, PlaybackSourceSelection, Playlist, PlaylistPreview,
    ProviderCapabilities, ProviderCommandError, ProviderResult, ProviderStatus,
    ProviderTrackReference, ResolvedPlaybackSource, SearchResult, Song,
};
use yaqmc_provider_api::{CommentsProvider, SongCommentsPage, SongCommentsRequest};

const ROUTE_PREFIX: &str = "yaqmc-federated:";

#[derive(Clone)]
pub(crate) struct FederationMember {
    pub provider_id: String,
    pub profile_id: String,
    pub catalog: Arc<dyn CatalogProvider>,
    pub playback: Option<Arc<dyn PlaybackSourceProvider>>,
    pub lyrics: Option<Arc<dyn LyricsProvider>>,
    pub comments: Option<Arc<dyn CommentsProvider>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RoutedId {
    provider_id: String,
    profile_id: String,
    track_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_reference: Option<ProviderTrackReference>,
}

pub(crate) struct FederatedProvider {
    provider_id: String,
    display_name: String,
    members: Vec<FederationMember>,
}

impl FederatedProvider {
    pub(crate) fn new(
        provider_id: String,
        display_name: String,
        members: Vec<FederationMember>,
    ) -> Arc<Self> {
        Arc::new(Self {
            provider_id,
            display_name,
            members,
        })
    }

    pub(crate) fn registry_capabilities(self: &Arc<Self>) -> ProviderCapabilities {
        let capabilities = self.capabilities();
        ProviderCapabilities {
            display_name: Some(self.display_name.clone()),
            catalog: Some(Arc::clone(self) as Arc<dyn CatalogProvider>),
            playback: capabilities
                .streaming
                .then(|| Arc::clone(self) as Arc<dyn PlaybackSourceProvider>),
            lyrics: capabilities
                .lyrics
                .then(|| Arc::clone(self) as Arc<dyn LyricsProvider>),
            comments: self
                .members
                .iter()
                .any(|member| member.comments.is_some())
                .then(|| Arc::clone(self) as Arc<dyn CommentsProvider>),
            ..ProviderCapabilities::default()
        }
    }

    fn member_for_route(&self, route: &RoutedId) -> Option<&FederationMember> {
        self.members.iter().find(|member| {
            member.provider_id == route.provider_id && member.profile_id == route.profile_id
        })
    }

    fn route_for_song(&self, song: &Song) -> Option<(RoutedId, &FederationMember)> {
        let route = decode_id(&song.id).or_else(|| {
            song.provider.as_ref().map(|reference| RoutedId {
                provider_id: reference.provider_id.clone(),
                profile_id: reference.profile_id.clone(),
                track_id: reference.track_id.clone(),
                source_reference: Some(reference.clone()),
            })
        })?;
        let member = self.member_for_route(&route)?;
        Some((route, member))
    }

    fn route_for_id(&self, id: &str) -> Option<(RoutedId, &FederationMember)> {
        let route = decode_id(id)?;
        let member = self.member_for_route(&route)?;
        Some((route, member))
    }

    fn capabilities(&self) -> CatalogProviderCapabilities {
        CatalogProviderCapabilities {
            search: !self.members.is_empty(),
            album: !self.members.is_empty(),
            artist: !self.members.is_empty(),
            playlist: !self.members.is_empty(),
            lyrics: self.members.iter().any(|member| member.lyrics.is_some()),
            word_timed_lyrics: false,
            streaming: self.members.iter().any(|member| member.playback.is_some()),
            quality_selection: false,
        }
    }

    fn status_from_member(&self, status: ProviderStatus, online: usize) -> ProviderStatus {
        ProviderStatus {
            provider_id: self.provider_id.clone(),
            profile_id: "default".to_owned(),
            display_name: self.display_name.clone(),
            connection: if online > 0 { "online" } else { "offline" }.to_owned(),
            message: format!("{online}/{} providers available", self.members.len()),
            preferred_quality: status.preferred_quality,
            capabilities: self.capabilities(),
        }
    }

    fn remap_song(&self, member: &FederationMember, mut song: Song) -> Song {
        let origin_provider_id = song
            .provider
            .as_ref()
            .and_then(|reference| reference.origin_provider_id.clone())
            .unwrap_or_else(|| member.provider_id.clone());
        let original_id = song.id.clone();
        let original_album_id = song.album.id.clone();
        song.id = encode_route(&RoutedId {
            provider_id: member.provider_id.clone(),
            profile_id: member.profile_id.clone(),
            track_id: original_id,
            source_reference: song.provider.clone().filter(|reference| {
                reference.provider_id == member.provider_id
                    && reference.profile_id == member.profile_id
            }),
        });
        song.album.id = encode_id(member, &original_album_id);
        for artist in &mut song.artists {
            if !artist.id.is_empty() {
                artist.id = encode_id(member, &artist.id);
            }
        }
        song.provider = Some(ProviderTrackReference {
            provider_id: self.provider_id.clone(),
            origin_provider_id: Some(origin_provider_id),
            profile_id: "default".to_owned(),
            track_id: song.id.clone(),
            numeric_id: None,
            album_id: Some(encode_id(member, &original_album_id)),
            media_id: None,
        });
        song
    }

    fn remap_album(&self, member: &FederationMember, mut album: Album) -> Album {
        album.id = encode_id(member, &album.id);
        if !album.artist.id.is_empty() {
            album.artist.id = encode_id(member, &album.artist.id);
        }
        album.tracks = album
            .tracks
            .into_iter()
            .map(|song| self.remap_song(member, song))
            .collect();
        album
    }

    fn remap_artist(&self, member: &FederationMember, mut artist: Artist) -> Artist {
        artist.id = encode_id(member, &artist.id);
        artist.top_songs = artist
            .top_songs
            .into_iter()
            .map(|song| self.remap_song(member, song))
            .collect();
        artist.albums = artist
            .albums
            .into_iter()
            .map(|album| self.remap_album_preview(member, album))
            .collect();
        artist
    }

    fn remap_playlist(&self, member: &FederationMember, mut playlist: Playlist) -> Playlist {
        playlist.id = encode_id(member, &playlist.id);
        playlist.tracks = playlist
            .tracks
            .into_iter()
            .map(|song| self.remap_song(member, song))
            .collect();
        playlist
    }

    fn remap_album_preview(
        &self,
        member: &FederationMember,
        mut album: AlbumPreview,
    ) -> AlbumPreview {
        album.id = encode_id(member, &album.id);
        album.artist = self.remap_artist_preview(member, album.artist);
        album
    }

    fn remap_artist_preview(
        &self,
        member: &FederationMember,
        mut artist: ArtistPreview,
    ) -> ArtistPreview {
        artist.id = encode_id(member, &artist.id);
        artist
    }

    fn remap_playlist_preview(
        &self,
        member: &FederationMember,
        mut playlist: PlaylistPreview,
    ) -> PlaylistPreview {
        playlist.id = encode_id(member, &playlist.id);
        playlist
    }

    fn remap_search(&self, member: &FederationMember, result: SearchResult) -> SearchResult {
        match result {
            SearchResult::Song {
                query,
                page,
                has_more,
                items,
            } => SearchResult::Song {
                query,
                page,
                has_more,
                items: items
                    .into_iter()
                    .map(|song| self.remap_song(member, song))
                    .collect(),
            },
            SearchResult::Artist {
                query,
                page,
                has_more,
                items,
            } => SearchResult::Artist {
                query,
                page,
                has_more,
                items: items
                    .into_iter()
                    .map(|artist| self.remap_artist_preview(member, artist))
                    .collect(),
            },
            SearchResult::Album {
                query,
                page,
                has_more,
                items,
            } => SearchResult::Album {
                query,
                page,
                has_more,
                items: items
                    .into_iter()
                    .map(|album| self.remap_album_preview(member, album))
                    .collect(),
            },
            SearchResult::Playlist {
                query,
                page,
                has_more,
                items,
            } => SearchResult::Playlist {
                query,
                page,
                has_more,
                items: items
                    .into_iter()
                    .map(|playlist| self.remap_playlist_preview(member, playlist))
                    .collect(),
            },
        }
    }

    fn remap_featured_release(
        &self,
        member: &FederationMember,
        mut value: FeaturedRelease,
    ) -> FeaturedRelease {
        value.album = self.remap_album(member, value.album);
        value
    }

    fn remap_collection(
        &self,
        member: &FederationMember,
        value: MediaCollection,
    ) -> MediaCollection {
        match value {
            MediaCollection::Album(album) => {
                MediaCollection::Album(self.remap_album(member, album))
            }
            MediaCollection::Playlist(playlist) => {
                MediaCollection::Playlist(self.remap_playlist(member, playlist))
            }
        }
    }

    fn remap_home(&self, member: &FederationMember, mut value: HomeFeed) -> HomeFeed {
        value.featured = self.remap_featured_release(member, value.featured);
        value.recently_played = value
            .recently_played
            .into_iter()
            .map(|item| self.remap_collection(member, item))
            .collect();
        value.made_for_you = value
            .made_for_you
            .into_iter()
            .map(|item| self.remap_playlist(member, item))
            .collect();
        value.new_releases = value
            .new_releases
            .into_iter()
            .map(|item| self.remap_album(member, item))
            .collect();
        value.guess_songlist = value
            .guess_songlist
            .map(|item| self.remap_playlist(member, item));
        value.recommended_songlists = value
            .recommended_songlists
            .into_iter()
            .map(|item| self.remap_playlist(member, item))
            .collect();
        value.daily_songlist = value
            .daily_songlist
            .map(|item| self.remap_playlist(member, item));
        value.new_song_songlist = value
            .new_song_songlist
            .map(|item| self.remap_playlist(member, item));
        value.radar_songs = value
            .radar_songs
            .into_iter()
            .map(|song| self.remap_song(member, song))
            .collect();
        value
    }

    fn remap_discover(&self, member: &FederationMember, mut value: DiscoverFeed) -> DiscoverFeed {
        value.charts = value
            .charts
            .into_iter()
            .map(|item| self.remap_playlist(member, item))
            .collect();
        value.new_songs = value
            .new_songs
            .map(|item| self.remap_playlist(member, item));
        value.new_albums = value
            .new_albums
            .into_iter()
            .map(|item| self.remap_album(member, item))
            .collect();
        value.popular_songlists = value
            .popular_songlists
            .into_iter()
            .map(|item| self.remap_playlist(member, item))
            .collect();
        value.featured = value
            .featured
            .into_iter()
            .map(|mut item: FeaturedCard| {
                item.id = encode_id(member, &item.id);
                item
            })
            .collect();
        value
    }

    fn remap_area(&self, member: &FederationMember, mut value: AreaFeed) -> AreaFeed {
        value.songlists = value
            .songlists
            .into_iter()
            .map(|item| self.remap_playlist(member, item))
            .collect();
        value.playlists = value
            .playlists
            .into_iter()
            .map(|item| self.remap_playlist(member, item))
            .collect();
        for artist in &mut value.artists {
            artist.id = encode_id(member, &artist.id);
        }
        value
    }

    fn remap_artist_page(
        &self,
        member: &FederationMember,
        value: ArtistCatalogPage,
    ) -> ArtistCatalogPage {
        match value {
            ArtistCatalogPage::Song {
                artist_id,
                page,
                has_more,
                items,
            } => ArtistCatalogPage::Song {
                artist_id: encode_id(member, &artist_id),
                page,
                has_more,
                items: items
                    .into_iter()
                    .map(|song| self.remap_song(member, song))
                    .collect(),
            },
            ArtistCatalogPage::Album {
                artist_id,
                page,
                has_more,
                items,
            } => ArtistCatalogPage::Album {
                artist_id: encode_id(member, &artist_id),
                page,
                has_more,
                items: items
                    .into_iter()
                    .map(|album| self.remap_album_preview(member, album))
                    .collect(),
            },
        }
    }

    async fn resolve_route(
        &self,
        song: &Song,
    ) -> Result<(RoutedId, &FederationMember, Song), PlaybackSourceError> {
        let (route, member) = self
            .route_for_song(song)
            .ok_or(PlaybackSourceError::TrackUnavailable)?;
        let source = if let Some(source) = restore_song(&route, song) {
            source
        } else {
            member
                .catalog
                .catalog_song(route.track_id.clone())
                .await
                .map_err(super::provider::map_playback_command_error)?
        };
        if source.provider.as_ref().is_none_or(|reference| {
            reference.provider_id != member.provider_id || reference.profile_id != member.profile_id
        }) {
            return Err(PlaybackSourceError::TrackUnavailable);
        }
        Ok((route, member, source))
    }
}

#[async_trait]
impl CatalogProvider for FederatedProvider {
    fn catalog_capabilities(&self) -> CatalogProviderCapabilities {
        self.capabilities()
    }

    async fn catalog_status(&self) -> ProviderStatus {
        let statuses = join_all(
            self.members
                .iter()
                .map(|member| async move { member.catalog.catalog_status().await }),
        )
        .await;
        let online = statuses
            .iter()
            .filter(|status| status.connection == "online")
            .count();
        statuses
            .into_iter()
            .next()
            .map(|status| self.status_from_member(status, online))
            .unwrap_or_else(|| ProviderStatus {
                provider_id: self.provider_id.clone(),
                profile_id: "default".to_owned(),
                display_name: self.display_name.clone(),
                connection: "offline".to_owned(),
                message: "no federated provider is available".to_owned(),
                preferred_quality: AudioQualityPreference::Automatic,
                capabilities: self.capabilities(),
            })
    }

    async fn catalog_search(
        &self,
        query: String,
        kind: CatalogSearchKind,
        page: u32,
        limit: u32,
    ) -> ProviderResult<SearchResult> {
        let results = join_all(self.members.iter().map(|member| async {
            member
                .catalog
                .catalog_search(query.clone(), kind, page, limit)
                .await
                .map(|result| self.remap_search(member, result))
        }))
        .await;
        let mut buckets = Vec::new();
        let mut errors = Vec::new();
        for result in results {
            match result {
                Ok(result) => buckets.push(result),
                Err(error) => errors.push(error),
            }
        }
        if buckets.is_empty() {
            return Err(errors
                .into_iter()
                .next()
                .unwrap_or_else(|| ProviderCommandError {
                    code: "provider-unavailable".to_owned(),
                    message: "no federated provider returned a result".to_owned(),
                    retryable: true,
                }));
        }
        merge_search_results(&query, page, limit, kind, buckets)
    }

    async fn catalog_song(&self, id: String) -> ProviderResult<Song> {
        let (route, member) = self
            .route_for_id(&id)
            .ok_or_else(|| invalid_route("song"))?;
        member
            .catalog
            .catalog_song(route.track_id)
            .await
            .map(|song| self.remap_song(member, song))
    }

    async fn catalog_album(&self, id: String) -> ProviderResult<Album> {
        let (route, member) = self
            .route_for_id(&id)
            .ok_or_else(|| invalid_route("album"))?;
        member
            .catalog
            .catalog_album(route.track_id)
            .await
            .map(|album| self.remap_album(member, album))
    }

    async fn catalog_artist(&self, id: String) -> ProviderResult<Artist> {
        let (route, member) = self
            .route_for_id(&id)
            .ok_or_else(|| invalid_route("artist"))?;
        member
            .catalog
            .catalog_artist(route.track_id)
            .await
            .map(|artist| self.remap_artist(member, artist))
    }

    async fn catalog_artist_page(
        &self,
        id: String,
        kind: ArtistCatalogKind,
        page: u32,
        limit: u32,
    ) -> ProviderResult<ArtistCatalogPage> {
        let (route, member) = self
            .route_for_id(&id)
            .ok_or_else(|| invalid_route("artist"))?;
        member
            .catalog
            .catalog_artist_page(route.track_id, kind, page, limit)
            .await
            .map(|value| self.remap_artist_page(member, value))
    }

    async fn catalog_playlist(&self, id: String) -> ProviderResult<Playlist> {
        let (route, member) = self
            .route_for_id(&id)
            .ok_or_else(|| invalid_route("playlist"))?;
        member
            .catalog
            .catalog_playlist(route.track_id)
            .await
            .map(|playlist| self.remap_playlist(member, playlist))
    }

    async fn catalog_home(&self, refresh: bool) -> ProviderResult<HomeFeed> {
        let member = self.members.first().ok_or_else(unavailable)?;
        member
            .catalog
            .catalog_home(refresh)
            .await
            .map(|value| self.remap_home(member, value))
    }

    async fn catalog_discover(&self, refresh: bool) -> ProviderResult<DiscoverFeed> {
        let member = self.members.first().ok_or_else(unavailable)?;
        member
            .catalog
            .catalog_discover(refresh)
            .await
            .map(|value| self.remap_discover(member, value))
    }

    async fn catalog_area(&self, enc_area: String) -> ProviderResult<AreaFeed> {
        let member = self.members.first().ok_or_else(unavailable)?;
        member
            .catalog
            .catalog_area(enc_area)
            .await
            .map(|value| self.remap_area(member, value))
    }

    fn catalog_library(&self) -> LibrarySnapshot {
        let mut library = LibrarySnapshot::default();
        for member in &self.members {
            let snapshot = member.catalog.catalog_library();
            library.favorite_songs.extend(
                snapshot
                    .favorite_songs
                    .into_iter()
                    .map(|song| self.remap_song(member, song)),
            );
            library.saved_albums.extend(
                snapshot
                    .saved_albums
                    .into_iter()
                    .map(|album| self.remap_album(member, album)),
            );
            library.saved_playlists.extend(
                snapshot
                    .saved_playlists
                    .into_iter()
                    .map(|playlist| self.remap_playlist(member, playlist)),
            );
        }
        library
    }

    async fn catalog_artwork_data_uri(&self, url: String) -> ProviderResult<String> {
        for member in &self.members {
            if let Ok(value) = member.catalog.catalog_artwork_data_uri(url.clone()).await {
                return Ok(value);
            }
        }
        Err(unavailable())
    }

    fn catalog_cache_stats(&self) -> ProviderResult<CacheStats> {
        self.members
            .first()
            .map(|member| member.catalog.catalog_cache_stats())
            .unwrap_or_else(|| Err(unavailable()))
    }

    fn catalog_clear_cache(&self) -> ProviderResult<CacheStats> {
        self.members
            .first()
            .map(|member| member.catalog.catalog_clear_cache())
            .unwrap_or_else(|| Err(unavailable()))
    }

    async fn catalog_remember_songs(&self, songs: &[Song]) {
        for member in &self.members {
            let owned = songs
                .iter()
                .filter_map(|song| {
                    let (route, route_member) = self.route_for_song(song)?;
                    if route_member.provider_id != member.provider_id
                        || route_member.profile_id != member.profile_id
                    {
                        return None;
                    }
                    restore_song(&route, song)
                })
                .collect::<Vec<_>>();
            if !owned.is_empty() {
                member.catalog.catalog_remember_songs(&owned).await;
            }
        }
    }
}

#[async_trait]
impl LyricsProvider for FederatedProvider {
    async fn lyrics_for_song(
        &self,
        song_id: String,
    ) -> ProviderResult<Option<yaqmc_provider_api::LyricDocument>> {
        let (route, member) = self
            .route_for_id(&song_id)
            .ok_or_else(|| invalid_route("song"))?;
        let Some(lyrics) = &member.lyrics else {
            return Ok(None);
        };
        let mut document = lyrics.lyrics_for_song(route.track_id).await?;
        if let Some(document) = &mut document {
            document.song_id = song_id;
        }
        Ok(document)
    }
}

#[async_trait]
impl CommentsProvider for FederatedProvider {
    async fn song_comments(
        &self,
        mut request: SongCommentsRequest,
    ) -> ProviderResult<SongCommentsPage> {
        request.validate()?;
        let (route, member) = self
            .route_for_id(&request.song_id)
            .ok_or_else(|| invalid_route("song"))?;
        let comments = member
            .comments
            .as_ref()
            .ok_or_else(|| ProviderCommandError {
                code: "unsupported-operation".to_owned(),
                message: "the source provider does not support comments".to_owned(),
                retryable: false,
            })?;
        request.song_id = route.track_id;
        comments.song_comments(request).await
    }
}

#[async_trait]
impl PlaybackSourceResolver for FederatedProvider {
    async fn resolve(&self, song: &Song) -> Result<ResolvedPlaybackSource, PlaybackSourceError> {
        let (_, member, source) = self.resolve_route(song).await?;
        member
            .playback
            .as_ref()
            .ok_or(PlaybackSourceError::TrackUnavailable)?
            .resolve(&source)
            .await
    }

    async fn resolve_unavailable_fallback(
        &self,
        song: &Song,
        failed: &PlaybackSourceSelection,
    ) -> Result<ResolvedPlaybackSource, PlaybackSourceError> {
        let (_, member, source) = self.resolve_route(song).await?;
        member
            .playback
            .as_ref()
            .ok_or(PlaybackSourceError::TrackUnavailable)?
            .resolve_unavailable_fallback(&source, failed)
            .await
    }

    async fn resolve_client_fallback(
        &self,
        song: &Song,
        failed: &PlaybackSourceSelection,
    ) -> Result<ResolvedPlaybackSource, PlaybackSourceError> {
        let (_, member, source) = self.resolve_route(song).await?;
        member
            .playback
            .as_ref()
            .ok_or(PlaybackSourceError::TrackUnavailable)?
            .resolve_client_fallback(&source, failed)
            .await
    }
}

#[async_trait]
impl PlaybackSourceProvider for FederatedProvider {
    fn playback_media_http_client(&self) -> reqwest::Client {
        self.members
            .first()
            .and_then(|member| member.playback.as_ref())
            .map(|provider| provider.playback_media_http_client())
            .unwrap_or_default()
    }

    async fn playback_set_preferred_quality(
        &self,
        quality: AudioQualityPreference,
    ) -> ProviderResult<ProviderStatus> {
        let member = self.members.first().ok_or_else(unavailable)?;
        let provider = member
            .playback
            .as_ref()
            .ok_or_else(|| ProviderCommandError {
                code: "unsupported-operation".to_owned(),
                message: "no federated provider supports quality selection".to_owned(),
                retryable: false,
            })?;
        provider.playback_set_preferred_quality(quality).await
    }

    async fn playback_set_current_quality(
        &self,
        track_id: String,
        quality: AudioQualityPreference,
    ) -> ProviderResult<()> {
        let (route, member) = self
            .route_for_id(&track_id)
            .ok_or_else(|| invalid_route("song"))?;
        let provider = member
            .playback
            .as_ref()
            .ok_or_else(|| ProviderCommandError {
                code: "unsupported-operation".to_owned(),
                message: "the selected federated provider has no playback capability".to_owned(),
                retryable: false,
            })?;
        let native_track_id = if let Some(reference) = &route.source_reference {
            reference.track_id.clone()
        } else {
            let source = member.catalog.catalog_song(route.track_id.clone()).await?;
            source
                .provider
                .filter(|reference| {
                    reference.provider_id == member.provider_id
                        && reference.profile_id == member.profile_id
                })
                .ok_or_else(|| invalid_route("song"))?
                .track_id
        };
        provider
            .playback_set_current_quality(native_track_id, quality)
            .await
    }
}

fn encode_id(member: &FederationMember, track_id: &str) -> String {
    let route = RoutedId {
        provider_id: member.provider_id.clone(),
        profile_id: member.profile_id.clone(),
        track_id: track_id.to_owned(),
        source_reference: None,
    };
    encode_route(&route)
}

fn encode_route(route: &RoutedId) -> String {
    let encoded = serde_json::to_vec(route)
        .map(|value| URL_SAFE_NO_PAD.encode(value))
        .unwrap_or_default();
    format!("{ROUTE_PREFIX}{encoded}")
}

fn decode_id(value: &str) -> Option<RoutedId> {
    let encoded = value.strip_prefix(ROUTE_PREFIX)?;
    let bytes = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    let route: RoutedId = serde_json::from_slice(&bytes).ok()?;
    (!route.provider_id.is_empty()
        && !route.profile_id.is_empty()
        && !route.track_id.is_empty()
        && route.source_reference.as_ref().is_none_or(|reference| {
            reference.provider_id == route.provider_id
                && reference.profile_id == route.profile_id
                && !reference.track_id.trim().is_empty()
        }))
    .then_some(route)
}

/// Include the underlying member when a playing track is wrapped by another
/// plugin's federation. Metadata ownership alone is not the playback boundary.
pub(crate) fn song_uses_providers(
    song: &Song,
    providers: &std::collections::HashSet<String>,
) -> bool {
    if song
        .provider
        .as_ref()
        .is_some_and(|p| providers.contains(&p.provider_id))
    {
        return true;
    }
    let mut id = song.id.clone();
    for _ in 0..8 {
        let Some(route) = decode_id(&id) else {
            return false;
        };
        if providers.contains(&route.provider_id) {
            return true;
        }
        id = route.track_id;
    }
    // Malformed nesting must never make an automatic update interrupt playback.
    true
}

fn restore_song(route: &RoutedId, song: &Song) -> Option<Song> {
    let mut source = song.clone();
    source.id = route.track_id.clone();
    source.provider = Some(route.source_reference.clone()?);
    if let Some(album) = decode_id(&song.album.id) {
        if album.provider_id != route.provider_id || album.profile_id != route.profile_id {
            return None;
        }
        source.album.id = album.track_id;
    }
    for artist in &mut source.artists {
        if let Some(artist_route) = decode_id(&artist.id) {
            if artist_route.provider_id != route.provider_id
                || artist_route.profile_id != route.profile_id
            {
                return None;
            }
            artist.id = artist_route.track_id;
        }
    }
    Some(source)
}

fn merge_search_results(
    query: &str,
    page: u32,
    limit: u32,
    kind: CatalogSearchKind,
    results: Vec<SearchResult>,
) -> ProviderResult<SearchResult> {
    let limit = limit.max(1) as usize;
    match kind {
        CatalogSearchKind::Song => {
            let mut buckets = Vec::new();
            let mut has_more = false;
            for result in results {
                if let SearchResult::Song {
                    has_more: result_has_more,
                    items,
                    ..
                } = result
                {
                    has_more |= result_has_more;
                    buckets.push(items);
                }
            }
            let items = interleave(buckets, limit);
            Ok(SearchResult::Song {
                query: query.to_owned(),
                page,
                has_more,
                items,
            })
        }
        CatalogSearchKind::Artist => {
            let mut buckets = Vec::new();
            let mut has_more = false;
            for result in results {
                if let SearchResult::Artist {
                    has_more: result_has_more,
                    items,
                    ..
                } = result
                {
                    has_more |= result_has_more;
                    buckets.push(items);
                }
            }
            let items = interleave(buckets, limit);
            Ok(SearchResult::Artist {
                query: query.to_owned(),
                page,
                has_more,
                items,
            })
        }
        CatalogSearchKind::Album => {
            let mut buckets = Vec::new();
            let mut has_more = false;
            for result in results {
                if let SearchResult::Album {
                    has_more: result_has_more,
                    items,
                    ..
                } = result
                {
                    has_more |= result_has_more;
                    buckets.push(items);
                }
            }
            let items = interleave(buckets, limit);
            Ok(SearchResult::Album {
                query: query.to_owned(),
                page,
                has_more,
                items,
            })
        }
        CatalogSearchKind::Playlist => {
            let mut buckets = Vec::new();
            let mut has_more = false;
            for result in results {
                if let SearchResult::Playlist {
                    has_more: result_has_more,
                    items,
                    ..
                } = result
                {
                    has_more |= result_has_more;
                    buckets.push(items);
                }
            }
            let items = interleave(buckets, limit);
            Ok(SearchResult::Playlist {
                query: query.to_owned(),
                page,
                has_more,
                items,
            })
        }
    }
}

fn interleave<T>(mut buckets: Vec<Vec<T>>, limit: usize) -> Vec<T> {
    let mut items = Vec::with_capacity(limit);
    for bucket in &mut buckets {
        bucket.reverse();
    }
    while items.len() < limit {
        let mut progressed = false;
        for bucket in &mut buckets {
            if let Some(item) = bucket.pop() {
                items.push(item);
                progressed = true;
                if items.len() == limit {
                    break;
                }
            }
        }
        if !progressed {
            break;
        }
    }
    items
}

fn invalid_route(kind: &str) -> ProviderCommandError {
    ProviderCommandError {
        code: "invalid-request".to_owned(),
        message: format!("the federated {kind} ID is invalid"),
        retryable: false,
    }
}

fn unavailable() -> ProviderCommandError {
    ProviderCommandError {
        code: "provider-unavailable".to_owned(),
        message: "no federated provider is available".to_owned(),
        retryable: true,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        decode_id, encode_id, encode_route, interleave, FederatedProvider, FederationMember,
    };
    use std::sync::{Arc, Mutex};
    use yaqmc_provider_api::{
        Album, Artist, ArtistSummary, Artwork, AudioQualityPreference, CatalogProvider,
        LibrarySnapshot, LyricDocument, LyricMetadata, LyricSyncMode, LyricsProvider,
        PlaybackSourceError, PlaybackSourceProvider, PlaybackSourceResolver,
        PlaybackSourceSelection, Playlist, PlaylistOwner, ProviderResult, ProviderStatus,
        ResolvedPlaybackSource, Song,
    };

    #[test]
    fn interleave_preserves_each_provider_order() {
        let result = interleave(vec![vec![1, 2, 3], vec![10, 20]], 5);
        assert_eq!(result, vec![1, 10, 2, 20, 3]);
    }

    #[test]
    fn routed_ids_round_trip_platform_and_profile() {
        let member = FederationMember {
            provider_id: "org.example.spotify".to_owned(),
            profile_id: "work".to_owned(),
            catalog: Arc::new(NoopCatalog::default()),
            playback: None,
            lyrics: None,
            comments: None,
        };
        let encoded = encode_id(&member, "track/1");
        let decoded = decode_id(&encoded).expect("route");
        assert_eq!(decoded.provider_id, "org.example.spotify");
        assert_eq!(decoded.profile_id, "work");
        assert_eq!(decoded.track_id, "track/1");
        let wrapped = source_song("org.example.aggregate", &encoded, &encoded);
        assert!(super::song_uses_providers(
            &wrapped,
            &std::collections::HashSet::from(["org.example.spotify".into()])
        ));
        assert!(!super::song_uses_providers(
            &wrapped,
            &std::collections::HashSet::from(["org.example.other".into()])
        ));
    }

    fn source_song(provider_id: &str, catalog_id: &str, track_id: &str) -> Song {
        serde_json::from_value(serde_json::json!({
            "id": catalog_id,
            "title": "Routing fixture",
            "artists": [],
            "album": { "id": "source-album", "title": "Fixture album" },
            "artwork": { "src": "", "alt": "", "dominantColor": "#000000" },
            "durationMs": 120000,
            "trackNumber": 1,
            "isFavorite": false,
            "quality": "standard",
            "availability": { "status": "available" },
            "provider": {
                "providerId": provider_id,
                "profileId": "work",
                "trackId": track_id,
                "numericId": 123,
                "albumId": "source-album",
                "mediaId": "native-media-id"
            }
        }))
        .expect("source song")
    }

    fn artwork() -> Artwork {
        Artwork {
            src: String::new(),
            alt: String::new(),
            dominant_color: "#000000".to_owned(),
            variants: Vec::new(),
        }
    }

    fn source_album(id: &str, artist_id: &str, track: Song) -> Album {
        Album {
            id: id.to_owned(),
            title: "Fixture album".to_owned(),
            artist: ArtistSummary {
                id: artist_id.to_owned(),
                name: "Fixture artist".to_owned(),
            },
            artwork: artwork(),
            release_year: 2026,
            genre: "Pop".to_owned(),
            description: "Fixture album description".to_owned(),
            tracks: vec![track],
        }
    }

    fn source_playlist(id: &str, track: Song) -> Playlist {
        Playlist {
            id: id.to_owned(),
            title: "Fixture playlist".to_owned(),
            description: "Fixture playlist description".to_owned(),
            owner: PlaylistOwner {
                id: "owner-id".to_owned(),
                display_name: "Fixture owner".to_owned(),
            },
            artwork: artwork(),
            updated_label: "today".to_owned(),
            tracks: vec![track],
        }
    }

    fn source_artist(id: &str, top_song: Song) -> Artist {
        Artist {
            id: id.to_owned(),
            name: "Fixture artist".to_owned(),
            artwork: artwork(),
            description: "Fixture artist description".to_owned(),
            top_songs: vec![top_song],
            albums: Vec::new(),
        }
    }

    #[test]
    fn remaps_nested_artist_ids_in_songs_and_albums() {
        let member = FederationMember {
            provider_id: "org.example.spotify".to_owned(),
            profile_id: "work".to_owned(),
            catalog: Arc::new(NoopCatalog::default()),
            playback: None,
            lyrics: None,
            comments: None,
        };
        let federation = FederatedProvider::new(
            "org.example.aggregate".to_owned(),
            "Aggregate".to_owned(),
            vec![member.clone()],
        );
        let mut source = source_song("org.example.spotify", "native-song", "native-song");
        source.artists = vec![ArtistSummary {
            id: "native-artist".to_owned(),
            name: "Fixture artist".to_owned(),
        }];

        let mapped_song = federation.remap_song(&member, source.clone());
        assert_eq!(
            mapped_song.provider.as_ref().unwrap().provider_id,
            "org.example.aggregate"
        );
        assert_eq!(
            mapped_song
                .provider
                .as_ref()
                .unwrap()
                .origin_provider_id
                .as_deref(),
            Some("org.example.spotify")
        );
        let persisted: Song =
            serde_json::from_slice(&serde_json::to_vec(&mapped_song).unwrap()).unwrap();
        assert_eq!(persisted.provider, mapped_song.provider);
        let wrapped_again = federation.remap_song(&member, mapped_song.clone());
        assert_eq!(
            wrapped_again
                .provider
                .as_ref()
                .unwrap()
                .origin_provider_id
                .as_deref(),
            Some("org.example.spotify")
        );
        let song_artist_route = decode_id(&mapped_song.artists[0].id).expect("song artist route");
        assert_eq!(song_artist_route.track_id, "native-artist");

        let mapped_album = federation.remap_album(
            &member,
            source_album("native-album", "native-artist", source),
        );
        let album_artist_route = decode_id(&mapped_album.artist.id).expect("album artist route");
        assert_eq!(album_artist_route.track_id, "native-artist");
        let nested_song_artist_route =
            decode_id(&mapped_album.tracks[0].artists[0].id).expect("album track artist route");
        assert_eq!(nested_song_artist_route.track_id, "native-artist");
    }

    #[test]
    fn remapping_keeps_each_member_platform_and_distinct_routes_for_equal_track_ids() {
        let member = |provider_id: &str| FederationMember {
            provider_id: provider_id.to_owned(),
            profile_id: "work".to_owned(),
            catalog: Arc::new(NoopCatalog::default()),
            playback: None,
            lyrics: None,
            comments: None,
        };
        let (netease, kugou) = (member("org.example.netease"), member("org.example.kugou"));
        let federation = FederatedProvider::new(
            "org.example.aggregate".to_owned(),
            "Aggregate".to_owned(),
            vec![netease.clone(), kugou.clone()],
        );
        let first = federation.remap_song(
            &netease,
            source_song("org.example.netease", "same-id", "same-id"),
        );
        let second = federation.remap_song(
            &kugou,
            source_song("org.example.kugou", "same-id", "same-id"),
        );
        // Routing moves to the federation, the display source stays with the member platform.
        assert_eq!(
            first.provider.as_ref().unwrap().provider_id,
            "org.example.aggregate"
        );
        assert_eq!(
            first
                .provider
                .as_ref()
                .unwrap()
                .origin_provider_id
                .as_deref(),
            Some("org.example.netease")
        );
        assert_eq!(
            second
                .provider
                .as_ref()
                .unwrap()
                .origin_provider_id
                .as_deref(),
            Some("org.example.kugou")
        );
        assert_ne!(first.id, second.id);
        assert_eq!(
            decode_id(&first.id).unwrap().provider_id,
            "org.example.netease"
        );
    }

    #[tokio::test]
    async fn nested_song_artist_route_can_be_loaded_from_the_federation() {
        let mut source = source_song("org.example.spotify", "native-song", "native-song");
        source.artists = vec![ArtistSummary {
            id: "native-artist".to_owned(),
            name: "Fixture artist".to_owned(),
        }];
        let native_artist = source_artist("native-artist", source.clone());
        let catalog = Arc::new(NoopCatalog {
            artist: Some(native_artist),
            ..NoopCatalog::default()
        });
        let member = FederationMember {
            provider_id: "org.example.spotify".to_owned(),
            profile_id: "work".to_owned(),
            catalog: Arc::clone(&catalog) as Arc<dyn CatalogProvider>,
            playback: None,
            lyrics: None,
            comments: None,
        };
        let federation = FederatedProvider::new(
            "org.example.aggregate".to_owned(),
            "Aggregate".to_owned(),
            vec![member.clone()],
        );
        let mapped_song = federation.remap_song(&member, source);
        let artist = federation
            .catalog_artist(mapped_song.artists[0].id.clone())
            .await
            .expect("nested artist route");
        assert_eq!(artist.id, mapped_song.artists[0].id);
    }

    #[tokio::test]
    async fn federated_lyrics_restore_the_federated_song_id() {
        let source = source_song("org.example.spotify", "native-song", "native-song");
        let lyrics = Arc::new(RecordingLyrics {
            document: Some(LyricDocument {
                comments: Vec::new(),
                song_id: "native-song".to_owned(),
                sync_mode: LyricSyncMode::Line,
                metadata: LyricMetadata {
                    source_label: "fixture".to_owned(),
                    language: None,
                    translated_language: None,
                    offset_ms: 0,
                },
                vocalists: Vec::new(),
                lines: Vec::new(),
            }),
            requested: Mutex::new(Vec::new()),
        });
        let member = FederationMember {
            provider_id: "org.example.spotify".to_owned(),
            profile_id: "work".to_owned(),
            catalog: Arc::new(NoopCatalog::default()),
            playback: None,
            lyrics: Some(Arc::clone(&lyrics) as Arc<dyn LyricsProvider>),
            comments: None,
        };
        let federation = FederatedProvider::new(
            "org.example.aggregate".to_owned(),
            "Aggregate".to_owned(),
            vec![member.clone()],
        );
        let mapped_song = federation.remap_song(&member, source);
        let document = federation
            .lyrics_for_song(mapped_song.id.clone())
            .await
            .expect("lyrics")
            .expect("lyric document");
        assert_eq!(document.song_id, mapped_song.id);
        assert_eq!(
            *lyrics.requested.lock().expect("lyrics request"),
            vec!["native-song".to_owned()]
        );
    }

    #[test]
    fn federated_library_aggregates_and_remaps_every_member() {
        let first_song = source_song("org.example.spotify", "first-song", "first-song");
        let second_song = source_song("org.example.netease", "second-song", "second-song");
        let first_catalog = Arc::new(NoopCatalog {
            library: LibrarySnapshot {
                favorite_songs: vec![first_song.clone()],
                saved_albums: vec![source_album(
                    "first-album",
                    "first-artist",
                    first_song.clone(),
                )],
                saved_playlists: vec![source_playlist("first-playlist", first_song)],
            },
            ..NoopCatalog::default()
        });
        let second_catalog = Arc::new(NoopCatalog {
            library: LibrarySnapshot {
                favorite_songs: vec![second_song.clone()],
                saved_albums: vec![source_album(
                    "second-album",
                    "second-artist",
                    second_song.clone(),
                )],
                saved_playlists: vec![source_playlist("second-playlist", second_song)],
            },
            ..NoopCatalog::default()
        });
        let first_member = FederationMember {
            provider_id: "org.example.spotify".to_owned(),
            profile_id: "work".to_owned(),
            catalog: first_catalog,
            playback: None,
            lyrics: None,
            comments: None,
        };
        let second_member = FederationMember {
            provider_id: "org.example.netease".to_owned(),
            profile_id: "work".to_owned(),
            catalog: second_catalog,
            playback: None,
            lyrics: None,
            comments: None,
        };
        let federation = FederatedProvider::new(
            "org.example.aggregate".to_owned(),
            "Aggregate".to_owned(),
            vec![first_member, second_member],
        );

        let library = federation.catalog_library();
        assert_eq!(library.favorite_songs.len(), 2);
        assert_eq!(library.saved_albums.len(), 2);
        assert_eq!(library.saved_playlists.len(), 2);
        for song in &library.favorite_songs {
            assert!(decode_id(&song.id).is_some());
        }
        for album in &library.saved_albums {
            assert!(decode_id(&album.id).is_some());
            assert!(decode_id(&album.artist.id).is_some());
            assert!(decode_id(&album.tracks[0].id).is_some());
        }
        for playlist in &library.saved_playlists {
            assert!(decode_id(&playlist.id).is_some());
            assert!(decode_id(&playlist.tracks[0].id).is_some());
        }
    }

    #[tokio::test]
    async fn song_routes_restore_native_references_and_cache_only_native_songs() {
        for (provider_id, catalog_id, track_id) in [
            ("qqmusic", "qqmusic:track:source-mid", "source-mid"),
            (
                "org.example.spotify",
                "spotify-track-id",
                "spotify-track-id",
            ),
            ("org.example.netease", "5257138", "5257138"),
            ("org.example.kugou", "SOURCE-HASH", "SOURCE-HASH"),
        ] {
            let mut source = source_song(provider_id, catalog_id, track_id);
            source.artists = vec![ArtistSummary {
                id: "native-artist".to_owned(),
                name: "Fixture artist".to_owned(),
            }];
            let catalog = Arc::new(NoopCatalog::default());
            let playback = Arc::new(RecordingPlayback::default());
            let member = FederationMember {
                provider_id: provider_id.to_owned(),
                profile_id: "work".to_owned(),
                catalog: Arc::clone(&catalog) as Arc<dyn CatalogProvider>,
                playback: Some(Arc::clone(&playback) as Arc<dyn PlaybackSourceProvider>),
                lyrics: None,
                comments: None,
            };
            let federation = FederatedProvider::new(
                "org.example.aggregate".to_owned(),
                "Aggregate".to_owned(),
                vec![member.clone()],
            );
            let mapped = federation.remap_song(&member, source.clone());
            let (_, _, restored) = federation.resolve_route(&mapped).await.expect("route");
            assert_eq!(restored, source);
            assert!(matches!(
                federation.resolve(&mapped).await,
                Err(PlaybackSourceError::Cancelled)
            ));
            assert_eq!(
                *playback.resolved.lock().expect("resolved song"),
                Some(source.clone())
            );
            *playback.resolved.lock().expect("clear resolved song") = None;
            let failed = PlaybackSourceSelection {
                requested_quality: AudioQualityPreference::Automatic,
                resolved_quality: yaqmc_provider_api::AudioQuality::HiRes,
                fallback_reason: None,
                preview: false,
                quality_capabilities: Vec::new(),
            };
            assert!(matches!(
                federation
                    .resolve_unavailable_fallback(&mapped, &failed)
                    .await,
                Err(PlaybackSourceError::Cancelled)
            ));
            assert_eq!(
                *playback.resolved.lock().expect("fallback song"),
                Some(source.clone())
            );
            federation
                .playback_set_current_quality(mapped.id.clone(), AudioQualityPreference::High)
                .await
                .expect("current quality");
            assert_eq!(
                *playback.quality.lock().expect("quality"),
                Some((track_id.to_owned(), AudioQualityPreference::High))
            );
            federation.catalog_remember_songs(&[mapped]).await;
            assert_eq!(*catalog.remembered.lock().expect("cache"), vec![source]);
        }
    }

    #[tokio::test]
    async fn legacy_song_routes_restore_reference_from_the_source_catalog() {
        let source = source_song("qqmusic", "qqmusic:track:source-mid", "source-mid");
        let member = FederationMember {
            provider_id: "qqmusic".to_owned(),
            profile_id: "work".to_owned(),
            catalog: Arc::new(NoopCatalog {
                song: Some(source.clone()),
                ..NoopCatalog::default()
            }),
            playback: None,
            lyrics: None,
            comments: None,
        };
        let federation = FederatedProvider::new(
            "org.example.aggregate".to_owned(),
            "Aggregate".to_owned(),
            vec![member.clone()],
        );
        let mut legacy = federation.remap_song(&member, source.clone());
        legacy.id = encode_id(&member, &source.id);
        let (_, _, restored) = federation
            .resolve_route(&legacy)
            .await
            .expect("legacy route");
        assert_eq!(restored, source);
    }

    #[test]
    fn routed_song_rejects_foreign_embedded_provider_or_profile() {
        let member = FederationMember {
            provider_id: "qqmusic".to_owned(),
            profile_id: "work".to_owned(),
            catalog: Arc::new(NoopCatalog::default()),
            playback: None,
            lyrics: None,
            comments: None,
        };
        let federation = FederatedProvider::new(
            "org.example.aggregate".to_owned(),
            "Aggregate".to_owned(),
            vec![member.clone()],
        );
        let mapped = federation.remap_song(
            &member,
            source_song("qqmusic", "qqmusic:track:source-mid", "source-mid"),
        );
        let route = decode_id(&mapped.id).expect("route");
        let mut foreign_provider = route.clone();
        foreign_provider
            .source_reference
            .as_mut()
            .expect("source")
            .provider_id = "other".to_owned();
        assert!(decode_id(&encode_route(&foreign_provider)).is_none());
        let mut foreign_profile = route;
        foreign_profile
            .source_reference
            .as_mut()
            .expect("source")
            .profile_id = "other".to_owned();
        assert!(decode_id(&encode_route(&foreign_profile)).is_none());
    }

    #[derive(Default)]
    struct RecordingPlayback {
        resolved: Mutex<Option<Song>>,
        quality: Mutex<Option<(String, AudioQualityPreference)>>,
    }

    #[async_trait::async_trait]
    impl PlaybackSourceResolver for RecordingPlayback {
        async fn resolve(
            &self,
            song: &Song,
        ) -> Result<ResolvedPlaybackSource, PlaybackSourceError> {
            *self.resolved.lock().expect("resolved song") = Some(song.clone());
            Err(PlaybackSourceError::Cancelled)
        }

        async fn resolve_unavailable_fallback(
            &self,
            song: &Song,
            _failed: &PlaybackSourceSelection,
        ) -> Result<ResolvedPlaybackSource, PlaybackSourceError> {
            self.resolve(song).await
        }
    }

    #[async_trait::async_trait]
    impl PlaybackSourceProvider for RecordingPlayback {
        fn playback_media_http_client(&self) -> reqwest::Client {
            reqwest::Client::new()
        }
        async fn playback_set_preferred_quality(
            &self,
            _: AudioQualityPreference,
        ) -> ProviderResult<ProviderStatus> {
            unreachable!()
        }
        async fn playback_set_current_quality(
            &self,
            track_id: String,
            quality: AudioQualityPreference,
        ) -> ProviderResult<()> {
            *self.quality.lock().expect("quality") = Some((track_id, quality));
            Ok(())
        }
    }

    struct RecordingLyrics {
        document: Option<LyricDocument>,
        requested: Mutex<Vec<String>>,
    }

    #[async_trait::async_trait]
    impl LyricsProvider for RecordingLyrics {
        async fn lyrics_for_song(&self, song_id: String) -> ProviderResult<Option<LyricDocument>> {
            self.requested.lock().expect("lyrics request").push(song_id);
            Ok(self.document.clone())
        }
    }

    #[derive(Default)]
    struct NoopCatalog {
        song: Option<Song>,
        artist: Option<Artist>,
        library: LibrarySnapshot,
        remembered: Mutex<Vec<Song>>,
    }

    #[async_trait::async_trait]
    impl CatalogProvider for NoopCatalog {
        fn catalog_capabilities(&self) -> yaqmc_provider_api::CatalogProviderCapabilities {
            unreachable!()
        }
        async fn catalog_status(&self) -> yaqmc_provider_api::ProviderStatus {
            unreachable!()
        }
        async fn catalog_search(
            &self,
            _: String,
            _: yaqmc_provider_api::CatalogSearchKind,
            _: u32,
            _: u32,
        ) -> yaqmc_provider_api::ProviderResult<yaqmc_provider_api::SearchResult> {
            unreachable!()
        }
        async fn catalog_song(
            &self,
            id: String,
        ) -> yaqmc_provider_api::ProviderResult<yaqmc_provider_api::Song> {
            let song = self.song.clone().expect("fixture song");
            assert_eq!(song.id, id);
            Ok(song)
        }
        async fn catalog_album(
            &self,
            _: String,
        ) -> yaqmc_provider_api::ProviderResult<yaqmc_provider_api::Album> {
            unreachable!()
        }
        async fn catalog_artist(
            &self,
            id: String,
        ) -> yaqmc_provider_api::ProviderResult<yaqmc_provider_api::Artist> {
            let artist = self.artist.clone().expect("fixture artist");
            assert_eq!(artist.id, id);
            Ok(artist)
        }
        async fn catalog_artist_page(
            &self,
            _: String,
            _: yaqmc_provider_api::ArtistCatalogKind,
            _: u32,
            _: u32,
        ) -> yaqmc_provider_api::ProviderResult<yaqmc_provider_api::ArtistCatalogPage> {
            unreachable!()
        }
        async fn catalog_playlist(
            &self,
            _: String,
        ) -> yaqmc_provider_api::ProviderResult<yaqmc_provider_api::Playlist> {
            unreachable!()
        }
        async fn catalog_home(
            &self,
            _: bool,
        ) -> yaqmc_provider_api::ProviderResult<yaqmc_provider_api::HomeFeed> {
            unreachable!()
        }
        async fn catalog_discover(
            &self,
            _: bool,
        ) -> yaqmc_provider_api::ProviderResult<yaqmc_provider_api::DiscoverFeed> {
            unreachable!()
        }
        async fn catalog_area(
            &self,
            _: String,
        ) -> yaqmc_provider_api::ProviderResult<yaqmc_provider_api::AreaFeed> {
            unreachable!()
        }
        fn catalog_library(&self) -> yaqmc_provider_api::LibrarySnapshot {
            self.library.clone()
        }
        async fn catalog_artwork_data_uri(
            &self,
            _: String,
        ) -> yaqmc_provider_api::ProviderResult<String> {
            unreachable!()
        }
        fn catalog_cache_stats(
            &self,
        ) -> yaqmc_provider_api::ProviderResult<yaqmc_provider_api::CacheStats> {
            unreachable!()
        }
        fn catalog_clear_cache(
            &self,
        ) -> yaqmc_provider_api::ProviderResult<yaqmc_provider_api::CacheStats> {
            unreachable!()
        }
        async fn catalog_remember_songs(&self, songs: &[yaqmc_provider_api::Song]) {
            self.remembered
                .lock()
                .expect("cache")
                .extend_from_slice(songs);
        }
    }
}
