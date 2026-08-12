use crate::{
    audio::{AudioEngine, AudioEngineError, AudioOutputDevice},
    media::{MediaPreparer, PlaybackEpochGuard, PlaybackSourceError, PlaybackSourceResolver},
    qqmusic::PlaybackSourceSelection,
};
use rand::seq::SliceRandom;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use thiserror::Error;
use tokio::sync::{broadcast, RwLock};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Artwork {
    pub src: String,
    pub alt: String,
    pub dominant_color: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ArtistSummary {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct AlbumSummary {
    pub id: String,
    pub title: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AudioQuality {
    Standard,
    High,
    Lossless,
    Master,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AudioCodec {
    Mp3,
    Aac,
    Flac,
    Alac,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFormatInfo {
    pub quality: AudioQuality,
    pub codec: AudioCodec,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bitrate_kbps: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_rate_hz: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bit_depth: Option<u16>,
    pub lossless: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTrackReference {
    pub provider_id: String,
    pub track_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub numeric_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub album_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum PlaybackCapability {
    Full,
    Preview {
        #[serde(rename = "startMs")]
        start_ms: u64,
        #[serde(rename = "endMs")]
        end_ms: u64,
    },
    Unavailable {
        reason: String,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum SongAvailability {
    Available,
    Unavailable {
        reason: String,
    },
    EntitlementRequired {
        #[serde(rename = "requiredTier")]
        required_tier: String,
    },
}

impl SongAvailability {
    fn is_available(&self) -> bool {
        // Account-gated catalog rows still need to reach the account-bound
        // source resolver. Only the resolver has the current entitlement and
        // can make the authoritative allow/fallback/deny decision.
        matches!(self, Self::Available | Self::EntitlementRequired { .. })
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Song {
    pub id: String,
    pub title: String,
    pub artists: Vec<ArtistSummary>,
    pub album: AlbumSummary,
    pub artwork: Artwork,
    pub duration_ms: u64,
    pub track_number: u32,
    pub is_favorite: bool,
    pub quality: AudioQuality,
    pub availability: SongAvailability,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub audio_formats: Vec<AudioFormatInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playback_capability: Option<PlaybackCapability>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<ProviderTrackReference>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RepeatMode {
    #[default]
    Off,
    All,
    One,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricVocalist {
    pub id: String,
    pub display_name: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricWord {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricLine {
    pub id: String,
    pub start_ms: Option<u64>,
    pub end_ms: Option<u64>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub translation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub romanization: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vocalist_id: Option<String>,
    #[serde(default)]
    pub words: Vec<LyricWord>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricMetadata {
    pub source_label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub translated_language: Option<String>,
    pub offset_ms: i64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LyricSyncMode {
    Unsynchronized,
    Line,
    Word,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricDocument {
    pub song_id: String,
    pub sync_mode: LyricSyncMode,
    pub metadata: LyricMetadata,
    #[serde(default)]
    pub vocalists: Vec<LyricVocalist>,
    pub lines: Vec<LyricLine>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayTracksRequest {
    pub tracks: Vec<Song>,
    pub start_at_id: Option<String>,
    #[serde(default)]
    pub shuffle: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSnapshot {
    pub queue: Vec<Song>,
    pub current_index: Option<usize>,
    pub position_ms: u64,
    pub is_playing: bool,
    pub volume: f64,
    pub is_muted: bool,
    pub repeat: RepeatMode,
    pub shuffle: bool,
    pub playback_state: PlaybackState,
    pub playback_duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playback_error: Option<PlaybackFailure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_selection: Option<PlaybackSourceSelection>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlaybackState {
    #[default]
    Idle,
    Loading,
    Buffering,
    Playing,
    Paused,
    Stopped,
    Ended,
    RecoverableError,
    FatalError,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackFailure {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueSnapshot {
    pub current_index: Option<usize>,
    pub tracks: Vec<Song>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentLyricState {
    pub song_id: Option<String>,
    pub position_ms: u64,
    pub line_index: Option<usize>,
    pub word_index: Option<usize>,
    pub line: Option<LyricLine>,
    pub word: Option<LyricWord>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricSurfaceProjection {
    pub timestamp_ms: u64,
    pub current_track: Option<Song>,
    pub position_ms: u64,
    pub is_playing: bool,
    pub playback_state: PlaybackState,
    pub playback_duration_ms: Option<u64>,
    pub sync_mode: Option<LyricSyncMode>,
    pub line_index: Option<usize>,
    pub word_index: Option<usize>,
    pub current_line: Option<LyricLine>,
    pub next_line: Option<LyricLine>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiEvent {
    pub version: u8,
    #[serde(rename = "type")]
    pub event_type: String,
    pub timestamp_ms: u64,
    pub data: Value,
}

#[derive(Debug, Error)]
pub enum PlayerError {
    #[error("the queue is empty")]
    EmptyQueue,
    #[error("queue index {0} is out of range")]
    IndexOutOfRange(usize),
    #[error("the requested queue has no playable tracks")]
    NoPlayableTracks,
    #[error("volume must be between 0 and 1")]
    InvalidVolume,
    #[error("playback failed: {0}")]
    Playback(String),
}

#[derive(Default)]
struct PlayerCore {
    queue: Vec<Song>,
    current_index: Option<usize>,
    position_ms: u64,
    playback_state: PlaybackState,
    playback_duration_ms: Option<u64>,
    playback_error: Option<PlaybackFailure>,
    timeline_offset_ms: u64,
    volume: f64,
    is_muted: bool,
    repeat: RepeatMode,
    shuffle: bool,
    lyrics: Option<LyricDocument>,
    source_selection: Option<PlaybackSourceSelection>,
    active_epoch_guard: Option<PlaybackEpochGuard>,
}

impl PlayerCore {
    fn snapshot(&self) -> PlayerSnapshot {
        PlayerSnapshot {
            queue: self.queue.clone(),
            current_index: self.current_index,
            position_ms: self.position_ms,
            is_playing: self.playback_state == PlaybackState::Playing,
            volume: self.volume,
            is_muted: self.is_muted,
            repeat: self.repeat,
            shuffle: self.shuffle,
            playback_state: self.playback_state,
            playback_duration_ms: self.playback_duration_ms,
            playback_error: self.playback_error.clone(),
            source_selection: self.source_selection.clone(),
        }
    }

    fn current_song(&self) -> Option<&Song> {
        self.current_index.and_then(|index| self.queue.get(index))
    }
}

pub struct PlayerService {
    core: Arc<RwLock<PlayerCore>>,
    events: broadcast::Sender<ApiEvent>,
    clock_running: AtomicBool,
    transition_running: AtomicBool,
    recovery_running: AtomicBool,
    runtime_expiry_retry_available: AtomicBool,
    load_generation: Arc<AtomicU64>,
    audio: Arc<dyn AudioEngine>,
    resolver: Arc<dyn PlaybackSourceResolver>,
    preparer: Arc<dyn MediaPreparer>,
}

impl PlayerService {
    pub fn with_runtime(
        audio: Arc<dyn AudioEngine>,
        resolver: Arc<dyn PlaybackSourceResolver>,
        preparer: Arc<dyn MediaPreparer>,
    ) -> Self {
        let (events, _) = broadcast::channel(256);
        Self {
            core: Arc::new(RwLock::new(PlayerCore {
                volume: 0.72,
                ..PlayerCore::default()
            })),
            events,
            clock_running: AtomicBool::new(false),
            transition_running: AtomicBool::new(false),
            recovery_running: AtomicBool::new(false),
            runtime_expiry_retry_available: AtomicBool::new(true),
            load_generation: Arc::new(AtomicU64::new(0)),
            audio,
            resolver,
            preparer,
        }
    }

    #[cfg(test)]
    pub fn new() -> Self {
        Self::with_runtime(
            Arc::new(crate::audio::TestAudioEngine::default()),
            Arc::new(crate::media::TestPlaybackSourceResolver),
            Arc::new(crate::media::PassthroughMediaPreparer),
        )
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ApiEvent> {
        self.events.subscribe()
    }

    pub async fn snapshot(&self) -> PlayerSnapshot {
        self.core.read().await.snapshot()
    }

    pub async fn current_track(&self) -> Option<Song> {
        self.core.read().await.current_song().cloned()
    }

    pub async fn queue_snapshot(&self) -> QueueSnapshot {
        let core = self.core.read().await;
        QueueSnapshot {
            current_index: core.current_index,
            tracks: core.queue.clone(),
        }
    }

    pub async fn lyrics(&self) -> Option<LyricDocument> {
        self.core.read().await.lyrics.clone()
    }

    pub async fn current_lyric_state(&self) -> CurrentLyricState {
        let core = self.core.read().await;
        current_lyric_state(&core)
    }

    pub async fn lyric_surface_projection(&self) -> LyricSurfaceProjection {
        let core = self.core.read().await;
        let lyric = current_lyric_state(&core);
        let next_line = lyric.line_index.and_then(|index| {
            core.lyrics
                .as_ref()
                .and_then(|document| document.lines.get(index + 1))
                .cloned()
        });
        LyricSurfaceProjection {
            timestamp_ms: unix_timestamp_ms(),
            current_track: core.current_song().cloned(),
            position_ms: core.position_ms,
            is_playing: core.playback_state == PlaybackState::Playing,
            playback_state: core.playback_state,
            playback_duration_ms: core.playback_duration_ms,
            sync_mode: core.lyrics.as_ref().map(|document| document.sync_mode),
            line_index: lyric.line_index,
            word_index: lyric.word_index,
            current_line: lyric.line,
            next_line,
        }
    }

    async fn mutate<F>(&self, event_type: &str, mutation: F) -> Result<PlayerSnapshot, PlayerError>
    where
        F: FnOnce(&mut PlayerCore) -> Result<(), PlayerError>,
    {
        let snapshot = {
            let mut core = self.core.write().await;
            mutation(&mut core)?;
            core.snapshot()
        };
        self.publish(event_type, &snapshot);
        Ok(snapshot)
    }

    pub async fn hydrate_queue(&self, tracks: Vec<Song>) -> PlayerSnapshot {
        let mut core = self.core.write().await;
        if core.queue.is_empty() && !tracks.is_empty() {
            core.queue = tracks;
            core.current_index = Some(0);
        }
        let snapshot = core.snapshot();
        drop(core);
        self.publish("queue.changed", &snapshot);
        snapshot
    }

    pub async fn restore(&self, snapshot: PlayerSnapshot) -> PlayerSnapshot {
        let restored = {
            let mut core = self.core.write().await;
            core.queue = snapshot.queue;
            core.current_index = snapshot
                .current_index
                .filter(|index| *index < core.queue.len());
            core.volume = snapshot.volume.clamp(0.0, 1.0);
            core.is_muted = snapshot.is_muted;
            core.repeat = snapshot.repeat;
            core.shuffle = snapshot.shuffle;
            core.playback_duration_ms = snapshot.playback_duration_ms.or_else(|| {
                core.current_index
                    .and_then(|index| core.queue.get(index))
                    .map(|song| song.duration_ms)
            });
            let duration = core.playback_duration_ms.unwrap_or(0);
            core.position_ms = if snapshot.position_ms < duration {
                snapshot.position_ms
            } else {
                0
            };
            core.playback_state = if core.current_index.is_some() {
                PlaybackState::Paused
            } else {
                PlaybackState::Idle
            };
            core.playback_error = None;
            core.timeline_offset_ms = 0;
            core.source_selection = None;
            core.active_epoch_guard = None;
            core.lyrics = None;
            core.snapshot()
        };
        let _ = self.audio.set_volume(if restored.is_muted {
            0.0
        } else {
            restored.volume as f32
        });
        self.publish("queue.changed", &restored);
        restored
    }

    pub async fn play_tracks(
        &self,
        request: PlayTracksRequest,
    ) -> Result<PlayerSnapshot, PlayerError> {
        let tracks: Vec<_> = request
            .tracks
            .into_iter()
            .filter(|track| track.availability.is_available())
            .collect();
        if tracks.is_empty() {
            return Err(PlayerError::NoPlayableTracks);
        }
        let index = request
            .start_at_id
            .as_deref()
            .and_then(|id| tracks.iter().position(|track| track.id == id))
            .unwrap_or(0);
        {
            let mut core = self.core.write().await;
            core.queue = tracks;
            core.current_index = Some(index);
            core.position_ms = 0;
            core.lyrics = None;
            if let Some(shuffle) = request.shuffle {
                core.shuffle = shuffle;
            }
        }
        self.load_index(index, true, 0).await
    }

    pub async fn play_from_queue(&self, index: usize) -> Result<PlayerSnapshot, PlayerError> {
        if index >= self.core.read().await.queue.len() {
            return Err(PlayerError::IndexOutOfRange(index));
        }
        self.load_index(index, true, 0).await
    }

    pub async fn reload_current(&self) -> Result<PlayerSnapshot, PlayerError> {
        let (index, position_ms, autoplay) = {
            let core = self.core.read().await;
            (
                core.current_index.ok_or(PlayerError::EmptyQueue)?,
                core.position_ms,
                matches!(
                    core.playback_state,
                    PlaybackState::Playing | PlaybackState::Buffering
                ),
            )
        };
        self.load_index(index, autoplay, position_ms).await
    }

    pub async fn play(&self) -> Result<PlayerSnapshot, PlayerError> {
        let (index, position, loaded, guard) = {
            let core = self.core.read().await;
            (
                core.current_index.ok_or(PlayerError::EmptyQueue)?,
                core.position_ms,
                self.audio.snapshot().loaded,
                core.active_epoch_guard.clone(),
            )
        };
        if guard
            .as_ref()
            .is_some_and(|guard| guard.validate().is_err())
        {
            return Err(self.cancel_active_source().await);
        }
        if !loaded {
            return self.load_index(index, true, position).await;
        }
        if let Err(error) = self.audio.play() {
            return Err(self.record_audio_failure(&error).await);
        }
        let Some(guard) = guard else {
            return self
                .mutate("player.playback", |core| {
                    core.playback_state = PlaybackState::Playing;
                    core.playback_error = None;
                    Ok(())
                })
                .await;
        };
        let commit = {
            let mut core = self.core.write().await;
            if guard.validate().is_err() {
                Err(PlaybackSourceError::Cancelled)
            } else if !core
                .active_epoch_guard
                .as_ref()
                .is_some_and(|active| active.same_instance(&guard))
            {
                return Ok(core.snapshot());
            } else {
                let result = guard.validate_and_run(|| {
                    core.playback_state = PlaybackState::Playing;
                    core.playback_error = None;
                    core.snapshot()
                });
                if let Ok(snapshot) = &result {
                    self.publish("player.playback", snapshot);
                }
                result
            }
        };
        match commit {
            Ok(snapshot) => Ok(snapshot),
            Err(_) => Err(self.cancel_active_source().await),
        }
    }

    pub async fn pause(&self) -> Result<PlayerSnapshot, PlayerError> {
        self.load_generation.fetch_add(1, Ordering::AcqRel);
        if let Err(error) = self.audio.pause() {
            return Err(self.record_audio_failure(&error).await);
        }
        let engine_position = self.audio.snapshot().position_ms;
        self.mutate("player.playback", |core| {
            core.position_ms = core.timeline_offset_ms.saturating_add(engine_position);
            core.playback_state = PlaybackState::Paused;
            Ok(())
        })
        .await
    }

    pub async fn stop(&self) -> Result<PlayerSnapshot, PlayerError> {
        self.load_generation.fetch_add(1, Ordering::AcqRel);
        if let Err(error) = self.audio.stop() {
            return Err(self.record_audio_failure(&error).await);
        }
        self.mutate("player.playback", |core| {
            core.position_ms = core.timeline_offset_ms;
            core.playback_state = PlaybackState::Stopped;
            core.playback_error = None;
            core.source_selection = None;
            core.active_epoch_guard = None;
            Ok(())
        })
        .await
    }

    pub async fn toggle(&self) -> Result<PlayerSnapshot, PlayerError> {
        if self.core.read().await.playback_state == PlaybackState::Playing {
            self.pause().await
        } else {
            self.play().await
        }
    }

    pub async fn next(&self) -> Result<PlayerSnapshot, PlayerError> {
        let candidates = self.next_candidates().await?;
        self.load_candidates(candidates).await
    }

    pub async fn previous(&self) -> Result<PlayerSnapshot, PlayerError> {
        let (current, position) = {
            let core = self.core.read().await;
            (
                core.current_index.ok_or(PlayerError::EmptyQueue)?,
                core.position_ms,
            )
        };
        if position > 4_000 {
            self.seek(0).await
        } else {
            self.load_index(current.saturating_sub(1), true, 0).await
        }
    }

    pub async fn seek(&self, position_ms: u64) -> Result<PlayerSnapshot, PlayerError> {
        let (bounded, offset, index, loaded, was_ended) = {
            let core = self.core.read().await;
            let song = core.current_song().ok_or(PlayerError::EmptyQueue)?;
            let duration = core.playback_duration_ms.unwrap_or(song.duration_ms);
            (
                position_ms.clamp(core.timeline_offset_ms, duration),
                core.timeline_offset_ms,
                core.current_index.expect("current song has an index"),
                self.audio.snapshot().loaded,
                core.playback_state == PlaybackState::Ended,
            )
        };
        if !loaded || was_ended {
            return self.load_index(index, false, bounded).await;
        }
        if let Err(error) = self
            .audio
            .seek(Duration::from_millis(bounded.saturating_sub(offset)))
        {
            return Err(self.record_audio_failure(&error).await);
        }
        self.mutate("player.seeked", move |core| {
            core.position_ms = bounded;
            Ok(())
        })
        .await
    }

    pub async fn set_volume(&self, volume: f64) -> Result<PlayerSnapshot, PlayerError> {
        if !(0.0..=1.0).contains(&volume) || !volume.is_finite() {
            return Err(PlayerError::InvalidVolume);
        }
        if let Err(error) = self.audio.set_volume(volume as f32) {
            return Err(self.record_audio_failure(&error).await);
        }
        self.mutate("player.volume", move |core| {
            core.volume = volume;
            core.is_muted = false;
            Ok(())
        })
        .await
    }

    pub async fn toggle_muted(&self) -> Result<PlayerSnapshot, PlayerError> {
        let (muted, volume) = {
            let core = self.core.read().await;
            (!core.is_muted, core.volume)
        };
        if let Err(error) = self
            .audio
            .set_volume(if muted { 0.0 } else { volume as f32 })
        {
            return Err(self.record_audio_failure(&error).await);
        }
        self.mutate("player.volume", |core| {
            core.is_muted = !core.is_muted;
            Ok(())
        })
        .await
    }

    pub async fn set_shuffle(&self, enabled: bool) -> PlayerSnapshot {
        self.mutate("player.mode", move |core| {
            core.shuffle = enabled;
            Ok(())
        })
        .await
        .expect("shuffle cannot fail")
    }

    pub async fn toggle_shuffle(&self) -> PlayerSnapshot {
        self.mutate("player.mode", |core| {
            core.shuffle = !core.shuffle;
            Ok(())
        })
        .await
        .expect("shuffle cannot fail")
    }

    pub async fn set_repeat(&self, repeat: RepeatMode) -> PlayerSnapshot {
        self.mutate("player.mode", move |core| {
            core.repeat = repeat;
            Ok(())
        })
        .await
        .expect("repeat cannot fail")
    }

    pub async fn cycle_repeat(&self) -> PlayerSnapshot {
        self.mutate("player.mode", |core| {
            core.repeat = match core.repeat {
                RepeatMode::Off => RepeatMode::All,
                RepeatMode::All => RepeatMode::One,
                RepeatMode::One => RepeatMode::Off,
            };
            Ok(())
        })
        .await
        .expect("repeat cannot fail")
    }

    pub async fn add_to_queue(&self, track: Song) -> PlayerSnapshot {
        self.mutate("queue.changed", move |core| {
            core.queue.push(track);
            if core.current_index.is_none() {
                core.current_index = Some(0);
            }
            Ok(())
        })
        .await
        .expect("queue append cannot fail")
    }

    pub async fn add_tracks_to_queue(&self, tracks: Vec<Song>) -> PlayerSnapshot {
        self.mutate("queue.changed", move |core| {
            core.queue.extend(tracks);
            if core.current_index.is_none() && !core.queue.is_empty() {
                core.current_index = Some(0);
            }
            Ok(())
        })
        .await
        .expect("queue append cannot fail")
    }

    pub async fn remove_from_queue(&self, index: usize) -> Result<PlayerSnapshot, PlayerError> {
        let (snapshot, reload, became_empty) = {
            let mut core = self.core.write().await;
            if index >= core.queue.len() {
                return Err(PlayerError::IndexOutOfRange(index));
            }
            let removed_current = core.current_index == Some(index);
            let autoplay = core.playback_state == PlaybackState::Playing;
            core.queue.remove(index);
            if core.queue.is_empty() {
                core.current_index = None;
                core.position_ms = 0;
                core.playback_state = PlaybackState::Idle;
                core.playback_duration_ms = None;
                core.source_selection = None;
                core.active_epoch_guard = None;
            } else if let Some(current) = core.current_index {
                core.current_index = Some(if index < current {
                    current - 1
                } else {
                    current.min(core.queue.len() - 1)
                });
            }
            let reload =
                removed_current.then_some((core.current_index.expect("non-empty queue"), autoplay));
            (core.snapshot(), reload, core.queue.is_empty())
        };
        self.publish("queue.changed", &snapshot);
        if became_empty {
            self.load_generation.fetch_add(1, Ordering::AcqRel);
            let _ = self.audio.stop();
        }
        if let Some((next_index, autoplay)) = reload {
            return self.load_index(next_index, autoplay, 0).await;
        }
        Ok(snapshot)
    }

    pub fn output_devices(&self) -> Result<Vec<AudioOutputDevice>, PlayerError> {
        self.audio
            .output_devices()
            .map_err(|error| PlayerError::Playback(audio_failure(&error).message))
    }

    pub fn set_output_device(
        &self,
        device_id: &str,
    ) -> Result<Vec<AudioOutputDevice>, PlayerError> {
        self.audio
            .set_output_device(device_id)
            .map_err(|error| PlayerError::Playback(audio_failure(&error).message))?;
        self.output_devices()
    }

    async fn load_index(
        &self,
        index: usize,
        autoplay: bool,
        resume_position_ms: u64,
    ) -> Result<PlayerSnapshot, PlayerError> {
        self.load_index_with_policy(index, autoplay, resume_position_ms, true)
            .await
    }

    async fn load_index_with_policy(
        &self,
        index: usize,
        autoplay: bool,
        resume_position_ms: u64,
        allow_runtime_expiry_retry: bool,
    ) -> Result<PlayerSnapshot, PlayerError> {
        self.runtime_expiry_retry_available
            .store(allow_runtime_expiry_retry, Ordering::Release);
        let generation = self.load_generation.fetch_add(1, Ordering::AcqRel) + 1;
        let (song, start_snapshot) = {
            let mut core = self.core.write().await;
            if index >= core.queue.len() {
                return Err(PlayerError::IndexOutOfRange(index));
            }
            let previous_song_id = core.current_song().map(|song| song.id.clone());
            core.current_index = Some(index);
            core.position_ms = resume_position_ms.min(core.queue[index].duration_ms);
            core.playback_state = PlaybackState::Loading;
            core.playback_error = None;
            core.playback_duration_ms = Some(core.queue[index].duration_ms);
            core.timeline_offset_ms = 0;
            core.source_selection = None;
            core.active_epoch_guard = None;
            if previous_song_id.as_deref() != Some(core.queue[index].id.as_str()) {
                core.lyrics = None;
            }
            (core.queue[index].clone(), core.snapshot())
        };
        let _ = self.audio.stop();
        self.publish("player.track", &start_snapshot);

        let resolved = match self.resolver.resolve(&song).await {
            Ok(source) => source,
            Err(error) => return self.fail_load(generation, &error).await,
        };
        if generation != self.load_generation.load(Ordering::Acquire) {
            return Ok(self.snapshot().await);
        }
        let buffering = {
            let mut core = self.core.write().await;
            core.playback_state = PlaybackState::Buffering;
            core.snapshot()
        };
        self.publish("player.playback", &buffering);

        let prepared = match self.preparer.prepare(resolved).await {
            Ok(source) => source,
            Err(PlaybackSourceError::UrlExpired) if allow_runtime_expiry_retry => {
                let refreshed = match self.resolver.resolve(&song).await {
                    Ok(source) => source,
                    Err(error) => return self.fail_load(generation, &error).await,
                };
                match self.preparer.prepare(refreshed).await {
                    Ok(source) => source,
                    Err(error) => return self.fail_load(generation, &error).await,
                }
            }
            Err(error) => return self.fail_load(generation, &error).await,
        };
        if generation != self.load_generation.load(Ordering::Acquire) {
            return Ok(self.snapshot().await);
        }

        if prepared.epoch_guard.validate().is_err() {
            return self
                .fail_load(generation, &PlaybackSourceError::Cancelled)
                .await;
        }
        let metadata = match self.audio.load(&prepared) {
            Ok(metadata) => metadata,
            Err(error) => return Err(self.record_audio_failure(&error).await),
        };
        if prepared.epoch_guard.validate().is_err() {
            let _ = self.audio.stop();
            return self
                .fail_load(generation, &PlaybackSourceError::Cancelled)
                .await;
        }
        if generation != self.load_generation.load(Ordering::Acquire) {
            let _ = self.audio.stop();
            return Ok(self.snapshot().await);
        }
        let (volume, muted) = {
            let core = self.core.read().await;
            (core.volume, core.is_muted)
        };
        if let Err(error) = self
            .audio
            .set_volume(if muted { 0.0 } else { volume as f32 })
        {
            return Err(self.record_audio_failure(&error).await);
        }
        let local_resume = resume_position_ms.saturating_sub(prepared.timeline_offset_ms);
        if local_resume > 0 {
            if let Err(error) = self.audio.seek(Duration::from_millis(local_resume)) {
                return Err(self.record_audio_failure(&error).await);
            }
        }
        if autoplay {
            if prepared.epoch_guard.validate().is_err() {
                let _ = self.audio.stop();
                return self
                    .fail_load(generation, &PlaybackSourceError::Cancelled)
                    .await;
            }
            if let Err(error) = self.audio.play() {
                return Err(self.record_audio_failure(&error).await);
            }
            if prepared.epoch_guard.validate().is_err() {
                let _ = self.audio.stop();
                return self
                    .fail_load(generation, &PlaybackSourceError::Cancelled)
                    .await;
            }
        }

        let commit = {
            let mut core = self.core.write().await;
            if generation != self.load_generation.load(Ordering::Acquire) {
                let snapshot = core.snapshot();
                drop(core);
                let _ = self.audio.stop();
                return Ok(snapshot);
            }
            let playable_duration = metadata
                .duration_ms
                .map(|duration| prepared.timeline_offset_ms.saturating_add(duration))
                .or(prepared.timeline_end_ms)
                .unwrap_or(song.duration_ms);
            prepared.epoch_guard.validate_and_run(|| {
                core.timeline_offset_ms = prepared.timeline_offset_ms;
                core.position_ms = resume_position_ms
                    .max(prepared.timeline_offset_ms)
                    .min(playable_duration);
                core.playback_duration_ms = Some(playable_duration);
                core.playback_state = if autoplay {
                    PlaybackState::Playing
                } else {
                    PlaybackState::Paused
                };
                core.playback_error = None;
                core.source_selection = Some(prepared.selection.clone());
                core.active_epoch_guard = Some(prepared.epoch_guard.clone());
                core.snapshot()
            })
        };
        let snapshot = match commit {
            Ok(snapshot) => snapshot,
            Err(_) => {
                let _ = self.audio.stop();
                return self
                    .fail_load(generation, &PlaybackSourceError::Cancelled)
                    .await;
            }
        };
        self.publish("player.playback", &snapshot);
        self.watch_epoch_invalidation(prepared.epoch_guard);
        Ok(snapshot)
    }

    async fn fail_load(
        &self,
        generation: u64,
        error: &PlaybackSourceError,
    ) -> Result<PlayerSnapshot, PlayerError> {
        if generation != self.load_generation.load(Ordering::Acquire) {
            return Ok(self.snapshot().await);
        }
        if matches!(error, PlaybackSourceError::Cancelled) {
            return Err(self.cancel_active_source().await);
        }
        let failure = source_failure(error);
        let snapshot = {
            let mut core = self.core.write().await;
            core.playback_state = if failure.retryable {
                PlaybackState::RecoverableError
            } else {
                PlaybackState::FatalError
            };
            core.playback_error = Some(failure.clone());
            core.source_selection = None;
            core.active_epoch_guard = None;
            core.snapshot()
        };
        self.publish("player.error", &snapshot);
        Err(PlayerError::Playback(failure.message))
    }

    async fn record_audio_failure(&self, error: &AudioEngineError) -> PlayerError {
        if matches!(error, AudioEngineError::SourceCancelled) {
            return self.cancel_active_source().await;
        }
        let failure = audio_failure(error);
        let snapshot = {
            let mut core = self.core.write().await;
            core.playback_state = if failure.retryable {
                PlaybackState::RecoverableError
            } else {
                PlaybackState::FatalError
            };
            core.playback_error = Some(failure.clone());
            core.source_selection = None;
            core.active_epoch_guard = None;
            core.snapshot()
        };
        self.publish("player.error", &snapshot);
        PlayerError::Playback(failure.message)
    }

    async fn cancel_active_source(&self) -> PlayerError {
        self.load_generation.fetch_add(1, Ordering::AcqRel);
        let _ = self.audio.stop();
        let snapshot = {
            let mut core = self.core.write().await;
            core.playback_state = if core.current_index.is_some() {
                PlaybackState::Stopped
            } else {
                PlaybackState::Idle
            };
            core.playback_error = None;
            core.source_selection = None;
            core.active_epoch_guard = None;
            core.snapshot()
        };
        self.publish("player.playback", &snapshot);
        PlayerError::Playback("The account-bound playback source was cancelled.".to_owned())
    }

    fn watch_epoch_invalidation(&self, guard: PlaybackEpochGuard) {
        if !guard.is_account_bound() {
            return;
        }
        let cancellation = guard.cancellation_token();
        let core = Arc::clone(&self.core);
        let audio = Arc::clone(&self.audio);
        let events = self.events.clone();
        let load_generation = Arc::clone(&self.load_generation);
        tauri::async_runtime::spawn(async move {
            cancellation.cancelled().await;
            let snapshot = {
                let mut core = core.write().await;
                if !core
                    .active_epoch_guard
                    .as_ref()
                    .is_some_and(|active| active.same_instance(&guard))
                {
                    return;
                }
                load_generation.fetch_add(1, Ordering::AcqRel);
                let _ = audio.stop();
                core.playback_state = if core.current_index.is_some() {
                    PlaybackState::Stopped
                } else {
                    PlaybackState::Idle
                };
                core.playback_error = None;
                core.source_selection = None;
                core.active_epoch_guard = None;
                core.snapshot()
            };
            let data = serde_json::to_value(&snapshot).unwrap_or_else(|_| json!({}));
            let _ = events.send(ApiEvent {
                version: 1,
                event_type: "player.playback".to_owned(),
                timestamp_ms: unix_timestamp_ms(),
                data,
            });
        });
    }

    async fn next_candidates(&self) -> Result<Vec<usize>, PlayerError> {
        let core = self.core.read().await;
        let current = core.current_index.ok_or(PlayerError::EmptyQueue)?;
        if core.queue.is_empty() {
            return Err(PlayerError::EmptyQueue);
        }
        let mut candidates = if core.shuffle {
            let mut values = (0..core.queue.len())
                .filter(|candidate| *candidate != current)
                .collect::<Vec<_>>();
            values.shuffle(&mut rand::rng());
            values
        } else {
            (current + 1..core.queue.len()).collect::<Vec<_>>()
        };
        if core.repeat == RepeatMode::All {
            if core.shuffle && candidates.is_empty() {
                candidates.push(current);
            } else if !core.shuffle {
                candidates.extend(0..=current);
            }
        }
        Ok(candidates)
    }

    async fn load_candidates(&self, candidates: Vec<usize>) -> Result<PlayerSnapshot, PlayerError> {
        if candidates.is_empty() {
            return Ok(self.mark_ended().await);
        }
        let mut last_error = None;
        for index in candidates {
            match self.load_index(index, true, 0).await {
                Ok(snapshot) => return Ok(snapshot),
                Err(error) => last_error = Some(error),
            }
        }
        Err(last_error.unwrap_or(PlayerError::NoPlayableTracks))
    }

    async fn mark_ended(&self) -> PlayerSnapshot {
        self.load_generation.fetch_add(1, Ordering::AcqRel);
        let _ = self.audio.stop();
        let snapshot = {
            let mut core = self.core.write().await;
            if let Some(duration) = core.playback_duration_ms {
                core.position_ms = duration;
            }
            core.playback_state = PlaybackState::Ended;
            core.source_selection = None;
            core.active_epoch_guard = None;
            core.snapshot()
        };
        self.publish("player.playback", &snapshot);
        snapshot
    }

    async fn handle_end(self: Arc<Self>) {
        let repeat = self.core.read().await.repeat;
        let result = if repeat == RepeatMode::One {
            let index = self.core.read().await.current_index;
            match index {
                Some(index) => self.load_index(index, true, 0).await,
                None => Err(PlayerError::EmptyQueue),
            }
        } else {
            match self.next_candidates().await {
                Ok(candidates) => self.load_candidates(candidates).await,
                Err(error) => Err(error),
            }
        };
        if let Err(error) = result {
            tracing::warn!(target: "player", error = %error, "automatic queue transition failed");
        }
        self.transition_running.store(false, Ordering::Release);
    }

    pub async fn set_lyrics(&self, document: Option<LyricDocument>) {
        let state = {
            let mut core = self.core.write().await;
            let current_song_id = core
                .current_index
                .and_then(|index| core.queue.get(index))
                .map(|song| song.id.as_str());
            if document
                .as_ref()
                .is_none_or(|candidate| Some(candidate.song_id.as_str()) == current_song_id)
            {
                core.lyrics = document;
            }
            current_lyric_state(&core)
        };
        self.publish("lyrics.changed", &state);
    }

    pub fn start_clock(self: &Arc<Self>) {
        if self.clock_running.swap(true, Ordering::AcqRel) {
            return;
        }
        let service = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(50));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut last_position_event = Instant::now();
            let mut previous_song_id: Option<String> = None;
            let mut previous_line_index: Option<usize> = None;
            let mut previous_word_index: Option<usize> = None;

            while service.clock_running.load(Ordering::Acquire) {
                interval.tick().await;
                let now = Instant::now();
                let engine = service.audio.snapshot();
                let (snapshot, should_advance, playback_changed, lyric_state, recovery) = {
                    let mut core = service.core.write().await;
                    let previous_state = core.playback_state;
                    let recovery = if engine.source_url_expired
                        && !service.recovery_running.swap(true, Ordering::AcqRel)
                    {
                        if service
                            .runtime_expiry_retry_available
                            .swap(false, Ordering::AcqRel)
                        {
                            let candidate = core.current_index.map(|index| {
                                (
                                    index,
                                    core.position_ms,
                                    matches!(
                                        previous_state,
                                        PlaybackState::Playing | PlaybackState::Buffering
                                    ),
                                )
                            });
                            if candidate.is_none() {
                                service.recovery_running.store(false, Ordering::Release);
                            }
                            candidate
                        } else {
                            service.recovery_running.store(false, Ordering::Release);
                            None
                        }
                    } else {
                        None
                    };
                    if engine.loaded {
                        core.position_ms =
                            core.timeline_offset_ms.saturating_add(engine.position_ms);
                        if let Some(duration) = engine.duration_ms {
                            core.playback_duration_ms =
                                Some(core.timeline_offset_ms.saturating_add(duration));
                        }
                    }
                    if let Some(message) = &engine.source_error {
                        if recovery.is_some() {
                            core.playback_state = PlaybackState::Buffering;
                            core.playback_error = None;
                        } else {
                            core.playback_state = PlaybackState::RecoverableError;
                            core.playback_error = Some(PlaybackFailure {
                                code: if engine.source_url_expired {
                                    "playback-link-expired"
                                } else {
                                    "streaming-failure"
                                }
                                .to_owned(),
                                message: message.clone(),
                                retryable: true,
                            });
                        }
                    } else if let Some(message) = &engine.output_error {
                        core.playback_state = PlaybackState::RecoverableError;
                        core.playback_error = Some(PlaybackFailure {
                            code: "output-device-unavailable".to_owned(),
                            message: message.clone(),
                            retryable: true,
                        });
                    } else if engine.buffering
                        && matches!(
                            core.playback_state,
                            PlaybackState::Playing | PlaybackState::Buffering
                        )
                    {
                        core.playback_state = PlaybackState::Buffering;
                    } else if engine.playing && core.playback_state != PlaybackState::Playing {
                        core.playback_state = PlaybackState::Playing;
                        core.playback_error = None;
                    }
                    let should_advance = engine.ended
                        && engine.source_error.is_none()
                        && matches!(
                            previous_state,
                            PlaybackState::Playing | PlaybackState::Buffering
                        );
                    let snapshot = core.snapshot();
                    let lyrics = current_lyric_state(&core);
                    (
                        snapshot,
                        should_advance,
                        previous_state != core.playback_state,
                        lyrics,
                        recovery,
                    )
                };

                if playback_changed {
                    service.publish("player.playback", &snapshot);
                }
                if snapshot.is_playing
                    && last_position_event.elapsed() >= Duration::from_millis(250)
                {
                    service.publish("player.position", &snapshot);
                    last_position_event = now;
                }
                if should_advance && !service.transition_running.swap(true, Ordering::AcqRel) {
                    let transition = Arc::clone(&service);
                    tauri::async_runtime::spawn(async move { transition.handle_end().await });
                }
                if let Some((index, position_ms, autoplay)) = recovery {
                    let recovery_service = Arc::clone(&service);
                    tauri::async_runtime::spawn(async move {
                        tracing::info!(target: "stream.range", position_ms, "re-resolving an expired progressive media URL once");
                        if let Err(error) = recovery_service
                            .load_index_with_policy(index, autoplay, position_ms, false)
                            .await
                        {
                            tracing::warn!(target: "stream.range", error = %error, "progressive URL recovery failed");
                        }
                        recovery_service
                            .recovery_running
                            .store(false, Ordering::Release);
                    });
                }

                let cursor_changed = previous_song_id != lyric_state.song_id
                    || previous_line_index != lyric_state.line_index
                    || previous_word_index != lyric_state.word_index;
                if cursor_changed {
                    let event_type = if previous_song_id != lyric_state.song_id
                        || previous_line_index != lyric_state.line_index
                    {
                        "lyrics.line"
                    } else {
                        "lyrics.word"
                    };
                    service.publish(event_type, &lyric_state);
                    previous_song_id = lyric_state.song_id.clone();
                    previous_line_index = lyric_state.line_index;
                    previous_word_index = lyric_state.word_index;
                }
            }
        });
    }

    pub fn stop_clock(&self) {
        self.clock_running.store(false, Ordering::Release);
        self.load_generation.fetch_add(1, Ordering::AcqRel);
        let _ = self.audio.stop();
    }

    fn publish<T: Serialize>(&self, event_type: &str, value: &T) {
        let data = serde_json::to_value(value).unwrap_or_else(|_| json!({}));
        let _ = self.events.send(ApiEvent {
            version: 1,
            event_type: event_type.to_owned(),
            timestamp_ms: unix_timestamp_ms(),
            data,
        });
    }
}

fn source_failure(error: &PlaybackSourceError) -> PlaybackFailure {
    let (code, message, retryable) = match error {
        PlaybackSourceError::UrlUnavailable => (
            "media-url-unavailable",
            "No playable media source is available for this track.",
            true,
        ),
        PlaybackSourceError::UrlExpired => (
            "media-url-expired",
            "The playback link expired before it could be prepared.",
            true,
        ),
        PlaybackSourceError::Network => (
            "network-failure",
            "The track could not be loaded from the network.",
            true,
        ),
        PlaybackSourceError::RangeUnsupported => (
            "http-range-unsupported",
            "This media server does not support seekable playback.",
            false,
        ),
        PlaybackSourceError::ResponseTooLarge => (
            "media-too-large",
            "The track exceeds the configured temporary-media limit.",
            false,
        ),
        PlaybackSourceError::DecoderUnsupported => (
            "decoder-unsupported",
            "This audio format is not supported by the native decoder.",
            false,
        ),
        PlaybackSourceError::EntitlementInsufficient => (
            "entitlement-insufficient",
            "The active QQ Music account is not entitled to this track or quality.",
            false,
        ),
        PlaybackSourceError::AuthenticationExpired => (
            "authentication-expired",
            "The QQ Music session expired and must be authorized again.",
            false,
        ),
        PlaybackSourceError::TrackUnavailable => (
            "track-unavailable",
            "This track is not currently available for playback.",
            false,
        ),
        PlaybackSourceError::CacheFailure => (
            "media-cache-failure",
            "The temporary media cache could not prepare this track.",
            true,
        ),
        PlaybackSourceError::DecryptionFailed => (
            "media-decryption-failed",
            "The encrypted QQ Music source could not be decrypted.",
            true,
        ),
        PlaybackSourceError::Cancelled => (
            "source-cancelled",
            "The account-bound playback source was cancelled.",
            false,
        ),
    };
    PlaybackFailure {
        code: code.to_owned(),
        message: message.to_owned(),
        retryable,
    }
}

fn audio_failure(error: &AudioEngineError) -> PlaybackFailure {
    let (code, message, retryable) = match error {
        AudioEngineError::OutputDeviceUnavailable | AudioEngineError::OutputDeviceOpenFailed => (
            "output-device-unavailable",
            "No usable audio output device is available.",
            true,
        ),
        AudioEngineError::MediaOpenFailed => (
            "media-open-failed",
            "The prepared audio file could not be opened.",
            true,
        ),
        AudioEngineError::DecoderUnsupported => (
            "decoder-unsupported",
            "The native decoder rejected this audio format.",
            false,
        ),
        AudioEngineError::SeekUnsupported => (
            "seek-unsupported",
            "This media source cannot seek to the requested position.",
            false,
        ),
        AudioEngineError::StreamingFailed => (
            "streaming-failure",
            "The progressive media stream could not continue.",
            true,
        ),
        AudioEngineError::WorkerUnavailable | AudioEngineError::WorkerTimeout => (
            "audio-engine-unavailable",
            "The native audio engine is not responding.",
            true,
        ),
        AudioEngineError::SourceCancelled => (
            "source-cancelled",
            "The account-bound playback source was cancelled.",
            false,
        ),
    };
    PlaybackFailure {
        code: code.to_owned(),
        message: message.to_owned(),
        retryable,
    }
}

fn current_lyric_state(core: &PlayerCore) -> CurrentLyricState {
    let song_id = core.current_song().map(|song| song.id.clone());
    let empty = || CurrentLyricState {
        song_id: song_id.clone(),
        position_ms: core.position_ms,
        line_index: None,
        word_index: None,
        line: None,
        word: None,
    };
    let Some(document) = core.lyrics.as_ref() else {
        return empty();
    };
    if document.sync_mode == LyricSyncMode::Unsynchronized
        || song_id.as_deref() != Some(document.song_id.as_str())
    {
        return empty();
    }
    let position = core.position_ms as i128 - document.metadata.offset_ms as i128;
    if position < 0 {
        return empty();
    }
    let position = position as u64;
    let line_index = document.lines.iter().enumerate().position(|(index, line)| {
        let Some(start) = line.start_ms else {
            return false;
        };
        let end = line.end_ms.or_else(|| {
            document.lines[index + 1..]
                .iter()
                .find_map(|candidate| candidate.start_ms)
        });
        position >= start && end.is_none_or(|end| position < end)
    });
    let Some(line_index) = line_index else {
        return empty();
    };
    let line = document.lines[line_index].clone();
    let word_index = line
        .words
        .iter()
        .position(|word| position >= word.start_ms && position < word.end_ms);
    let word = word_index.and_then(|index| line.words.get(index).cloned());
    CurrentLyricState {
        song_id,
        position_ms: core.position_ms,
        line_index: Some(line_index),
        word_index,
        line: Some(line),
        word,
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
    use crate::{
        audio::RodioAudioEngine,
        credentials::MemoryCredentialStore,
        media::CachedMediaPreparer,
        media::PlaybackEpochClock,
        qqmusic::{AccountEpoch, AudioQualityPreference, QQMusicService},
        storage::StorageService,
    };
    use async_trait::async_trait;
    use axum::{http::header, routing::get, Router};
    use std::sync::atomic::AtomicUsize;
    use tokio_util::sync::CancellationToken;

    fn song(id: &str, duration_ms: u64) -> Song {
        Song {
            id: id.to_owned(),
            title: id.to_owned(),
            artists: vec![ArtistSummary {
                id: "artist".to_owned(),
                name: "Artist".to_owned(),
            }],
            album: AlbumSummary {
                id: "album".to_owned(),
                title: "Album".to_owned(),
            },
            artwork: Artwork {
                src: "/cover.svg".to_owned(),
                alt: "Cover".to_owned(),
                dominant_color: "#000000".to_owned(),
            },
            duration_ms,
            track_number: 1,
            is_favorite: false,
            quality: AudioQuality::Lossless,
            availability: SongAvailability::Available,
            audio_formats: Vec::new(),
            playback_capability: None,
            provider: None,
        }
    }

    fn lyric_document() -> LyricDocument {
        LyricDocument {
            song_id: "one".to_owned(),
            sync_mode: LyricSyncMode::Word,
            metadata: LyricMetadata {
                source_label: "fixture".to_owned(),
                language: Some("en".to_owned()),
                translated_language: None,
                offset_ms: 0,
            },
            vocalists: vec![],
            lines: vec![
                LyricLine {
                    id: "line-1".to_owned(),
                    start_ms: Some(1_000),
                    end_ms: Some(3_000),
                    text: "one two".to_owned(),
                    translation: None,
                    romanization: None,
                    vocalist_id: None,
                    words: vec![
                        LyricWord {
                            start_ms: 1_000,
                            end_ms: 2_000,
                            text: "one ".to_owned(),
                        },
                        LyricWord {
                            start_ms: 2_000,
                            end_ms: 3_000,
                            text: "two".to_owned(),
                        },
                    ],
                },
                LyricLine {
                    id: "line-2".to_owned(),
                    start_ms: Some(4_000),
                    end_ms: Some(5_000),
                    text: "after gap".to_owned(),
                    translation: None,
                    romanization: None,
                    vocalist_id: None,
                    words: vec![],
                },
            ],
        }
    }

    fn resolved(song: &Song) -> crate::media::ResolvedPlaybackSource {
        crate::media::ResolvedPlaybackSource {
            cache_key: format!("test:{}", song.id),
            location: crate::media::PlaybackLocation::Local("test.wav".into()),
            format: crate::audio::AudioFormat::Wav,
            mime_type: Some("audio/wav".to_owned()),
            quality_label: "test".to_owned(),
            bitrate_kbps: None,
            sample_rate_hz: Some(16_000),
            bit_depth: Some(16),
            content_length: None,
            supports_range: true,
            expires_at_ms: None,
            timeline_offset_ms: 0,
            timeline_end_ms: Some(song.duration_ms),
            is_preview: false,
            selection: PlaybackSourceSelection {
                requested_quality: crate::qqmusic::AudioQualityPreference::Automatic,
                resolved_quality: song.quality,
                fallback_reason: None,
                preview: false,
            },
            epoch_guard: PlaybackEpochGuard::unrestricted(),
        }
    }

    struct CountingResolver {
        calls: Arc<AtomicUsize>,
    }

    struct GuardedResolver {
        guard: PlaybackEpochGuard,
    }

    #[async_trait]
    impl PlaybackSourceResolver for GuardedResolver {
        async fn resolve(
            &self,
            song: &Song,
        ) -> Result<crate::media::ResolvedPlaybackSource, PlaybackSourceError> {
            let mut source = resolved(song);
            source.epoch_guard = self.guard.clone();
            source.selection = PlaybackSourceSelection {
                requested_quality: AudioQualityPreference::High,
                resolved_quality: AudioQuality::Standard,
                fallback_reason: None,
                preview: false,
            };
            Ok(source)
        }
    }

    #[async_trait]
    impl PlaybackSourceResolver for CountingResolver {
        async fn resolve(
            &self,
            song: &Song,
        ) -> Result<crate::media::ResolvedPlaybackSource, PlaybackSourceError> {
            self.calls.fetch_add(1, Ordering::AcqRel);
            Ok(resolved(song))
        }
    }

    struct ExpireOncePreparer {
        calls: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl MediaPreparer for ExpireOncePreparer {
        async fn prepare(
            &self,
            source: crate::media::ResolvedPlaybackSource,
        ) -> Result<crate::audio::PreparedPlaybackSource, PlaybackSourceError> {
            if self.calls.fetch_add(1, Ordering::AcqRel) == 0 {
                return Err(PlaybackSourceError::UrlExpired);
            }
            Ok(crate::audio::PreparedPlaybackSource {
                location: crate::audio::PreparedPlaybackLocation::Local("test.wav".into()),
                format: source.format,
                timeline_offset_ms: source.timeline_offset_ms,
                timeline_end_ms: source.timeline_end_ms,
                is_preview: source.is_preview,
                cache_key: source.cache_key,
                selection: source.selection,
                epoch_guard: source.epoch_guard,
            })
        }
    }

    struct DelayedResolver;

    #[async_trait]
    impl PlaybackSourceResolver for DelayedResolver {
        async fn resolve(
            &self,
            song: &Song,
        ) -> Result<crate::media::ResolvedPlaybackSource, PlaybackSourceError> {
            if song.id == "slow" {
                tokio::time::sleep(Duration::from_millis(120)).await;
            }
            Ok(resolved(song))
        }
    }

    #[tokio::test]
    async fn controls_share_one_authoritative_snapshot() {
        let player = PlayerService::new();
        player
            .hydrate_queue(vec![song("one", 10_000), song("two", 8_000)])
            .await;
        let playing = player.play().await.expect("queue is playable");
        assert!(playing.is_playing);
        assert_eq!(playing.current_index, Some(0));
        let next = player.next().await.expect("next succeeds");
        assert_eq!(next.current_index, Some(1));
        assert_eq!(player.snapshot().await, next);
    }

    #[tokio::test]
    async fn account_gated_tracks_reach_the_source_resolver() {
        let resolver_calls = Arc::new(AtomicUsize::new(0));
        let player = PlayerService::with_runtime(
            Arc::new(crate::audio::TestAudioEngine::default()),
            Arc::new(CountingResolver {
                calls: Arc::clone(&resolver_calls),
            }),
            Arc::new(crate::media::PassthroughMediaPreparer),
        );
        let mut gated = song("vip-track", 10_000);
        gated.availability = SongAvailability::EntitlementRequired {
            required_tier: "QQ Music VIP".to_owned(),
        };

        player
            .play_tracks(PlayTracksRequest {
                tracks: vec![gated],
                start_at_id: None,
                shuffle: None,
            })
            .await
            .expect("the resolver, not queue admission, decides account rights");

        assert_eq!(resolver_calls.load(Ordering::Acquire), 1);
    }

    #[tokio::test]
    async fn explicitly_unavailable_tracks_are_rejected_before_source_resolution() {
        let resolver_calls = Arc::new(AtomicUsize::new(0));
        let player = PlayerService::with_runtime(
            Arc::new(crate::audio::TestAudioEngine::default()),
            Arc::new(CountingResolver {
                calls: Arc::clone(&resolver_calls),
            }),
            Arc::new(crate::media::PassthroughMediaPreparer),
        );
        let mut unavailable = song("removed-track", 10_000);
        unavailable.availability = SongAvailability::Unavailable {
            reason: "copyright".to_owned(),
        };

        assert!(matches!(
            player
                .play_tracks(PlayTracksRequest {
                    tracks: vec![unavailable],
                    start_at_id: None,
                    shuffle: None,
                })
                .await,
            Err(PlayerError::NoPlayableTracks)
        ));
        assert_eq!(resolver_calls.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn reload_current_resolves_again_and_preserves_position_and_play_state() {
        let resolver_calls = Arc::new(AtomicUsize::new(0));
        let engine = Arc::new(crate::audio::TestAudioEngine::default());
        let player = PlayerService::with_runtime(
            engine.clone(),
            Arc::new(CountingResolver {
                calls: Arc::clone(&resolver_calls),
            }),
            Arc::new(crate::media::PassthroughMediaPreparer),
        );
        player
            .play_tracks(PlayTracksRequest {
                tracks: vec![song("one", 10_000)],
                start_at_id: None,
                shuffle: None,
            })
            .await
            .expect("initial source plays");
        player.seek(4_200).await.expect("seek succeeds");

        let reloaded = player.reload_current().await.expect("reload succeeds");

        assert_eq!(resolver_calls.load(Ordering::Acquire), 2);
        assert_eq!(reloaded.position_ms, 4_200);
        assert_eq!(reloaded.playback_state, PlaybackState::Playing);
        assert_eq!(engine.snapshot().position_ms, 4_200);

        player.pause().await.expect("pause succeeds");
        let paused = player
            .reload_current()
            .await
            .expect("paused reload succeeds");
        assert_eq!(resolver_calls.load(Ordering::Acquire), 3);
        assert_eq!(paused.position_ms, 4_200);
        assert_eq!(paused.playback_state, PlaybackState::Paused);
        assert!(engine.snapshot().paused);
    }

    #[tokio::test]
    async fn play_tracks_applies_shuffle_atomically_and_bulk_queue_append_preserves_order() {
        let player = PlayerService::with_runtime(
            Arc::new(crate::audio::TestAudioEngine::default()),
            Arc::new(crate::media::TestPlaybackSourceResolver),
            Arc::new(crate::media::PassthroughMediaPreparer),
        );
        let first = player
            .play_tracks(PlayTracksRequest {
                tracks: vec![song("one", 1_000), song("two", 1_000)],
                start_at_id: None,
                shuffle: Some(true),
            })
            .await
            .expect("shuffle playback starts");
        assert!(first.shuffle);
        assert_eq!(
            first
                .queue
                .iter()
                .map(|track| track.id.as_str())
                .collect::<Vec<_>>(),
            ["one", "two"]
        );

        let appended = player
            .add_tracks_to_queue(vec![song("three", 1_000), song("four", 1_000)])
            .await;
        assert_eq!(
            appended
                .queue
                .iter()
                .map(|track| track.id.as_str())
                .collect::<Vec<_>>(),
            ["one", "two", "three", "four"]
        );
        assert!(appended.shuffle);
    }

    #[tokio::test]
    async fn actual_engine_end_event_advances_the_authoritative_queue() {
        let engine = Arc::new(crate::audio::TestAudioEngine::default());
        let player = Arc::new(PlayerService::with_runtime(
            engine.clone(),
            Arc::new(crate::media::TestPlaybackSourceResolver),
            Arc::new(crate::media::PassthroughMediaPreparer),
        ));
        player.start_clock();
        player
            .play_tracks(PlayTracksRequest {
                tracks: vec![song("one", 1_000), song("two", 1_000)],
                start_at_id: None,
                shuffle: None,
            })
            .await
            .expect("playback starts");
        player.set_lyrics(Some(lyric_document())).await;
        engine.finish();
        tokio::time::sleep(Duration::from_millis(180)).await;
        let snapshot = player.snapshot().await;
        assert_eq!(snapshot.current_index, Some(1));
        assert_eq!(snapshot.playback_state, PlaybackState::Playing);
        assert!(player.lyrics().await.is_none());
        assert_eq!(
            player.current_lyric_state().await.song_id.as_deref(),
            Some("two")
        );
        assert!(player.current_lyric_state().await.line_index.is_none());
        player.stop_clock();
    }

    #[tokio::test]
    async fn late_lyrics_for_the_previous_track_cannot_replace_the_current_document() {
        let player = PlayerService::new();
        player
            .hydrate_queue(vec![song("one", 10_000), song("two", 10_000)])
            .await;
        player.play_from_queue(1).await.expect("second track loads");

        player.set_lyrics(Some(lyric_document())).await;

        assert!(player.lyrics().await.is_none());
        assert_eq!(
            player.current_lyric_state().await.song_id.as_deref(),
            Some("two")
        );
    }

    #[tokio::test]
    async fn expired_media_url_is_resolved_again_once_then_played() {
        let resolver_calls = Arc::new(AtomicUsize::new(0));
        let preparer_calls = Arc::new(AtomicUsize::new(0));
        let player = PlayerService::with_runtime(
            Arc::new(crate::audio::TestAudioEngine::default()),
            Arc::new(CountingResolver {
                calls: Arc::clone(&resolver_calls),
            }),
            Arc::new(ExpireOncePreparer {
                calls: Arc::clone(&preparer_calls),
            }),
        );
        let snapshot = player
            .play_tracks(PlayTracksRequest {
                tracks: vec![song("one", 10_000)],
                start_at_id: None,
                shuffle: None,
            })
            .await
            .expect("bounded refresh succeeds");
        assert_eq!(snapshot.playback_state, PlaybackState::Playing);
        assert_eq!(resolver_calls.load(Ordering::Acquire), 2);
        assert_eq!(preparer_calls.load(Ordering::Acquire), 2);
    }

    #[tokio::test]
    async fn account_epoch_cancellation_stops_audio_and_clears_sanitized_selection() {
        let clock = Arc::new(PlaybackEpochClock::default());
        let epoch = AccountEpoch::for_test(23);
        clock.replace(Some(epoch.clone()));
        let cancellation = CancellationToken::new();
        let guard = PlaybackEpochGuard::account_bound(epoch, cancellation.clone(), clock);
        let engine = Arc::new(crate::audio::TestAudioEngine::default());
        let player = PlayerService::with_runtime(
            engine.clone(),
            Arc::new(GuardedResolver { guard }),
            Arc::new(crate::media::PassthroughMediaPreparer),
        );

        let playing = player
            .play_tracks(PlayTracksRequest {
                tracks: vec![song("guarded", 10_000)],
                start_at_id: None,
                shuffle: None,
            })
            .await
            .expect("current account source plays");
        assert!(playing.source_selection.is_some());
        let serialized = serde_json::to_string(&playing).expect("serialize snapshot");
        assert!(!serialized.contains("account_bound"));
        assert!(!serialized.contains("generation"));
        assert!(!serialized.contains("scope"));

        player.pause().await.expect("pause guarded source");
        cancellation.cancel();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if player.snapshot().await.source_selection.is_none() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancellation watcher completed");

        let cancelled = player.snapshot().await;
        assert_eq!(cancelled.playback_state, PlaybackState::Stopped);
        assert!(cancelled.playback_error.is_none());
        assert!(cancelled.source_selection.is_none());
        assert!(!engine.snapshot().loaded);
    }

    #[tokio::test]
    async fn cancellation_between_guarded_resume_and_core_commit_cannot_publish_playing() {
        let clock = Arc::new(PlaybackEpochClock::default());
        let epoch = AccountEpoch::for_test(29);
        clock.replace(Some(epoch.clone()));
        let cancellation = CancellationToken::new();
        let guard =
            PlaybackEpochGuard::account_bound(epoch, cancellation.clone(), Arc::clone(&clock));
        let engine = Arc::new(crate::audio::TestAudioEngine::default());
        let player = PlayerService::with_runtime(
            engine.clone(),
            Arc::new(GuardedResolver { guard }),
            Arc::new(crate::media::PassthroughMediaPreparer),
        );

        player
            .play_tracks(PlayTracksRequest {
                tracks: vec![song("guarded-resume", 10_000)],
                start_at_id: None,
                shuffle: None,
            })
            .await
            .expect("guarded source plays");
        player.pause().await.expect("guarded source pauses");
        engine.cancel_after_next_play(cancellation);

        assert!(player.play().await.is_err());
        let snapshot = player.snapshot().await;
        assert_eq!(snapshot.playback_state, PlaybackState::Stopped);
        assert!(snapshot.playback_error.is_none());
        assert!(snapshot.source_selection.is_none());
        assert!(!engine.snapshot().loaded);
    }

    #[tokio::test]
    async fn qqmusic_http_client_still_prepares_media() {
        let root = tempfile::tempdir().expect("temp root");
        let fixture_path = root.path().join("served.wav");
        crate::audio::write_fixture_wav(&fixture_path, Duration::from_millis(250), 7)
            .expect("write fixture WAV");
        let fixture_bytes = tokio::fs::read(&fixture_path)
            .await
            .expect("read fixture WAV");
        let content_length = fixture_bytes.len() as u64;
        let hits = Arc::new(AtomicUsize::new(0));
        let server_hits = Arc::clone(&hits);
        let app = Router::new().route(
            "/fixture.wav",
            get(move || {
                let fixture_bytes = fixture_bytes.clone();
                let server_hits = Arc::clone(&server_hits);
                async move {
                    server_hits.fetch_add(1, Ordering::AcqRel);
                    ([(header::CONTENT_TYPE, "audio/wav")], fixture_bytes)
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("media listener");
        let address = listener.local_addr().expect("media address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("media server");
        });
        let storage = Arc::new(
            StorageService::open(root.path().join("data"), root.path().join("cache"))
                .expect("storage"),
        );
        let service = QQMusicService::new(
            Arc::clone(&storage),
            Arc::new(MemoryCredentialStore::default()),
            root.path().join("fixtures"),
        )
        .expect("QQ Music service");
        let preparer = CachedMediaPreparer::new(service.http_client(), storage);

        let prepared = preparer
            .prepare(crate::media::ResolvedPlaybackSource {
                cache_key: "qqmusic:fixture:ordinary-http".to_owned(),
                location: crate::media::PlaybackLocation::Http {
                    url: format!("http://{address}/fixture.wav"),
                    headers: Vec::new(),
                },
                format: crate::audio::AudioFormat::Wav,
                mime_type: Some("audio/wav".to_owned()),
                quality_label: "fixture".to_owned(),
                bitrate_kbps: None,
                sample_rate_hz: Some(16_000),
                bit_depth: Some(16),
                content_length: Some(content_length),
                supports_range: false,
                expires_at_ms: None,
                timeline_offset_ms: 0,
                timeline_end_ms: Some(250),
                is_preview: false,
                selection: PlaybackSourceSelection {
                    requested_quality: crate::qqmusic::AudioQualityPreference::Automatic,
                    resolved_quality: AudioQuality::Standard,
                    fallback_reason: None,
                    preview: false,
                },
                epoch_guard: PlaybackEpochGuard::unrestricted(),
            })
            .await
            .expect("ordinary client downloads fixture media");

        match prepared.location {
            crate::audio::PreparedPlaybackLocation::Local(path) => assert!(path.is_file()),
            crate::audio::PreparedPlaybackLocation::Progressive(_) => {
                panic!("non-range fixture must be fully cached")
            }
            crate::audio::PreparedPlaybackLocation::EncryptedLocal { .. }
            | crate::audio::PreparedPlaybackLocation::EncryptedProgressive { .. } => {
                panic!("ordinary fixture must not use an encrypted location")
            }
        }
        assert_eq!(hits.load(Ordering::Acquire), 1);
        server.abort();
    }

    #[tokio::test]
    async fn stale_slow_track_resolution_cannot_replace_a_newer_track() {
        let player = Arc::new(PlayerService::with_runtime(
            Arc::new(crate::audio::TestAudioEngine::default()),
            Arc::new(DelayedResolver),
            Arc::new(crate::media::PassthroughMediaPreparer),
        ));
        player
            .hydrate_queue(vec![song("slow", 10_000), song("fast", 10_000)])
            .await;
        let slow_player = Arc::clone(&player);
        let slow = tokio::spawn(async move { slow_player.play_from_queue(0).await });
        tokio::time::sleep(Duration::from_millis(10)).await;
        player.play_from_queue(1).await.expect("fast track loads");
        slow.await
            .expect("slow task joins")
            .expect("superseded request resolves safely");
        let snapshot = player.snapshot().await;
        assert_eq!(snapshot.current_index, Some(1));
        assert_eq!(snapshot.queue[1].id, "fast");
        assert_eq!(snapshot.playback_state, PlaybackState::Playing);
    }

    #[tokio::test]
    async fn lyric_cursor_uses_exclusive_boundaries_and_preserves_gaps() {
        let player = PlayerService::new();
        player.hydrate_queue(vec![song("one", 10_000)]).await;
        player.set_lyrics(Some(lyric_document())).await;

        player.seek(1_999).await.expect("seek succeeds");
        let first = player.current_lyric_state().await;
        assert_eq!(first.line_index, Some(0));
        assert_eq!(first.word_index, Some(0));

        player.seek(2_000).await.expect("seek succeeds");
        assert_eq!(player.current_lyric_state().await.word_index, Some(1));

        player.seek(3_000).await.expect("seek succeeds");
        assert_eq!(player.current_lyric_state().await.line_index, None);

        player.seek(4_000).await.expect("seek succeeds");
        assert_eq!(player.current_lyric_state().await.line_index, Some(1));
    }

    #[tokio::test]
    async fn lyric_surface_projection_uses_the_authoritative_track_clock() {
        let player = PlayerService::new();
        player.hydrate_queue(vec![song("one", 10_000)]).await;
        player.set_lyrics(Some(lyric_document())).await;
        player.seek(2_100).await.expect("seek succeeds");

        let projection = player.lyric_surface_projection().await;
        assert_eq!(
            projection
                .current_track
                .as_ref()
                .map(|song| song.id.as_str()),
            Some("one")
        );
        assert_eq!(projection.position_ms, 2_100);
        assert_eq!(projection.line_index, Some(0));
        assert_eq!(projection.word_index, Some(1));
        assert!(projection.current_line.is_some());
        assert!(projection.next_line.is_some());
    }

    #[test]
    fn event_contract_is_versioned_and_uses_stable_field_names() {
        let event = ApiEvent {
            version: 1,
            event_type: "player.position".to_owned(),
            timestamp_ms: 42,
            data: json!({ "positionMs": 10 }),
        };
        let value = serde_json::to_value(event).expect("event serializes");
        assert_eq!(value["version"], 1);
        assert_eq!(value["type"], "player.position");
        assert_eq!(value["timestampMs"], 42);
    }

    #[tokio::test]
    #[ignore = "opt-in audible native output acceptance"]
    async fn local_fixture_drives_real_position_pause_seek_lyrics_and_queue_end() {
        let root = tempfile::tempdir().expect("temp root");
        let storage = Arc::new(
            StorageService::open(root.path().join("data"), root.path().join("cache"))
                .expect("storage"),
        );
        let resolver = Arc::new(
            QQMusicService::new(
                Arc::clone(&storage),
                Arc::new(MemoryCredentialStore::default()),
                root.path().join("fixture-media"),
            )
            .expect("fixture resolver"),
        );
        let preparer = Arc::new(CachedMediaPreparer::new(
            resolver.http_client(),
            Arc::clone(&storage),
        ));
        let audio = Arc::new(RodioAudioEngine::open_default().expect("default output"));
        let player = Arc::new(PlayerService::with_runtime(audio, resolver, preparer));
        player.start_clock();
        player
            .set_volume(0.06)
            .await
            .expect("quiet acceptance volume");
        player
            .play_tracks(PlayTracksRequest {
                tracks: vec![song("one", 1_600), song("two", 1_600)],
                start_at_id: Some("one".to_owned()),
                shuffle: None,
            })
            .await
            .expect("local playback starts");
        player.set_lyrics(Some(lyric_document())).await;
        tokio::time::sleep(Duration::from_millis(550)).await;
        let playing = player.snapshot().await;
        assert_eq!(playing.playback_state, PlaybackState::Playing);
        assert!(playing.position_ms >= 350);

        player.pause().await.expect("pause");
        let paused_at = player.snapshot().await.position_ms;
        tokio::time::sleep(Duration::from_millis(350)).await;
        assert!(player.snapshot().await.position_ms.abs_diff(paused_at) < 100);

        player.seek(1_000).await.expect("seek");
        assert_eq!(player.current_lyric_state().await.line_index, Some(0));
        player.play().await.expect("resume");
        tokio::time::sleep(Duration::from_millis(850)).await;
        let transitioned = player.snapshot().await;
        assert_eq!(transitioned.current_index, Some(1));
        assert_eq!(transitioned.playback_state, PlaybackState::Playing);
        player.stop_clock();
    }
}
