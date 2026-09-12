//! Application mapping for typed web discovery. No upstream protocol lives here.

use super::*;
use crate::qmapi::cgi::map_qmapi_error;
use qqmusic_api::models::discovery::{FeedCard, FeedCardKind};

fn cover(value: &str) -> String {
    artwork::normalize_provider_artwork_url(value).unwrap_or_default()
}

pub(super) fn playlist_card(card: FeedCard) -> Option<Playlist> {
    let title = clean_text(&card.title);
    if card.id.is_empty() || title.is_empty() {
        return None;
    }
    Some(Playlist {
        id: playlist_id(&card.id),
        artwork: artwork_from_provider_url(&card.cover_url, &title, color_for(&card.id)),
        title,
        description: clean_text(&card.subtitle),
        owner: PlaylistOwner {
            id: "qqmusic".into(),
            display_name: "QQ Music".into(),
        },
        updated_label: String::new(),
        tracks: Vec::new(),
    })
}

impl QQMusicClient {
    pub(super) async fn toplist(&self, top_id: u64, limit: u32) -> Result<Playlist, QQMusicError> {
        let response = self
            .catalog
            .top
            .get_web_detail(top_id, 0, limit, "")
            .await
            .map_err(map_qmapi_error)?;
        let details = response.info;
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
            artwork: artwork_from_provider_url(&artwork_url, &title, artwork_color),
            title,
            description: clean_text(&details.intro),
            owner: PlaylistOwner {
                id: "qqmusic".into(),
                display_name: "QQ Music".into(),
            },
            updated_label: non_empty(details.update_time)
                .map(|value| format!("Updated {value}"))
                .unwrap_or_else(|| "Updated daily".into()),
            tracks: response
                .songs
                .into_iter()
                .enumerate()
                .filter_map(|(index, song)| normalize_qm_song(song, index as u32 + 1))
                .collect(),
        })
    }

    pub(super) async fn categories(&self) -> Result<Vec<Category>, QQMusicError> {
        Ok(self
            .catalog
            .discovery
            .categories()
            .await
            .map_err(map_qmapi_error)?
            .into_iter()
            .filter_map(|card| {
                let title = clean_text(&card.title);
                (!title.is_empty()).then(|| Category {
                    enc_area: card.area_key,
                    title,
                    cover: cover(&card.cover_url),
                })
            })
            .collect())
    }

    pub(super) async fn podcasts(&self) -> Result<Vec<Podcast>, QQMusicError> {
        Ok(self
            .catalog
            .discovery
            .podcasts()
            .await
            .map_err(map_qmapi_error)?
            .into_iter()
            .filter_map(|card| {
                let title = clean_text(&card.title);
                (!title.is_empty()).then(|| Podcast {
                    id: card.id,
                    title,
                    subtitle: clean_text(&card.subtitle),
                    cover: cover(&card.cover_url),
                })
            })
            .collect())
    }

    pub(super) async fn new_mvs(&self) -> Result<Vec<NewMv>, QQMusicError> {
        Ok(self
            .catalog
            .discovery
            .new_mvs(0, 8)
            .await
            .map_err(map_qmapi_error)?
            .into_iter()
            .filter_map(|card| {
                let title = clean_text(&card.title);
                (!title.is_empty()).then(|| NewMv {
                    id: card.id,
                    title,
                    cover: cover(&card.cover_url),
                    artist: clean_text(&card.artist),
                    duration_ms: card.duration_seconds.saturating_mul(1000),
                })
            })
            .collect())
    }

    pub(super) async fn featured_cards(&self) -> Result<Vec<FeaturedCard>, QQMusicError> {
        Ok(self
            .catalog
            .discovery
            .featured()
            .await
            .map_err(map_qmapi_error)?
            .into_iter()
            .filter_map(|card| {
                let title = clean_text(&card.title);
                (!title.is_empty()).then(|| FeaturedCard {
                    id: card.id,
                    title,
                    subtitle: clean_text(&card.subtitle),
                    cover: cover(&card.cover_url),
                })
            })
            .collect())
    }

    pub(super) async fn area_home(&self, enc_area: &str) -> Result<AreaFeed, QQMusicError> {
        let response = self
            .catalog
            .discovery
            .area(enc_area)
            .await
            .map_err(map_qmapi_error)?;
        let mut result = AreaFeed {
            title: clean_text(&response.title),
            songlists: vec![],
            playlists: vec![],
            artists: vec![],
        };
        for card in response.shelves.into_iter().flat_map(|shelf| shelf.cards) {
            match card.kind {
                FeedCardKind::Playlist | FeedCardKind::NewSongs => {
                    if let Some(playlist) = playlist_card(card) {
                        result.playlists.push(playlist);
                    }
                }
                FeedCardKind::Songlist => {
                    if let Some(playlist) = playlist_card(card) {
                        result.songlists.push(playlist);
                    }
                }
                FeedCardKind::Artist => {
                    let name = clean_text(&card.title);
                    if !name.is_empty() {
                        result.artists.push(AreaArtist {
                            id: card.id,
                            name,
                            cover: cover(&card.cover_url),
                        });
                    }
                }
                FeedCardKind::Other => {}
            }
        }
        Ok(result)
    }
}
