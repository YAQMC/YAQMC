//! Catalog, status, OAuth, and provider error DTOs.

use crate::{ArtistSummary, Artwork, AudioQualityPreference, Song};
use serde::{Deserialize, Serialize};

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
    #[serde(default)]
    pub guess_songlist: Option<Playlist>,
    #[serde(default)]
    pub recommended_songlists: Vec<Playlist>,
    #[serde(default)]
    pub daily_songlist: Option<Playlist>,
    #[serde(default)]
    pub new_song_songlist: Option<Playlist>,
    #[serde(default)]
    pub radar_based_on_song: Option<String>,
    #[serde(default)]
    pub radar_songs: Vec<Song>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverFeed {
    pub charts: Vec<Playlist>,
    #[serde(default)]
    pub new_songs: Option<Playlist>,
    #[serde(default)]
    pub new_albums: Vec<Album>,
    #[serde(default)]
    pub popular_songlists: Vec<Playlist>,
    #[serde(default)]
    pub categories: Vec<Category>,
    #[serde(default)]
    pub podcasts: Vec<Podcast>,
    #[serde(default)]
    pub new_mvs: Vec<NewMv>,
    #[serde(default)]
    pub featured: Vec<FeaturedCard>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub enc_area: String,
    pub title: String,
    pub cover: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Podcast {
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub cover: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMv {
    pub id: String,
    pub title: String,
    pub cover: String,
    pub duration_ms: u64,
    pub artist: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeaturedCard {
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub cover: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AreaFeed {
    pub title: String,
    #[serde(default)]
    pub songlists: Vec<Playlist>,
    #[serde(default)]
    pub playlists: Vec<Playlist>,
    #[serde(default)]
    pub artists: Vec<AreaArtist>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AreaArtist {
    pub id: String,
    pub name: String,
    pub cover: String,
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

#[derive(Clone, Debug, Deserialize, Serialize)]
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider_id: String,
    pub display_name: String,
    pub connection: String,
    pub message: String,
    pub preferred_quality: AudioQualityPreference,
    pub capabilities: CatalogProviderCapabilities,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCommandError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl ProviderCommandError {
    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self {
            code: "invalid-request".to_owned(),
            message: message.into(),
            retryable: false,
        }
    }

    pub fn adapter(message: impl Into<String>) -> Self {
        Self {
            code: "provider-failure".to_owned(),
            message: message.into(),
            retryable: false,
        }
    }
}

pub type ProviderResult<T> = Result<T, ProviderCommandError>;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum OAuthLoginProvider {
    Qq,
    Wechat,
}

impl OAuthLoginProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Qq => "qq",
            Self::Wechat => "wechat",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthCallbackMatcher {
    pub url_prefix: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthPrepareResult {
    pub attempt_id: String,
    pub url: String,
    pub navigation_allowlist: Vec<String>,
    pub callback_matcher: OAuthCallbackMatcher,
    #[serde(skip)]
    pub snapshot: crate::AccountSnapshot,
}
