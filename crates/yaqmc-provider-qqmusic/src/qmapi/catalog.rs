//! Typed qm-api-rs catalog boundary.
//!
//! This module intentionally exposes only the pinned library model values to
//! the parent provider.  Request construction, upstream routes, and response
//! wire DTOs remain owned by qm-api-rs.

use qqmusic_api::{models::base::Singer, Client};

use crate::qmapi::cgi::map_qmapi_error;
use crate::qqmusic::QQMusicError;

const TOP_ENTITY_LIMIT: i64 = 20;
const ALBUM_TRACK_PAGE_SIZE: i64 = 100;
const MAX_ALBUM_TRACK_PAGES: u32 = 100;

pub(crate) struct AlbumCatalog {
    pub detail: qqmusic_api::models::album::AlbumDetail,
    pub singers: Vec<Singer>,
    pub tracks: Vec<qqmusic_api::Song>,
}

pub(crate) struct ArtistCatalog {
    pub info: qqmusic_api::models::singer::HomepageHeaderResponse,
    pub description: qqmusic_api::models::singer::SingerDetailResponse,
    pub top_songs: Vec<qqmusic_api::Song>,
    pub albums: Vec<qqmusic_api::models::singer::AlbumBrief>,
}

pub(crate) async fn song(client: &Client, mid: &str) -> Result<qqmusic_api::Song, QQMusicError> {
    let response = client.song.get_detail(mid).await.map_err(map_qmapi_error)?;
    if response.track.mid.trim().is_empty()
        || (response.track.name.trim().is_empty() && response.track.title.trim().is_empty())
    {
        return Err(QQMusicError::NotFound);
    }
    Ok(response.track)
}

pub(crate) async fn album(client: &Client, mid: &str) -> Result<AlbumCatalog, QQMusicError> {
    let response = client
        .album
        .get_detail(mid)
        .await
        .map_err(map_qmapi_error)?;
    let detail = response.album;
    let singers = response.singers;
    if detail.base.mid.trim().is_empty()
        && detail.base.id <= 0
        && detail.base.name.trim().is_empty()
        && detail.base.title.trim().is_empty()
    {
        return Err(QQMusicError::NotFound);
    }

    let mut tracks = Vec::new();
    let mut page = 1_u32;
    loop {
        if page > MAX_ALBUM_TRACK_PAGES {
            return Err(QQMusicError::SchemaChanged);
        }
        let response = client
            .album
            .get_song(mid, ALBUM_TRACK_PAGE_SIZE, i64::from(page))
            .await
            .map_err(map_qmapi_error)?;
        let total = response.total_num.max(0) as usize;
        let page_len = response.song_list.len();
        tracks.extend(response.song_list);

        if total == 0 || tracks.len() >= total {
            break;
        }
        if page_len == 0 {
            return Err(QQMusicError::SchemaChanged);
        }
        page = page.saturating_add(1);
    }

    Ok(AlbumCatalog {
        detail,
        singers,
        tracks,
    })
}

pub(crate) async fn artist(client: &Client, mid: &str) -> Result<ArtistCatalog, QQMusicError> {
    let info = client.singer.get_info(mid).await.map_err(map_qmapi_error)?;
    if info.singer.mid.trim().is_empty()
        && info.singer.id <= 0
        && info.singer.name.trim().is_empty()
    {
        return Err(QQMusicError::NotFound);
    }

    let mids = vec![mid.to_owned()];
    let description = client
        .singer
        .get_desc(&mids, true, true, true, true, false)
        .await
        .map_err(map_qmapi_error)?;
    let songs = client
        .singer
        .get_songs_list(mid, TOP_ENTITY_LIMIT, 1)
        .await
        .map_err(map_qmapi_error)?;
    let albums = client
        .singer
        .get_album_list(mid, TOP_ENTITY_LIMIT, 1)
        .await
        .map_err(map_qmapi_error)?;

    Ok(ArtistCatalog {
        info,
        description,
        top_songs: songs.song_list,
        albums: albums.album_list,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;
    use qqmusic_api::{ApiTransport, Client, Platform, TransportRequest, TransportResponse};

    #[derive(Default)]
    struct FixtureTransport {
        calls: Mutex<Vec<usize>>,
        requests: Mutex<Vec<serde_json::Value>>,
    }

    impl FixtureTransport {
        fn calls(&self) -> Vec<usize> {
            self.calls.lock().expect("fixture call lock").clone()
        }

        fn requests(&self) -> Vec<serde_json::Value> {
            self.requests.lock().expect("fixture request lock").clone()
        }
    }

    #[async_trait]
    impl ApiTransport for FixtureTransport {
        async fn execute(
            &self,
            request: TransportRequest,
        ) -> qqmusic_api::Result<TransportResponse> {
            let call_index = {
                let mut calls = self.calls.lock().expect("fixture call lock");
                let index = calls.len();
                calls.push(index);
                index
            };
            let qqmusic_api::HttpBody::Json(payload) = request.body else {
                panic!("typed catalog request must use JSON body");
            };
            self.requests
                .lock()
                .expect("fixture request lock")
                .push(payload.clone());

            let fixture = if payload.get("qimeiParams").is_some() {
                assert_eq!(call_index, 4, "qimei request must follow album pages");
                &include_bytes!("../../tests/fixtures/qqmusic/catalog/artist-qimei.json")[..]
            } else {
                assert_eq!(request.url, "https://u.y.qq.com/cgi-bin/musicu.fcg");
                let req = &payload["req_0"];
                let module = req["module"].as_str().unwrap_or_default();
                let method = req["method"].as_str().unwrap_or_default();
                match (module, method) {
                    ("music.pf_song_detail_svr", "get_song_detail_yqq") => {
                        assert_eq!(req["param"]["song_mid"], "SONG_MID");
                        &include_bytes!("../../tests/fixtures/qqmusic/catalog/song-detail.json")[..]
                    }
                    ("music.musichallAlbum.AlbumInfoServer", "GetAlbumDetail") => {
                        assert_eq!(req["param"]["albumMId"], "ALBUM_MID");
                        &include_bytes!("../../tests/fixtures/qqmusic/catalog/album-detail.json")[..]
                    }
                    ("music.musichallAlbum.AlbumSongList", "GetAlbumSongList") => {
                        assert_eq!(req["param"]["albumMid"], "ALBUM_MID");
                        assert_eq!(req["param"]["num"], 100);
                        assert!(matches!(req["param"]["begin"].as_i64(), Some(0 | 100)));
                        if req["param"]["begin"] == 0 {
                            &include_bytes!(
                                "../../tests/fixtures/qqmusic/catalog/album-songs-page-1.json"
                            )[..]
                        } else {
                            &include_bytes!(
                                "../../tests/fixtures/qqmusic/catalog/album-songs-page-2.json"
                            )[..]
                        }
                    }
                    ("music.getSession.session", "GetSession") => {
                        assert_eq!(call_index, 5);
                        &include_bytes!("../../tests/fixtures/qqmusic/catalog/artist-session.json")
                            [..]
                    }
                    ("music.UnifiedHomepage.UnifiedHomepageSrv", "GetHomepageHeader") => {
                        assert_eq!(req["param"]["SingerMid"], "ARTIST_MID");
                        &include_bytes!("../../tests/fixtures/qqmusic/catalog/artist-info.json")[..]
                    }
                    ("music.musichallSinger.SingerInfoInter", "GetSingerDetail") => {
                        assert_eq!(
                            req["param"]["singer_mids"],
                            serde_json::json!(["ARTIST_MID"])
                        );
                        &include_bytes!(
                            "../../tests/fixtures/qqmusic/catalog/artist-description.json"
                        )[..]
                    }
                    ("musichall.song_list_server", "GetSingerSongList") => {
                        assert_eq!(req["param"]["singerMid"], "ARTIST_MID");
                        assert_eq!(req["param"]["number"], 20);
                        assert_eq!(req["param"]["begin"], 0);
                        &include_bytes!("../../tests/fixtures/qqmusic/catalog/artist-songs.json")[..]
                    }
                    ("music.musichallAlbum.AlbumListServer", "GetAlbumList") => {
                        assert_eq!(req["param"]["singerMid"], "ARTIST_MID");
                        assert_eq!(req["param"]["number"], 20);
                        assert_eq!(req["param"]["begin"], 0);
                        &include_bytes!("../../tests/fixtures/qqmusic/catalog/artist-albums.json")[..]
                    }
                    _ => panic!("unexpected typed catalog request {module}/{method}"),
                }
            };
            Ok(TransportResponse {
                status: 200,
                final_url: request.url,
                headers: Vec::new(),
                body: fixture.to_vec(),
            })
        }
    }

    #[tokio::test]
    async fn typed_catalog_calls_normalize_song_artist_and_bounded_album_pages() {
        let transport = Arc::new(FixtureTransport::default());
        let client = Client::new_with_transport(None, Some(Platform::Web), transport.clone());

        let song = super::song(&client, "SONG_MID").await.expect("song detail");
        assert_eq!(song.mid, "SONG_MID");

        let album = super::album(&client, "ALBUM_MID")
            .await
            .expect("album detail");
        assert_eq!(album.detail.base.mid, "ALBUM_MID");
        assert_eq!(album.tracks.len(), 2);
        assert_eq!(album.tracks[1].mid, "SONG_MID_2");

        let artist = super::artist(&client, "ARTIST_MID")
            .await
            .expect("artist detail");
        assert_eq!(artist.info.singer.mid, "ARTIST_MID");
        assert_eq!(artist.description.singer_list.len(), 1);
        assert_eq!(artist.top_songs.len(), 1);
        assert_eq!(artist.albums.len(), 1);

        let calls = transport.calls();
        assert_eq!(calls, (0..10).collect::<Vec<_>>());

        let requests = transport.requests();
        assert_eq!(requests.len(), 10);
        assert_eq!(requests[0]["req_0"]["module"], "music.pf_song_detail_svr");
        assert_eq!(requests[0]["req_0"]["method"], "get_song_detail_yqq");
        assert_eq!(requests[0]["req_0"]["param"]["song_mid"], "SONG_MID");
        assert_eq!(
            requests[1]["req_0"]["module"],
            "music.musichallAlbum.AlbumInfoServer"
        );
        assert_eq!(requests[1]["req_0"]["method"], "GetAlbumDetail");
        assert_eq!(requests[1]["req_0"]["param"]["albumMId"], "ALBUM_MID");
        for (index, begin) in [(2, 0), (3, 100)] {
            assert_eq!(
                requests[index]["req_0"]["module"],
                "music.musichallAlbum.AlbumSongList"
            );
            assert_eq!(requests[index]["req_0"]["method"], "GetAlbumSongList");
            assert_eq!(requests[index]["req_0"]["param"]["albumMid"], "ALBUM_MID");
            assert_eq!(requests[index]["req_0"]["param"]["num"], 100);
            assert_eq!(requests[index]["req_0"]["param"]["begin"], begin);
        }
        assert!(requests[4].get("qimeiParams").is_some());
        assert_eq!(requests[5]["req_0"]["module"], "music.getSession.session");
        assert_eq!(requests[5]["req_0"]["method"], "GetSession");
        assert_eq!(
            requests[6]["req_0"]["module"],
            "music.UnifiedHomepage.UnifiedHomepageSrv"
        );
        assert_eq!(requests[6]["req_0"]["method"], "GetHomepageHeader");
        assert_eq!(requests[6]["req_0"]["param"]["SingerMid"], "ARTIST_MID");
        assert_eq!(
            requests[7]["req_0"]["module"],
            "music.musichallSinger.SingerInfoInter"
        );
        assert_eq!(requests[7]["req_0"]["method"], "GetSingerDetail");
        assert_eq!(
            requests[7]["req_0"]["param"]["singer_mids"],
            serde_json::json!(["ARTIST_MID"])
        );
        assert_eq!(requests[8]["req_0"]["module"], "musichall.song_list_server");
        assert_eq!(requests[8]["req_0"]["method"], "GetSingerSongList");
        assert_eq!(requests[8]["req_0"]["param"]["singerMid"], "ARTIST_MID");
        assert_eq!(requests[8]["req_0"]["param"]["number"], 20);
        assert_eq!(requests[8]["req_0"]["param"]["begin"], 0);
        assert_eq!(
            requests[9]["req_0"]["module"],
            "music.musichallAlbum.AlbumListServer"
        );
        assert_eq!(requests[9]["req_0"]["method"], "GetAlbumList");
        assert_eq!(requests[9]["req_0"]["param"]["singerMid"], "ARTIST_MID");
        assert_eq!(requests[9]["req_0"]["param"]["number"], 20);
        assert_eq!(requests[9]["req_0"]["param"]["begin"], 0);
    }
}
