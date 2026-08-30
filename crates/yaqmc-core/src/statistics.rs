//! Local-only listening statistics derived from the authoritative player clock.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::player::{
    ApiEvent, ObserverFollowupEvent, PlaybackContextEvent, PlaybackLifecycleEvent, PlaybackState,
    PlaybackTransitionReason, PlayerEventObserver, PlayerSnapshot, Song,
};
use crate::storage::{StorageError, StorageService};

const QUALIFIED_THRESHOLD_MS: u64 = 30_000;
const CHECKPOINT_INTERVAL_MS: u64 = 15_000;
const MAX_NORMAL_POSITION_DELTA_MS: u64 = 5_000;
const MAX_SOURCE_CONTEXT_BYTES: usize = 64;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum StatisticsRange {
    #[serde(rename = "7-days")]
    SevenDays,
    #[serde(rename = "30-days")]
    ThirtyDays,
    #[serde(rename = "365-days")]
    ThreeHundredSixtyFiveDays,
    #[serde(rename = "all-time")]
    AllTime,
}

impl StatisticsRange {
    pub(crate) fn cutoff_ms(self, now_ms: u64) -> u64 {
        let days = match self {
            Self::SevenDays => 7,
            Self::ThirtyDays => 30,
            Self::ThreeHundredSixtyFiveDays => 365,
            Self::AllTime => return 0,
        };
        now_ms.saturating_sub(days * 24 * 60 * 60 * 1_000)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StatisticsExportFormat {
    Json,
    Csv,
}

impl StatisticsExportFormat {
    fn extension(self) -> &'static str {
        match self {
            Self::Json => "json",
            Self::Csv => "csv",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ListeningOutcome {
    InProgress,
    Completed,
    Qualified,
    Skipped,
    Stopped,
    Error,
}

impl ListeningOutcome {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::InProgress => "in-progress",
            Self::Completed => "completed",
            Self::Qualified => "qualified",
            Self::Skipped => "skipped",
            Self::Stopped => "stopped",
            Self::Error => "error",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "in-progress" => Some(Self::InProgress),
            "completed" => Some(Self::Completed),
            "qualified" => Some(Self::Qualified),
            "skipped" => Some(Self::Skipped),
            "stopped" => Some(Self::Stopped),
            "error" => Some(Self::Error),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListeningArtist {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListeningDisplaySnapshot {
    pub title: String,
    pub album_id: Option<String>,
    pub album_title: String,
    pub artists: Vec<ListeningArtist>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListeningSessionRecord {
    pub session_id: String,
    pub provider_id: String,
    pub track_id: String,
    pub display: ListeningDisplaySnapshot,
    pub started_at_ms: u64,
    pub ended_at_ms: Option<u64>,
    pub listened_ms: u64,
    pub playable_duration_ms: Option<u64>,
    pub outcome: ListeningOutcome,
    pub source_context: String,
    pub requested_quality: Option<String>,
    pub resolved_quality: Option<String>,
    pub preview: bool,
    pub error_code: Option<String>,
    pub updated_at_ms: u64,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatisticsEntityTotal {
    pub provider_id: String,
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub listened_ms: u64,
    pub play_count: u64,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatisticsDailyTotal {
    pub day_start_ms: u64,
    pub listened_ms: u64,
    pub play_count: u64,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatisticsDimensionTotal {
    pub key: String,
    pub listened_ms: u64,
    pub play_count: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatisticsSnapshot {
    pub range: StatisticsRange,
    pub from_ms: u64,
    pub to_ms: u64,
    pub qualified_listening_ms: u64,
    pub qualified_play_count: u64,
    pub completed_count: u64,
    pub skipped_count: u64,
    pub skip_rate: f64,
    pub record_count: u64,
    pub database_bytes: u64,
    pub top_songs: Vec<StatisticsEntityTotal>,
    pub top_artists: Vec<StatisticsEntityTotal>,
    pub top_albums: Vec<StatisticsEntityTotal>,
    pub daily: Vec<StatisticsDailyTotal>,
    pub qualities: Vec<StatisticsDimensionTotal>,
    pub providers: Vec<StatisticsDimensionTotal>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatisticsExportRequest {
    pub range: StatisticsRange,
    pub format: StatisticsExportFormat,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatisticsExportResult {
    pub path: String,
    pub bytes: u64,
    pub session_count: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatisticsClearResult {
    pub deleted_sessions: u64,
    pub revision: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatisticsChanged {
    pub revision: u64,
}

struct ActiveListening {
    player_session_id: u64,
    record: ListeningSessionRecord,
    last_position_ms: u64,
    last_state: PlaybackState,
    last_seek_revision: u64,
    checkpoint_listened_ms: u64,
}

struct TrackerState {
    active: Option<ActiveListening>,
    source_context: String,
    pending_recovery_session: Option<u64>,
    revision: u64,
}

impl Default for TrackerState {
    fn default() -> Self {
        Self {
            active: None,
            source_context: "queue".to_owned(),
            pending_recovery_session: None,
            revision: 0,
        }
    }
}

pub struct StatisticsService {
    storage: Arc<StorageService>,
    state: Mutex<TrackerState>,
    sequence: AtomicU64,
}

impl StatisticsService {
    pub fn new(storage: Arc<StorageService>) -> Result<Arc<Self>, StorageError> {
        storage.recover_listening_sessions(unix_timestamp_ms())?;
        Ok(Arc::new(Self {
            storage,
            state: Mutex::new(TrackerState::default()),
            sequence: AtomicU64::new(0),
        }))
    }

    pub fn snapshot(&self, range: StatisticsRange) -> Result<StatisticsSnapshot, StorageError> {
        self.storage.statistics_snapshot(range, unix_timestamp_ms())
    }

    pub fn export(
        &self,
        request: StatisticsExportRequest,
    ) -> Result<StatisticsExportResult, StatisticsError> {
        let target = validate_export_path(&request.path, request.format)?;
        let now = unix_timestamp_ms();
        let snapshot = self.storage.statistics_snapshot(request.range, now)?;
        let sessions = self
            .storage
            .listening_sessions_for_export(request.range, now)?;
        let bytes = match request.format {
            StatisticsExportFormat::Json => serde_json::to_vec_pretty(&json!({
                "schemaVersion": 1,
                "statistics": snapshot,
                "sessions": sessions,
            }))
            .map_err(|_| StatisticsError::Serialize)?,
            StatisticsExportFormat::Csv => render_csv(&snapshot, &sessions).into_bytes(),
        };
        write_export(&target, &bytes)?;
        Ok(StatisticsExportResult {
            path: target.to_string_lossy().into_owned(),
            bytes: bytes.len() as u64,
            session_count: sessions.len() as u64,
        })
    }

    pub fn clear(&self) -> Result<StatisticsClearResult, StorageError> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let deleted_sessions = self.storage.clear_listening_sessions()?;
        if let Some(active) = state.active.as_mut() {
            let now = unix_timestamp_ms();
            active.record.session_id = self.next_id(now);
            active.record.started_at_ms = now;
            active.record.ended_at_ms = None;
            active.record.listened_ms = 0;
            active.record.outcome = ListeningOutcome::InProgress;
            active.record.error_code = None;
            active.record.updated_at_ms = now;
            active.checkpoint_listened_ms = 0;
            // The next player event establishes a post-clear clock baseline;
            // no position movement observed before the clear can leak in.
            active.last_state = PlaybackState::Paused;
            if let Err(error) = self.storage.upsert_listening_session(&active.record) {
                tracing::warn!(target: "statistics", %error, "active listening checkpoint after clear failed");
            }
        }
        state.revision = state.revision.saturating_add(1);
        Ok(StatisticsClearResult {
            deleted_sessions,
            revision: state.revision,
        })
    }

    pub fn shutdown(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _ = self.finalize_locked(
            &mut state,
            FinalizeReason::Stopped,
            unix_timestamp_ms(),
            None,
        );
    }

    fn next_id(&self, now_ms: u64) -> String {
        let sequence = self.sequence.fetch_add(1, Ordering::AcqRel) + 1;
        let random = rand::random::<u64>();
        format!("{now_ms:016x}{:016x}", random ^ sequence.rotate_left(17))
    }

    fn observe_context(&self, event: &ApiEvent) {
        let Ok(context) = serde_json::from_value::<PlaybackContextEvent>(event.data.clone()) else {
            return;
        };
        let normalized = context.source_context.trim();
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.source_context = if normalized.is_empty()
            || normalized.len() > MAX_SOURCE_CONTEXT_BYTES
            || !normalized
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            "queue".to_owned()
        } else {
            normalized.to_owned()
        };
    }

    fn observe_lifecycle(&self, event: &ApiEvent) -> Option<StatisticsChanged> {
        let lifecycle =
            serde_json::from_value::<PlaybackLifecycleEvent>(event.data.clone()).ok()?;
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if lifecycle.reason == PlaybackTransitionReason::Recovery {
            if state
                .active
                .as_ref()
                .is_some_and(|active| active.player_session_id == lifecycle.from_session_id)
            {
                state.pending_recovery_session = Some(lifecycle.from_session_id);
            }
            return None;
        }
        if state
            .active
            .as_ref()
            .is_none_or(|active| active.player_session_id != lifecycle.from_session_id)
        {
            return None;
        }
        let reason = match lifecycle.reason {
            PlaybackTransitionReason::Completed => FinalizeReason::Completed,
            PlaybackTransitionReason::Skipped => FinalizeReason::Skipped,
            PlaybackTransitionReason::QueueReplaced => FinalizeReason::Stopped,
            PlaybackTransitionReason::Recovery => return None,
        };
        self.finalize_locked(&mut state, reason, event.timestamp_ms, None)
    }

    fn observe_snapshot(&self, event: &ApiEvent) -> Option<StatisticsChanged> {
        let snapshot = serde_json::from_value::<PlayerSnapshot>(event.data.clone()).ok()?;
        let current = snapshot
            .current_index
            .and_then(|index| snapshot.queue.get(index));
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        if event.event_type == "player.track" {
            if let Some(active_session_id) =
                state.active.as_ref().map(|active| active.player_session_id)
            {
                if active_session_id != snapshot.session_id {
                    let recovering = state.pending_recovery_session == Some(active_session_id)
                        && state.active.as_ref().is_some_and(|active| {
                            current.is_some_and(|song| same_track(&active.record, song))
                        });
                    if recovering {
                        let active = state.active.as_mut().expect("active session was observed");
                        active.player_session_id = snapshot.session_id;
                        active.last_position_ms = snapshot.position_ms;
                        active.last_state = snapshot.playback_state;
                        active.last_seek_revision = snapshot.last_seek_revision;
                        active.record.updated_at_ms = event.timestamp_ms;
                        if let Err(error) = self.storage.upsert_listening_session(&active.record) {
                            tracing::warn!(target: "statistics", %error, "recovery checkpoint failed");
                        }
                        state.pending_recovery_session = None;
                        return None;
                    }
                    let changed = self.finalize_locked(
                        &mut state,
                        FinalizeReason::Stopped,
                        event.timestamp_ms,
                        None,
                    );
                    if let Some(song) = current {
                        self.start_locked(&mut state, &snapshot, song, event.timestamp_ms);
                    }
                    return changed;
                }
            }
            if state.active.is_none() {
                if let Some(song) = current {
                    self.start_locked(&mut state, &snapshot, song, event.timestamp_ms);
                }
                return None;
            }
        }

        let active = state.active.as_mut()?;
        if active.player_session_id != snapshot.session_id {
            return None;
        }
        let previous_state = active.last_state;
        let same_seek = active.last_seek_revision == snapshot.last_seek_revision;
        if previous_state == PlaybackState::Playing
            && same_seek
            && snapshot.position_ms >= active.last_position_ms
        {
            let delta = snapshot.position_ms - active.last_position_ms;
            if delta <= MAX_NORMAL_POSITION_DELTA_MS {
                active.record.listened_ms = active.record.listened_ms.saturating_add(delta);
            }
        }
        active.last_position_ms = snapshot.position_ms;
        active.last_state = snapshot.playback_state;
        active.last_seek_revision = snapshot.last_seek_revision;
        active.record.playable_duration_ms = snapshot
            .playback_duration_ms
            .filter(|duration| *duration > 0)
            .or(active.record.playable_duration_ms);
        if let Some(selection) = snapshot.source_selection.as_ref() {
            active.record.requested_quality =
                Some(selection.requested_quality.as_setting().to_owned());
            active.record.resolved_quality = Some(audio_quality_name(selection.resolved_quality));
            active.record.preview = selection.preview;
        }
        active.record.updated_at_ms = event.timestamp_ms;

        let terminal = match snapshot.playback_state {
            PlaybackState::Ended => Some((FinalizeReason::Completed, None)),
            PlaybackState::Stopped => Some((FinalizeReason::Stopped, None)),
            PlaybackState::FatalError => Some((
                FinalizeReason::Error,
                snapshot
                    .playback_error
                    .as_ref()
                    .map(|error| error.code.clone()),
            )),
            _ => None,
        };
        if let Some((reason, error_code)) = terminal {
            return self.finalize_locked(&mut state, reason, event.timestamp_ms, error_code);
        }
        let state_changed = previous_state != snapshot.playback_state;
        if state_changed
            || active
                .record
                .listened_ms
                .saturating_sub(active.checkpoint_listened_ms)
                >= CHECKPOINT_INTERVAL_MS
        {
            if let Err(error) = self.storage.upsert_listening_session(&active.record) {
                tracing::warn!(target: "statistics", %error, "listening checkpoint failed");
            } else {
                active.checkpoint_listened_ms = active.record.listened_ms;
            }
        }
        None
    }

    fn start_locked(
        &self,
        state: &mut TrackerState,
        snapshot: &PlayerSnapshot,
        song: &Song,
        now_ms: u64,
    ) {
        if snapshot.session_id == 0 {
            return;
        }
        let provider_id = song
            .provider
            .as_ref()
            .map(|reference| reference.provider_id.trim())
            .filter(|value| !value.is_empty())
            .unwrap_or("unknown")
            .to_owned();
        let track_id = song
            .provider
            .as_ref()
            .map(|reference| reference.track_id.trim())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| song.id.trim())
            .to_owned();
        if track_id.is_empty() {
            return;
        }
        let display = ListeningDisplaySnapshot {
            title: song.title.clone(),
            album_id: (!song.album.id.trim().is_empty()).then(|| song.album.id.trim().to_owned()),
            album_title: song.album.title.clone(),
            artists: song
                .artists
                .iter()
                .filter(|artist| !artist.id.trim().is_empty() || !artist.name.trim().is_empty())
                .map(|artist| ListeningArtist {
                    id: artist.id.trim().to_owned(),
                    name: artist.name.clone(),
                })
                .collect(),
        };
        let mut record = ListeningSessionRecord {
            session_id: self.next_id(now_ms),
            provider_id,
            track_id,
            display,
            started_at_ms: now_ms,
            ended_at_ms: None,
            listened_ms: 0,
            playable_duration_ms: snapshot
                .playback_duration_ms
                .filter(|duration| *duration > 0)
                .or((song.duration_ms > 0).then_some(song.duration_ms)),
            outcome: ListeningOutcome::InProgress,
            source_context: state.source_context.clone(),
            requested_quality: None,
            resolved_quality: None,
            preview: false,
            error_code: None,
            updated_at_ms: now_ms,
        };
        if let Some(selection) = snapshot.source_selection.as_ref() {
            record.requested_quality = Some(selection.requested_quality.as_setting().to_owned());
            record.resolved_quality = Some(audio_quality_name(selection.resolved_quality));
            record.preview = selection.preview;
        }
        if let Err(error) = self.storage.upsert_listening_session(&record) {
            tracing::warn!(target: "statistics", %error, "initial listening checkpoint failed");
        }
        state.pending_recovery_session = None;
        state.active = Some(ActiveListening {
            player_session_id: snapshot.session_id,
            record,
            last_position_ms: snapshot.position_ms,
            last_state: snapshot.playback_state,
            last_seek_revision: snapshot.last_seek_revision,
            checkpoint_listened_ms: 0,
        });
    }

    fn finalize_locked(
        &self,
        state: &mut TrackerState,
        reason: FinalizeReason,
        now_ms: u64,
        error_code: Option<String>,
    ) -> Option<StatisticsChanged> {
        let mut active = state.active.take()?;
        active.record.ended_at_ms = Some(now_ms.max(active.record.started_at_ms));
        active.record.updated_at_ms = now_ms;
        active.record.error_code = error_code;
        let qualified = active.record.listened_ms >= qualification_threshold(&active.record);
        active.record.outcome = match reason {
            FinalizeReason::Completed => ListeningOutcome::Completed,
            FinalizeReason::Skipped if qualified => ListeningOutcome::Qualified,
            FinalizeReason::Skipped => ListeningOutcome::Skipped,
            FinalizeReason::Stopped if qualified => ListeningOutcome::Qualified,
            FinalizeReason::Stopped => ListeningOutcome::Stopped,
            FinalizeReason::Error if qualified => ListeningOutcome::Qualified,
            FinalizeReason::Error => ListeningOutcome::Error,
        };
        if let Err(error) = self.storage.upsert_listening_session(&active.record) {
            tracing::warn!(target: "statistics", %error, "listening finalization failed");
        }
        state.pending_recovery_session = None;
        state.revision = state.revision.saturating_add(1);
        Some(StatisticsChanged {
            revision: state.revision,
        })
    }
}

impl PlayerEventObserver for StatisticsService {
    fn observe(&self, event: &ApiEvent) -> Option<ObserverFollowupEvent> {
        let changed = match event.event_type.as_str() {
            "player.context" => {
                self.observe_context(event);
                None
            }
            "player.transition" => self.observe_lifecycle(event),
            "player.track" | "player.playback" | "player.position" | "player.seeked"
            | "player.error" => self.observe_snapshot(event),
            _ => None,
        }?;
        Some(ObserverFollowupEvent {
            event_type: "statistics.changed",
            data: serde_json::to_value(changed).unwrap_or_else(|_| json!({})),
        })
    }
}

#[derive(Clone, Copy)]
enum FinalizeReason {
    Completed,
    Skipped,
    Stopped,
    Error,
}

#[derive(Debug, thiserror::Error)]
pub enum StatisticsError {
    #[error("statistics storage failed")]
    Storage(#[from] StorageError),
    #[error("statistics export path must be an absolute path with the requested extension")]
    InvalidPath,
    #[error("statistics export could not be serialized")]
    Serialize,
    #[error("statistics export could not be written")]
    File,
}

fn qualification_threshold(record: &ListeningSessionRecord) -> u64 {
    record
        .playable_duration_ms
        .filter(|duration| *duration > 0)
        .map(|duration| QUALIFIED_THRESHOLD_MS.min(duration / 2))
        .unwrap_or(QUALIFIED_THRESHOLD_MS)
}

fn same_track(record: &ListeningSessionRecord, song: &Song) -> bool {
    let provider = song
        .provider
        .as_ref()
        .map(|reference| reference.provider_id.as_str())
        .unwrap_or("unknown");
    let track = song
        .provider
        .as_ref()
        .map(|reference| reference.track_id.as_str())
        .unwrap_or(song.id.as_str());
    record.provider_id == provider && record.track_id == track
}

fn audio_quality_name(quality: crate::player::AudioQuality) -> String {
    match quality {
        crate::player::AudioQuality::Standard => "standard",
        crate::player::AudioQuality::High => "high",
        crate::player::AudioQuality::Lossless => "lossless",
        crate::player::AudioQuality::HiRes => "hi-res",
        crate::player::AudioQuality::Master => "master",
    }
    .to_owned()
}

fn validate_export_path(
    path: &str,
    format: StatisticsExportFormat,
) -> Result<PathBuf, StatisticsError> {
    let target = PathBuf::from(path);
    let valid_extension = target
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case(format.extension()));
    if !target.is_absolute() || !valid_extension || target.file_name().is_none() {
        return Err(StatisticsError::InvalidPath);
    }
    Ok(target)
}

fn write_export(path: &Path, bytes: &[u8]) -> Result<(), StatisticsError> {
    if let Some(parent) = path.parent() {
        if !parent.is_dir() {
            return Err(StatisticsError::InvalidPath);
        }
    }
    fs::write(path, bytes).map_err(|_| StatisticsError::File)
}

fn render_csv(snapshot: &StatisticsSnapshot, sessions: &[ListeningSessionRecord]) -> String {
    let mut rows = vec![
        "recordType,sessionId,providerId,trackId,title,albumId,albumTitle,artists,startedAtMs,endedAtMs,listenedMs,playableDurationMs,outcome,sourceContext,requestedQuality,resolvedQuality,preview,errorCode,qualifiedListeningMs,qualifiedPlayCount,completedCount,skippedCount,skipRate".to_owned(),
        [
            "summary".to_owned(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            snapshot.qualified_listening_ms.to_string(),
            snapshot.qualified_play_count.to_string(),
            snapshot.completed_count.to_string(),
            snapshot.skipped_count.to_string(),
            snapshot.skip_rate.to_string(),
        ]
        .into_iter()
        .map(|value| csv_cell(&value))
        .collect::<Vec<_>>()
        .join(","),
    ];
    for session in sessions {
        let artists = session
            .display
            .artists
            .iter()
            .map(|artist| artist.name.as_str())
            .collect::<Vec<_>>()
            .join(" / ");
        rows.push(
            [
                "session".to_owned(),
                session.session_id.clone(),
                session.provider_id.clone(),
                session.track_id.clone(),
                session.display.title.clone(),
                session.display.album_id.clone().unwrap_or_default(),
                session.display.album_title.clone(),
                artists,
                session.started_at_ms.to_string(),
                session
                    .ended_at_ms
                    .map(|value| value.to_string())
                    .unwrap_or_default(),
                session.listened_ms.to_string(),
                session
                    .playable_duration_ms
                    .map(|value| value.to_string())
                    .unwrap_or_default(),
                session.outcome.as_str().to_owned(),
                session.source_context.clone(),
                session.requested_quality.clone().unwrap_or_default(),
                session.resolved_quality.clone().unwrap_or_default(),
                session.preview.to_string(),
                session.error_code.clone().unwrap_or_default(),
            ]
            .into_iter()
            .chain((0..5).map(|_| String::new()))
            .map(|value| csv_cell(&value))
            .collect::<Vec<_>>()
            .join(","),
        );
    }
    rows.join("\n") + "\n"
}

fn csv_cell(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_owned()
    }
}

fn unix_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::playback_types::{
        AudioQualityPreference, PlaybackFallbackReason, PlaybackSourceSelection,
    };
    use crate::player::{
        AlbumSummary, ArtistSummary, Artwork, AudioQuality, PlaybackFailure, PlaybackOrder,
        PrimaryPlaybackMode, QueueEntry, RepeatMode, SongAvailability,
    };
    use serde_json::Value;

    fn song(id: &str, duration_ms: u64) -> Song {
        Song {
            id: id.to_owned(),
            title: format!("Song {id}"),
            artists: vec![ArtistSummary {
                id: "artist-one".to_owned(),
                name: "Artist One".to_owned(),
            }],
            album: AlbumSummary {
                id: "album-one".to_owned(),
                title: "Album One".to_owned(),
            },
            artwork: Artwork {
                src: String::new(),
                alt: String::new(),
                dominant_color: String::new(),
                variants: Vec::new(),
            },
            duration_ms,
            track_number: 1,
            is_favorite: false,
            quality: AudioQuality::High,
            availability: SongAvailability::Available,
            audio_formats: Vec::new(),
            playback_capability: None,
            provider: Some(yaqmc_provider_api::ProviderTrackReference {
                provider_id: "fake".to_owned(),
                track_id: id.to_owned(),
                numeric_id: None,
                album_id: Some("album-one".to_owned()),
                media_id: None,
            }),
        }
    }

    fn snapshot(
        session_id: u64,
        track: Song,
        state: PlaybackState,
        position_ms: u64,
        seek_revision: u64,
    ) -> PlayerSnapshot {
        PlayerSnapshot {
            queue: vec![track.clone()],
            queue_entries: vec![QueueEntry {
                id: format!("entry-{session_id}"),
                track,
            }],
            current_index: Some(0),
            current_queue_entry_id: Some(format!("entry-{session_id}")),
            position_ms,
            is_playing: state == PlaybackState::Playing,
            volume: 0.7,
            is_muted: false,
            repeat: RepeatMode::Off,
            playback_order: PlaybackOrder::Sequential,
            shuffle: false,
            primary_playback_mode: PrimaryPlaybackMode::Sequential,
            shuffle_traversal: Vec::new(),
            shuffle_cursor: 0,
            playback_history: Vec::new(),
            history_cursor: 0,
            upcoming_queue_entry_ids: Vec::new(),
            playback_state: state,
            playback_duration_ms: Some(100_000),
            playback_error: None,
            source_selection: None,
            session_id,
            snapshot_revision: position_ms,
            source_generation: 1,
            last_seek_revision: seek_revision,
            sampled_at_ms: 0,
        }
    }

    fn event<T: Serialize>(event_type: &str, timestamp_ms: u64, data: &T) -> ApiEvent {
        ApiEvent {
            version: 1,
            event_type: event_type.to_owned(),
            timestamp_ms,
            data: serde_json::to_value(data).expect("event serializes"),
        }
    }

    fn observe_snapshot(
        service: &StatisticsService,
        event_type: &str,
        timestamp_ms: u64,
        snapshot: &PlayerSnapshot,
    ) {
        let _ = service.observe(&event(event_type, timestamp_ms, snapshot));
    }

    fn observe_transition(
        service: &StatisticsService,
        timestamp_ms: u64,
        session_id: u64,
        reason: PlaybackTransitionReason,
    ) {
        let _ = service.observe(&event(
            "player.transition",
            timestamp_ms,
            &PlaybackLifecycleEvent {
                from_session_id: session_id,
                reason,
            },
        ));
    }

    fn service() -> Arc<StatisticsService> {
        StatisticsService::new(Arc::new(StorageService::temporary()))
            .expect("statistics service opens")
    }

    fn play_forward(
        service: &StatisticsService,
        session_id: u64,
        track: &Song,
        duration_ms: Option<u64>,
        listened_ms: u64,
    ) -> PlayerSnapshot {
        let started_at = session_id * 100_000;
        let mut initial = snapshot(session_id, track.clone(), PlaybackState::Loading, 0, 0);
        initial.playback_duration_ms = duration_ms;
        observe_snapshot(service, "player.track", started_at, &initial);
        initial.playback_state = PlaybackState::Playing;
        initial.is_playing = true;
        observe_snapshot(service, "player.playback", started_at + 1, &initial);
        let mut position = 0;
        while position < listened_ms {
            position = (position + MAX_NORMAL_POSITION_DELTA_MS).min(listened_ms);
            initial.position_ms = position;
            observe_snapshot(service, "player.position", started_at + position, &initial);
        }
        initial
    }

    #[test]
    fn pause_buffer_seek_and_recovery_time_are_not_counted() {
        let service = service();
        let track = song("one", 100_000);
        observe_snapshot(
            &service,
            "player.track",
            1_000,
            &snapshot(1, track.clone(), PlaybackState::Loading, 0, 0),
        );
        observe_snapshot(
            &service,
            "player.playback",
            1_001,
            &snapshot(1, track.clone(), PlaybackState::Playing, 0, 0),
        );
        for step in 1..=5 {
            observe_snapshot(
                &service,
                "player.position",
                1_001 + step * 5_000,
                &snapshot(1, track.clone(), PlaybackState::Playing, step * 5_000, 0),
            );
        }
        observe_snapshot(
            &service,
            "player.playback",
            27_000,
            &snapshot(1, track.clone(), PlaybackState::Paused, 25_000, 0),
        );
        observe_snapshot(
            &service,
            "player.playback",
            40_000,
            &snapshot(1, track.clone(), PlaybackState::Buffering, 25_000, 0),
        );
        observe_snapshot(
            &service,
            "player.seeked",
            41_000,
            &snapshot(1, track.clone(), PlaybackState::Playing, 70_000, 1),
        );
        observe_snapshot(
            &service,
            "player.position",
            46_000,
            &snapshot(1, track, PlaybackState::Playing, 75_000, 1),
        );
        observe_transition(&service, 46_001, 1, PlaybackTransitionReason::Skipped);

        let snapshot = service
            .snapshot(StatisticsRange::AllTime)
            .expect("statistics query");
        assert_eq!(snapshot.qualified_listening_ms, 30_000);
        assert_eq!(snapshot.qualified_play_count, 1);
        assert_eq!(snapshot.skipped_count, 0);
    }

    #[test]
    fn repeat_one_eos_creates_one_completed_record_per_player_session() {
        let service = service();
        let track = song("repeat", 10_000);
        for session_id in [1, 2] {
            observe_snapshot(
                &service,
                "player.track",
                session_id * 20_000,
                &snapshot(session_id, track.clone(), PlaybackState::Loading, 0, 0),
            );
            observe_snapshot(
                &service,
                "player.playback",
                session_id * 20_000 + 1,
                &snapshot(session_id, track.clone(), PlaybackState::Playing, 0, 0),
            );
            observe_snapshot(
                &service,
                "player.position",
                session_id * 20_000 + 5_000,
                &snapshot(session_id, track.clone(), PlaybackState::Playing, 5_000, 0),
            );
            observe_transition(
                &service,
                session_id * 20_000 + 10_000,
                session_id,
                PlaybackTransitionReason::Completed,
            );
        }

        let snapshot = service
            .snapshot(StatisticsRange::AllTime)
            .expect("statistics query");
        assert_eq!(snapshot.completed_count, 2);
        assert_eq!(snapshot.qualified_play_count, 2);
        assert_eq!(snapshot.qualified_listening_ms, 10_000);
        assert_eq!(snapshot.top_songs[0].play_count, 2);
        assert_eq!(snapshot.top_artists[0].id, "artist-one");
    }

    #[test]
    fn recovery_transfers_the_record_without_counting_the_position_jump() {
        let service = service();
        let track = song("recover", 100_000);
        observe_snapshot(
            &service,
            "player.track",
            1_000,
            &snapshot(1, track.clone(), PlaybackState::Loading, 0, 0),
        );
        observe_snapshot(
            &service,
            "player.playback",
            1_001,
            &snapshot(1, track.clone(), PlaybackState::Playing, 0, 0),
        );
        observe_snapshot(
            &service,
            "player.position",
            6_000,
            &snapshot(1, track.clone(), PlaybackState::Playing, 5_000, 0),
        );
        observe_transition(&service, 6_001, 1, PlaybackTransitionReason::Recovery);
        observe_snapshot(
            &service,
            "player.track",
            7_000,
            &snapshot(2, track.clone(), PlaybackState::Loading, 5_000, 0),
        );
        observe_snapshot(
            &service,
            "player.playback",
            8_000,
            &snapshot(2, track.clone(), PlaybackState::Playing, 5_000, 0),
        );
        observe_snapshot(
            &service,
            "player.position",
            13_000,
            &snapshot(2, track, PlaybackState::Playing, 10_000, 0),
        );
        observe_transition(&service, 13_001, 2, PlaybackTransitionReason::Completed);

        let sessions = service
            .storage
            .listening_sessions_for_export(StatisticsRange::AllTime, u64::MAX)
            .expect("session export");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].listened_ms, 10_000);
        assert_eq!(sessions[0].outcome, ListeningOutcome::Completed);
    }

    #[test]
    fn explicit_navigation_and_queue_replacement_use_thresholded_outcomes() {
        let service = service();
        let early_next = song("early-next", 100_000);
        play_forward(&service, 1, &early_next, Some(100_000), 5_000);
        observe_transition(&service, 105_001, 1, PlaybackTransitionReason::Skipped);

        let qualified_previous = song("qualified-previous", 100_000);
        play_forward(&service, 2, &qualified_previous, Some(100_000), 30_000);
        observe_transition(&service, 230_001, 2, PlaybackTransitionReason::Skipped);

        let replaced = song("queue-replaced", 100_000);
        play_forward(&service, 3, &replaced, Some(100_000), 5_000);
        observe_transition(
            &service,
            305_001,
            3,
            PlaybackTransitionReason::QueueReplaced,
        );

        let sessions = service
            .storage
            .listening_sessions_for_export(StatisticsRange::AllTime, u64::MAX)
            .expect("session export");
        let outcomes = sessions
            .into_iter()
            .map(|session| (session.track_id, session.outcome))
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(outcomes["early-next"], ListeningOutcome::Skipped);
        assert_eq!(outcomes["qualified-previous"], ListeningOutcome::Qualified);
        assert_eq!(outcomes["queue-replaced"], ListeningOutcome::Stopped);
    }

    #[test]
    fn preview_unknown_duration_and_fatal_errors_follow_v1_policy() {
        let service = service();
        let preview = song("preview", 180_000);
        let mut preview_snapshot = play_forward(&service, 1, &preview, Some(20_000), 10_000);
        preview_snapshot.source_selection = Some(PlaybackSourceSelection {
            requested_quality: AudioQualityPreference::Lossless,
            resolved_quality: AudioQuality::High,
            fallback_reason: Some(PlaybackFallbackReason::PreviewOnly),
            preview: true,
            quality_capabilities: Vec::new(),
        });
        observe_snapshot(&service, "player.playback", 110_001, &preview_snapshot);
        observe_transition(&service, 110_002, 1, PlaybackTransitionReason::Skipped);

        let unknown = song("unknown-duration", 0);
        play_forward(&service, 2, &unknown, None, 25_000);
        observe_transition(&service, 225_001, 2, PlaybackTransitionReason::Skipped);

        let early_error = song("early-error", 100_000);
        let mut fatal = play_forward(&service, 3, &early_error, Some(100_000), 5_000);
        fatal.playback_state = PlaybackState::FatalError;
        fatal.is_playing = false;
        fatal.playback_error = Some(PlaybackFailure {
            code: "decoder-failed".to_owned(),
            message: "fixture error".to_owned(),
            retryable: false,
        });
        observe_snapshot(&service, "player.error", 305_001, &fatal);

        let qualified_error = song("qualified-error", 100_000);
        let mut fatal = play_forward(&service, 4, &qualified_error, Some(100_000), 30_000);
        fatal.playback_state = PlaybackState::FatalError;
        fatal.is_playing = false;
        fatal.playback_error = Some(PlaybackFailure {
            code: "network-failed".to_owned(),
            message: "fixture error".to_owned(),
            retryable: false,
        });
        observe_snapshot(&service, "player.error", 430_001, &fatal);

        let sessions = service
            .storage
            .listening_sessions_for_export(StatisticsRange::AllTime, u64::MAX)
            .expect("session export");
        let sessions = sessions
            .into_iter()
            .map(|session| (session.track_id.clone(), session))
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(sessions["preview"].outcome, ListeningOutcome::Qualified);
        assert!(sessions["preview"].preview);
        assert_eq!(
            sessions["preview"].resolved_quality.as_deref(),
            Some("high")
        );
        assert_eq!(
            sessions["unknown-duration"].outcome,
            ListeningOutcome::Skipped
        );
        assert_eq!(sessions["early-error"].outcome, ListeningOutcome::Error);
        assert_eq!(
            sessions["early-error"].error_code.as_deref(),
            Some("decoder-failed")
        );
        assert_eq!(
            sessions["qualified-error"].outcome,
            ListeningOutcome::Qualified
        );
        assert_eq!(
            sessions["qualified-error"].error_code.as_deref(),
            Some("network-failed")
        );
    }

    #[test]
    fn export_totals_match_and_clear_preserves_unrelated_storage() {
        let service = service();
        service
            .storage
            .set_setting("preserve-me", "yes")
            .expect("setting write");
        let track = song("export", 10_000);
        observe_snapshot(
            &service,
            "player.track",
            1_000,
            &snapshot(1, track, PlaybackState::Loading, 0, 0),
        );
        observe_transition(&service, 2_000, 1, PlaybackTransitionReason::Completed);
        let qualified = song("export-qualified", 100_000);
        play_forward(&service, 2, &qualified, Some(100_000), 30_000);
        observe_transition(&service, 230_001, 2, PlaybackTransitionReason::Skipped);
        let skipped = song("export-skipped", 100_000);
        play_forward(&service, 3, &skipped, Some(100_000), 5_000);
        observe_transition(&service, 305_001, 3, PlaybackTransitionReason::Skipped);

        let directory = tempfile::tempdir().expect("export directory");
        let json_path = directory.path().join("statistics.json");
        let csv_path = directory.path().join("statistics.csv");
        service
            .export(StatisticsExportRequest {
                range: StatisticsRange::AllTime,
                format: StatisticsExportFormat::Json,
                path: json_path.to_string_lossy().into_owned(),
            })
            .expect("JSON export");
        service
            .export(StatisticsExportRequest {
                range: StatisticsRange::AllTime,
                format: StatisticsExportFormat::Csv,
                path: csv_path.to_string_lossy().into_owned(),
            })
            .expect("CSV export");
        let json: Value =
            serde_json::from_slice(&fs::read(json_path).expect("JSON read")).expect("JSON parses");
        let statistics = &json["statistics"];
        assert_eq!(statistics["qualifiedListeningMs"], 30_000);
        assert_eq!(statistics["qualifiedPlayCount"], 2);
        assert_eq!(statistics["completedCount"], 1);
        assert_eq!(statistics["skippedCount"], 1);
        let csv = fs::read_to_string(csv_path).expect("CSV read");
        let summary = csv
            .lines()
            .nth(1)
            .expect("CSV contains the summary row")
            .split(',')
            .collect::<Vec<_>>();
        assert_eq!(&summary[18..22], ["30000", "2", "1", "1"]);
        let csv_skip_rate = summary[22].parse::<f64>().expect("CSV skip rate");
        let json_skip_rate = statistics["skipRate"].as_f64().expect("JSON skip rate");
        assert!((csv_skip_rate - json_skip_rate).abs() < f64::EPSILON);

        let cleared = service.clear().expect("statistics clear");
        assert_eq!(cleared.deleted_sessions, 3);
        assert_eq!(
            service
                .storage
                .get_setting("preserve-me")
                .expect("setting read")
                .as_deref(),
            Some("yes")
        );
        assert_eq!(
            service
                .snapshot(StatisticsRange::AllTime)
                .expect("empty statistics")
                .record_count,
            0
        );
    }

    #[test]
    fn startup_recovers_orphaned_in_progress_rows_as_stopped() {
        let storage = Arc::new(StorageService::temporary());
        let record = ListeningSessionRecord {
            session_id: "orphan".to_owned(),
            provider_id: "fake".to_owned(),
            track_id: "one".to_owned(),
            display: ListeningDisplaySnapshot {
                title: "One".to_owned(),
                album_id: None,
                album_title: String::new(),
                artists: Vec::new(),
            },
            started_at_ms: 1_000,
            ended_at_ms: None,
            listened_ms: 4_000,
            playable_duration_ms: Some(10_000),
            outcome: ListeningOutcome::InProgress,
            source_context: "direct".to_owned(),
            requested_quality: None,
            resolved_quality: None,
            preview: false,
            error_code: None,
            updated_at_ms: 5_000,
        };
        storage
            .upsert_listening_session(&record)
            .expect("orphan checkpoint");
        let service = StatisticsService::new(storage).expect("service recovers");
        let sessions = service
            .storage
            .listening_sessions_for_export(StatisticsRange::AllTime, u64::MAX)
            .expect("session export");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].outcome, ListeningOutcome::Stopped);
        assert!(sessions[0].ended_at_ms.is_some());
    }
}
