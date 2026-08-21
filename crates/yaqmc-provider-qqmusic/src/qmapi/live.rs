//! Maintainer LIVE VERIFY against a real `qqmusic-session`.
//!
//! Ignored by default. CI must not pass `-- --ignored`. Encrypted evkey, QR,
//! OAuth, mutations, `choose_source`, and home/discover mapping stay in-tree.
//! Non-test `qmapi` builds use library lyric HTTP, clear vkey HTTP, and VIP
//! fetch. Encrypted evkey, QR, OAuth, mutations, `choose_source`, and
//! home/discover mapping stay in-tree.
//! This module never prints cookies, musickey, UIN, vkey, ekey, or sign.

use std::sync::Mutex;

use qqmusic_api::{
    ApiTransport, CgiOptions, Client, HttpBody, Platform, QmError, TransportRequest,
    TransportResponse,
};
use serde_json::json;
use yaqmc_core::credentials::{CredentialStore, PlatformCredentialStore};
use yaqmc_provider_api::{LyricDocument, PlaybackLocation};

use crate::qmapi::credential::credential_from_session;
use crate::qmapi::entitlement::account_entitlement_from_qmapi;
use crate::qmapi::lyric::lyric_document_from_qmapi;
use crate::qmapi::transport::YaqmcReqwestTransport;
use crate::qmapi::vkey::playback_location_from_qmapi;
use crate::qqmusic::account::{EntitlementTier, MembershipState};
use crate::qqmusic::{SessionRecord, ACTIVE_SESSION};

pub(crate) const LIVE_ENV: &str = "YAQMC_QMAP_LIVE";
pub(crate) const ATTACH_ENV: &str = "YAQMC_ALLOW_PRODUCTION_ATTACH";

/// Public catalog mid used by the qm-api-rs lyric vector corpus. Not a user library id.
const PUBLIC_LYRIC_MID: &str = "001X3HEN1oK0Jr";

/// LIVE VERIFY 2026-08-21: library `get_lyric` returned this without Referer.
const LYRIC_PARAM_REJECTED: i64 = 24_001;

#[derive(Clone, Debug)]
struct CapturedRequest {
    url: String,
    query: Vec<(String, String)>,
    cgi_method: Option<String>,
}

struct ForwardingCapture {
    inner: YaqmcReqwestTransport,
    captured: Mutex<Vec<CapturedRequest>>,
}

impl ForwardingCapture {
    fn captured(&self) -> Vec<CapturedRequest> {
        self.captured
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

#[async_trait::async_trait]
impl ApiTransport for ForwardingCapture {
    async fn execute(&self, request: TransportRequest) -> qqmusic_api::Result<TransportResponse> {
        self.captured
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(CapturedRequest {
                url: request.url.clone(),
                query: request.query.clone(),
                cgi_method: cgi_method(&request.body),
            });
        self.inner.execute(request).await
    }

    fn allow_origin(&self, origin: &str) {
        self.inner.allow_origin(origin);
    }
}

fn env_yes(name: &str) -> bool {
    matches!(std::env::var(name).as_deref(), Ok("1"))
}

fn require_live_opt_in() {
    assert!(
        std::env::var_os("YAQMC_CREDENTIAL_DIR").is_none(),
        "unset YAQMC_CREDENTIAL_DIR; LIVE VERIFY reads the OS keyring"
    );
    assert!(
        env_yes(LIVE_ENV) && env_yes(ATTACH_ENV),
        "LIVE VERIFY requires {LIVE_ENV}=1 {ATTACH_ENV}=1"
    );
}

fn load_active_session() -> SessionRecord {
    let store = PlatformCredentialStore::new();
    let raw = store
        .load(ACTIVE_SESSION)
        .expect("OS keyring must be available in the desktop session")
        .expect("no qqmusic-session; log in with npm run dev:desktop first");
    serde_json::from_str(&raw).unwrap_or_else(|_| {
        panic!("qqmusic-session did not match SessionRecord (body not printed)")
    })
}

fn query_value<'a>(query: &'a [(String, String)], name: &str) -> Option<&'a str> {
    query
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

fn cgi_method(body: &HttpBody) -> Option<String> {
    let HttpBody::Json(payload) = body else {
        return None;
    };
    payload
        .get("req_0")
        .and_then(|request| request.get("method"))
        .and_then(|value| value.as_str())
        .map(ToOwned::to_owned)
}

fn signed_dislike_zzc(captured: &[CapturedRequest]) -> bool {
    captured.iter().any(|request| {
        let sign = query_value(&request.query, "sign").unwrap_or("");
        request.cgi_method.as_deref() == Some("GetDislikeList")
            && request.url.contains("/musics.fcg")
            && sign.starts_with("zzc")
            && (40..=48).contains(&sign.len())
    })
}

fn location_host(location: &PlaybackLocation) -> String {
    let url = match location {
        PlaybackLocation::Http { url, .. } | PlaybackLocation::EncryptedHttp { url, .. } => url,
        _ => return "unsupported".to_owned(),
    };
    reqwest::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(ToOwned::to_owned))
        .unwrap_or_else(|| "invalid".to_owned())
}

fn qmapi_fail(error: &QmError) -> String {
    match error {
        QmError::CredentialExpired(_) => "credential-expired".to_owned(),
        QmError::CredentialInvalid(_) => "credential-invalid".to_owned(),
        QmError::CgiApi { code, .. } | QmError::GlobalApi { code, .. } => {
            format!("{:?} {code}", error.category())
        }
        QmError::Login { code, .. } => format!("login {code}"),
        QmError::Http { status, .. } => format!("http {status}"),
        _ => format!("{:?}", error.category()),
    }
}

fn cgi_code(error: &QmError) -> Option<i64> {
    match error {
        QmError::CgiApi { code, .. } | QmError::GlobalApi { code, .. } => Some(*code),
        _ => None,
    }
}

fn map_lyric(
    mid: &str,
    response: &qqmusic_api::models::lyric::GetLyricResponse,
) -> Result<LyricDocument, &'static str> {
    match lyric_document_from_qmapi(mid, response) {
        Some(document) if !document.lines.is_empty() => Ok(document),
        Some(_) => Err("mapped LyricDocument had no lines"),
        None => Err("in-tree lyric mapper returned none"),
    }
}

fn line_timings(document: &LyricDocument) -> Vec<(Option<u64>, Option<u64>)> {
    document
        .lines
        .iter()
        .map(|line| (line.start_ms, line.end_ms))
        .collect()
}

fn compare_lyric_timings(intree: &LyricDocument, qmapi: &LyricDocument) -> Result<(), String> {
    if intree.lines.len() != qmapi.lines.len() {
        return Err(format!(
            "L: line count {} vs {}",
            intree.lines.len(),
            qmapi.lines.len()
        ));
    }
    if line_timings(intree) != line_timings(qmapi) {
        return Err("L: line timings diverged (text not printed)".to_owned());
    }
    Ok(())
}

fn live_client(
    credential: qqmusic_api::Credential,
    platform: Platform,
    transport: std::sync::Arc<ForwardingCapture>,
) -> Client {
    Client::new_with_transport(Some(credential), Some(platform), transport)
}

async fn intree_shaped_play_lyric(mid: &str) -> Result<(i64, serde_json::Value), String> {
    let payload = json!({
        "comm": { "ct": 24, "cv": 0 },
        "req_1": {
            "module": "music.musichallSong.PlayLyricInfo",
            "method": "GetPlayLyricInfo",
            "param": { "songMID": mid, "qrc": 1, "qrc_t": 0, "roma": 1, "trans": 1 }
        }
    });
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .build()
        .map_err(|_| "http client".to_owned())?;
    let response = client
        .post("https://u.y.qq.com/cgi-bin/musicu.fcg")
        .header("Referer", "https://y.qq.com/")
        .header("Origin", "https://y.qq.com")
        .json(&payload)
        .send()
        .await
        .map_err(|_| "transport".to_owned())?;
    let envelope: serde_json::Value = response.json().await.map_err(|_| "json".to_owned())?;
    let code = envelope
        .get("req_1")
        .and_then(|request| request.get("code"))
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(-1);
    let data = envelope
        .get("req_1")
        .and_then(|request| request.get("data"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    Ok((code, data))
}

#[test]
fn live_verify_opt_in_env_names_are_stable() {
    assert_eq!(LIVE_ENV, "YAQMC_QMAP_LIVE");
    assert_eq!(ATTACH_ENV, "YAQMC_ALLOW_PRODUCTION_ATTACH");
    assert_eq!(LYRIC_PARAM_REJECTED, 24_001);
}

#[test]
fn lyric_timing_compare_requires_matching_line_clocks() {
    let left = lyric_document_from_qmapi(
        "TRACK",
        &qqmusic_api::models::lyric::GetLyricResponse {
            lyric: "[00:00.00]One\n[00:02.00]Two".to_owned(),
            ..qqmusic_api::models::lyric::GetLyricResponse::default()
        },
    )
    .expect("left");
    let right = lyric_document_from_qmapi(
        "TRACK",
        &qqmusic_api::models::lyric::GetLyricResponse {
            lyric: "[00:00.00]One\n[00:03.00]Two".to_owned(),
            ..qqmusic_api::models::lyric::GetLyricResponse::default()
        },
    )
    .expect("right");
    assert!(compare_lyric_timings(&left, &left).is_ok());
    assert!(compare_lyric_timings(&left, &right).is_err());
}

#[test]
fn signed_dislike_requires_method_and_zzc() {
    let request = CapturedRequest {
        url: "https://u.y.qq.com/cgi-bin/musics.fcg".to_owned(),
        query: vec![(
            "sign".into(),
            "zzc0123456789abcdef0123456789abcdef01234567".into(),
        )],
        cgi_method: Some("GetDislikeList".into()),
    };
    assert!(signed_dislike_zzc(std::slice::from_ref(&request)));
    let mut other = request;
    other.cgi_method = Some("GetPlayLyricInfo".into());
    assert!(!signed_dislike_zzc(&[other]));
}

#[tokio::test]
#[ignore = "LIVE VERIFY: YAQMC_QMAP_LIVE=1 YAQMC_ALLOW_PRODUCTION_ATTACH=1"]
async fn qmapi_live_verify_session_lyrics_sign_vkey_vip_and_feed() {
    require_live_opt_in();
    let session = load_active_session();
    let credential = credential_from_session(&session)
        .expect("session needs qm_keyst or qqmusic_key; re-login if expired");
    eprintln!("LIVE VERIFY C/D: session converted");

    let transport = std::sync::Arc::new(ForwardingCapture {
        inner: YaqmcReqwestTransport::new(qqmusic_api::TransportConfig::default())
            .expect("YaqmcReqwestTransport"),
        captured: Mutex::new(Vec::new()),
    });
    let web = live_client(credential.clone(), Platform::Web, transport.clone());
    // Android comm still puts `authst` in the CGI body. Pin `dcddabc` also
    // writes Credential Cookie on CGI, so Web/Desktop can authenticate without
    // a cookie jar. A/B keeps Android `GetDislikeList` as the signed-read probe.
    let android = live_client(credential.clone(), Platform::Android, transport.clone());
    let mut failures = Vec::new();

    let searched = web.search.search_songs("晴天", 1, 1).await;
    let (lyric_mid, lyric_song_id, playback_song) = match &searched {
        Ok(songs) if !songs.is_empty() => {
            let song = &songs[0];
            let mid = if song.mid.is_empty() {
                PUBLIC_LYRIC_MID.to_owned()
            } else {
                song.mid.clone()
            };
            (mid, song.id, Some(song.clone()))
        }
        _ => (PUBLIC_LYRIC_MID.to_owned(), 0, None),
    };

    let mut intree_lyric = None;
    match intree_shaped_play_lyric(&lyric_mid).await {
        Ok((0, data)) => match qqmusic_api::models::lyric::GetLyricResponse::parse(data) {
            Ok(response) => match map_lyric(&lyric_mid, &response) {
                Ok(document) => {
                    eprintln!(
                        "LIVE VERIFY L: lines={} via in-tree HTTP",
                        document.lines.len()
                    );
                    intree_lyric = Some(document);
                }
                Err(error) => failures.push(format!("L: in-tree HTTP {error}")),
            },
            Err(_) => failures.push("L: in-tree HTTP did not parse (body not printed)".to_owned()),
        },
        Ok((code, _)) => failures.push(format!("L: in-tree HTTP cgi {code}")),
        Err(error) => failures.push(format!("L: in-tree HTTP {error}")),
    }

    let mut qmapi_lyric = None;
    match web
        .lyric
        .get_lyric(&lyric_mid, 0, true, true, true, false)
        .await
    {
        Ok(response) => match map_lyric(&lyric_mid, &response) {
            Ok(document) => {
                eprintln!(
                    "LIVE VERIFY L: lines={} via get_lyric mid",
                    document.lines.len()
                );
                qmapi_lyric = Some(document);
            }
            Err(error) => failures.push(format!("L: get_lyric {error}")),
        },
        Err(error) => {
            let mid_fail = qmapi_fail(&error);
            if lyric_song_id > 0 {
                match web
                    .lyric
                    .get_lyric(&lyric_song_id.to_string(), 0, true, true, true, false)
                    .await
                {
                    Ok(response) => match map_lyric(&lyric_mid, &response) {
                        Ok(document) => {
                            eprintln!(
                                "LIVE VERIFY L: get_lyric(mid) {mid_fail}; get_lyric(songId) succeeded (API should send songID)"
                            );
                            qmapi_lyric = Some(document);
                        }
                        Err(mapped) => failures.push(format!("L: get_lyric songId {mapped}")),
                    },
                    Err(id_error) => {
                        let combined = CgiOptions {
                            platform: Some(Platform::Web),
                            preserve_bool: true,
                            comm: Some(json!({ "ct": 24, "cv": 0 })),
                            override_comm: true,
                            ..CgiOptions::default()
                        };
                        match web
                            .request_cgi(
                                "music.musichallSong.PlayLyricInfo",
                                "GetPlayLyricInfo",
                                json!({
                                    "songID": lyric_song_id,
                                    "songMid": lyric_mid,
                                    "crypt": 1,
                                    "qrc": 1,
                                    "qrc_t": 0,
                                    "roma": 1,
                                    "trans": 1
                                }),
                                &combined,
                            )
                            .await
                        {
                            Ok(reply) if reply.code == 0 => {
                                match qqmusic_api::models::lyric::GetLyricResponse::parse(
                                    reply.data,
                                ) {
                                    Ok(response) => match map_lyric(&lyric_mid, &response) {
                                        Ok(document) => {
                                            eprintln!(
                                                "LIVE VERIFY L: get_lyric mid/id failed; combined songID+songMid ok (API)"
                                            );
                                            qmapi_lyric = Some(document);
                                        }
                                        Err(mapped) => {
                                            failures.push(format!("L: combined {mapped}"))
                                        }
                                    },
                                    Err(_) => failures.push(
                                        "L: combined lyric reply did not parse (body not printed)"
                                            .to_owned(),
                                    ),
                                }
                            }
                            Ok(reply) => failures.push(format!(
                                "L: get_lyric {mid_fail}; songId {}; combined cgi {} (API)",
                                qmapi_fail(&id_error),
                                reply.code
                            )),
                            Err(combined_error) => failures.push(format!(
                                "L: get_lyric {mid_fail}; songId {}; combined {} (API)",
                                qmapi_fail(&id_error),
                                qmapi_fail(&combined_error)
                            )),
                        }
                    }
                }
            } else {
                failures.push(format!("L: get_lyric {mid_fail} (API)"));
            }
        }
    }

    match (&intree_lyric, &qmapi_lyric) {
        (Some(intree), Some(qmapi)) => {
            if let Err(error) = compare_lyric_timings(intree, qmapi) {
                failures.push(error);
            } else {
                eprintln!(
                    "LIVE VERIFY L: compared lines={} first_ms={:?} last_ms={:?}",
                    intree.lines.len(),
                    intree.lines.first().and_then(|line| line.start_ms),
                    intree.lines.last().and_then(|line| line.start_ms)
                );
            }
        }
        (None, Some(_)) => failures.push("L: get_lyric ok but in-tree HTTP failed".to_owned()),
        (Some(_), None) => {}
        (None, None) => {}
    }

    let before_sign = transport.captured().len();
    match android
        .user
        .get_dislike_list(3, 1, 0, Some(&credential))
        .await
    {
        Ok(_) => {
            if signed_dislike_zzc(&transport.captured()[before_sign..]) {
                eprintln!("LIVE VERIFY A/B: zzc accepted on GetDislikeList");
            } else {
                failures.push(
                    "A/B: GetDislikeList succeeded but request was not musics.fcg + zzc".to_owned(),
                );
            }
        }
        Err(error) => {
            let signed = signed_dislike_zzc(&transport.captured()[before_sign..]);
            failures.push(format!(
                "A/B: GetDislikeList {} signed_zzc={signed} (not VIP; check CGI Cookie/authst)",
                qmapi_fail(&error)
            ));
        }
    }

    let mut i_unplayable = false;
    match playback_song {
        Some(song) => match android
            .song
            .best_playable(&song, Some(&credential), false)
            .await
        {
            Ok(source) => {
                match playback_location_from_qmapi(
                    source.result,
                    &source.url,
                    &source.ekey,
                    source.encrypted,
                ) {
                    Ok(location) => {
                        eprintln!(
                            "LIVE VERIFY I: playable=true host={} encrypted={}",
                            location_host(&location),
                            source.encrypted
                        );
                    }
                    Err(crate::qqmusic::QQMusicError::EntitlementUnavailable) => {
                        i_unplayable = true;
                        eprintln!(
                            "LIVE VERIFY I: playable=false entitlement=unavailable (ok for Free)"
                        );
                    }
                    Err(error) => failures.push(format!("I: sanitizer {error}")),
                }
            }
            Err(error) if cgi_code(&error) == Some(104_003) => {
                i_unplayable = true;
                eprintln!(
                    "LIVE VERIFY I: playable=false entitlement=unavailable (104003; ok for Free)"
                );
            }
            Err(error) => failures.push(format!("I: {}", qmapi_fail(&error))),
        },
        None => match &searched {
            Err(error) => failures.push(format!("I: search {}", qmapi_fail(error))),
            Ok(_) => failures.push("I: search returned no tracks".to_owned()),
        },
    }

    match android.user.get_vip_info(Some(&credential)).await {
        Ok(vip) => {
            let entitlement = account_entitlement_from_qmapi(&vip);
            eprintln!(
                "LIVE VERIFY H: tier={:?} membership={:?}",
                entitlement.tier, entitlement.membership
            );
            if i_unplayable
                && entitlement.tier == EntitlementTier::SuperVip
                && entitlement.membership == MembershipState::Active
            {
                failures.push("I: 104003 despite SuperVip Active".to_owned());
            }
        }
        Err(error) => failures.push(format!("H: {}", qmapi_fail(&error))),
    }

    match web.recommend.get_home_feed(1, 0, 0, &[]).await {
        Ok(_) => eprintln!("LIVE VERIFY K: home_feed ok"),
        Err(error) => failures.push(format!("K: {}", qmapi_fail(&error))),
    }

    assert!(
        failures.is_empty(),
        "LIVE VERIFY failed: {}",
        failures.join("; ")
    );
}
