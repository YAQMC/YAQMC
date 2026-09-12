//! Provider-to-library contracts. No production profile or network is used.

use super::*;
use std::collections::VecDeque;
use std::sync::Mutex;

fn blocked_legacy_http() -> Client {
    // These tests require the injected library transport. A legacy call must
    // fail locally instead of contacting QQ and accidentally passing on live data.
    Client::builder()
        .no_proxy()
        .proxy(reqwest::Proxy::all("http://127.0.0.1:0").unwrap())
        .build()
        .unwrap()
}

struct SonglistTransport {
    pages: Mutex<VecDeque<Value>>,
    requests: Mutex<Vec<Value>>,
}

#[async_trait]
impl qqmusic_api::ApiTransport for SonglistTransport {
    async fn execute(
        &self,
        request: qqmusic_api::TransportRequest,
    ) -> qqmusic_api::Result<qqmusic_api::TransportResponse> {
        assert_eq!(request.url, "https://u.y.qq.com/cgi-bin/musicu.fcg");
        let qqmusic_api::HttpBody::Json(payload) = request.body else {
            panic!("songlist must use the library CGI transport");
        };
        let mut requests = self.requests.lock().unwrap();
        assert_eq!(payload["req_0"]["module"], "music.srfDissInfo.DissInfo");
        assert_eq!(payload["req_0"]["method"], "CgiGetDiss");
        assert_eq!(payload["req_0"]["param"]["disstid"], 7654321);
        assert_eq!(payload["req_0"]["param"]["song_num"], 100);
        assert_eq!(
            payload["req_0"]["param"]["song_begin"],
            requests.len() * 100
        );
        requests.push(payload);
        let page = self
            .pages
            .lock()
            .unwrap()
            .pop_front()
            .expect("extra request");
        Ok(qqmusic_api::TransportResponse {
            status: 200,
            final_url: request.url,
            headers: Vec::new(),
            body: serde_json::to_vec(&json!({
                "code": 0,
                "req_0": {"code": 0, "data": page}
            }))
            .unwrap(),
        })
    }
}

fn fixture(pages: Vec<Value>) -> (QQMusicClient, Arc<SonglistTransport>) {
    let transport = Arc::new(SonglistTransport {
        pages: Mutex::new(pages.into()),
        requests: Mutex::new(Vec::new()),
    });
    let http = blocked_legacy_http();
    (
        QQMusicClient {
            http: http.clone(),
            artwork_http: http,
            catalog: qqmusic_api::Client::new_with_transport(
                None,
                Some(qqmusic_api::Platform::Web),
                transport.clone(),
            ),
        },
        transport,
    )
}

fn page(tracks: &[&str], total: i64) -> Value {
    json!({
        "code": 0,
        "subcode": 0,
        "dirinfo": {
            "tid": 7654321,
            "dirName": "Synthetic playlist",
            "desc": "Provider description",
            "picUrl": "https://y.gtimg.cn/synthetic-cover.jpg",
            "creator": {"musicid": 10001, "nick": "Synthetic curator"}
        },
        "songlist": tracks.iter().map(|mid| json!({
            "mid": mid,
            "title": format!("Song {mid}"),
            "interval": 180,
            "file": {"size_128mp3": 4096}
        })).collect::<Vec<_>>(),
        "total_song_num": total,
        "hasmore": 0
    })
}

#[tokio::test]
async fn playlist_uses_typed_api_and_preserves_metadata_order_and_duplicates() {
    let (client, transport) = fixture(vec![page(&["FIRST"], 3), page(&["SECOND", "FIRST"], 3)]);
    let playlist = client.playlist("7654321").await.unwrap();
    assert_eq!(playlist.id, "qqmusic:playlist:7654321");
    assert_eq!(playlist.title, "Synthetic playlist");
    assert_eq!(playlist.description, "Provider description");
    assert_eq!(playlist.owner.display_name, "Synthetic curator");
    assert_eq!(
        playlist.artwork.src,
        "https://y.gtimg.cn/synthetic-cover.jpg"
    );
    assert_eq!(
        playlist
            .tracks
            .iter()
            .map(|song| song.id.as_str())
            .collect::<Vec<_>>(),
        [
            "qqmusic:track:FIRST",
            "qqmusic:track:SECOND",
            "qqmusic:track:FIRST"
        ]
    );
    assert_eq!(transport.requests.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn playlist_accepts_empty_playlist_but_not_missing_metadata() {
    let (client, _) = fixture(vec![page(&[], 0)]);
    assert!(client.playlist("7654321").await.unwrap().tracks.is_empty());
    let (client, _) = fixture(vec![json!({})]);
    assert!(matches!(
        client.playlist("7654321").await,
        Err(QQMusicError::Protocol)
    ));
}

#[tokio::test]
async fn playlist_rejects_invalid_ids_without_network() {
    let (client, transport) = fixture(vec![]);
    for id in ["", "invalid", "0", "-1", "9223372036854775808"] {
        assert!(matches!(
            client.playlist(id).await,
            Err(QQMusicError::InvalidRequest)
        ));
    }
    assert!(transport.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn playlist_rejects_foreign_identity_and_errors_on_every_page() {
    for field in ["code", "subcode", "total_song_num", "hasmore", "identity"] {
        for later_page in [false, true] {
            let mut invalid = page(&["SECOND"], 2);
            if field == "identity" {
                invalid["dirinfo"]["tid"] = json!(9999);
            } else {
                invalid[field] = json!(-1);
            }
            let mut pages = Vec::new();
            if later_page {
                pages.push(page(&["FIRST"], 2));
            }
            pages.push(invalid);
            let (client, _) = fixture(pages);
            let error = client.playlist("7654321").await.unwrap_err();
            assert!(
                match field {
                    "code" | "subcode" => matches!(error, QQMusicError::SchemaChanged),
                    _ => matches!(error, QQMusicError::Protocol),
                },
                "{field}, later={later_page}"
            );
        }
    }
}

#[tokio::test]
async fn playlist_never_returns_a_truncated_page_as_complete() {
    let (client, _) = fixture(vec![page(&["FIRST"], 2), page(&[], 2)]);
    assert!(matches!(
        client.playlist("7654321").await,
        Err(QQMusicError::SchemaChanged)
    ));
    let mut more = page(&["FIRST"], 0);
    more["hasmore"] = json!(1);
    let (client, transport) = fixture(vec![more; 100]);
    assert!(matches!(
        client.playlist("7654321").await,
        Err(QQMusicError::SchemaChanged)
    ));
    assert_eq!(transport.requests.lock().unwrap().len(), 100);
}

struct DiscoveryTransport {
    requests: Mutex<Vec<String>>,
    fail: bool,
}

#[async_trait]
impl qqmusic_api::ApiTransport for DiscoveryTransport {
    async fn execute(
        &self,
        request: qqmusic_api::TransportRequest,
    ) -> qqmusic_api::Result<qqmusic_api::TransportResponse> {
        assert_eq!(request.url, "https://u.y.qq.com/cgi-bin/musicu.fcg");
        assert!(request
            .headers
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case("cookie"))
            .all(|(_, v)| v.is_empty()));
        let qqmusic_api::HttpBody::Json(payload) = request.body else {
            panic!("typed discovery CGI required");
        };
        assert_eq!(payload["comm"], json!({"ct":24,"cv":0}));
        let method = payload["req_0"]["method"].as_str().unwrap();
        self.requests.lock().unwrap().push(method.to_owned());
        let card = json!({"id":"7654321","title":"Playlist <em>title</em>",
            "subtitle":"Description","type":500,"subtype":0,"cover":{"medium_url":"https://y.gtimg.cn/fixture.jpg"}});
        let shelf = json!({"id":1,"v_niche":[{"v_card":[
            {"id":"url?encArea=abc%2Fdef&x=1","title":"Category","cover":"https://example.invalid/untrusted.jpg"},
            card,{"id":"ARTIST","title":"Artist","type":600,"cover":"//y.gtimg.cn/artist.jpg"},
            {"id":"7654322","title":"Songlist","type":700}
        ]}]});
        let data = match method {
            "getCategoryAreaInCategoryPlaylist" | "GetFocus" => json!({"shelf":shelf}),
            "getRadioList" => json!({"radioList":[card]}),
            "GetNewMv" => json!({"list":[{"mvid":42,"title":"Video","duration":180,
                "singers":[{"name":"Artist"}],"cover":"https://example.invalid/untrusted.jpg"}]}),
            "getAreaHomePage" => json!({"title":"Area","v_shelf":[shelf]}),
            "GetDetail" => {
                json!({"data":{"title":"Chart","intro":"Summary","magicColor":{"r":1,"g":2,"b":3},
                "headPicUrl":"https://y.gtimg.cn/chart.jpg"},
                "songInfoList":[{"mid":"TRACK","title":"Track","file":{"size_128mp3":4096}}]})
            }
            "GetRecommendFeed" => {
                json!({"List":[{"Playlist":{"basic":{"tid":7654321,"dissname":"Playlist <em>title</em>",
                "desc":"Description","cover":{"medium_url":"https://y.gtimg.cn/fixture.jpg"},"creator_nick":"Creator"}}}]})
            }
            "get_new_song_info" => {
                json!({"songlist":[{"mid":"FIRST","title":"First"},{"mid":"SECOND","title":"Second"},
                {"mid":"FIRST","title":"First"}]})
            }
            other => panic!("unexpected library operation {other}"),
        };
        Ok(qqmusic_api::TransportResponse {
            status: 200,
            final_url: request.url,
            headers: vec![],
            body: serde_json::to_vec(
                &json!({"code":0,"req_0":{"code":if self.fail {104003} else {0},"data":data}}),
            )
            .unwrap(),
        })
    }
}

fn discovery_fixture(fail: bool) -> (QQMusicClient, Arc<DiscoveryTransport>) {
    let transport = Arc::new(DiscoveryTransport {
        requests: Mutex::new(vec![]),
        fail,
    });
    let http = blocked_legacy_http();
    (
        QQMusicClient {
            http: http.clone(),
            artwork_http: http,
            catalog: qqmusic_api::Client::new_with_transport(
                None,
                Some(qqmusic_api::Platform::Web),
                transport.clone(),
            ),
        },
        transport,
    )
}

#[tokio::test]
async fn discovery_typed_mapping_preserves_sections_and_host_artwork_policy() {
    let (client, transport) = discovery_fixture(false);
    let categories = client.categories().await.unwrap();
    assert_eq!(categories[0].enc_area, "abc%2Fdef");
    assert!(categories[0].cover.is_empty());
    let podcasts = client.podcasts().await.unwrap();
    assert_eq!(podcasts[0].title, "Playlist title");
    assert_eq!(podcasts[0].cover, "https://y.gtimg.cn/fixture.jpg");
    let mvs = client.new_mvs().await.unwrap();
    assert_eq!(mvs[0].duration_ms, 180_000);
    assert_eq!(mvs[0].artist, "Artist");
    assert!(mvs[0].cover.is_empty());
    assert_eq!(client.featured_cards().await.unwrap().len(), 4);
    let area = client.area_home("abc%2Fdef").await.unwrap();
    assert_eq!(area.title, "Area");
    assert_eq!(area.playlists.len(), 1);
    assert_eq!(area.songlists.len(), 1);
    assert_eq!(area.artists[0].cover, "https://y.gtimg.cn/artist.jpg");
    let chart = client.toplist(62, 18).await.unwrap();
    assert_eq!(chart.description, "Summary");
    assert_eq!(chart.artwork.dominant_color, "#010203");
    assert_eq!(chart.tracks[0].id, "qqmusic:track:TRACK");
    assert_eq!(transport.requests.lock().unwrap().len(), 6);
}

#[tokio::test]
async fn discovery_business_failures_do_not_become_empty_sections() {
    let (client, transport) = discovery_fixture(true);
    assert!(matches!(
        client.categories().await,
        Err(QQMusicError::SchemaChanged)
    ));
    assert!(matches!(
        client.podcasts().await,
        Err(QQMusicError::SchemaChanged)
    ));
    assert!(matches!(
        client.new_mvs().await,
        Err(QQMusicError::SchemaChanged)
    ));
    assert!(matches!(
        client.featured_cards().await,
        Err(QQMusicError::SchemaChanged)
    ));
    assert!(matches!(
        client.area_home("abc").await,
        Err(QQMusicError::SchemaChanged)
    ));
    assert!(matches!(
        client.toplist(62, 18).await,
        Err(QQMusicError::SchemaChanged)
    ));
    assert_eq!(transport.requests.lock().unwrap().len(), 6);
}

#[tokio::test]
async fn public_recommendation_typed_mapping_preserves_metadata_order_and_errors() {
    let (client, transport) = discovery_fixture(false);
    let playlists = client.general_songlists(6).await.unwrap();
    assert_eq!(playlists[0].id, "qqmusic:playlist:7654321");
    assert_eq!(playlists[0].title, "Playlist title");
    assert_eq!(playlists[0].owner.display_name, "Creator");
    assert_eq!(playlists[0].description, "Description");
    let songs = client.general_newsongs().await.unwrap();
    assert_eq!(
        songs.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
        [
            "qqmusic:track:FIRST",
            "qqmusic:track:SECOND",
            "qqmusic:track:FIRST"
        ]
    );
    assert_eq!(transport.requests.lock().unwrap().len(), 2);
    let (client, transport) = discovery_fixture(true);
    assert!(matches!(
        client.general_songlists(6).await,
        Err(QQMusicError::SchemaChanged)
    ));
    assert!(matches!(
        client.general_newsongs().await,
        Err(QQMusicError::SchemaChanged)
    ));
    assert_eq!(transport.requests.lock().unwrap().len(), 2);
}
