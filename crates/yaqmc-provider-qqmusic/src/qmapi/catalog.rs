//! Typed qm-api-rs catalog boundary.
//!
//! This module intentionally exposes only normalized library boundary values
//! to the parent provider. The album-list and playlist-search paths add narrow
//! compatibility decoders for production fields that the pinned qm-api-rs
//! models cannot currently deserialize without discarding the whole page.

use qqmusic_api::{
    models::{base::Singer, singer::AlbumBrief},
    CgiOptions, Client, Platform,
};
use serde::{de::Error as _, Deserialize, Deserializer};
use serde_json::{json, Value};

use crate::qmapi::cgi::map_qmapi_error;
use crate::qqmusic::QQMusicError;
use yaqmc_provider_api::ArtistCatalogKind;

const TOP_ENTITY_LIMIT: i64 = 20;
const ALBUM_TRACK_PAGE_SIZE: i64 = 100;
const MAX_ALBUM_TRACK_PAGES: u32 = 100;
const SONGLIST_TRACK_PAGE_SIZE: i64 = 100;
const MAX_SONGLIST_TRACK_PAGES: u32 = 100;

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

pub(crate) enum ArtistCatalogPage {
    Songs {
        total: i64,
        items: Vec<qqmusic_api::Song>,
    },
    Albums {
        total: i64,
        items: Vec<qqmusic_api::models::singer::AlbumBrief>,
    },
}

pub(crate) struct PlaylistSearchPage {
    pub total: i64,
    pub items: Vec<PlaylistSearchItem>,
}

pub(crate) struct PlaylistSearchItem {
    pub id: String,
    pub title: String,
    pub creator: String,
    pub artwork_url: String,
    pub track_count: u32,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct PlaylistSearchResponse {
    meta: PlaylistSearchMeta,
    body: PlaylistSearchBody,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct PlaylistSearchMeta {
    sum: i64,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct PlaylistSearchBody {
    #[serde(
        rename = "item_songlist",
        deserialize_with = "deserialize_playlist_items"
    )]
    items: Vec<PlaylistSearchWireItem>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct PlaylistSearchWireItem {
    #[serde(rename = "dissid", deserialize_with = "deserialize_stringish")]
    id: String,
    #[serde(rename = "dissname", deserialize_with = "deserialize_stringish")]
    title: String,
    #[serde(rename = "nickname", deserialize_with = "deserialize_stringish")]
    creator: String,
    #[serde(
        rename = "logo",
        alias = "picUrl",
        alias = "cover",
        deserialize_with = "deserialize_stringish"
    )]
    artwork_url: String,
    #[serde(
        rename = "songnum",
        alias = "songNum",
        alias = "song_cnt",
        deserialize_with = "deserialize_u32ish"
    )]
    track_count: u32,
}

fn deserialize_playlist_items<'de, D>(
    deserializer: D,
) -> Result<Vec<PlaylistSearchWireItem>, D::Error>
where
    D: Deserializer<'de>,
{
    let Value::Array(entries) = Value::deserialize(deserializer)? else {
        return Err(D::Error::custom("item_songlist must be an array"));
    };
    Ok(entries
        .into_iter()
        .filter_map(|entry| serde_json::from_value(entry).ok())
        .collect())
}

fn deserialize_stringish<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    match Value::deserialize(deserializer)? {
        Value::String(value) => Ok(value),
        Value::Number(value) => Ok(value.to_string()),
        Value::Null => Ok(String::new()),
        _ => Ok(String::new()),
    }
}

fn deserialize_u32ish<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    match Value::deserialize(deserializer)? {
        Value::Number(value) => Ok(value
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .unwrap_or_default()),
        Value::String(value) => Ok(value.parse::<u32>().unwrap_or_default()),
        _ => Ok(0),
    }
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct SingerAlbumListResponse {
    singer_mid: String,
    total: i64,
    #[serde(deserialize_with = "deserialize_album_list")]
    album_list: Vec<AlbumBrief>,
}

fn deserialize_album_list<'de, D>(deserializer: D) -> Result<Vec<AlbumBrief>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    let entries = match value {
        Value::Null => return Ok(Vec::new()),
        Value::Array(entries) => entries,
        _ => return Err(D::Error::custom("albumList must be an array or null")),
    };

    entries
        .into_iter()
        .map(|mut entry| {
            // The production endpoint currently returns `tags: null`. The
            // pinned qm-api-rs `AlbumBrief` expects an array, and its lenient
            // JSONPath conversion otherwise discards the entire album page.
            if let Some(object) = entry.as_object_mut() {
                if object.get("tags").is_some_and(Value::is_null) {
                    object.insert("tags".to_owned(), Value::Array(Vec::new()));
                }
            }
            serde_json::from_value(entry).map_err(D::Error::custom)
        })
        .collect()
}

async fn artist_album_list(
    client: &Client,
    mid: &str,
    number: i64,
    page: i64,
) -> Result<SingerAlbumListResponse, QQMusicError> {
    client
        .cgi(
            "music.musichallAlbum.AlbumListServer",
            "GetAlbumList",
            json!({
                "singerMid": mid,
                "order": 1,
                "number": number,
                "begin": (page - 1) * number,
            }),
            &CgiOptions::default(),
        )
        .await
        .map_err(map_qmapi_error)
}

pub(crate) async fn playlist_search(
    client: &Client,
    query: &str,
    page: u32,
    limit: u32,
) -> Result<PlaylistSearchPage, QQMusicError> {
    let response: PlaylistSearchResponse = client
        .cgi(
            "music.search.SearchCgiService",
            "DoSearchForQQMusicMobile",
            json!({
                "searchid": qqmusic_api::get_search_id(),
                "query": query,
                "search_type": qqmusic_api::SearchType::Songlist.value(),
                "num_per_page": limit,
                "page_num": page,
                "highlight": true,
                "grp": true,
                "selectors": {},
                "vec_selectors": [],
            }),
            &CgiOptions {
                platform: Some(Platform::Android),
                ..CgiOptions::default()
            },
        )
        .await
        .map_err(map_qmapi_error)?;

    if page == 1 && response.meta.sum > 0 && response.body.items.is_empty() {
        return Err(QQMusicError::SchemaChanged);
    }

    Ok(PlaylistSearchPage {
        total: response.meta.sum,
        items: response
            .body
            .items
            .into_iter()
            .map(|item| PlaylistSearchItem {
                id: item.id,
                title: item.title,
                creator: item.creator,
                artwork_url: item.artwork_url,
                track_count: item.track_count,
            })
            .collect(),
    })
}

pub(crate) async fn songlist(
    client: &Client,
    id: i64,
) -> Result<qqmusic_api::models::songlist::GetSonglistDetailResponse, QQMusicError> {
    let mut response = client
        .songlist
        .get_detail(id, 0, SONGLIST_TRACK_PAGE_SIZE, 1, false, true, true)
        .await
        .map_err(map_qmapi_error)?;
    let mut page = 1_u32;

    loop {
        let total = usize::try_from(response.total.max(0)).unwrap_or(usize::MAX);
        let complete = if total > 0 {
            response.songs.len() >= total
        } else {
            response.hasmore <= 0
        };
        if complete {
            return Ok(response);
        }
        if page >= MAX_SONGLIST_TRACK_PAGES {
            return Err(QQMusicError::SchemaChanged);
        }

        page = page.saturating_add(1);
        let next = client
            .songlist
            .get_detail(
                id,
                0,
                SONGLIST_TRACK_PAGE_SIZE,
                i64::from(page),
                false,
                true,
                true,
            )
            .await
            .map_err(map_qmapi_error)?;
        if next.songs.is_empty() {
            return Err(QQMusicError::SchemaChanged);
        }
        response.total = response.total.max(next.total);
        response.hasmore = next.hasmore;
        response.songs.extend(next.songs);
    }
}

pub(crate) async fn artist_catalog_page(
    client: &Client,
    mid: &str,
    kind: ArtistCatalogKind,
    page: u32,
    limit: u32,
) -> Result<ArtistCatalogPage, QQMusicError> {
    let number = i64::from(limit);
    let page = i64::from(page);
    match kind {
        ArtistCatalogKind::Song => {
            let response = client
                .singer
                .get_songs_list(mid, number, page)
                .await
                .map_err(map_qmapi_error)?;
            if response.singer_mid.trim() != mid {
                return Err(QQMusicError::SchemaChanged);
            }
            Ok(ArtistCatalogPage::Songs {
                total: response.total_num,
                items: response.song_list,
            })
        }
        ArtistCatalogKind::Album => {
            let response = artist_album_list(client, mid, number, page).await?;
            if response.singer_mid.trim() != mid {
                return Err(QQMusicError::SchemaChanged);
            }
            Ok(ArtistCatalogPage::Albums {
                total: response.total,
                items: response.album_list,
            })
        }
    }
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
    let albums = artist_album_list(client, mid, TOP_ENTITY_LIMIT, 1).await?;

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
    use yaqmc_provider_api::ArtistCatalogKind;

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
                        assert!(matches!(
                            (
                                req["param"]["number"].as_i64(),
                                req["param"]["begin"].as_i64()
                            ),
                            (Some(20), Some(0)) | (Some(8), Some(8))
                        ));
                        &include_bytes!("../../tests/fixtures/qqmusic/catalog/artist-songs.json")[..]
                    }
                    ("music.musichallAlbum.AlbumListServer", "GetAlbumList") => {
                        assert_eq!(req["param"]["singerMid"], "ARTIST_MID");
                        assert!(matches!(
                            (
                                req["param"]["number"].as_i64(),
                                req["param"]["begin"].as_i64()
                            ),
                            (Some(20), Some(0)) | (Some(8), Some(8))
                        ));
                        &include_bytes!("../../tests/fixtures/qqmusic/catalog/artist-albums.json")[..]
                    }
                    ("music.srfDissInfo.DissInfo", "CgiGetDiss") => {
                        assert_eq!(req["param"]["disstid"], 5_505_165_762_i64);
                        assert_eq!(req["param"]["song_num"], super::SONGLIST_TRACK_PAGE_SIZE);
                        match req["param"]["song_begin"].as_i64() {
                            Some(0) => &br#"{"code":0,"req_0":{"code":0,"subcode":0,"data":{"code":0,"subcode":0,"dirinfo":{"tid":5505165762,"dirName":"Provider daily title","picUrl":"https://y.gtimg.cn/provider-daily.jpg","desc":"Provider daily description","creator":{"musicid":10001,"nick":"Provider curator","encrypt_uin":"PUBLIC_CREATOR_ID"}},"songlist":[{"id":1,"mid":"DAILY_TRACK_1","title":"Daily track 1"}],"total_song_num":2}}}"#[..],
                            Some(100) => &br#"{"code":0,"req_0":{"code":0,"data":{"code":0,"subcode":0,"songlist":[{"id":2,"mid":"DAILY_TRACK_2","title":"Daily track 2"}],"total_song_num":2,"hasmore":0}}}"#[..],
                            begin => panic!("unexpected songlist page offset {begin:?}"),
                        }
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

        let songs =
            super::artist_catalog_page(&client, "ARTIST_MID", ArtistCatalogKind::Song, 2, 8)
                .await
                .expect("artist song page");
        assert!(matches!(
            songs,
            super::ArtistCatalogPage::Songs { total: 1, items } if items.len() == 1
        ));
        let albums =
            super::artist_catalog_page(&client, "ARTIST_MID", ArtistCatalogKind::Album, 2, 8)
                .await
                .expect("artist album page");
        assert!(matches!(
            albums,
            super::ArtistCatalogPage::Albums { total: 1, items } if items.len() == 1
        ));
        let daily = super::songlist(&client, 5_505_165_762)
            .await
            .expect("daily songlist");
        assert_eq!(daily.info.base.title, "Provider daily title");
        assert_eq!(daily.info.creator.nick, "Provider curator");
        assert_eq!(daily.songs.len(), 2);

        let calls = transport.calls();
        assert_eq!(calls, (0..14).collect::<Vec<_>>());

        let requests = transport.requests();
        assert_eq!(requests.len(), 14);
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
        assert_eq!(requests[10]["req_0"]["method"], "GetSingerSongList");
        assert_eq!(requests[10]["req_0"]["param"]["number"], 8);
        assert_eq!(requests[10]["req_0"]["param"]["begin"], 8);
        assert_eq!(requests[11]["req_0"]["method"], "GetAlbumList");
        assert_eq!(requests[11]["req_0"]["param"]["number"], 8);
        assert_eq!(requests[11]["req_0"]["param"]["begin"], 8);
        assert_eq!(
            requests[12]["req_0"]["module"],
            "music.srfDissInfo.DissInfo"
        );
        assert_eq!(requests[12]["req_0"]["method"], "CgiGetDiss");
        assert_eq!(
            requests[12]["req_0"]["param"]["song_num"],
            super::SONGLIST_TRACK_PAGE_SIZE
        );
        assert_eq!(requests[12]["req_0"]["param"]["song_begin"], 0);
        assert_eq!(requests[13]["req_0"]["param"]["song_begin"], 100);
    }
}
