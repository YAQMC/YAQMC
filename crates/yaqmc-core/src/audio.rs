use crate::{
    media::{MediaDecryptor, PlaybackEpochGuard},
    playback_types::PlaybackSourceSelection,
    streaming::{ProgressiveMonitor, ProgressiveSource},
};
use rodio::{
    cpal::{traits::HostTrait, StreamError},
    decoder::DecoderBuilder,
    Decoder, Device, DeviceSinkBuilder, DeviceTrait, MixerDeviceSink, Player, Source,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use thiserror::Error;
pub use yaqmc_provider_api::media::AudioFormat;

pub const AUDIO_OUTPUT_DEVICE_SETTING: &str = "audio-output-device";

const COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
const DEFAULT_OUTPUT_ID: &str = "system:default";
const OUTPUT_RECOVERY_INTERVAL: Duration = Duration::from_secs(2);
const OUTPUT_UNDERRUN_LOG_INTERVAL: Duration = Duration::from_secs(5);
const MAX_OUTPUT_RECOVERY_ATTEMPTS: usize = 5;
/// Rodio only writes `Player::get_pos()` from mixer `periodic_access`. If the
/// CPAL stream stops pulling without an error callback, the atomic pause flag
/// still says "playing" while the mutex position freezes. Wait this long after
/// load/play/seek before treating that freeze as a dead output.
const PLAYHEAD_STALL_GRACE: Duration = Duration::from_millis(250);
const PLAYHEAD_STALL: Duration = Duration::from_millis(200);
const PLAYHEAD_RECOVER_INTERVAL: Duration = Duration::from_millis(250);
const MAX_PLAYHEAD_RECOVER_ATTEMPTS: usize = 4;

#[derive(Clone, Debug, PartialEq, Eq)]
enum OutputSelection {
    SystemDefault,
    SpecificDevice(String),
}

impl OutputSelection {
    fn parse(value: &str) -> Result<Self, AudioEngineError> {
        if value == DEFAULT_OUTPUT_ID {
            return Ok(Self::SystemDefault);
        }
        let Some(digest) = value.strip_prefix("device:") else {
            return Err(AudioEngineError::InvalidOutputSelection);
        };
        if digest.len() != 24 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(AudioEngineError::InvalidOutputSelection);
        }
        Ok(Self::SpecificDevice(value.to_owned()))
    }

    fn id(&self) -> &str {
        match self {
            Self::SystemDefault => DEFAULT_OUTPUT_ID,
            Self::SpecificDevice(device_id) => device_id,
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            Self::SystemDefault => "system-default",
            Self::SpecificDevice(_) => "specific-device",
        }
    }
}

fn recovery_selection(selection: &OutputSelection) -> OutputSelection {
    selection.clone()
}

fn output_stream_error_interrupts_playback(error: &StreamError) -> bool {
    // CPAL reports an underrun as a possible glitch while keeping the stream
    // valid. Treating it as device loss creates a false fatal UI state and a
    // rebuild loop, especially for high-rate progressive FLAC sources.
    !matches!(error, StreamError::BufferUnderrun)
}

struct PlayheadWatch {
    last_pos_ms: u64,
    last_move_at: Instant,
    last_transport_at: Instant,
    last_recover_at: Instant,
    recover_attempts: usize,
    nudged_play: bool,
}

impl PlayheadWatch {
    fn new() -> Self {
        let now = Instant::now();
        Self {
            last_pos_ms: 0,
            last_move_at: now,
            last_transport_at: now,
            last_recover_at: now.checked_sub(Duration::from_secs(5)).unwrap_or(now),
            recover_attempts: 0,
            nudged_play: false,
        }
    }

    fn note_transport(&mut self) {
        let now = Instant::now();
        self.last_transport_at = now;
        self.last_move_at = now;
        self.recover_attempts = 0;
        self.nudged_play = false;
    }

    fn note_position(&mut self, position_ms: u64) {
        if position_ms.abs_diff(self.last_pos_ms) > 0 {
            self.last_pos_ms = position_ms;
            self.last_move_at = Instant::now();
            self.recover_attempts = 0;
            self.nudged_play = false;
        }
    }

    fn stalled_while_playing(&self) -> bool {
        self.last_transport_at.elapsed() >= PLAYHEAD_STALL_GRACE
            && self.last_move_at.elapsed() >= PLAYHEAD_STALL
    }
}

// These explicit slots mirror the long-lived worker state; a wrapper would exist only to borrow it.
#[allow(clippy::too_many_arguments)]
fn install_rebuilt_output(
    device_sink: &mut MixerDeviceSink,
    player: &mut Player,
    progressive_monitor: &mut Option<ProgressiveMonitor>,
    selected_output: &mut OutputSelection,
    resolved_output: &mut AudioResolvedOutput,
    output_recovery_attempts: &mut usize,
    snapshot: &Arc<Mutex<AudioEngineSnapshot>>,
    rebuilt: (
        MixerDeviceSink,
        Player,
        Option<ProgressiveMonitor>,
        OutputSelection,
        AudioResolvedOutput,
    ),
) {
    let (next_sink, next_player, next_monitor, selection, resolved) = rebuilt;
    *device_sink = next_sink;
    *player = next_player;
    *progressive_monitor = next_monitor;
    *selected_output = selection;
    *resolved_output = resolved;
    *output_recovery_attempts = 0;
    snapshot
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .output_error = None;
}

fn reset_playback_snapshot(snapshot: &mut AudioEngineSnapshot) {
    let output_error = snapshot.output_error.clone();
    *snapshot = AudioEngineSnapshot {
        output_error,
        ..AudioEngineSnapshot::default()
    };
}

#[derive(Clone, Debug)]
pub enum PreparedPlaybackLocation {
    Local(PathBuf),
    Progressive(ProgressiveSource),
    EncryptedLocal {
        path: PathBuf,
        content_length: u64,
        decryptor: Arc<dyn MediaDecryptor>,
    },
    EncryptedProgressive {
        source: ProgressiveSource,
        decryptor: Arc<dyn MediaDecryptor>,
    },
}

struct DecryptingReader<Reader> {
    inner: Reader,
    decryptor: Arc<dyn MediaDecryptor>,
    position: u64,
}

impl<Reader> DecryptingReader<Reader> {
    fn new(inner: Reader, decryptor: Arc<dyn MediaDecryptor>) -> Self {
        Self {
            inner,
            decryptor,
            position: 0,
        }
    }
}

impl<Reader: Read> Read for DecryptingReader<Reader> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let read = self.inner.read(buffer)?;
        self.decryptor.decrypt(&mut buffer[..read], self.position)?;
        self.position = self.position.saturating_add(read as u64);
        Ok(read)
    }
}

impl<Reader: Seek> Seek for DecryptingReader<Reader> {
    fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
        self.position = self.inner.seek(position)?;
        Ok(self.position)
    }
}

#[derive(Clone, Debug)]
pub struct PreparedPlaybackSource {
    pub location: PreparedPlaybackLocation,
    pub format: AudioFormat,
    pub timeline_offset_ms: u64,
    pub timeline_end_ms: Option<u64>,
    pub is_preview: bool,
    pub cache_key: String,
    pub selection: PlaybackSourceSelection,
    pub epoch_guard: PlaybackEpochGuard,
    pub load_generation: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AudioEngineSnapshot {
    pub loaded: bool,
    pub playing: bool,
    pub paused: bool,
    pub ended: bool,
    pub position_ms: u64,
    pub duration_ms: Option<u64>,
    pub output_error: Option<String>,
    pub source_error: Option<String>,
    pub source_url_expired: bool,
    pub buffering: bool,
    pub progressive_downloaded_bytes: Option<u64>,
    pub progressive_total_bytes: Option<u64>,
    pub source_generation: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AudioLoadMetadata {
    pub duration_ms: Option<u64>,
    pub format: AudioFormat,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioResolvedOutput {
    pub name: String,
    pub driver: String,
    pub host: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub sample_format: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioOutputDevice {
    pub id: String,
    pub label: String,
    pub is_default: bool,
    pub is_selected: bool,
    pub selection_kind: String,
    pub resolved_output: Option<AudioResolvedOutput>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AudioEngineError {
    #[error("no audio output device is available")]
    OutputDeviceUnavailable,
    #[error("the audio output selection is invalid")]
    InvalidOutputSelection,
    #[error("the audio output device could not be opened")]
    OutputDeviceOpenFailed,
    #[error("the media file could not be opened")]
    MediaOpenFailed,
    #[error("the media format is unsupported or malformed")]
    DecoderUnsupported,
    #[error("the encrypted media did not decrypt to a valid FLAC stream")]
    DecryptionFailed,
    #[error("seeking is not supported by this media source")]
    SeekUnsupported,
    #[error("the progressive media stream failed")]
    StreamingFailed,
    #[error("the native audio worker stopped unexpectedly")]
    WorkerUnavailable,
    #[error("the native audio worker did not respond")]
    WorkerTimeout,
    #[error("the account-bound playback source was cancelled")]
    SourceCancelled,
    #[error("the source load belonged to a superseded playback session")]
    StaleCommand,
}

pub trait AudioEngine: Send + Sync {
    fn load(&self, source: &PreparedPlaybackSource) -> Result<AudioLoadMetadata, AudioEngineError>;
    fn play(&self) -> Result<(), AudioEngineError>;
    fn pause(&self) -> Result<(), AudioEngineError>;
    fn stop(&self) -> Result<(), AudioEngineError>;
    fn seek(&self, position: Duration) -> Result<(), AudioEngineError>;
    fn set_volume(&self, volume: f32) -> Result<(), AudioEngineError>;
    fn set_output_device(&self, device_id: &str) -> Result<(), AudioEngineError>;
    fn snapshot(&self) -> AudioEngineSnapshot;
    fn output_devices(&self) -> Result<Vec<AudioOutputDevice>, AudioEngineError>;
    /// Rebuild the output stream in place. Used when Rodio still reports
    /// playing but `get_pos()` has stopped advancing.
    fn recover_output(&self) -> Result<(), AudioEngineError> {
        Ok(())
    }
}

/// Keeps the application shell and provider features available when the host has no usable
/// output device. Every control returns a stable device error instead of panicking at startup.
pub struct UnavailableAudioEngine;

impl AudioEngine for UnavailableAudioEngine {
    fn load(
        &self,
        _source: &PreparedPlaybackSource,
    ) -> Result<AudioLoadMetadata, AudioEngineError> {
        Err(AudioEngineError::OutputDeviceUnavailable)
    }

    fn play(&self) -> Result<(), AudioEngineError> {
        Err(AudioEngineError::OutputDeviceUnavailable)
    }

    fn pause(&self) -> Result<(), AudioEngineError> {
        Err(AudioEngineError::OutputDeviceUnavailable)
    }

    fn stop(&self) -> Result<(), AudioEngineError> {
        Ok(())
    }

    fn seek(&self, _position: Duration) -> Result<(), AudioEngineError> {
        Err(AudioEngineError::OutputDeviceUnavailable)
    }

    fn set_volume(&self, _volume: f32) -> Result<(), AudioEngineError> {
        Err(AudioEngineError::OutputDeviceUnavailable)
    }

    fn set_output_device(&self, _device_id: &str) -> Result<(), AudioEngineError> {
        Err(AudioEngineError::OutputDeviceUnavailable)
    }

    fn snapshot(&self) -> AudioEngineSnapshot {
        AudioEngineSnapshot {
            output_error: Some("No usable audio output device is available.".to_owned()),
            ..AudioEngineSnapshot::default()
        }
    }

    fn output_devices(&self) -> Result<Vec<AudioOutputDevice>, AudioEngineError> {
        Ok(Vec::new())
    }
}

enum AudioCommand {
    Load {
        source: PreparedPlaybackSource,
        reply: mpsc::SyncSender<Result<AudioLoadMetadata, AudioEngineError>>,
    },
    Play(mpsc::SyncSender<Result<(), AudioEngineError>>),
    Pause(mpsc::SyncSender<Result<(), AudioEngineError>>),
    Stop(mpsc::SyncSender<Result<(), AudioEngineError>>),
    SetVolume {
        volume: f32,
        reply: mpsc::SyncSender<Result<(), AudioEngineError>>,
    },
    SetOutputDevice {
        device_id: String,
        reply: mpsc::SyncSender<Result<(), AudioEngineError>>,
    },
    Devices(mpsc::SyncSender<Result<Vec<AudioOutputDevice>, AudioEngineError>>),
    RecoverOutput(mpsc::SyncSender<Result<(), AudioEngineError>>),
    Shutdown,
}

struct PendingSeek {
    position: Duration,
    source_generation: u64,
    reply: mpsc::SyncSender<Result<(), AudioEngineError>>,
}

pub struct RodioAudioEngine {
    commands: mpsc::Sender<AudioCommand>,
    pending_seek: Arc<Mutex<Option<PendingSeek>>>,
    source_generation: Arc<AtomicU64>,
    snapshot: Arc<Mutex<AudioEngineSnapshot>>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
}

impl RodioAudioEngine {
    pub fn open_default() -> Result<Self, AudioEngineError> {
        let (commands, receiver) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let snapshot = Arc::new(Mutex::new(AudioEngineSnapshot::default()));
        let pending_seek = Arc::new(Mutex::new(None));
        let source_generation = Arc::new(AtomicU64::new(0));
        let worker_snapshot = Arc::clone(&snapshot);
        let worker_pending = Arc::clone(&pending_seek);
        let worker_generation = Arc::clone(&source_generation);

        let worker = thread::Builder::new()
            .name("native-audio-engine".to_owned())
            .spawn(move || {
                audio_worker(
                    receiver,
                    worker_snapshot,
                    worker_pending,
                    worker_generation,
                    ready_tx,
                )
            })
            .map_err(|_| AudioEngineError::WorkerUnavailable)?;

        match ready_rx.recv_timeout(COMMAND_TIMEOUT) {
            Ok(Ok(())) => Ok(Self {
                commands,
                pending_seek,
                source_generation,
                snapshot,
                worker: Mutex::new(Some(worker)),
            }),
            Ok(Err(error)) => {
                let _ = worker.join();
                Err(error)
            }
            Err(_) => {
                let _ = worker.join();
                Err(AudioEngineError::WorkerTimeout)
            }
        }
    }

    fn request<T>(
        &self,
        build: impl FnOnce(mpsc::SyncSender<Result<T, AudioEngineError>>) -> AudioCommand,
    ) -> Result<T, AudioEngineError> {
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        self.commands
            .send(build(reply_tx))
            .map_err(|_| AudioEngineError::WorkerUnavailable)?;
        reply_rx
            .recv_timeout(COMMAND_TIMEOUT)
            .map_err(|_| AudioEngineError::WorkerTimeout)?
    }
}

impl AudioEngine for RodioAudioEngine {
    fn load(&self, source: &PreparedPlaybackSource) -> Result<AudioLoadMetadata, AudioEngineError> {
        self.request(|reply| AudioCommand::Load {
            source: source.clone(),
            reply,
        })
    }

    fn play(&self) -> Result<(), AudioEngineError> {
        self.request(AudioCommand::Play)
    }

    fn pause(&self) -> Result<(), AudioEngineError> {
        self.request(AudioCommand::Pause)
    }

    fn stop(&self) -> Result<(), AudioEngineError> {
        self.request(AudioCommand::Stop)
    }

    fn seek(&self, position: Duration) -> Result<(), AudioEngineError> {
        // Queue the latest intent and return immediately. Waiting on try_seek
        // serializes Electron stdio RPCs for up to COMMAND_TIMEOUT, so Core
        // SeekMailbox and this pending slot never coalesce under rapid seek.
        let generation = self.source_generation.load(Ordering::Acquire);
        {
            let mut slot = self
                .pending_seek
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(previous) = slot.take() {
                tracing::debug!(
                    target: "audio.seek",
                    superseded_generation = previous.source_generation,
                    "coalesced superseded seek"
                );
                let _ = previous.reply.send(Ok(()));
            }
            let (reply_tx, _reply_rx) = mpsc::sync_channel(1);
            *slot = Some(PendingSeek {
                position,
                source_generation: generation,
                reply: reply_tx,
            });
        }
        Ok(())
    }

    fn set_volume(&self, volume: f32) -> Result<(), AudioEngineError> {
        self.request(|reply| AudioCommand::SetVolume { volume, reply })
    }

    fn set_output_device(&self, device_id: &str) -> Result<(), AudioEngineError> {
        self.request(|reply| AudioCommand::SetOutputDevice {
            device_id: device_id.to_owned(),
            reply,
        })
    }

    fn snapshot(&self) -> AudioEngineSnapshot {
        self.snapshot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn output_devices(&self) -> Result<Vec<AudioOutputDevice>, AudioEngineError> {
        self.request(AudioCommand::Devices)
    }

    fn recover_output(&self) -> Result<(), AudioEngineError> {
        self.request(AudioCommand::RecoverOutput)
    }
}

impl Drop for RodioAudioEngine {
    fn drop(&mut self) {
        let _ = self.commands.send(AudioCommand::Shutdown);
        if let Some(worker) = self
            .worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            let _ = worker.join();
        }
    }
}

fn discard_pending_seeks(pending_seek: &Mutex<Option<PendingSeek>>) {
    if let Some(pending) = pending_seek
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
    {
        let _ = pending.reply.send(Ok(()));
    }
}

fn apply_pending_seek(
    player: &mut Player,
    pending_seek: &Mutex<Option<PendingSeek>>,
    current_generation: u64,
) {
    let Some(pending) = pending_seek
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
    else {
        return;
    };
    if pending.source_generation != current_generation {
        tracing::debug!(
            target: "audio.seek",
            pending_generation = pending.source_generation,
            current_generation,
            "discarded stale seek"
        );
        let _ = pending.reply.send(Ok(()));
        return;
    }
    let result = player
        .try_seek(pending.position)
        .map_err(|_| AudioEngineError::SeekUnsupported);
    let _ = pending.reply.send(result);
}

fn audio_worker(
    receiver: mpsc::Receiver<AudioCommand>,
    snapshot: Arc<Mutex<AudioEngineSnapshot>>,
    pending_seek: Arc<Mutex<Option<PendingSeek>>>,
    source_generation: Arc<AtomicU64>,
    ready: mpsc::SyncSender<Result<(), AudioEngineError>>,
) {
    let default_selection = OutputSelection::SystemDefault;
    let (mut device_sink, mut player, mut selected_output, mut resolved_output) =
        match open_output(&default_selection, &snapshot, None) {
            Ok(output) => output,
            Err(error) => {
                let _ = ready.send(Err(error));
                return;
            }
        };
    let mut progressive_monitor: Option<ProgressiveMonitor> = None;
    let mut loaded_source: Option<PreparedPlaybackSource> = None;
    let mut accepted_load_generation = 0_u64;
    let mut current_volume = 1.0_f32;
    let mut last_recovery_attempt = Instant::now()
        .checked_sub(Duration::from_secs(5))
        .unwrap_or_else(Instant::now);
    let mut recovery_attempts = 0_usize;
    let mut playhead = PlayheadWatch::new();
    let _ = ready.send(Ok(()));

    loop {
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(AudioCommand::Load { source, reply }) => {
                if playhead.stalled_while_playing()
                    && !player.is_paused()
                    && !player.empty()
                    && playhead.recover_attempts < MAX_PLAYHEAD_RECOVER_ATTEMPTS
                {
                    match replace_output(
                        &selected_output,
                        &snapshot,
                        &player,
                        loaded_source.as_ref(),
                        current_volume,
                    ) {
                        Ok(rebuilt) => {
                            tracing::warn!(
                                target: "audio",
                                position_ms = duration_ms(player.get_pos()),
                                "rebuilt audio output before load because the playhead was frozen"
                            );
                            install_rebuilt_output(
                                &mut device_sink,
                                &mut player,
                                &mut progressive_monitor,
                                &mut selected_output,
                                &mut resolved_output,
                                &mut recovery_attempts,
                                &snapshot,
                                rebuilt,
                            );
                            playhead.note_transport();
                        }
                        Err(error) => {
                            tracing::warn!(
                                target: "audio",
                                error = %error,
                                "frozen-playhead rebuild before load failed"
                            );
                        }
                    }
                }
                if source.load_generation != 0 && source.load_generation < accepted_load_generation
                {
                    tracing::debug!(
                        target: "audio.source",
                        load_generation = source.load_generation,
                        accepted_load_generation,
                        "discarded stale source load"
                    );
                    let _ = reply.send(Err(AudioEngineError::StaleCommand));
                } else {
                    if source.load_generation != 0 {
                        accepted_load_generation = source.load_generation;
                    }
                    let generation = source_generation.fetch_add(1, Ordering::AcqRel) + 1;
                    discard_pending_seeks(&pending_seek);
                    let result = decode_source(&source).and_then(|decoded| {
                        let source_sample_rate = decoded.sample_rate;
                        if source_sample_rate != resolved_output.sample_rate {
                            let (next_sink, next_player, selection, resolved) =
                                open_output(&selected_output, &snapshot, Some(source_sample_rate))?;
                            source
                                .epoch_guard
                                .validate()
                                .map_err(|_| AudioEngineError::SourceCancelled)?;
                            next_player.set_volume(current_volume);
                            device_sink = next_sink;
                            player = next_player;
                            selected_output = selection;
                            resolved_output = resolved;
                            recovery_attempts = 0;
                            snapshot
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner())
                                .output_error = None;
                        }
                        source
                            .epoch_guard
                            .validate()
                            .map_err(|_| AudioEngineError::SourceCancelled)?;
                        Ok(append_decoded_source(&player, decoded))
                    });
                    let mut current = snapshot
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    match &result {
                        Ok((metadata, monitor)) => {
                            progressive_monitor = monitor.clone();
                            loaded_source = Some(source);
                            let output_error = current.output_error.clone();
                            *current = AudioEngineSnapshot {
                                loaded: true,
                                paused: true,
                                duration_ms: metadata.duration_ms,
                                source_generation: generation,
                                output_error,
                                ..AudioEngineSnapshot::default()
                            };
                        }
                        Err(_) => {
                            progressive_monitor = None;
                            loaded_source = None;
                            reset_playback_snapshot(&mut current);
                            current.source_generation = generation;
                        }
                    }
                    let _ = reply.send(result.map(|(metadata, _)| metadata));
                }
                playhead.note_transport();
            }
            Ok(AudioCommand::Play(reply)) => {
                let result = loaded_source.as_ref().map_or(Ok(()), |source| {
                    source
                        .epoch_guard
                        .validate_and_run(|| player.play())
                        .map_err(|_| AudioEngineError::SourceCancelled)
                });
                if result.is_err() {
                    player.clear();
                    progressive_monitor = None;
                    loaded_source = None;
                    reset_playback_snapshot(
                        &mut snapshot
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner()),
                    );
                }
                let _ = reply.send(result);
                playhead.note_transport();
            }
            Ok(AudioCommand::Pause(reply)) => {
                player.pause();
                let _ = reply.send(Ok(()));
                playhead.note_transport();
            }
            Ok(AudioCommand::Stop(reply)) => {
                source_generation.fetch_add(1, Ordering::AcqRel);
                discard_pending_seeks(&pending_seek);
                player.clear();
                progressive_monitor = None;
                loaded_source = None;
                reset_playback_snapshot(
                    &mut snapshot
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()),
                );
                let _ = reply.send(Ok(()));
                playhead.note_transport();
            }
            Ok(AudioCommand::SetVolume { volume, reply }) => {
                current_volume = volume.clamp(0.0, 1.0);
                player.set_volume(current_volume);
                let _ = reply.send(Ok(()));
            }
            Ok(AudioCommand::SetOutputDevice { device_id, reply }) => {
                let selection = OutputSelection::parse(&device_id);
                let result = selection.and_then(|selection| {
                    replace_output(
                        &selection,
                        &snapshot,
                        &player,
                        loaded_source.as_ref(),
                        current_volume,
                    )
                });
                match result {
                    Ok((next_sink, next_player, next_monitor, selection, resolved)) => {
                        device_sink = next_sink;
                        player = next_player;
                        progressive_monitor = next_monitor;
                        selected_output = selection;
                        resolved_output = resolved;
                        recovery_attempts = 0;
                        snapshot
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .output_error = None;
                        let _ = reply.send(Ok(()));
                    }
                    Err(error) => {
                        let _ = reply.send(Err(error));
                    }
                }
            }
            Ok(AudioCommand::Devices(reply)) => {
                let _ = reply.send(list_output_devices(&selected_output, &resolved_output));
            }
            Ok(AudioCommand::RecoverOutput(reply)) => {
                let result = replace_output(
                    &selected_output,
                    &snapshot,
                    &player,
                    loaded_source.as_ref(),
                    current_volume,
                );
                match result {
                    Ok(rebuilt) => {
                        tracing::warn!(
                            target: "audio",
                            selection = selected_output.kind(),
                            resolved_device = resolved_output.name,
                            "rebuilt audio output after a frozen playhead"
                        );
                        install_rebuilt_output(
                            &mut device_sink,
                            &mut player,
                            &mut progressive_monitor,
                            &mut selected_output,
                            &mut resolved_output,
                            &mut recovery_attempts,
                            &snapshot,
                            rebuilt,
                        );
                        playhead.note_transport();
                        let _ = reply.send(Ok(()));
                    }
                    Err(error) => {
                        tracing::warn!(
                            target: "audio",
                            error = %error,
                            "frozen-playhead output rebuild failed"
                        );
                        let _ = reply.send(Err(error));
                    }
                }
            }
            Ok(AudioCommand::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                discard_pending_seeks(&pending_seek);
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }

        apply_pending_seek(
            &mut player,
            &pending_seek,
            source_generation.load(Ordering::Acquire),
        );

        if loaded_source
            .as_ref()
            .is_some_and(|source| source.epoch_guard.validate().is_err())
        {
            source_generation.fetch_add(1, Ordering::AcqRel);
            discard_pending_seeks(&pending_seek);
            player.clear();
            progressive_monitor = None;
            loaded_source = None;
            reset_playback_snapshot(
                &mut snapshot
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()),
            );
        }

        let output_interrupted = snapshot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .output_error
            .is_some();
        if output_interrupted
            && recovery_attempts < MAX_OUTPUT_RECOVERY_ATTEMPTS
            && last_recovery_attempt.elapsed() >= OUTPUT_RECOVERY_INTERVAL
        {
            last_recovery_attempt = Instant::now();
            recovery_attempts += 1;
            tracing::warn!(
                target: "audio",
                selection = selected_output.kind(),
                attempt = recovery_attempts,
                max_attempts = MAX_OUTPUT_RECOVERY_ATTEMPTS,
                "attempting to rebuild an interrupted audio output"
            );
            match replace_output(
                &recovery_selection(&selected_output),
                &snapshot,
                &player,
                loaded_source.as_ref(),
                current_volume,
            ) {
                Ok((next_sink, next_player, next_monitor, selection, resolved)) => {
                    tracing::info!(
                        target: "audio",
                        selection = selection.kind(),
                        resolved_device = resolved.name,
                        "recovered playback on the selected audio output"
                    );
                    device_sink = next_sink;
                    player = next_player;
                    progressive_monitor = next_monitor;
                    selected_output = selection;
                    resolved_output = resolved;
                    recovery_attempts = 0;
                    snapshot
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .output_error = None;
                }
                Err(error) => {
                    tracing::warn!(
                        target: "audio",
                        selection = selected_output.kind(),
                        attempt = recovery_attempts,
                        error = %error,
                        "audio output rebuild failed"
                    );
                    if recovery_attempts == MAX_OUTPUT_RECOVERY_ATTEMPTS {
                        snapshot
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .output_error = Some(format!(
                            "The selected audio output could not be restored after {MAX_OUTPUT_RECOVERY_ATTEMPTS} attempts."
                        ));
                    }
                }
            }
        }

        let (loaded_playing, buffering) = {
            let mut current = snapshot
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if current.loaded {
                current.position_ms = duration_ms(player.get_pos());
                current.paused = player.is_paused();
                current.ended = player.empty();
                current.playing =
                    !current.paused && !current.ended && current.output_error.is_none();
                if let Some(monitor) = &progressive_monitor {
                    current.buffering = monitor.is_waiting();
                    current.source_error = monitor.error();
                    current.source_url_expired = monitor.error_kind()
                        == Some(crate::streaming::ProgressiveError::UrlExpired);
                    current.progressive_downloaded_bytes = Some(monitor.downloaded_bytes());
                    current.progressive_total_bytes = Some(monitor.content_length());
                    if current.source_error.is_some() {
                        current.playing = false;
                    }
                } else {
                    current.buffering = false;
                    current.source_error = None;
                    current.source_url_expired = false;
                    current.progressive_downloaded_bytes = None;
                    current.progressive_total_bytes = None;
                }
                playhead.note_position(current.position_ms);
                (
                    current.playing
                        && !current.paused
                        && !current.ended
                        && !current.buffering
                        && current.source_error.is_none()
                        && current.output_error.is_none(),
                    current.buffering,
                )
            } else {
                playhead.note_position(current.position_ms);
                (false, false)
            }
        };

        if loaded_playing && playhead.stalled_while_playing() {
            if !playhead.nudged_play {
                player.play();
                playhead.nudged_play = true;
                playhead.last_recover_at = Instant::now();
                tracing::warn!(
                    target: "audio",
                    position_ms = playhead.last_pos_ms,
                    stalled_ms = playhead.last_move_at.elapsed().as_millis() as u64,
                    "nudged Rodio play() because get_pos() stopped advancing"
                );
            } else if playhead.last_recover_at.elapsed() >= PLAYHEAD_RECOVER_INTERVAL
                && playhead.recover_attempts < MAX_PLAYHEAD_RECOVER_ATTEMPTS
            {
                playhead.recover_attempts += 1;
                playhead.last_recover_at = Instant::now();
                tracing::warn!(
                    target: "audio",
                    position_ms = playhead.last_pos_ms,
                    attempt = playhead.recover_attempts,
                    max_attempts = MAX_PLAYHEAD_RECOVER_ATTEMPTS,
                    "rebuilding audio output because get_pos() is frozen while playing"
                );
                match replace_output(
                    &selected_output,
                    &snapshot,
                    &player,
                    loaded_source.as_ref(),
                    current_volume,
                ) {
                    Ok(rebuilt) => {
                        install_rebuilt_output(
                            &mut device_sink,
                            &mut player,
                            &mut progressive_monitor,
                            &mut selected_output,
                            &mut resolved_output,
                            &mut recovery_attempts,
                            &snapshot,
                            rebuilt,
                        );
                        playhead.note_transport();
                        playhead.last_pos_ms = duration_ms(player.get_pos());
                    }
                    Err(error) => {
                        tracing::warn!(
                            target: "audio",
                            error = %error,
                            attempt = playhead.recover_attempts,
                            "frozen-playhead output rebuild failed"
                        );
                    }
                }
            } else if playhead.recover_attempts >= MAX_PLAYHEAD_RECOVER_ATTEMPTS
                && playhead.last_recover_at.elapsed() >= Duration::from_secs(5)
            {
                playhead.last_recover_at = Instant::now();
                tracing::error!(
                    target: "audio",
                    position_ms = playhead.last_pos_ms,
                    "playhead is still frozen after output rebuilds; mixer is not consuming"
                );
            }
        } else if buffering || player.is_paused() {
            playhead.last_move_at = Instant::now();
            playhead.nudged_play = false;
        }

        let _keep_output_alive = &device_sink;
    }
}

fn open_output(
    selection: &OutputSelection,
    snapshot: &Arc<Mutex<AudioEngineSnapshot>>,
    requested_sample_rate: Option<u32>,
) -> Result<
    (
        MixerDeviceSink,
        Player,
        OutputSelection,
        AudioResolvedOutput,
    ),
    AudioEngineError,
> {
    let host = rodio::cpal::default_host();
    let host_name = host.id().to_string();
    let (device, resolved_selection) = match selection {
        OutputSelection::SystemDefault => (
            host.default_output_device()
                .ok_or(AudioEngineError::OutputDeviceUnavailable)?,
            OutputSelection::SystemDefault,
        ),
        OutputSelection::SpecificDevice(device_id) => enumerated_output_devices()?
            .into_iter()
            .find_map(|(device, info, legacy_id)| {
                (info.id == *device_id || legacy_id == *device_id)
                    .then_some((device, OutputSelection::SpecificDevice(info.id)))
            })
            .ok_or(AudioEngineError::OutputDeviceUnavailable)?,
    };
    let description = device
        .description()
        .map_err(|_| AudioEngineError::OutputDeviceUnavailable)?;
    let (device_name, driver) = device_signature(&description);
    let default_config = device.default_output_config().ok().map(|config| {
        format!(
            "{} Hz / {} channels / {}",
            config.sample_rate(),
            config.channels(),
            config.sample_format()
        )
    });
    let mut builder = DeviceSinkBuilder::from_device(device)
        .map_err(|_| AudioEngineError::OutputDeviceOpenFailed)?;
    if let Some(sample_rate) = requested_sample_rate.and_then(std::num::NonZeroU32::new) {
        builder = builder.with_sample_rate(sample_rate);
    }
    let output_snapshot = Arc::clone(snapshot);
    let interrupted_device = device_name.clone();
    let interrupted_selection = resolved_selection.kind();
    let mut last_underrun_log = Instant::now()
        .checked_sub(OUTPUT_UNDERRUN_LOG_INTERVAL)
        .unwrap_or_else(Instant::now);
    let mut sink = builder
        .with_error_callback(move |error| {
            if !output_stream_error_interrupts_playback(&error) {
                if last_underrun_log.elapsed() >= OUTPUT_UNDERRUN_LOG_INTERVAL {
                    last_underrun_log = Instant::now();
                    tracing::warn!(
                        target: "audio",
                        error = %error,
                        selection = interrupted_selection,
                        resolved_device = interrupted_device,
                        "audio output buffer underrun; keeping the active stream"
                    );
                }
                return;
            }
            tracing::error!(
                target: "audio",
                error = %error,
                selection = interrupted_selection,
                resolved_device = interrupted_device,
                "audio output stream failed"
            );
            let mut current = output_snapshot
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            current.playing = false;
            current.output_error = Some("The selected audio output device was interrupted.".into());
        })
        .open_sink_or_fallback()
        .map_err(|error| {
            tracing::error!(
                target: "audio",
                selection = resolved_selection.kind(),
                resolved_device = device_name,
                driver,
                host = host_name,
                requested_sample_rate,
                default_config = default_config.as_deref().unwrap_or("unavailable"),
                error = %error,
                "audio output stream creation failed"
            );
            AudioEngineError::OutputDeviceOpenFailed
        })?;
    sink.log_on_drop(false);
    let config = sink.config();
    let resolved = AudioResolvedOutput {
        name: device_name,
        driver,
        host: host_name,
        sample_rate: config.sample_rate().into(),
        channels: config.channel_count().into(),
        sample_format: config.sample_format().to_string(),
    };
    tracing::info!(
        target: "audio",
        selection = resolved_selection.kind(),
        resolved_device = resolved.name,
        driver = resolved.driver,
        host = resolved.host,
        sample_rate = resolved.sample_rate,
        requested_sample_rate,
        channels = resolved.channels,
        sample_format = resolved.sample_format,
        default_config = default_config.as_deref().unwrap_or("unavailable"),
        "audio output stream opened"
    );
    let player = Player::connect_new(sink.mixer());
    player.pause();
    Ok((sink, player, resolved_selection, resolved))
}

fn replace_output(
    selection: &OutputSelection,
    snapshot: &Arc<Mutex<AudioEngineSnapshot>>,
    current_player: &Player,
    loaded_source: Option<&PreparedPlaybackSource>,
    volume: f32,
) -> Result<
    (
        MixerDeviceSink,
        Player,
        Option<ProgressiveMonitor>,
        OutputSelection,
        AudioResolvedOutput,
    ),
    AudioEngineError,
> {
    let was_paused = current_player.is_paused();
    let position = current_player.get_pos();
    let decoded = loaded_source.map(decode_source).transpose()?;
    let requested_sample_rate = decoded.as_ref().map(|decoded| decoded.sample_rate);
    let (sink, player, selection, resolved) =
        open_output(selection, snapshot, requested_sample_rate)?;
    player.set_volume(volume);
    let monitor = if let Some((source, decoded)) = loaded_source.zip(decoded) {
        source
            .epoch_guard
            .validate()
            .map_err(|_| AudioEngineError::SourceCancelled)?;
        let (_, monitor) = append_decoded_source(&player, decoded);
        if position > Duration::ZERO {
            player
                .try_seek(position)
                .map_err(|_| AudioEngineError::SeekUnsupported)?;
        }
        if !was_paused {
            player.play();
        }
        monitor
    } else {
        None
    };
    Ok((sink, player, monitor, selection, resolved))
}

struct DecodedPlaybackSource {
    source: Box<dyn Source + Send>,
    metadata: AudioLoadMetadata,
    monitor: Option<ProgressiveMonitor>,
    sample_rate: u32,
}

fn decode_source(
    source: &PreparedPlaybackSource,
) -> Result<DecodedPlaybackSource, AudioEngineError> {
    source
        .epoch_guard
        .validate_and_run(|| decode_source_unchecked(source))
        .map_err(|_| AudioEngineError::SourceCancelled)?
}

fn decode_source_unchecked(
    source: &PreparedPlaybackSource,
) -> Result<DecodedPlaybackSource, AudioEngineError> {
    tracing::debug!(
        target: "audio",
        format = source.format.as_str(),
        preview = source.is_preview,
        cache_key = %source.cache_key,
        "loading prepared media"
    );
    match &source.location {
        PreparedPlaybackLocation::Local(path) => {
            let file = File::open(path).map_err(|_| AudioEngineError::MediaOpenFailed)?;
            let decoder = Decoder::try_from(file).map_err(|error| {
                tracing::warn!(
                    target: "audio",
                    format = source.format.as_str(),
                    error = %error,
                    "decoder rejected media"
                );
                AudioEngineError::DecoderUnsupported
            })?;
            Ok(decoded_playback_source(decoder, source.format, None))
        }
        PreparedPlaybackLocation::Progressive(progressive) => {
            let reader = progressive
                .open_reader()
                .map_err(|_| AudioEngineError::StreamingFailed)?;
            let decoder = DecoderBuilder::new()
                .with_data(reader)
                .with_byte_len(progressive.content_length())
                .with_seekable(true)
                .with_hint(source.format.extension())
                .build()
                .map_err(|error| {
                    tracing::warn!(
                        target: "audio",
                        format = source.format.as_str(),
                        error = %error,
                        "decoder rejected progressive media"
                    );
                    AudioEngineError::DecoderUnsupported
                })?;
            Ok(decoded_playback_source(
                decoder,
                source.format,
                Some(progressive.monitor()),
            ))
        }
        PreparedPlaybackLocation::EncryptedLocal {
            path,
            content_length,
            decryptor,
        } => {
            let mut reader = DecryptingReader::new(
                File::open(path).map_err(|_| AudioEngineError::MediaOpenFailed)?,
                decryptor.clone(),
            );
            validate_decrypted_flac(&mut reader, decryptor.as_ref())?;
            let decoder = DecoderBuilder::new()
                .with_data(reader)
                .with_byte_len(*content_length)
                .with_seekable(true)
                .with_hint(source.format.extension())
                .build()
                .map_err(|error| {
                    tracing::warn!(
                        target: "audio",
                        media_kind = "encrypted-flac",
                        error = %error,
                        "decoder rejected decrypted media"
                    );
                    AudioEngineError::DecoderUnsupported
                })?;
            Ok(decoded_playback_source(decoder, source.format, None))
        }
        PreparedPlaybackLocation::EncryptedProgressive { source, decryptor } => {
            let mut reader = DecryptingReader::new(
                source
                    .open_reader()
                    .map_err(|_| AudioEngineError::StreamingFailed)?,
                decryptor.clone(),
            );
            validate_decrypted_flac(&mut reader, decryptor.as_ref())?;
            let decoder = DecoderBuilder::new()
                .with_data(reader)
                .with_byte_len(source.content_length())
                .with_seekable(true)
                .with_hint("flac")
                .build()
                .map_err(|error| {
                    tracing::warn!(
                        target: "audio",
                        media_kind = "encrypted-progressive-flac",
                        error = %error,
                        "decoder rejected decrypted progressive media"
                    );
                    AudioEngineError::DecoderUnsupported
                })?;
            Ok(decoded_playback_source(
                decoder,
                AudioFormat::Flac,
                Some(source.monitor()),
            ))
        }
    }
}

fn decoded_playback_source<S>(
    source: S,
    format: AudioFormat,
    monitor: Option<ProgressiveMonitor>,
) -> DecodedPlaybackSource
where
    S: Source + Send + 'static,
{
    let sample_rate = source.sample_rate().get();
    let duration_ms = source.total_duration().map(duration_ms);
    tracing::debug!(
        target: "audio",
        source_sample_rate = sample_rate,
        source_channels = source.channels().get(),
        "decoded media format"
    );
    DecodedPlaybackSource {
        source: Box::new(source),
        metadata: AudioLoadMetadata {
            duration_ms,
            format,
        },
        monitor,
        sample_rate,
    }
}

fn append_decoded_source(
    player: &Player,
    decoded: DecodedPlaybackSource,
) -> (AudioLoadMetadata, Option<ProgressiveMonitor>) {
    let DecodedPlaybackSource {
        source,
        metadata,
        monitor,
        ..
    } = decoded;
    player.clear();
    player.append(source);
    player.pause();
    (metadata, monitor)
}

fn validate_decrypted_flac<Reader: Read + Seek>(
    reader: &mut Reader,
    decryptor: &dyn MediaDecryptor,
) -> Result<(), AudioEngineError> {
    let mut magic = [0_u8; 4];
    reader.read_exact(&mut magic).map_err(|error| {
        tracing::warn!(
            target: "audio",
            error = %error,
            "failed to read the decrypted media signature"
        );
        AudioEngineError::DecryptionFailed
    })?;
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|_| AudioEngineError::DecryptionFailed)?;
    let valid = magic == *b"fLaC";
    let magic_hex = format!(
        "{:02x}{:02x}{:02x}{:02x}",
        magic[0], magic[1], magic[2], magic[3]
    );
    if valid {
        tracing::debug!(
            target: "audio",
            decrypted_magic = %magic_hex,
            valid_flac = true,
            "probed decrypted media signature"
        );
    } else {
        tracing::warn!(
            target: "audio",
            decrypted_magic = %magic_hex,
            valid_flac = false,
            cipher = decryptor.cipher_kind(),
            derived_key_length = decryptor.derived_key_length(),
            "decrypted media does not start with the FLAC signature; key or stream mismatch"
        );
    }
    valid
        .then_some(())
        .ok_or(AudioEngineError::DecryptionFailed)
}

fn list_output_devices(
    selection: &OutputSelection,
    resolved_output: &AudioResolvedOutput,
) -> Result<Vec<AudioOutputDevice>, AudioEngineError> {
    let host = rodio::cpal::default_host();
    let default_device_id = host
        .default_output_device()
        .and_then(|device| device.id().ok())
        .map(|device_id| stable_device_id(&device_id.to_string()));
    let mut result = vec![AudioOutputDevice {
        id: DEFAULT_OUTPUT_ID.to_owned(),
        label: "System default".to_owned(),
        is_default: true,
        is_selected: matches!(selection, OutputSelection::SystemDefault),
        selection_kind: "system-default".to_owned(),
        resolved_output: matches!(selection, OutputSelection::SystemDefault)
            .then(|| resolved_output.clone()),
    }];
    match enumerated_output_devices() {
        Ok(devices) => result.extend(devices.into_iter().map(|(_, mut info, _)| {
            info.is_default = default_device_id
                .as_ref()
                .is_some_and(|device_id| info.id == *device_id);
            info.is_selected = info.id == selection.id();
            if info.is_selected {
                info.resolved_output = Some(resolved_output.clone());
            }
            info
        })),
        Err(error) => {
            tracing::warn!(
                target: "audio",
                error = %error,
                "audio device enumeration failed; reporting the active output only"
            );
            if let OutputSelection::SpecificDevice(device_id) = selection {
                result.push(AudioOutputDevice {
                    id: device_id.clone(),
                    label: resolved_output.name.clone(),
                    is_default: false,
                    is_selected: true,
                    selection_kind: "specific-device".to_owned(),
                    resolved_output: Some(resolved_output.clone()),
                });
            }
        }
    }
    Ok(result)
}

fn enumerated_output_devices() -> Result<Vec<(Device, AudioOutputDevice, String)>, AudioEngineError>
{
    let host = rodio::cpal::default_host();
    let devices = host
        .output_devices()
        .map_err(|_| AudioEngineError::OutputDeviceUnavailable)?;
    let mut ordinals = std::collections::HashMap::<(String, String), usize>::new();
    Ok(devices
        .filter_map(|device| {
            let description = device.description().ok()?;
            let signature = device_signature(&description);
            let ordinal = ordinals.entry(signature.clone()).or_default();
            let legacy_id = legacy_device_id(&signature.0, &signature.1, *ordinal);
            *ordinal += 1;
            let native_id = device.id().ok()?.to_string();
            let id = stable_device_id(&native_id);
            Some((
                device,
                AudioOutputDevice {
                    id,
                    label: signature.0,
                    is_default: false,
                    is_selected: false,
                    selection_kind: "specific-device".to_owned(),
                    resolved_output: None,
                },
                legacy_id,
            ))
        })
        .collect())
}

fn device_signature(description: &rodio::cpal::DeviceDescription) -> (String, String) {
    (
        description.name().to_owned(),
        description.driver().unwrap_or("unknown").to_owned(),
    )
}

fn stable_device_id(native_id: &str) -> String {
    let digest = Sha256::digest(native_id.as_bytes());
    let suffix = digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("device:{suffix}")
}

fn legacy_device_id(name: &str, driver: &str, ordinal: usize) -> String {
    let digest = Sha256::digest(format!("{driver}\0{name}\0{ordinal}").as_bytes());
    let suffix = digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("device:{suffix}")
}

fn duration_ms(duration: Duration) -> u64 {
    duration.as_millis().min(u64::MAX as u128) as u64
}

pub fn write_fixture_wav(path: &Path, duration: Duration, seed: u32) -> std::io::Result<()> {
    const SAMPLE_RATE: u32 = 16_000;
    const CHANNELS: u16 = 1;
    const BITS_PER_SAMPLE: u16 = 16;
    let sample_count = (duration.as_secs_f64() * f64::from(SAMPLE_RATE)).round() as u32;
    let data_size = sample_count * u32::from(CHANNELS) * u32::from(BITS_PER_SAMPLE / 8);
    let mut writer = BufWriter::new(File::create(path)?);

    writer.write_all(b"RIFF")?;
    writer.write_all(&(36_u32.saturating_add(data_size)).to_le_bytes())?;
    writer.write_all(b"WAVEfmt ")?;
    writer.write_all(&16_u32.to_le_bytes())?;
    writer.write_all(&1_u16.to_le_bytes())?;
    writer.write_all(&CHANNELS.to_le_bytes())?;
    writer.write_all(&SAMPLE_RATE.to_le_bytes())?;
    let byte_rate = SAMPLE_RATE * u32::from(CHANNELS) * u32::from(BITS_PER_SAMPLE / 8);
    writer.write_all(&byte_rate.to_le_bytes())?;
    let block_align = CHANNELS * (BITS_PER_SAMPLE / 8);
    writer.write_all(&block_align.to_le_bytes())?;
    writer.write_all(&BITS_PER_SAMPLE.to_le_bytes())?;
    writer.write_all(b"data")?;
    writer.write_all(&data_size.to_le_bytes())?;

    let root = 174.0 + f64::from(seed % 9) * 11.0;
    for sample_index in 0..sample_count {
        let time = f64::from(sample_index) / f64::from(SAMPLE_RATE);
        let phase = (time % 8.0) / 8.0;
        let envelope = (phase * std::f64::consts::PI).sin().powi(2);
        let chord = (time * root * std::f64::consts::TAU).sin()
            + 0.45 * (time * root * 1.5 * std::f64::consts::TAU).sin()
            + 0.25 * (time * root * 2.0 * std::f64::consts::TAU).sin();
        let sample = (chord * envelope * 1_600.0).clamp(f64::from(i16::MIN), f64::from(i16::MAX));
        writer.write_all(&(sample as i16).to_le_bytes())?;
    }
    writer.flush()
}

#[cfg(any(test, feature = "test-support"))]
#[derive(Clone, Copy)]
struct LiveClockState {
    origin: Instant,
    base_ms: u64,
}

#[cfg(any(test, feature = "test-support"))]
pub struct TestAudioEngine {
    state: Mutex<AudioEngineSnapshot>,
    volume: Mutex<f32>,
    loaded_guard: Mutex<Option<PlaybackEpochGuard>>,
    cancel_after_play: Mutex<Option<tokio_util::sync::CancellationToken>>,
    source_generation: AtomicU64,
    loads: AtomicU64,
    overlaps: AtomicU64,
    accepted_load_generation: AtomicU64,
    live_clock: bool,
    live_clock_state: Mutex<Option<LiveClockState>>,
}

#[cfg(any(test, feature = "test-support"))]
impl Default for TestAudioEngine {
    fn default() -> Self {
        Self {
            state: Mutex::new(AudioEngineSnapshot::default()),
            volume: Mutex::new(0.72),
            loaded_guard: Mutex::new(None),
            cancel_after_play: Mutex::new(None),
            source_generation: AtomicU64::new(0),
            loads: AtomicU64::new(0),
            overlaps: AtomicU64::new(0),
            accepted_load_generation: AtomicU64::new(0),
            live_clock: false,
            live_clock_state: Mutex::new(None),
        }
    }
}

#[cfg(any(test, feature = "test-support"))]
impl TestAudioEngine {
    pub fn with_live_clock() -> Self {
        Self {
            live_clock: true,
            ..Self::default()
        }
    }

    fn arm_live_clock(&self, position_ms: u64) {
        if !self.live_clock {
            return;
        }
        *self
            .live_clock_state
            .lock()
            .expect("test engine live clock lock") = Some(LiveClockState {
            origin: Instant::now(),
            base_ms: position_ms,
        });
    }

    fn clear_live_clock(&self) {
        *self
            .live_clock_state
            .lock()
            .expect("test engine live clock lock") = None;
    }

    fn apply_live_clock(&self, state: &mut AudioEngineSnapshot) {
        if !self.live_clock {
            return;
        }
        let clock = *self
            .live_clock_state
            .lock()
            .expect("test engine live clock lock");
        let Some(clock) = clock else {
            return;
        };
        if !(state.playing
            && !state.paused
            && !state.buffering
            && !state.ended
            && state.source_error.is_none())
        {
            return;
        }
        let elapsed = clock.origin.elapsed().as_millis().min(u64::MAX as u128) as u64;
        let mut position = clock.base_ms.saturating_add(elapsed);
        if let Some(duration) = state.duration_ms {
            if duration > 0 && position >= duration {
                position = duration;
                state.playing = false;
                state.ended = true;
                state.paused = false;
                self.clear_live_clock();
            }
        }
        state.position_ms = position;
    }

    pub fn finish(&self) {
        let mut state = self.state.lock().expect("test engine lock");
        self.apply_live_clock(&mut state);
        state.playing = false;
        state.paused = false;
        state.ended = true;
        state.position_ms = state.duration_ms.unwrap_or(state.position_ms);
        self.clear_live_clock();
    }

    #[allow(dead_code)]
    pub fn unload(&self) {
        let mut state = self.state.lock().expect("test engine lock");
        state.loaded = false;
        state.playing = false;
        state.paused = false;
        state.ended = false;
    }

    pub fn load_count(&self) -> u64 {
        self.loads.load(Ordering::Acquire)
    }

    pub fn overlap_count(&self) -> u64 {
        self.overlaps.load(Ordering::Acquire)
    }

    pub fn force_snapshot(&self, mutate: impl FnOnce(&mut AudioEngineSnapshot)) {
        let mut state = self.state.lock().expect("test engine lock");
        self.apply_live_clock(&mut state);
        mutate(&mut state);
        if self.live_clock && state.playing && !state.paused && !state.ended && !state.buffering {
            self.arm_live_clock(state.position_ms);
        } else {
            self.clear_live_clock();
        }
    }

    pub fn cancel_after_next_play(&self, cancellation: tokio_util::sync::CancellationToken) {
        *self
            .cancel_after_play
            .lock()
            .expect("test engine cancellation lock") = Some(cancellation);
    }
}

#[cfg(any(test, feature = "test-support"))]
impl AudioEngine for TestAudioEngine {
    fn load(&self, source: &PreparedPlaybackSource) -> Result<AudioLoadMetadata, AudioEngineError> {
        if source.load_generation != 0 {
            let accepted = self.accepted_load_generation.load(Ordering::Acquire);
            if source.load_generation < accepted {
                return Err(AudioEngineError::StaleCommand);
            }
            self.accepted_load_generation
                .store(source.load_generation, Ordering::Release);
        }
        source
            .epoch_guard
            .validate_and_run(|| {
                let already_loaded = self.state.lock().expect("test engine lock").loaded;
                if already_loaded {
                    self.overlaps.fetch_add(1, Ordering::AcqRel);
                }
                let metadata = AudioLoadMetadata {
                    duration_ms: source
                        .timeline_end_ms
                        .map(|end| end - source.timeline_offset_ms),
                    format: source.format,
                };
                let generation = self.source_generation.fetch_add(1, Ordering::AcqRel) + 1;
                self.loads.fetch_add(1, Ordering::AcqRel);
                *self.state.lock().expect("test engine lock") = AudioEngineSnapshot {
                    loaded: true,
                    paused: true,
                    duration_ms: metadata.duration_ms,
                    source_generation: generation,
                    ..AudioEngineSnapshot::default()
                };
                self.clear_live_clock();
                *self.loaded_guard.lock().expect("test engine guard lock") =
                    Some(source.epoch_guard.clone());
                metadata
            })
            .map_err(|_| AudioEngineError::SourceCancelled)
    }

    fn play(&self) -> Result<(), AudioEngineError> {
        let guard = self
            .loaded_guard
            .lock()
            .expect("test engine guard lock")
            .clone();
        if let Some(guard) = guard {
            let result = guard.validate_and_run(|| {
                let mut state = self.state.lock().expect("test engine lock");
                self.apply_live_clock(&mut state);
                state.playing = true;
                state.paused = false;
                state.ended = false;
                self.arm_live_clock(state.position_ms);
            });
            if result.is_err() {
                *self.state.lock().expect("test engine lock") = AudioEngineSnapshot::default();
                *self.loaded_guard.lock().expect("test engine guard lock") = None;
                return Err(AudioEngineError::SourceCancelled);
            }
            if let Some(cancellation) = self
                .cancel_after_play
                .lock()
                .expect("test engine cancellation lock")
                .take()
            {
                cancellation.cancel();
            }
            return Ok(());
        }
        let mut state = self.state.lock().expect("test engine lock");
        self.apply_live_clock(&mut state);
        state.playing = true;
        state.paused = false;
        state.ended = false;
        self.arm_live_clock(state.position_ms);
        Ok(())
    }

    fn pause(&self) -> Result<(), AudioEngineError> {
        let mut state = self.state.lock().expect("test engine lock");
        self.apply_live_clock(&mut state);
        state.playing = false;
        state.paused = true;
        self.clear_live_clock();
        Ok(())
    }

    fn stop(&self) -> Result<(), AudioEngineError> {
        let generation = self.source_generation.fetch_add(1, Ordering::AcqRel) + 1;
        *self.state.lock().expect("test engine lock") = AudioEngineSnapshot {
            source_generation: generation,
            ..AudioEngineSnapshot::default()
        };
        *self.loaded_guard.lock().expect("test engine guard lock") = None;
        *self
            .cancel_after_play
            .lock()
            .expect("test engine cancellation lock") = None;
        self.clear_live_clock();
        Ok(())
    }

    fn seek(&self, position: Duration) -> Result<(), AudioEngineError> {
        let mut state = self.state.lock().expect("test engine lock");
        self.apply_live_clock(&mut state);
        let exhausted = state.ended
            || (state.loaded
                && !state.playing
                && !state.paused
                && !state.buffering
                && state.duration_ms.is_some_and(|duration| {
                    duration > 0 && state.position_ms.saturating_add(80) >= duration
                }));
        if exhausted {
            return Ok(());
        }
        state.position_ms = duration_ms(position);
        if self.live_clock && state.playing && !state.paused && !state.ended && !state.buffering {
            self.arm_live_clock(state.position_ms);
        }
        Ok(())
    }

    fn set_volume(&self, volume: f32) -> Result<(), AudioEngineError> {
        *self.volume.lock().expect("test engine volume lock") = volume;
        Ok(())
    }

    fn set_output_device(&self, _device_id: &str) -> Result<(), AudioEngineError> {
        Ok(())
    }

    fn snapshot(&self) -> AudioEngineSnapshot {
        let cancelled = self
            .loaded_guard
            .lock()
            .expect("test engine guard lock")
            .as_ref()
            .is_some_and(|guard| guard.validate().is_err());
        if cancelled {
            *self.state.lock().expect("test engine lock") = AudioEngineSnapshot::default();
            *self.loaded_guard.lock().expect("test engine guard lock") = None;
            self.clear_live_clock();
        }
        let mut state = self.state.lock().expect("test engine lock");
        self.apply_live_clock(&mut state);
        state.clone()
    }

    fn output_devices(&self) -> Result<Vec<AudioOutputDevice>, AudioEngineError> {
        Ok(vec![AudioOutputDevice {
            id: "test".to_owned(),
            label: "Deterministic test output".to_owned(),
            is_default: true,
            is_selected: true,
            selection_kind: "specific-device".to_owned(),
            resolved_output: None,
        }])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        media::{PlaybackEpochClock, PlaybackEpochGuard},
        playback_types::{AudioQualityPreference, PlaybackEpoch, PlaybackSourceSelection},
        player::AudioQuality,
    };
    use tokio_util::sync::CancellationToken;

    #[test]
    fn generated_fixture_decodes_with_known_duration_and_supports_seek() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("fixture.wav");
        write_fixture_wav(&path, Duration::from_millis(750), 4).expect("write fixture");
        let file = File::open(&path).expect("open fixture");
        let mut decoder = Decoder::try_from(file).expect("decode fixture");
        let duration = decoder.total_duration().expect("known duration");
        assert!((duration.as_millis() as i64 - 750).abs() <= 1);
        assert_eq!(decoder.sample_rate().get(), 16_000);
        decoder
            .try_seek(Duration::from_millis(500))
            .expect("fixture is seekable");

        let decoded = decode_source(&rodio_fixture_source(path, 750)).expect("prepare fixture");
        assert_eq!(decoded.sample_rate, 16_000);
    }

    fn rodio_fixture_source(path: PathBuf, duration_ms: u64) -> PreparedPlaybackSource {
        PreparedPlaybackSource {
            location: PreparedPlaybackLocation::Local(path),
            format: AudioFormat::Wav,
            timeline_offset_ms: 0,
            timeline_end_ms: Some(duration_ms),
            is_preview: false,
            cache_key: "test:rodio-clock".to_owned(),
            selection: PlaybackSourceSelection {
                requested_quality: AudioQualityPreference::Automatic,
                resolved_quality: AudioQuality::Standard,
                fallback_reason: None,
                preview: false,
                quality_capabilities: Vec::new(),
            },
            epoch_guard: PlaybackEpochGuard::unrestricted(),
            load_generation: 1,
        }
    }

    #[test]
    fn rodio_local_fixture_playhead_advances_while_playing() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("clock.wav");
        write_fixture_wav(&path, Duration::from_millis(2_500), 7).expect("write fixture");
        let engine = RodioAudioEngine::open_default().expect("default audio output opens");
        engine.set_volume(0.0).expect("mute fixture");
        engine
            .load(&rodio_fixture_source(path, 2_500))
            .expect("load fixture");
        let resolved_sample_rate = engine
            .output_devices()
            .expect("list output devices")
            .into_iter()
            .find_map(|device| device.resolved_output.map(|output| output.sample_rate));
        assert_eq!(resolved_sample_rate, Some(16_000));
        engine.play().expect("play");
        let started = Instant::now();
        let mut last = 0_u64;
        let mut advances = 0_u32;
        while started.elapsed() < Duration::from_millis(2_000) {
            thread::sleep(Duration::from_millis(80));
            let snap = engine.snapshot();
            assert!(
                snap.playing || snap.buffering,
                "fixture should stay playing unless intentionally stalled: {snap:?}"
            );
            if snap.buffering {
                last = snap.position_ms;
                advances = 0;
                continue;
            }
            if snap.position_ms > last {
                advances += 1;
                last = snap.position_ms;
            }
            if advances >= 3 && last >= 120 {
                engine.stop().expect("stop");
                return;
            }
        }
        panic!(
            "playing=true but Rodio get_pos() did not advance: last={last} advances={advances} snap={:?}",
            engine.snapshot()
        );
    }

    #[test]
    fn output_device_ids_are_stable_without_exposing_native_ids() {
        let id = stable_device_id("wasapi:{AUDIO-ENDPOINT-GUID}");
        assert_eq!(id, stable_device_id("wasapi:{AUDIO-ENDPOINT-GUID}"));
        assert_ne!(id, stable_device_id("wasapi:{OTHER-ENDPOINT-GUID}"));
        assert!(id.starts_with("device:"));
        assert!(!id.contains("AUDIO-ENDPOINT-GUID"));
        assert!(!id.contains("wasapi"));
    }

    #[test]
    fn legacy_output_ids_remain_recognizable_during_persistence_migration() {
        let legacy = legacy_device_id("Headphones", "WASAPI", 0);
        assert_eq!(legacy, legacy_device_id("Headphones", "WASAPI", 0));
        assert_ne!(legacy, legacy_device_id("Headphones", "WASAPI", 1));
        assert_eq!(
            OutputSelection::parse(&legacy).map(|value| value.id().to_owned()),
            Ok(legacy)
        );
    }

    #[test]
    fn output_selection_distinguishes_policy_from_device_identity() {
        assert_eq!(
            OutputSelection::parse(DEFAULT_OUTPUT_ID),
            Ok(OutputSelection::SystemDefault)
        );
        let device_id = stable_device_id("alsa:pipewire");
        assert_eq!(
            OutputSelection::parse(&device_id),
            Ok(OutputSelection::SpecificDevice(device_id))
        );
        assert_eq!(
            OutputSelection::parse("Default Audio Device"),
            Err(AudioEngineError::InvalidOutputSelection)
        );
    }

    #[test]
    fn output_recovery_keeps_the_selected_policy() {
        let specific = OutputSelection::SpecificDevice(stable_device_id("alsa:pipewire"));
        assert_eq!(recovery_selection(&specific), specific);
        assert_eq!(
            recovery_selection(&OutputSelection::SystemDefault),
            OutputSelection::SystemDefault
        );
    }

    #[test]
    fn buffer_underrun_does_not_impersonate_a_missing_output_device() {
        assert!(!output_stream_error_interrupts_playback(
            &StreamError::BufferUnderrun
        ));
        assert!(output_stream_error_interrupts_playback(
            &StreamError::DeviceNotAvailable
        ));
        assert!(output_stream_error_interrupts_playback(
            &StreamError::StreamInvalidated
        ));
    }

    #[test]
    fn resetting_playback_does_not_hide_an_output_failure() {
        let mut snapshot = AudioEngineSnapshot {
            loaded: true,
            playing: true,
            output_error: Some("device lost".to_owned()),
            ..AudioEngineSnapshot::default()
        };
        reset_playback_snapshot(&mut snapshot);
        assert!(!snapshot.loaded);
        assert!(!snapshot.playing);
        assert_eq!(snapshot.output_error.as_deref(), Some("device lost"));
    }

    #[test]
    fn decrypted_flac_probe_requires_magic_and_rewinds() {
        #[derive(Debug)]
        struct IdentityDecryptor;

        impl MediaDecryptor for IdentityDecryptor {
            fn decrypt(&self, _data: &mut [u8], _offset: u64) -> std::io::Result<()> {
                Ok(())
            }

            fn cipher_kind(&self) -> &'static str {
                "identity-test"
            }

            fn derived_key_length(&self) -> usize {
                0
            }
        }

        let decryptor = IdentityDecryptor;
        let mut valid = std::io::Cursor::new(b"fLaCpayload".to_vec());
        assert_eq!(validate_decrypted_flac(&mut valid, &decryptor), Ok(()));
        assert_eq!(valid.position(), 0);

        let mut invalid = std::io::Cursor::new(b"ID3 payload".to_vec());
        assert_eq!(
            validate_decrypted_flac(&mut invalid, &decryptor),
            Err(AudioEngineError::DecryptionFailed)
        );
        assert_eq!(invalid.position(), 0);
    }

    #[test]
    fn retained_guard_rejects_resume_after_account_epoch_changes() {
        let clock = Arc::new(PlaybackEpochClock::default());
        let epoch = PlaybackEpoch::new(11, "test-account-11");
        clock.replace(Some(epoch.clone()));
        let cancellation = CancellationToken::new();
        let engine = TestAudioEngine::default();
        let source = PreparedPlaybackSource {
            location: PreparedPlaybackLocation::Local(PathBuf::from("unused-test.wav")),
            format: AudioFormat::Wav,
            timeline_offset_ms: 0,
            timeline_end_ms: Some(1_000),
            is_preview: false,
            cache_key: "test:guard".to_owned(),
            selection: PlaybackSourceSelection {
                requested_quality: AudioQualityPreference::High,
                resolved_quality: AudioQuality::Standard,
                fallback_reason: None,
                preview: false,
                quality_capabilities: Vec::new(),
            },
            epoch_guard: PlaybackEpochGuard::account_bound(epoch, cancellation.clone(), clock),
            load_generation: 0,
        };

        engine.load(&source).expect("current source loads");
        engine.pause().expect("source pauses");
        cancellation.cancel();
        assert_eq!(engine.play(), Err(AudioEngineError::SourceCancelled));
        assert!(!engine.snapshot().loaded);
    }

    #[test]
    fn older_load_generation_is_rejected_without_replacing_the_source() {
        let engine = TestAudioEngine::default();
        let source = |generation: u64| PreparedPlaybackSource {
            location: PreparedPlaybackLocation::Local(PathBuf::from("unused-test.wav")),
            format: AudioFormat::Wav,
            timeline_offset_ms: 0,
            timeline_end_ms: Some(1_000),
            is_preview: false,
            cache_key: "test:stale".to_owned(),
            selection: PlaybackSourceSelection {
                requested_quality: AudioQualityPreference::High,
                resolved_quality: AudioQuality::Standard,
                fallback_reason: None,
                preview: false,
                quality_capabilities: Vec::new(),
            },
            epoch_guard: PlaybackEpochGuard::unrestricted(),
            load_generation: generation,
        };
        engine.load(&source(2)).expect("newer source loads");
        let generation = engine.snapshot().source_generation;
        assert_eq!(engine.load(&source(1)), Err(AudioEngineError::StaleCommand));
        assert_eq!(engine.snapshot().source_generation, generation);
        assert!(engine.snapshot().loaded);
    }
}
