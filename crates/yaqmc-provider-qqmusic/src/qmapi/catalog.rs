//! Row K (PROV-04): discover/home/category coverage vs `qqmusic-api`.
//!
//! Overlapping CGI is probed through injected transport. Wire `HomeFeed` /
//! `DiscoverFeed` / `AreaFeed` mapping stays in-tree (row N). Production
//! `build_home` / `build_discover` / `area_home` stay in-tree until LIVE
//! VERIFY. Endpoints with no typed library API stay Keep.

/// Favorite daily-30 disstid used by in-tree `personalized_daily_songs`.
pub(crate) const DAILY30_DISSID: i64 = 5_505_165_762;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CatalogCoverage {
    /// Same CGI family as in-tree. Document mapping stays in-tree.
    Hybrid,
    /// Library has a similar call; CGI module or params diverge. Keep in-tree.
    Divergent,
    /// No typed library API. Keep in-tree.
    Keep,
}

pub(crate) struct CatalogEndpoint {
    pub yaqmc: &'static str,
    pub module: &'static str,
    pub method: &'static str,
    pub coverage: CatalogCoverage,
}

pub(crate) const CATALOG_ENDPOINTS: &[CatalogEndpoint] = &[
    CatalogEndpoint {
        yaqmc: "home recommended songlists / new-song feed card",
        module: "music.recommend.RecommendFeed",
        method: "get_recommend_feed",
        coverage: CatalogCoverage::Hybrid,
    },
    CatalogEndpoint {
        yaqmc: "guess you like",
        module: "music.radioProxy.MbTrackRadioSvr",
        method: "get_radio_track",
        coverage: CatalogCoverage::Hybrid,
    },
    CatalogEndpoint {
        yaqmc: "radar (library omits EntranceSongs)",
        module: "music.recommend.TrackRelationServer",
        method: "GetRadarSong",
        coverage: CatalogCoverage::Hybrid,
    },
    CatalogEndpoint {
        yaqmc: "guest recommended songlists",
        module: "music.playlist.PlaylistSquare",
        method: "GetRecommendFeed",
        coverage: CatalogCoverage::Hybrid,
    },
    CatalogEndpoint {
        yaqmc: "guest new songs",
        module: "newsong.NewSongServer",
        method: "get_new_song_info",
        coverage: CatalogCoverage::Hybrid,
    },
    CatalogEndpoint {
        yaqmc: "daily 30 / new-song diss",
        module: "music.srfDissInfo.DissInfo",
        method: "CgiGetDiss",
        coverage: CatalogCoverage::Hybrid,
    },
    CatalogEndpoint {
        yaqmc: "home/discover toplist",
        module: "musicToplist.ToplistInfoServer",
        method: "GetDetail",
        coverage: CatalogCoverage::Divergent,
    },
    CatalogEndpoint {
        yaqmc: "discover new MVs",
        module: "MvService.MvInfoProServer",
        method: "GetNewMv",
        coverage: CatalogCoverage::Divergent,
    },
    CatalogEndpoint {
        yaqmc: "discover categories (encArea)",
        module: "music.area.CategoryArea",
        method: "getCategoryAreaInCategoryPlaylist",
        coverage: CatalogCoverage::Keep,
    },
    CatalogEndpoint {
        yaqmc: "area home",
        module: "music.area.AreaHome",
        method: "getAreaHomePage",
        coverage: CatalogCoverage::Keep,
    },
    CatalogEndpoint {
        yaqmc: "discover podcasts",
        module: "music.longRadio.recommend",
        method: "getRadioList",
        coverage: CatalogCoverage::Keep,
    },
    CatalogEndpoint {
        yaqmc: "discover featured cards",
        module: "music.musicHall.MusicHallPlatformSvr",
        method: "GetFocus",
        coverage: CatalogCoverage::Keep,
    },
];

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use qqmusic_api::{
        ApiTransport, Client, HttpBody, Platform, TransportRequest, TransportResponse,
    };
    use serde_json::Value;

    use super::*;

    const CGI_OK: &[u8] = br#"{"code":0,"req_0":{"code":0,"data":{}}}"#;

    struct RecordingTransport {
        captured: Mutex<Vec<HttpBody>>,
    }

    impl RecordingTransport {
        fn new() -> Self {
            Self {
                captured: Mutex::new(Vec::new()),
            }
        }

        fn last_req0(&self) -> Value {
            let captured = self
                .captured
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let HttpBody::Json(payload) = captured.last().expect("CGI captured") else {
                panic!("CGI body must be JSON");
            };
            payload.get("req_0").cloned().expect("req_0")
        }
    }

    #[async_trait::async_trait]
    impl ApiTransport for RecordingTransport {
        async fn execute(
            &self,
            request: TransportRequest,
        ) -> qqmusic_api::Result<TransportResponse> {
            self.captured
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(request.body);
            Ok(TransportResponse {
                status: 200,
                final_url: request.url,
                headers: Vec::new(),
                body: CGI_OK.to_vec(),
            })
        }
    }

    fn probe_client(transport: std::sync::Arc<RecordingTransport>) -> Client {
        Client::new_with_transport(None, Some(Platform::Web), transport)
    }

    fn coverage_of(module: &str, method: &str) -> CatalogCoverage {
        CATALOG_ENDPOINTS
            .iter()
            .find(|endpoint| endpoint.module == module && endpoint.method == method)
            .map(|endpoint| endpoint.coverage)
            .expect("endpoint is in the audit table")
    }

    #[test]
    fn catalog_audit_lists_every_home_discover_area_cgi() {
        let hybrids = CATALOG_ENDPOINTS
            .iter()
            .filter(|endpoint| endpoint.coverage == CatalogCoverage::Hybrid)
            .count();
        let keep = CATALOG_ENDPOINTS
            .iter()
            .filter(|endpoint| endpoint.coverage == CatalogCoverage::Keep)
            .count();
        let divergent = CATALOG_ENDPOINTS
            .iter()
            .filter(|endpoint| endpoint.coverage == CatalogCoverage::Divergent)
            .count();
        assert_eq!(hybrids, 6);
        assert_eq!(divergent, 2);
        assert_eq!(keep, 4);
        assert!(CATALOG_ENDPOINTS
            .iter()
            .any(|endpoint| endpoint.yaqmc.contains("encArea")));
        assert_eq!(
            coverage_of("music.area.AreaHome", "getAreaHomePage"),
            CatalogCoverage::Keep
        );
        assert_eq!(
            coverage_of("musicToplist.ToplistInfoServer", "GetDetail"),
            CatalogCoverage::Divergent
        );
    }

    #[tokio::test]
    async fn home_feed_uses_recommend_feed_cgi() {
        let transport = std::sync::Arc::new(RecordingTransport::new());
        let client = probe_client(transport.clone());
        client
            .recommend
            .get_home_feed(1, 0, 0, &[])
            .await
            .expect("feed");
        let req = transport.last_req0();
        assert_eq!(req["module"], "music.recommend.RecommendFeed");
        assert_eq!(req["method"], "get_recommend_feed");
        assert_eq!(req["param"]["page"], 1);
        assert_eq!(req["param"]["direction"], 0);
    }

    #[tokio::test]
    async fn guess_uses_radio_track_cgi() {
        let transport = std::sync::Arc::new(RecordingTransport::new());
        let client = probe_client(transport.clone());
        client
            .recommend
            .get_guess_recommend(None)
            .await
            .expect("guess");
        let req = transport.last_req0();
        assert_eq!(req["module"], "music.radioProxy.MbTrackRadioSvr");
        assert_eq!(req["method"], "get_radio_track");
        assert_eq!(req["param"]["id"], 99);
        assert_eq!(req["param"]["num"], 5);
    }

    #[tokio::test]
    async fn radar_cgi_matches_intree_module() {
        let transport = std::sync::Arc::new(RecordingTransport::new());
        let client = probe_client(transport.clone());
        client
            .recommend
            .get_radar_recommend(1)
            .await
            .expect("radar");
        let req = transport.last_req0();
        assert_eq!(req["module"], "music.recommend.TrackRelationServer");
        assert_eq!(req["method"], "GetRadarSong");
        assert_eq!(req["param"]["Page"], 1);
        assert_eq!(req["param"]["EntranceSongs"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn guest_songlists_use_playlist_square() {
        let transport = std::sync::Arc::new(RecordingTransport::new());
        let client = probe_client(transport.clone());
        client
            .recommend
            .get_recommend_songlist(1, 12)
            .await
            .expect("songlists");
        let req = transport.last_req0();
        assert_eq!(req["module"], "music.playlist.PlaylistSquare");
        assert_eq!(req["method"], "GetRecommendFeed");
        assert_eq!(req["param"]["From"], 0);
        assert_eq!(req["param"]["Size"], 12);
    }

    #[tokio::test]
    async fn guest_newsongs_use_new_song_server_type_five() {
        let transport = std::sync::Arc::new(RecordingTransport::new());
        let client = probe_client(transport.clone());
        client
            .recommend
            .get_recommend_newsong(5)
            .await
            .expect("newsongs");
        let req = transport.last_req0();
        assert_eq!(req["module"], "newsong.NewSongServer");
        assert_eq!(req["method"], "get_new_song_info");
        assert_eq!(req["param"]["type"], 5);
    }

    #[tokio::test]
    async fn daily_thirty_uses_cgi_get_diss() {
        let transport = std::sync::Arc::new(RecordingTransport::new());
        let client = probe_client(transport.clone());
        client
            .songlist
            .get_detail(DAILY30_DISSID, 0, 30, 1, true, true, true)
            .await
            .expect("diss");
        let req = transport.last_req0();
        assert_eq!(req["module"], "music.srfDissInfo.DissInfo");
        assert_eq!(req["method"], "CgiGetDiss");
        assert_eq!(req["param"]["disstid"], DAILY30_DISSID);
        assert_eq!(req["param"]["song_num"], 30);
        assert_eq!(req["param"]["song_begin"], 0);
    }

    #[tokio::test]
    async fn library_toplist_cgi_diverges_from_intree() {
        let transport = std::sync::Arc::new(RecordingTransport::new());
        let client = probe_client(transport.clone());
        client.top.get_detail(62, 10, 1, false).await.expect("top");
        let req = transport.last_req0();
        assert_eq!(req["module"], "music.musicToplist.Toplist");
        assert_eq!(req["method"], "GetDetail");
        assert_ne!(req["module"], "musicToplist.ToplistInfoServer");
    }

    #[tokio::test]
    async fn library_mv_list_cgi_diverges_from_intree_get_new_mv() {
        let transport = std::sync::Arc::new(RecordingTransport::new());
        let client = probe_client(transport.clone());
        client.mv.get_mv_list(0, 0, 0, 8, 1).await.expect("mv list");
        let req = transport.last_req0();
        assert_eq!(req["module"], "MvService.MvInfoProServer");
        assert_eq!(req["method"], "GetAllocMvInfo");
        assert_ne!(req["method"], "GetNewMv");
    }
}
