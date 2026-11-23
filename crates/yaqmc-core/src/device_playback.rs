//! Explicit, single-use attempts to resume another QQ client's playback.
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use serde::Serialize;
use tokio::sync::Mutex;
use yaqmc_provider_api::{
    MusicProvider, ProviderCommandError, ProviderProfileKey, ProviderResult, RemotePlaybackSnapshot,
};

use crate::{
    player::{PlayTracksRequest, PlayerService},
    CoreHandle,
};

const PREVIEW_TTL: Duration = Duration::from_secs(30);

mod sharing;
pub(crate) use sharing::DevicePlaybackSharingStatus;

#[derive(Default)]
pub(crate) struct DevicePlaybackService {
    pending: Mutex<Option<Pending>>,
    sharing: Arc<sharing::SharingService>,
    report_gate: Arc<Mutex<()>>,
}

struct Pending {
    token: String,
    profile: ProviderProfileKey,
    remote: RemotePlaybackSnapshot,
    created: Instant,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DevicePlaybackPreview {
    token: String,
    #[serde(flatten)]
    remote: RemotePlaybackSnapshot,
    expires_in_ms: u64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ReportStatus {
    Reported,
    NotSent,
    Unconfirmed,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DevicePlaybackResult {
    pub local_started: bool,
    pub report_status: ReportStatus,
    pub report_error_code: Option<String>,
    // No protocol receipt currently confirms that the original device paused.
    pub remote_pause_confirmed: bool,
}

fn error(code: &str, message: &str) -> ProviderCommandError {
    ProviderCommandError {
        code: code.into(),
        message: message.into(),
        retryable: false,
    }
}

fn provider(
    core: &CoreHandle,
    scope: &ProviderProfileKey,
) -> ProviderResult<Arc<dyn MusicProvider>> {
    core.providers()
        .require_provider_profile(Some(&scope.provider_id), Some(&scope.profile_id))?
        .legacy_provider()
        .ok_or_else(|| {
            error(
                "unsupported-operation",
                "remote playback is unavailable for this provider",
            )
        })
}

impl DevicePlaybackService {
    pub(crate) fn start_sharing(&self, core: &CoreHandle, runtime: &tokio::runtime::Handle) {
        self.sharing.clone().start(
            core.services.clone(),
            self.report_gate.clone(),
            core.subscribe_shutdown(),
            runtime,
        );
    }

    pub(crate) fn sharing(
        &self,
        core: &CoreHandle,
        scope: ProviderProfileKey,
        enabled: Option<bool>,
    ) -> ProviderResult<DevicePlaybackSharingStatus> {
        let generation = provider(core, &scope)?.account_generation();
        self.sharing
            .configure(&core.storage(), scope, generation, enabled)
    }
    pub async fn preview(
        &self,
        core: &CoreHandle,
        scope: ProviderProfileKey,
    ) -> ProviderResult<Option<DevicePlaybackPreview>> {
        let mut pending = self.pending.try_lock().map_err(|_| {
            error(
                "device-playback-busy",
                "a remote playback operation is in progress",
            )
        })?;
        *pending = None;
        let provider = provider(core, &scope)?;
        let Some(remote) = provider.remote_playback().await? else {
            return Ok(None);
        };
        let token = format!("{:032x}", rand::random::<u128>());
        *pending = Some(Pending {
            token: token.clone(),
            profile: scope,
            remote: remote.clone(),
            created: Instant::now(),
        });
        Ok(Some(DevicePlaybackPreview {
            token,
            remote,
            expires_in_ms: PREVIEW_TTL.as_millis() as u64,
        }))
    }

    pub async fn take_over(
        &self,
        core: &CoreHandle,
        scope: ProviderProfileKey,
        token: String,
    ) -> ProviderResult<DevicePlaybackResult> {
        // Held through the whole attempt: retries/double clicks cannot duplicate a write.
        let mut pending = self.pending.try_lock().map_err(|_| {
            error(
                "device-playback-busy",
                "a remote playback operation is in progress",
            )
        })?;
        let provider = provider(core, &scope)?;
        let previous =
            consume_preview(&mut pending, &scope, &token, provider.account_generation())?;
        let _report = self.report_gate.lock().await;
        let player: Arc<PlayerService> = core.player();
        let before = player.snapshot().await;
        let fresh = provider.remote_playback().await?.ok_or_else(|| {
            error(
                "device-playback-changed",
                "remote playback is no longer available; refresh the preview",
            )
        })?;
        if fresh.account_generation != previous.account_generation
            || fresh.current_song_id != previous.current_song_id
            || fresh
                .tracks
                .iter()
                .map(|song| &song.id)
                .ne(previous.tracks.iter().map(|song| &song.id))
            || provider.account_generation() != fresh.account_generation
        {
            return Err(error(
                "device-playback-changed",
                "remote playback or account changed; refresh the preview",
            ));
        }
        let current = fresh
            .tracks
            .iter()
            .find(|song| song.id == fresh.current_song_id)
            .filter(|song| song.availability.is_available())
            .ok_or_else(|| {
                error(
                    "track-unavailable",
                    "the remote current track is unavailable",
                )
            })?;
        let current_id = current.id.clone();
        core.providers().remember_scoped_songs(&fresh.tracks).await;
        if provider.account_generation() != fresh.account_generation {
            return Err(error(
                "device-playback-changed",
                "account changed; refresh the preview",
            ));
        }
        let started = player
            .play_tracks_if_unchanged(
                PlayTracksRequest {
                    tracks: fresh.tracks.clone(),
                    start_at_id: Some(current_id.clone()),
                    shuffle: Some(false),
                },
                "device-takeover",
                Some(&before),
            )
            .await
            .map_err(|_| {
                error(
                    "device-playback-local-failed",
                    "local playback could not start; no listening report was sent",
                )
            })?;
        let live = player.snapshot().await;
        let same_playback = live.session_id == started.session_id
            && live.is_playing
            && live.queue.iter().map(|song| &song.id).eq(fresh
                .tracks
                .iter()
                .filter(|song| song.availability.is_available())
                .map(|song| &song.id))
            && live
                .current_index
                .and_then(|index| live.queue.get(index))
                .is_some_and(|song| song.id == current_id);
        if !same_playback || provider.account_generation() != fresh.account_generation {
            return Ok(DevicePlaybackResult {
                local_started: same_playback,
                report_status: ReportStatus::NotSent,
                report_error_code: Some("playback-or-account-changed".into()),
                remote_pause_confirmed: false,
            });
        }
        if live
            .source_selection
            .as_ref()
            .is_some_and(|selection| selection.preview)
        {
            return Ok(DevicePlaybackResult {
                local_started: true,
                report_status: ReportStatus::NotSent,
                report_error_code: Some("preview-only".into()),
                remote_pause_confirmed: false,
            });
        }
        let reported = yaqmc_provider_api::PlaybackReport {
            current_song_id: current_id,
            tracks: fresh
                .tracks
                .iter()
                .filter(|song| song.availability.is_available())
                .cloned()
                .collect(),
            account_generation: fresh.account_generation,
            position_ms: live.position_ms,
            is_playing: true,
        };
        let result = provider.report_remote_playback(&reported).await;
        let (report_status, report_error_code) = match result {
            Ok(()) => (ReportStatus::Reported, None),
            Err(error) => (ReportStatus::Unconfirmed, Some(error.code)),
        };
        Ok(DevicePlaybackResult {
            local_started: true,
            report_status,
            report_error_code,
            remote_pause_confirmed: false,
        })
    }
}

fn consume_preview(
    pending: &mut Option<Pending>,
    scope: &ProviderProfileKey,
    token: &str,
    generation: u64,
) -> ProviderResult<RemotePlaybackSnapshot> {
    let value = pending.as_ref().ok_or_else(|| {
        error(
            "device-preview-expired",
            "refresh the remote playback preview",
        )
    })?;
    if token.len() != 32 || value.token != token || value.profile != *scope {
        return Err(error(
            "device-preview-invalid",
            "remote playback preview does not match this profile",
        ));
    }
    let value = pending.take().expect("preview was checked above");
    if value.created.elapsed() > PREVIEW_TTL || value.remote.account_generation != generation {
        return Err(error(
            "device-preview-expired",
            "remote playback preview expired or account changed",
        ));
    }
    Ok(value.remote)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pending() -> Option<Pending> {
        Some(Pending {
            token: "a".repeat(32),
            profile: ProviderProfileKey::new("qqmusic", "work").unwrap(),
            remote: RemotePlaybackSnapshot {
                current_song_id: "song".into(),
                tracks: vec![],
                updated_at_ms: 1,
                queue_truncated: false,
                account_generation: 7,
            },
            created: Instant::now(),
        })
    }
    #[test]
    fn previews_are_profile_bound_single_use_and_expire_on_account_change() {
        let scope = ProviderProfileKey::new("qqmusic", "work").unwrap();
        let mut value = pending();
        assert!(consume_preview(
            &mut value,
            &ProviderProfileKey::new("qqmusic", "default").unwrap(),
            &"a".repeat(32),
            7
        )
        .is_err());
        assert!(consume_preview(&mut value, &scope, &"b".repeat(32), 7).is_err());
        assert!(consume_preview(&mut value, &scope, &"a".repeat(32), 7).is_ok());
        assert!(consume_preview(&mut value, &scope, &"a".repeat(32), 7).is_err());
        value = pending();
        assert!(consume_preview(&mut value, &scope, &"a".repeat(32), 8).is_err());
        assert!(value.is_none());
        value = pending();
        value.as_mut().unwrap().created = Instant::now() - PREVIEW_TTL - Duration::from_secs(1);
        assert!(consume_preview(&mut value, &scope, &"a".repeat(32), 7).is_err());
    }
}
