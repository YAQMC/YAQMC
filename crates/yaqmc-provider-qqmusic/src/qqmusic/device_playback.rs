//! Native platform profiles and one persistent installation/profile device identity.
//! Time values still use the library’s modeled millisecond report contract.
use super::*;
use qqmusic_api::{
    models::device_playback::ListeningMusicReportRequest, modules::song::SongQueryInfo,
};
use serde_json::{json, Value};
use yaqmc_provider_api::{PlaybackReport, RemotePlaybackSnapshot};

pub(crate) fn native_platform() -> qqmusic_api::Platform {
    if cfg!(target_os = "android") {
        qqmusic_api::Platform::Android
    } else {
        qqmusic_api::Platform::Desktop
    }
}

fn device_key(profile: &ProviderProfileKey, platform: qqmusic_api::Platform) -> String {
    format!(
        "qqmusic:playback-device:{}:{}",
        profile.profile_id,
        platform.as_str()
    )
}

pub(super) fn new_client(
    profile: &ProviderProfileKey,
    storage: &Arc<dyn ProviderStorage>,
    transport: Arc<dyn QqTransport>,
) -> Result<qqmusic_api::Client, QQMusicError> {
    client_for_platform(profile, storage, transport, native_platform())
}

fn client_for_platform(
    profile: &ProviderProfileKey,
    storage: &Arc<dyn ProviderStorage>,
    transport: Arc<dyn QqTransport>,
    platform: qqmusic_api::Platform,
) -> Result<qqmusic_api::Client, QQMusicError> {
    let client = qqmusic_api::Client::new_with_transport(
        None,
        Some(platform),
        Arc::new(DevicePlaybackTransport(
            transport::qmapi_bridge::HostTransport {
                inner: transport,
                operation: "device-playback",
                response_shape: "device-playback",
            },
        )),
    );
    let key = device_key(profile, platform);
    let device = storage
        .get_setting(&key)
        .map_err(|_| QQMusicError::Storage)?
        .and_then(|json| serde_json::from_str::<qqmusic_api::Device>(&json).ok());
    if let Some(device) = device {
        client.context().set_device(device);
    }
    let json =
        serde_json::to_string(&client.context().device()).map_err(|_| QQMusicError::Storage)?;
    storage
        .set_setting(&key, &json)
        .map_err(|_| QQMusicError::Storage)?;
    Ok(client)
}

// Keep the response limit, signing, and error handling owned by the SDK. The
// pinned SDK rejects the null queue returned for a successful empty snapshot.
struct DevicePlaybackTransport(transport::qmapi_bridge::HostTransport);

#[async_trait]
impl qqmusic_api::ApiTransport for DevicePlaybackTransport {
    async fn execute(
        &self,
        request: qqmusic_api::TransportRequest,
    ) -> qqmusic_api::Result<qqmusic_api::TransportResponse> {
        let snapshot_read = matches!(&request.body, qqmusic_api::HttpBody::Json(body)
            if body.as_object().is_some_and(|fields| fields.values().any(|entry|
                entry["module"] == "music.richFlag.listening"
                    && entry["method"] == "GetOtherPlatCurrentPlaylist")));
        let mut response = self.0.execute(request).await?;
        if snapshot_read && (200..300).contains(&response.status) {
            if let Ok(mut body) = serde_json::from_slice::<Value>(&response.body) {
                if body["code"] == 0 && body["req_0"]["code"] == 0 {
                    if let Some(playlist @ Value::Null) = body.pointer_mut("/req_0/data/playList") {
                        *playlist = json!([]);
                        response.body = serde_json::to_vec(&body)?;
                    }
                }
            }
        }
        Ok(response)
    }
}

impl QQMusicService {
    fn prepare_playback_session(&self, generation: u64) {
        let mut previous = self
            .device_playback_generation
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if previous.is_some_and(|value| value != generation) {
            let context = self.device_playback_client.context();
            // Retain installation identity/QIMEI, invalidate cached Android sessions.
            context.set_device(context.device());
        }
        *previous = Some(generation);
    }

    fn persist_playback_device(&self) -> Result<(), QQMusicError> {
        let json = serde_json::to_string(&self.device_playback_client.context().device())
            .map_err(|_| QQMusicError::Storage)?;
        self.storage
            .set_setting(
                &device_key(
                    &self.profile,
                    self.device_playback_client.context().platform,
                ),
                &json,
            )
            .map_err(|_| QQMusicError::Storage)
    }

    pub(crate) async fn remote_playback_snapshot(
        &self,
    ) -> Result<Option<RemotePlaybackSnapshot>, QQMusicError> {
        let context = self.auth.capture_account_context().await?;
        self.prepare_playback_session(context.epoch.generation);
        let credential = crate::qmapi::credential::credential_from_session(&context.session)?;
        let client = &self.device_playback_client;
        let read = client
            .device_playback
            .get_other_platform_current_playlist_with_cancellation(
                Some(&credential),
                context.cancellation.clone(),
            );
        let remote = tokio::select! {
            biased;
            _ = context.cancellation.cancelled() => return Err(QQMusicError::Cancelled),
            result = read => result.map_err(crate::qmapi::cgi::map_qmapi_error)?,
        };
        self.auth.ensure_current(&context.epoch).await?;
        self.persist_playback_device()?;
        if !remote.has_current_song() {
            return Ok(None);
        }
        let now_sec = self.clock.now_ms() / 1000;
        let updated = u64::try_from(remote.update_timestamp_sec)
            .map_err(|_| QQMusicError::MalformedResponse)?;
        let lifetime = if remote.keep_sec > 0 {
            (remote.keep_sec as u64).min(300)
        } else {
            300
        };
        if updated == 0
            || updated > now_sec.saturating_add(30)
            || now_sec.saturating_sub(updated) > lifetime
        {
            return Ok(None);
        }
        let mut ids: Vec<_> = remote
            .play_list
            .iter()
            .copied()
            .filter(|id| *id > 0)
            .take(100)
            .collect();
        if !ids.contains(&remote.listening_song_id) {
            ids.insert(0, remote.listening_song_id);
            ids.truncate(100);
        }
        let query: Vec<_> = ids.iter().copied().map(SongQueryInfo::by_id).collect();
        let metadata = tokio::select! {
            biased;
            _ = context.cancellation.cancelled() => return Err(QQMusicError::Cancelled),
            result = client.song.query_song(&query) => result.map_err(crate::qmapi::cgi::map_qmapi_error)?,
        };
        self.auth.ensure_current(&context.epoch).await?;
        // Only standard music IDs are represented by the player/report DTO.
        let by_id: HashMap<_, _> = metadata
            .tracks
            .into_iter()
            .filter(|raw| raw.r#type == 0)
            .filter_map(|raw| {
                let id = raw.id;
                normalize_qm_song(raw, 1).map(|song| (id, song))
            })
            .collect();
        let current = by_id
            .get(&remote.listening_song_id)
            .ok_or(QQMusicError::Unavailable)?;
        let tracks: Vec<_> = ids.iter().filter_map(|id| by_id.get(id).cloned()).collect();
        Ok(Some(RemotePlaybackSnapshot {
            current_song_id: current.id.clone(),
            queue_truncated: remote.play_list.len() > 100 || tracks.len() < ids.len(),
            tracks,
            updated_at_ms: updated.saturating_mul(1000),
            account_generation: context.epoch.generation,
        }))
    }

    pub(crate) async fn publish_remote_playback(
        &self,
        report: &PlaybackReport,
    ) -> Result<(), QQMusicError> {
        let context = self.auth.capture_account_context().await?;
        self.prepare_playback_session(context.epoch.generation);
        let song = report
            .tracks
            .iter()
            .find(|song| song.id == report.current_song_id)
            .ok_or(QQMusicError::InvalidRequest)?;
        if context.epoch.generation != report.account_generation
            || !song_matches_profile(song, &self.profile)
            || report
                .tracks
                .iter()
                .any(|track| !song_matches_profile(track, &self.profile))
        {
            return Err(QQMusicError::Cancelled);
        }
        let reference = song.provider.as_ref().ok_or(QQMusicError::InvalidRequest)?;
        let song_id = reference
            .numeric_id
            .and_then(|id| i64::try_from(id).ok())
            .filter(|id| *id > 0)
            .ok_or(QQMusicError::InvalidRequest)?;
        let play_list = report
            .tracks
            .iter()
            .filter_map(|track| {
                track
                    .provider
                    .as_ref()?
                    .numeric_id
                    .and_then(|id| i64::try_from(id).ok())
            })
            .take(100)
            .collect();
        let request = ListeningMusicReportRequest {
            song_mid: reference.track_id.clone(),
            song_type: 0,
            pause_flag: !report.is_playing,
            remaining_time_ms: song.duration_ms.saturating_sub(report.position_ms),
            song_play_time_ms: song.duration_ms,
            song_id,
            speed: 1.0,
            icon2: 0,
            play_list: Some(play_list),
        };
        let credential = crate::qmapi::credential::credential_from_session(&context.session)?;
        let client = &self.device_playback_client;
        self.auth.ensure_current(&context.epoch).await?;
        let write = client.device_playback.report_listening_music(
            &request,
            &credential,
            context.cancellation.clone(),
        );
        // Cancellation also covers Android's QIMEI/session bootstrap.
        let receipt = tokio::select! {
            biased;
            _ = context.cancellation.cancelled() => return Err(QQMusicError::OutcomeUnknown),
            result = write => result.map_err(|_| QQMusicError::OutcomeUnknown)?,
        };
        self.auth
            .ensure_current(&context.epoch)
            .await
            .map_err(|_| QQMusicError::OutcomeUnknown)?;
        if receipt.code != 0 || receipt.need_play_list != 0 {
            return Err(QQMusicError::OutcomeUnknown);
        }
        self.persist_playback_device()?;
        // The SDK's receipt decoder is permissive. This only means the report call
        // returned; it is not evidence of remote pause or an authoritative takeover.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::{
        auth::{AuthChallenge, AuthPollResult, QQMusicAuthProtocol, ValidatedAccount},
        clock::ManualClock,
        transport::{RetryClass, TransportRequest, TransportResponse},
    };
    use super::*;
    use serde_json::json;
    use std::sync::atomic::AtomicUsize;
    use yaqmc_core::{credentials::MemoryCredentialStore, storage::StorageService};
    use yaqmc_provider_api::MusicProvider;

    struct Auth;
    #[async_trait]
    impl QQMusicAuthProtocol for Auth {
        async fn create_challenge(
            &self,
            _: CancellationToken,
        ) -> Result<AuthChallenge, QQMusicError> {
            Err(QQMusicError::UnsupportedOperation)
        }
        async fn poll_challenge(
            &self,
            _: &AuthChallenge,
            _: CancellationToken,
        ) -> Result<AuthPollResult, QQMusicError> {
            Err(QQMusicError::UnsupportedOperation)
        }
        async fn exchange_oauth_code(
            &self,
            _: OAuthLoginProvider,
            _: &str,
            _: CancellationToken,
        ) -> Result<SessionRecord, QQMusicError> {
            Err(QQMusicError::UnsupportedOperation)
        }
        async fn validate_session(
            &self,
            _: &SessionRecord,
            _: CancellationToken,
        ) -> Result<ValidatedAccount, QQMusicError> {
            Ok(ValidatedAccount {
                profile: account::AccountProfile {
                    avatar_url: None,
                    nickname: "Fixture".into(),
                    masked_identity: "1***1".into(),
                },
                entitlement: AccountEntitlement {
                    tier: EntitlementTier::Free,
                    membership: MembershipState::Active,
                    expires_at_ms: None,
                    secondary_entitlements: vec![],
                    permitted_qualities: vec![AudioQuality::Standard],
                    observed_maximum_quality: None,
                    restrictions: vec![],
                },
                encrypted_uin: None,
            })
        }
    }

    struct Wire {
        requests: std::sync::Mutex<Vec<(Value, RetryClass)>>,
        fail_report: AtomicBool,
        report_calls: AtomicUsize,
        timestamp: std::sync::atomic::AtomicI64,
        snapshot_override: std::sync::Mutex<Option<Value>>,
        pending_read: AtomicBool,
        pending_session: AtomicBool,
        reject_login: AtomicBool,
    }
    #[async_trait]
    impl QqTransport for Wire {
        async fn execute(
            &self,
            request: TransportRequest,
        ) -> Result<TransportResponse, QQMusicError> {
            let body: Value =
                serde_json::from_slice(request.body.as_deref().unwrap_or_default()).unwrap();
            if request.url.host_str() == Some("api.tencentmusic.com") {
                self.requests
                    .lock()
                    .unwrap()
                    .push((json!({"req_0": {"method": "QIMEI"}}), request.retry));
                return Ok(TransportResponse { status: reqwest::StatusCode::OK, final_url: request.url,
                    headers: reqwest::header::HeaderMap::new(),
                    body: serde_json::to_vec(&json!({"data": json!({"data": {"q16": "fixture-q16", "q36": "fixture-q36"}}).to_string()})).unwrap() });
            }
            let query = body
                .as_object()
                .unwrap()
                .values()
                .find(|value| value.get("method").is_some())
                .expect("CGI query");
            self.requests
                .lock()
                .unwrap()
                .push((json!({"comm": body["comm"], "req_0": query}), request.retry));
            let method = query["method"].as_str().unwrap();
            let data = match method {
                "GetSession" => {
                    if self.pending_session.load(Ordering::SeqCst) {
                        std::future::pending::<()>().await;
                    }
                    json!({"session": {"uid": "fixture-uid", "sid": "fixture-sid"}})
                }
                "GetOtherPlatCurrentPlaylist" => {
                    if self.pending_read.load(Ordering::SeqCst) {
                        std::future::pending::<()>().await;
                    }
                    self.snapshot_override.lock().unwrap().clone().unwrap_or_else(|| {
                        json!({"listeningSongID": 2, "playList": [1,2,1], "updateTimestampSec": self.timestamp.load(Ordering::SeqCst), "keepSec": 60})
                    })
                }
                "CgiGetTrackInfo" => json!({"tracks": ([1,2].into_iter().map(|id| json!({
                    "id": id, "mid": format!("FIXTURE{id}"), "title": format!("Song {id}"), "type": 0, "interval": 180,
                    "album": {"mid": "FIXTUREALBUM", "name": "Album"}, "singer": [{"mid": "FIXTUREARTIST", "name": "Artist"}],
                    "file": {"size_128mp3": 1000}, "pay": {"pay_play": 0}
                })).collect::<Vec<_>>()) }),
                "ListeningMusicReport" => {
                    self.report_calls.fetch_add(1, Ordering::SeqCst);
                    if self.fail_report.load(Ordering::SeqCst) {
                        return Err(QQMusicError::Timeout);
                    }
                    if self.reject_login.load(Ordering::SeqCst) {
                        return Ok(TransportResponse { status: reqwest::StatusCode::OK, final_url: request.url,
                            headers: reqwest::header::HeaderMap::new(),
                            body: serde_json::to_vec(&json!({"code":0,"req_0":{"code":0,"data":{"code":405,"errmsg":"wx login","needPlayList":1}}})).unwrap() });
                    }
                    json!({"code": 0, "needPlayList": 0})
                }
                other => panic!("unexpected fixture method {other}"),
            };
            Ok(TransportResponse {
                status: reqwest::StatusCode::OK,
                final_url: request.url,
                headers: reqwest::header::HeaderMap::new(),
                body: serde_json::to_vec(&json!({"code": 0, "req_0": {"code": 0, "data": data}}))
                    .unwrap(),
            })
        }
    }

    async fn fixture() -> (Arc<QQMusicService>, Arc<Wire>) {
        fixture_for(native_platform()).await
    }

    async fn fixture_for(platform: qqmusic_api::Platform) -> (Arc<QQMusicService>, Arc<Wire>) {
        let storage = Arc::new(StorageService::temporary());
        let credentials = Arc::new(MemoryCredentialStore::default());
        let clock = Arc::new(ManualClock::new(1_800_000_000_000));
        let wire = Arc::new(Wire {
            requests: Default::default(),
            fail_report: AtomicBool::new(false),
            report_calls: AtomicUsize::new(0),
            timestamp: std::sync::atomic::AtomicI64::new(1_800_000_000),
            snapshot_override: Default::default(),
            pending_read: AtomicBool::new(false),
            pending_session: AtomicBool::new(false),
            reject_login: AtomicBool::new(false),
        });
        let mut service = QQMusicService::new_with_runtime_for_profile(
            storage.clone(),
            credentials.clone(),
            PathBuf::new(),
            wire.clone(),
            clock.clone(),
            ProviderProfileKey::new("qqmusic", "work").unwrap(),
        )
        .unwrap();
        service.device_playback_client =
            client_for_platform(&service.profile, &service.storage, wire.clone(), platform)
                .unwrap();
        // Only authentication is synthetic; device requests exercise the real SDK and host bridge.
        service.auth = Arc::new(QQMusicAuthService::new(
            Arc::new(Auth),
            SpawnBlockingCredentialStore::new(credentials),
            clock,
            storage,
        ));
        service
            .auth
            .complete_confirmation(SessionRecord {
                version: 1,
                uin: "1000000001".into(),
                encrypted_uin: None,
                cookie_header: "uin=1000000001; qm_keyst=SYNTHETIC_KEY".into(),
                expires_at_ms: 1_800_000_600_000,
                account_cache_scope: OpaqueAccountScope::parse("a".repeat(32)).unwrap(),
            })
            .await
            .unwrap();
        (Arc::new(service), wire)
    }

    fn report(
        remote: &RemotePlaybackSnapshot,
        position_ms: u64,
        is_playing: bool,
    ) -> PlaybackReport {
        PlaybackReport {
            current_song_id: remote.current_song_id.clone(),
            tracks: remote.tracks.clone(),
            account_generation: remote.account_generation,
            position_ms,
            is_playing,
        }
    }

    #[tokio::test]
    async fn accepts_null_snapshot_queue_but_rejects_other_malformed_types() {
        let (service, wire) = fixture_for(qqmusic_api::Platform::Desktop).await;
        *wire.snapshot_override.lock().unwrap() = Some(json!({"playList": null}));
        assert!(service.remote_playback().await.unwrap().is_none());
        *wire.snapshot_override.lock().unwrap() = Some(json!({"playList": "invalid"}));
        assert!(service.remote_playback().await.is_err());
        assert_eq!(wire.report_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn reads_profile_scoped_queue_then_reports_duration_remaining_and_write_class_once() {
        let (service, wire) = fixture().await;
        let remote = service.remote_playback().await.unwrap().unwrap();
        assert_eq!(remote.current_song_id, "qqmusic:track:FIXTURE2");
        assert_eq!(
            remote
                .tracks
                .iter()
                .map(|s| s.provider.as_ref().unwrap().numeric_id.unwrap())
                .collect::<Vec<_>>(),
            vec![1, 2, 1]
        );
        assert!(remote
            .tracks
            .iter()
            .all(|s| s.provider.as_ref().unwrap().profile_id == "work"));
        assert_eq!(wire.report_calls.load(Ordering::SeqCst), 0);
        service
            .report_remote_playback(&report(&remote, 10_000, true))
            .await
            .unwrap();
        let requests = wire.requests.lock().unwrap();
        let (request, retry) = requests.last().unwrap();
        assert_eq!(*retry, RetryClass::Write);
        assert_eq!(request["req_0"]["param"]["remainingTime"], 170_000);
        assert_eq!(request["req_0"]["param"]["songPlayTime"], 180_000);
        assert_eq!(request["req_0"]["param"]["playList"], json!([1, 2, 1]));
        assert_eq!(request["req_0"]["param"]["pauseFlag"], false);
        assert_eq!(request["comm"]["ct"], "19");
        assert!(!request["comm"]["guid"].as_str().unwrap().is_empty());
        assert_eq!(wire.report_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn stale_snapshots_are_ignored_and_ambiguous_writes_are_not_retried() {
        let (service, wire) = fixture().await;
        wire.timestamp.store(1_799_999_900, Ordering::SeqCst);
        assert!(service.remote_playback().await.unwrap().is_none());
        assert_eq!(
            wire.requests.lock().unwrap().len(),
            1,
            "stale reads never request metadata or report"
        );
        wire.timestamp.store(1_800_000_000, Ordering::SeqCst);
        let mut remote = service.remote_playback().await.unwrap().unwrap();
        remote.account_generation += 1;
        assert!(service
            .report_remote_playback(&report(&remote, 0, true))
            .await
            .is_err());
        assert_eq!(wire.report_calls.load(Ordering::SeqCst), 0);
        remote.account_generation -= 1;
        wire.fail_report.store(true, Ordering::SeqCst);
        assert_eq!(
            service
                .report_remote_playback(&report(&remote, 0, true))
                .await
                .unwrap_err()
                .code,
            "provider-failure"
        );
        assert_eq!(wire.report_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn restricted_wechat_receipt_is_uncertain_and_does_not_replay_the_report() {
        let (service, wire) = fixture().await;
        let remote = service.remote_playback().await.unwrap().unwrap();
        wire.reject_login.store(true, Ordering::SeqCst);
        let error = service
            .report_remote_playback(&report(&remote, 0, true))
            .await
            .unwrap_err();
        assert_eq!(error.code, "provider-failure");
        assert!(!error.retryable);
        assert_eq!(wire.report_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn device_identity_survives_recreation_and_is_profile_and_platform_scoped() {
        let (service, wire) = fixture().await;
        let scope = &service.profile;
        let storage = &service.storage;
        let first =
            client_for_platform(scope, storage, wire.clone(), qqmusic_api::Platform::Desktop)
                .unwrap();
        let again =
            client_for_platform(scope, storage, wire.clone(), qqmusic_api::Platform::Desktop)
                .unwrap();
        assert_eq!(
            first.context().device().open_udid,
            again.context().device().open_udid
        );
        let mobile =
            client_for_platform(scope, storage, wire.clone(), qqmusic_api::Platform::Android)
                .unwrap();
        assert_ne!(
            first.context().device().open_udid,
            mobile.context().device().open_udid
        );
        let other = client_for_platform(
            &ProviderProfileKey::new("qqmusic", "other").unwrap(),
            storage,
            wire,
            qqmusic_api::Platform::Desktop,
        )
        .unwrap();
        assert_ne!(
            first.context().device().open_udid,
            other.context().device().open_udid
        );
    }

    #[tokio::test]
    async fn android_reuses_native_sessions_and_reports_pause() {
        let (service, wire) = fixture_for(qqmusic_api::Platform::Android).await;
        let remote = service.remote_playback().await.unwrap().unwrap();
        service
            .report_remote_playback(&report(&remote, 20_000, false))
            .await
            .unwrap();
        service.remote_playback().await.unwrap();
        let requests = wire.requests.lock().unwrap();
        let count = |method| {
            requests
                .iter()
                .filter(|(r, _)| r["req_0"]["method"] == method)
                .count()
        };
        assert_eq!(count("QIMEI"), 1);
        assert_eq!(count("GetSession"), 2, "one authenticated session and one anonymous catalog session; repeated reads reuse both");
        let (read, _) = requests
            .iter()
            .find(|(r, _)| r["req_0"]["method"] == "GetOtherPlatCurrentPlaylist")
            .unwrap();
        assert_eq!(read["comm"]["ct"], "11");
        assert_eq!(read["comm"]["uid"], "fixture-uid");
        assert_eq!(read["comm"]["sid"], "fixture-sid");
        assert_eq!(read["comm"]["QIMEI36"], "fixture-q36");
        assert!(!read["comm"]["OpenUDID"].as_str().unwrap().is_empty());
        let (write, retry) = requests
            .iter()
            .find(|(r, _)| r["req_0"]["method"] == "ListeningMusicReport")
            .unwrap();
        assert_eq!(*retry, RetryClass::Write);
        assert_eq!(write["req_0"]["param"]["pauseFlag"], true);
        assert_eq!(write["req_0"]["param"]["remainingTime"], 160_000);
        assert_eq!(write["comm"]["OpenUDID"], read["comm"]["OpenUDID"]);
    }

    #[tokio::test]
    async fn android_account_invalidation_also_cancels_session_bootstrap() {
        let (service, wire) = fixture_for(qqmusic_api::Platform::Android).await;
        wire.pending_session.store(true, Ordering::SeqCst);
        let read = tokio::spawn({
            let service = service.clone();
            async move { service.remote_playback().await }
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while !wire
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|(r, _)| r["req_0"]["method"] == "GetSession")
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        service.sign_out().await.unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(2), read)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        assert_eq!(wire.report_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn account_invalidation_cancels_an_inflight_snapshot_read() {
        let (service, wire) = fixture().await;
        wire.pending_read.store(true, Ordering::SeqCst);
        let read = tokio::spawn({
            let service = service.clone();
            async move { service.remote_playback().await }
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while wire.requests.lock().unwrap().is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        service.sign_out().await.unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(2), read)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        assert_eq!(wire.report_calls.load(Ordering::SeqCst), 0);
    }
}
