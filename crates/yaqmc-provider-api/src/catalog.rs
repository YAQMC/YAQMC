//! Catalog, status, OAuth, and provider error DTOs.

use crate::{ArtistSummary, Artwork, AudioQualityPreference, Song};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistPreview {
    pub id: String,
    pub name: String,
    pub artwork: Artwork,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumPreview {
    pub id: String,
    pub title: String,
    pub artist: ArtistPreview,
    pub artwork: Artwork,
    pub release_year: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistPreview {
    pub id: String,
    pub title: String,
    pub creator: String,
    pub artwork: Artwork,
    pub track_count: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Artist {
    pub id: String,
    pub name: String,
    pub artwork: Artwork,
    pub description: String,
    pub top_songs: Vec<Song>,
    pub albums: Vec<AlbumPreview>,
}

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

#[cfg(test)]
mod catalog_shape_tests {
    use super::*;
    use serde_json::json;

    fn artwork() -> Artwork {
        Artwork {
            src: "/artwork/test.svg".to_owned(),
            alt: "Test artwork".to_owned(),
            dominant_color: "#000000".to_owned(),
            variants: Vec::new(),
        }
    }

    #[test]
    fn normalized_catalog_detail_shapes_use_the_frozen_camel_case_wire_names() {
        let artist = Artist {
            id: "qqmusic:artist:mid".to_owned(),
            name: "Artist".to_owned(),
            artwork: artwork(),
            description: "Description".to_owned(),
            top_songs: Vec::new(),
            albums: vec![AlbumPreview {
                id: "qqmusic:album:mid".to_owned(),
                title: "Album".to_owned(),
                artist: ArtistPreview {
                    id: "qqmusic:artist:mid".to_owned(),
                    name: "Artist".to_owned(),
                    artwork: artwork(),
                },
                artwork: artwork(),
                release_year: 2026,
            }],
        };

        assert_eq!(
            serde_json::to_value(&artist).expect("artist serializes"),
            json!({
                "id": "qqmusic:artist:mid",
                "name": "Artist",
                "artwork": {
                    "src": "/artwork/test.svg",
                    "alt": "Test artwork",
                    "dominantColor": "#000000"
                },
                "description": "Description",
                "topSongs": [],
                "albums": [{
                    "id": "qqmusic:album:mid",
                    "title": "Album",
                    "artist": {
                        "id": "qqmusic:artist:mid",
                        "name": "Artist",
                        "artwork": {
                            "src": "/artwork/test.svg",
                            "alt": "Test artwork",
                            "dominantColor": "#000000"
                        }
                    },
                    "artwork": {
                        "src": "/artwork/test.svg",
                        "alt": "Test artwork",
                        "dominantColor": "#000000"
                    },
                    "releaseYear": 2026
                }]
            })
        );
    }

    #[test]
    fn typed_search_result_serializes_kind_and_items() {
        let result = SearchResult::Song {
            query: "fixture".to_owned(),
            page: 2,
            has_more: true,
            items: Vec::new(),
        };
        assert_eq!(
            serde_json::to_value(result).expect("search result serializes"),
            json!({
                "kind": "song",
                "query": "fixture",
                "page": 2,
                "hasMore": true,
                "items": []
            })
        );
    }

    #[test]
    fn typed_search_result_serializes_all_item_tags() {
        let artist = SearchResult::Artist {
            query: "artist".to_owned(),
            page: 1,
            has_more: false,
            items: Vec::new(),
        };
        let album = SearchResult::Album {
            query: "album".to_owned(),
            page: 1,
            has_more: false,
            items: Vec::new(),
        };
        let playlist = SearchResult::Playlist {
            query: "playlist".to_owned(),
            page: 1,
            has_more: false,
            items: vec![PlaylistPreview {
                id: "qqmusic:playlist:1".to_owned(),
                title: "Playlist".to_owned(),
                creator: "Creator".to_owned(),
                artwork: artwork(),
                track_count: 12,
            }],
        };
        assert_eq!(serde_json::to_value(artist).unwrap()["kind"], "artist");
        assert_eq!(serde_json::to_value(album).unwrap()["kind"], "album");
        let playlist = serde_json::to_value(playlist).unwrap();
        assert_eq!(playlist["kind"], "playlist");
        assert_eq!(playlist["items"][0]["trackCount"], 12);
        assert!(serde_json::to_value(SearchResult::Song {
            query: "song".to_owned(),
            page: 1,
            has_more: false,
            items: Vec::new(),
        })
        .unwrap()
        .get("playlists")
        .is_none());

        assert!(serde_json::from_value::<SearchResult>(json!({
            "kind": "playlist",
            "query": "playlist",
            "page": 1,
            "hasMore": false,
            "items": []
        }))
        .is_ok());
    }

    #[test]
    fn artist_catalog_page_serializes_the_discriminated_camel_case_shape() {
        let page = ArtistCatalogPage::Album {
            artist_id: "qqmusic:artist:mid".to_owned(),
            page: 2,
            has_more: true,
            items: Vec::new(),
        };
        assert_eq!(
            serde_json::to_value(page).expect("artist catalog page serializes"),
            json!({
                "kind": "album",
                "artistId": "qqmusic:artist:mid",
                "page": 2,
                "hasMore": true,
                "items": []
            })
        );
    }

    #[test]
    fn account_login_flow_uses_the_frozen_oauth_wire_value() {
        assert_eq!(
            serde_json::to_value(AccountLoginFlow::OAuth).expect("login flow serializes"),
            json!("oauth")
        );
        assert_eq!(
            serde_json::from_value::<AccountLoginFlow>(json!("oauth"))
                .expect("login flow deserializes"),
            AccountLoginFlow::OAuth
        );
    }
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

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CatalogSearchKind {
    Song,
    Artist,
    Album,
    Playlist,
}

impl CatalogSearchKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Song => "song",
            Self::Artist => "artist",
            Self::Album => "album",
            Self::Playlist => "playlist",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SearchResult {
    Song {
        query: String,
        page: u32,
        #[serde(rename = "hasMore")]
        has_more: bool,
        items: Vec<Song>,
    },
    Artist {
        query: String,
        page: u32,
        #[serde(rename = "hasMore")]
        has_more: bool,
        items: Vec<ArtistPreview>,
    },
    Album {
        query: String,
        page: u32,
        #[serde(rename = "hasMore")]
        has_more: bool,
        items: Vec<AlbumPreview>,
    },
    Playlist {
        query: String,
        page: u32,
        #[serde(rename = "hasMore")]
        has_more: bool,
        items: Vec<PlaylistPreview>,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtistCatalogKind {
    Song,
    Album,
}

impl ArtistCatalogKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Song => "song",
            Self::Album => "album",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ArtistCatalogPage {
    Song {
        #[serde(rename = "artistId")]
        artist_id: String,
        page: u32,
        #[serde(rename = "hasMore")]
        has_more: bool,
        items: Vec<Song>,
    },
    Album {
        #[serde(rename = "artistId")]
        artist_id: String,
        page: u32,
        #[serde(rename = "hasMore")]
        has_more: bool,
        items: Vec<AlbumPreview>,
    },
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

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AccountLoginFlow {
    #[serde(rename = "oauth")]
    OAuth,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountLoginMethodDescriptor {
    /// Provider-scoped stable identifier. It is opaque outside the provider
    /// boundary and is never interpreted as an upstream platform route.
    pub id: String,
    pub label: String,
    pub flow: AccountLoginFlow,
}

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

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthExternalNavigationRule {
    pub scheme: String,
    pub host: String,
    pub path: String,
    pub android_packages: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthPrepareResult {
    pub attempt_id: String,
    pub url: String,
    pub mobile_url: Option<String>,
    pub navigation_allowlist: Vec<String>,
    pub external_navigation_rules: Vec<OAuthExternalNavigationRule>,
    pub callback_matcher: OAuthCallbackMatcher,
    #[serde(skip)]
    pub snapshot: crate::AccountSnapshot,
}
