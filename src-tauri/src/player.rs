use crate::{
    audio::{AudioEngine, AudioEngineError, AudioOutputDevice},
    media::{MediaPreparer, PlaybackSourceError, PlaybackSourceResolver},
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

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AudioQuality {
    Standard,
    High,
    Lossless,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
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
        matches!(self, Self::Available)
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
        }
    }

    fn current_song(&self) -> Option<&Song> {
        self.current_index.and_then(|index| self.queue.get(index))
    }
}

pub struct PlayerService {
    core: RwLock<PlayerCore>,
    events: broadcast::Sender<ApiEvent>,
    clock_running: AtomicBool,
    transition_running: AtomicBool,
    recovery_running: AtomicBool,
    runtime_expiry_retry_available: AtomicBool,
    load_generation: AtomicU64,
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
            core: RwLock::new(PlayerCore {
                volume: 0.72,
                ..PlayerCore::default()
            }),
            events,
            clock_running: AtomicBool::new(false),
            transition_running: AtomicBool::new(false),
            recovery_running: AtomicBool::new(false),
            runtime_expiry_retry_available: AtomicBool::new(true),
            load_generation: AtomicU64::new(0),
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
        }
        self.load_index(index, true, 0).await
    }

    pub async fn play_from_queue(&self, index: usize) -> Result<PlayerSnapshot, PlayerError> {
        if index >= self.core.read().await.queue.len() {
            return Err(PlayerError::IndexOutOfRange(index));
        }
        self.load_index(index, true, 0).await
    }

    pub async fn play(&self) -> Result<PlayerSnapshot, PlayerError> {
        let (index, position, loaded) = {
            let core = self.core.read().await;
            (
                core.current_index.ok_or(PlayerError::EmptyQueue)?,
                core.position_ms,
                self.audio.snapshot().loaded,
            )
        };
        if !loaded {
            return self.load_index(index, true, position).await;
        }
        if let Err(error) = self.audio.play() {
            return Err(self.record_audio_failure(&error).await);
        }
        self.mutate("player.playback", |core| {
            core.playback_state = PlaybackState::Playing;
            core.playback_error = None;
            Ok(())
        })
        .await
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
            core.current_index = Some(index);
            core.position_ms = resume_position_ms.min(core.queue[index].duration_ms);
            core.playback_state = PlaybackState::Loading;
            core.playback_error = None;
            core.playback_duration_ms = Some(core.queue[index].duration_ms);
            core.timeline_offset_ms = 0;
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

        let metadata = match self.audio.load(&prepared) {
            Ok(metadata) => metadata,
            Err(error) => return Err(self.record_audio_failure(&error).await),
        };
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
            if let Err(error) = self.audio.play() {
                return Err(self.record_audio_failure(&error).await);
            }
        }

        let snapshot = {
            let mut core = self.core.write().await;
            let playable_duration = metadata
                .duration_ms
                .map(|duration| prepared.timeline_offset_ms.saturating_add(duration))
                .or(prepared.timeline_end_ms)
                .unwrap_or(song.duration_ms);
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
            core.snapshot()
        };
        self.publish("player.playback", &snapshot);
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
        let failure = source_failure(error);
        let snapshot = {
            let mut core = self.core.write().await;
            core.playback_state = if failure.retryable {
                PlaybackState::RecoverableError
            } else {
                PlaybackState::FatalError
            };
            core.playback_error = Some(failure.clone());
            core.snapshot()
        };
        self.publish("player.error", &snapshot);
        Err(PlayerError::Playback(failure.message))
    }

    async fn record_audio_failure(&self, error: &AudioEngineError) -> PlayerError {
        let failure = audio_failure(error);
        let snapshot = {
            let mut core = self.core.write().await;
            core.playback_state = if failure.retryable {
                PlaybackState::RecoverableError
            } else {
                PlaybackState::FatalError
            };
            core.playback_error = Some(failure.clone());
            core.snapshot()
        };
        self.publish("player.error", &snapshot);
        PlayerError::Playback(failure.message)
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
            core.lyrics = document;
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
        audio::RodioAudioEngine, credentials::MemoryCredentialStore, media::CachedMediaPreparer,
        qqmusic::QQMusicService, storage::StorageService,
    };
    use async_trait::async_trait;
    use std::sync::atomic::AtomicUsize;

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
        }
    }

    struct CountingResolver {
        calls: Arc<AtomicUsize>,
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
            })
            .await
            .expect("playback starts");
        engine.finish();
        tokio::time::sleep(Duration::from_millis(180)).await;
        let snapshot = player.snapshot().await;
        assert_eq!(snapshot.current_index, Some(1));
        assert_eq!(snapshot.playback_state, PlaybackState::Playing);
        player.stop_clock();
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
            })
            .await
            .expect("bounded refresh succeeds");
        assert_eq!(snapshot.playback_state, PlaybackState::Playing);
        assert_eq!(resolver_calls.load(Ordering::Acquire), 2);
        assert_eq!(preparer_calls.load(Ordering::Acquire), 2);
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
