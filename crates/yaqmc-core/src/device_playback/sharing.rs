//! Opt-in listening reports from the authoritative local player, scoped to one account/profile.
use crate::{
    bootstrap::CoreServices,
    player::{PlaybackState, PlayerSnapshot},
    storage::StorageService,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use yaqmc_provider_api::{
    PlaybackReport, ProviderCommandError, ProviderProfileKey, ProviderResult,
};

const HEARTBEAT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DevicePlaybackSharingStatus {
    enabled: bool,
    platform: &'static str,
    report_status: &'static str,
    last_error_code: Option<String>,
    last_reported_at_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ReportKey {
    generation: u64,
    session: u64,
    playing: bool,
    seek: u64,
    queue: Vec<String>,
}

struct SharingState {
    status: DevicePlaybackSharingStatus,
    generation: u64,
    last: Option<ReportKey>,
    next: Instant,
    cancellation: CancellationToken,
}

impl SharingState {
    fn claim(&mut self, key: ReportKey, preview: bool, now: Instant) -> Option<CancellationToken> {
        if self.last.as_ref() == Some(&key) && (!key.playing || now < self.next) {
            return None;
        }
        self.last = Some(key);
        self.next = now + HEARTBEAT;
        if preview {
            self.status.report_status = "not-sent";
            self.status.last_error_code = Some("preview-only".into());
            return None;
        }
        Some(self.cancellation.clone())
    }
}

#[derive(Default)]
pub(super) struct SharingService {
    states: Mutex<HashMap<String, SharingState>>,
}

fn setting(scope: &ProviderProfileKey) -> String {
    format!("qqmusic:device-playback-sharing:{}", scope.profile_id)
}
fn failure(code: &str) -> ProviderCommandError {
    ProviderCommandError {
        code: code.into(),
        message: "playback sharing is unavailable".into(),
        retryable: false,
    }
}

impl SharingService {
    pub(super) fn configure(
        &self,
        storage: &StorageService,
        scope: ProviderProfileKey,
        generation: u64,
        enabled: Option<bool>,
    ) -> ProviderResult<DevicePlaybackSharingStatus> {
        if scope.provider_id != "qqmusic" {
            return Err(failure("unsupported-operation"));
        }
        let key = setting(&scope);
        let mut states = self.states.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(enabled) = enabled {
            storage
                .set_setting(&key, if enabled { "true" } else { "false" })
                .map_err(|_| failure("storage-failure"))?;
        }
        let persisted = storage
            .get_setting(&key)
            .map_err(|_| failure("storage-failure"))?
            .as_deref()
            == Some("true");
        let state = states.entry(key).or_insert_with(|| SharingState {
            status: DevicePlaybackSharingStatus {
                enabled: persisted,
                platform: if cfg!(target_os = "android") {
                    "android"
                } else {
                    "desktop"
                },
                report_status: "not-sent",
                last_error_code: None,
                last_reported_at_ms: None,
            },
            generation,
            last: None,
            next: Instant::now(),
            cancellation: CancellationToken::new(),
        });
        if state.status.enabled != persisted || state.generation != generation {
            state.generation = generation;
            state.cancellation.cancel();
            state.cancellation = CancellationToken::new();
            state.status.enabled = persisted;
            state.status.report_status = "not-sent";
            state.status.last_error_code = None;
            state.status.last_reported_at_ms = None;
            state.last = None;
            state.next = Instant::now();
        }
        Ok(state.status.clone())
    }

    pub(super) fn start(
        self: Arc<Self>,
        services: Arc<CoreServices>,
        gate: Arc<tokio::sync::Mutex<()>>,
        mut shutdown: watch::Receiver<bool>,
        runtime: &tokio::runtime::Handle,
    ) {
        runtime.spawn(async move {
            let mut ticks = tokio::time::interval(Duration::from_secs(3));
            ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    biased;
                    _ = shutdown.changed() => break,
                    _ = ticks.tick() => {
                        tokio::select! {
                            biased;
                            _ = shutdown.changed() => break,
                            _ = self.publish_current(&services, &gate) => {},
                        }
                    },
                }
            }
        });
    }

    async fn publish_current(&self, services: &CoreServices, gate: &tokio::sync::Mutex<()>) {
        let Ok(_report) = gate.try_lock() else {
            return;
        };
        let snapshot = services.player.snapshot().await;
        if !matches!(
            snapshot.playback_state,
            PlaybackState::Playing | PlaybackState::Paused
        ) || snapshot.source_selection.is_none()
        {
            return;
        }
        let Some(song) = snapshot.current_index.and_then(|i| snapshot.queue.get(i)) else {
            return;
        };
        let Some(reference) = song
            .provider
            .as_ref()
            .filter(|r| r.provider_id == "qqmusic")
        else {
            return;
        };
        let Ok(scope) = ProviderProfileKey::new(&reference.provider_id, &reference.profile_id)
        else {
            return;
        };
        let Ok(facade) = services
            .providers
            .require_provider_profile(Some(&scope.provider_id), Some(&scope.profile_id))
        else {
            return;
        };
        let Some(provider) = facade.legacy_provider() else {
            return;
        };
        let Ok(status) = self.configure(
            &services.storage,
            scope.clone(),
            provider.account_generation(),
            None,
        ) else {
            return;
        };
        if !status.enabled {
            return;
        }
        let key = ReportKey {
            generation: provider.account_generation(),
            session: snapshot.session_id,
            playing: snapshot.is_playing,
            seek: snapshot.last_seek_revision,
            queue: snapshot
                .queue_entries
                .iter()
                .map(|e| e.id.clone())
                .collect(),
        };
        let state_key = setting(&scope);
        let cancellation = {
            let mut states = self.states.lock().unwrap_or_else(|e| e.into_inner());
            let state = states
                .get_mut(&state_key)
                .expect("configured sharing state");
            let Some(token) = state.claim(
                key.clone(),
                snapshot
                    .source_selection
                    .as_ref()
                    .is_some_and(|s| s.preview),
                Instant::now(),
            ) else {
                return;
            };
            token
        };
        let offset = snapshot.current_index.unwrap_or(0).saturating_sub(50);
        let mut tracks: Vec<_> = snapshot
            .queue
            .iter()
            .skip(offset)
            .take(100)
            .filter(|s| {
                s.provider.as_ref().is_some_and(|r| {
                    r.provider_id == scope.provider_id && r.profile_id == scope.profile_id
                })
            })
            .cloned()
            .collect();
        if !tracks.iter().any(|s| s.id == song.id) {
            tracks.insert(0, song.clone());
            tracks.truncate(100);
        }
        let report = PlaybackReport {
            current_song_id: song.id.clone(),
            tracks,
            account_generation: key.generation,
            position_ms: snapshot.position_ms,
            is_playing: snapshot.is_playing,
        };
        let live = services.player.snapshot().await;
        if !same_player(&snapshot, &live)
            || provider.account_generation() != key.generation
            || cancellation.is_cancelled()
        {
            return;
        }
        let result = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return,
            result = tokio::time::timeout(Duration::from_secs(25), provider.report_remote_playback(&report)) => result.unwrap_or_else(|_| Err(failure("outcome-unknown"))),
        };
        let mut states = self.states.lock().unwrap_or_else(|e| e.into_inner());
        let Some(state) = states.get_mut(&state_key) else {
            return;
        };
        if state.cancellation.is_cancelled()
            || cancellation.is_cancelled()
            || state.last.as_ref() != Some(&key)
        {
            return;
        }
        match result {
            Ok(()) => {
                state.status.report_status = "reported";
                state.status.last_error_code = None;
                state.status.last_reported_at_ms = Some(
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64,
                );
            }
            Err(error) => {
                state.status.report_status = "unconfirmed";
                state.status.last_error_code = Some(error.code);
            }
        }
    }
}

fn same_player(before: &PlayerSnapshot, after: &PlayerSnapshot) -> bool {
    before.session_id == after.session_id
        && before.is_playing == after.is_playing
        && before.last_seek_revision == after.last_seek_revision
        && before
            .queue_entries
            .iter()
            .map(|entry| &entry.id)
            .eq(after.queue_entries.iter().map(|entry| &entry.id))
        && after.source_selection.as_ref().is_some_and(|s| !s.preview)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sharing_is_opt_in_persisted_profile_scoped_and_cancelled_on_disable() {
        let storage = StorageService::temporary();
        let service = SharingService::default();
        let scope = ProviderProfileKey::new("qqmusic", "work").unwrap();
        assert!(
            !service
                .configure(&storage, scope.clone(), 1, None)
                .unwrap()
                .enabled
        );
        assert!(
            service
                .configure(&storage, scope.clone(), 1, Some(true))
                .unwrap()
                .enabled
        );
        let token = service.states.lock().unwrap()[&setting(&scope)]
            .cancellation
            .clone();
        assert!(
            !service
                .configure(
                    &storage,
                    ProviderProfileKey::new("qqmusic", "default").unwrap(),
                    1,
                    None
                )
                .unwrap()
                .enabled
        );
        assert!(
            SharingService::default()
                .configure(&storage, scope.clone(), 1, None)
                .unwrap()
                .enabled
        );
        assert!(
            !service
                .configure(&storage, scope, 1, Some(false))
                .unwrap()
                .enabled
        );
        assert!(token.is_cancelled());
    }

    #[test]
    fn account_change_cancels_old_work_and_clears_its_report_status() {
        let storage = StorageService::temporary();
        let service = SharingService::default();
        let scope = ProviderProfileKey::new("qqmusic", "work").unwrap();
        service
            .configure(&storage, scope.clone(), 1, Some(true))
            .unwrap();
        let old = {
            let mut states = service.states.lock().unwrap();
            let state = states.get_mut(&setting(&scope)).unwrap();
            state.status.report_status = "reported";
            state.status.last_reported_at_ms = Some(10);
            state.cancellation.clone()
        };
        let status = service.configure(&storage, scope.clone(), 2, None).unwrap();
        assert!(old.is_cancelled());
        assert!(status.enabled);
        assert_eq!(status.report_status, "not-sent");
        assert_eq!(status.last_reported_at_ms, None);
    }

    #[test]
    fn reports_transitions_once_heartbeats_only_while_playing_and_excludes_previews() {
        let storage = StorageService::temporary();
        let service = SharingService::default();
        let scope = ProviderProfileKey::new("qqmusic", "work").unwrap();
        service
            .configure(&storage, scope.clone(), 1, Some(true))
            .unwrap();
        let mut states = service.states.lock().unwrap();
        let state = states.get_mut(&setting(&scope)).unwrap();
        let mut key = ReportKey {
            generation: 1,
            session: 1,
            playing: true,
            seek: 0,
            queue: vec!["entry-1".into()],
        };
        let now = Instant::now();
        assert!(state.claim(key.clone(), false, now).is_some());
        assert!(state
            .claim(key.clone(), false, now + Duration::from_secs(3))
            .is_none());
        assert!(state.claim(key.clone(), false, now + HEARTBEAT).is_some());
        key.playing = false;
        assert!(state.claim(key.clone(), false, now + HEARTBEAT).is_some());
        assert!(state
            .claim(key.clone(), false, now + HEARTBEAT * 10)
            .is_none());
        key.seek += 1;
        assert!(state
            .claim(key.clone(), false, now + HEARTBEAT * 10)
            .is_some());
        key.queue.push("entry-2".into());
        assert!(state
            .claim(key.clone(), false, now + HEARTBEAT * 10)
            .is_some());
        key.session += 1;
        assert!(state.claim(key, true, now + HEARTBEAT * 10).is_none());
        assert_eq!(
            state.status.last_error_code.as_deref(),
            Some("preview-only")
        );
    }
}
