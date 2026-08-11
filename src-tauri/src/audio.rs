use crate::{
    media::PlaybackEpochGuard,
    qqmusic::PlaybackSourceSelection,
    streaming::{ProgressiveMonitor, ProgressiveSource},
};
use rodio::{
    cpal::traits::HostTrait, decoder::DecoderBuilder, Decoder, Device, DeviceSinkBuilder,
    DeviceTrait, MixerDeviceSink, Player, Source,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::File,
    io::{BufWriter, Write},
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use thiserror::Error;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
const DEFAULT_OUTPUT_ID: &str = "system:default";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AudioFormat {
    Mp3,
    Aac,
    Flac,
    Wav,
}

impl AudioFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Mp3 => "mp3",
            Self::Aac => "m4a",
            Self::Flac => "flac",
            Self::Wav => "wav",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mp3 => "mp3",
            Self::Aac => "aac",
            Self::Flac => "flac",
            Self::Wav => "wav",
        }
    }
}

#[derive(Clone, Debug)]
pub enum PreparedPlaybackLocation {
    Local(PathBuf),
    Progressive(ProgressiveSource),
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
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AudioLoadMetadata {
    pub duration_ms: Option<u64>,
    pub format: AudioFormat,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioOutputDevice {
    pub id: String,
    pub label: String,
    pub is_default: bool,
    pub is_selected: bool,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AudioEngineError {
    #[error("no audio output device is available")]
    OutputDeviceUnavailable,
    #[error("the audio output device could not be opened")]
    OutputDeviceOpenFailed,
    #[error("the media file could not be opened")]
    MediaOpenFailed,
    #[error("the media format is unsupported or malformed")]
    DecoderUnsupported,
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
    Seek {
        position: Duration,
        reply: mpsc::SyncSender<Result<(), AudioEngineError>>,
    },
    SetVolume {
        volume: f32,
        reply: mpsc::SyncSender<Result<(), AudioEngineError>>,
    },
    SetOutputDevice {
        device_id: String,
        reply: mpsc::SyncSender<Result<(), AudioEngineError>>,
    },
    Devices(mpsc::SyncSender<Result<Vec<AudioOutputDevice>, AudioEngineError>>),
    Shutdown,
}

pub struct RodioAudioEngine {
    commands: mpsc::Sender<AudioCommand>,
    snapshot: Arc<Mutex<AudioEngineSnapshot>>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
}

impl RodioAudioEngine {
    pub fn open_default() -> Result<Self, AudioEngineError> {
        let (commands, receiver) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let snapshot = Arc::new(Mutex::new(AudioEngineSnapshot::default()));
        let worker_snapshot = Arc::clone(&snapshot);

        let worker = thread::Builder::new()
            .name("native-audio-engine".to_owned())
            .spawn(move || audio_worker(receiver, worker_snapshot, ready_tx))
            .map_err(|_| AudioEngineError::WorkerUnavailable)?;

        match ready_rx.recv_timeout(COMMAND_TIMEOUT) {
            Ok(Ok(())) => Ok(Self {
                commands,
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
        self.request(|reply| AudioCommand::Seek { position, reply })
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

fn audio_worker(
    receiver: mpsc::Receiver<AudioCommand>,
    snapshot: Arc<Mutex<AudioEngineSnapshot>>,
    ready: mpsc::SyncSender<Result<(), AudioEngineError>>,
) {
    let (mut device_sink, mut player, mut selected_output_id) =
        match open_output(DEFAULT_OUTPUT_ID, &snapshot) {
            Ok(output) => output,
            Err(error) => {
                let _ = ready.send(Err(error));
                return;
            }
        };
    let mut progressive_monitor: Option<ProgressiveMonitor> = None;
    let mut loaded_source: Option<PreparedPlaybackSource> = None;
    let mut current_volume = 1.0_f32;
    let mut last_recovery_attempt = Instant::now()
        .checked_sub(Duration::from_secs(5))
        .unwrap_or_else(Instant::now);
    let _ = ready.send(Ok(()));

    loop {
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(AudioCommand::Load { source, reply }) => {
                let result = load_source(&player, &source);
                let mut current = snapshot
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                match &result {
                    Ok((metadata, monitor)) => {
                        progressive_monitor = monitor.clone();
                        loaded_source = Some(source);
                        *current = AudioEngineSnapshot {
                            loaded: true,
                            paused: true,
                            duration_ms: metadata.duration_ms,
                            ..AudioEngineSnapshot::default()
                        };
                    }
                    Err(_) => {
                        progressive_monitor = None;
                        loaded_source = None;
                        *current = AudioEngineSnapshot::default();
                    }
                }
                let _ = reply.send(result.map(|(metadata, _)| metadata));
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
                    *snapshot
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                        AudioEngineSnapshot::default();
                }
                let _ = reply.send(result);
            }
            Ok(AudioCommand::Pause(reply)) => {
                player.pause();
                let _ = reply.send(Ok(()));
            }
            Ok(AudioCommand::Stop(reply)) => {
                player.clear();
                progressive_monitor = None;
                loaded_source = None;
                *snapshot
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                    AudioEngineSnapshot::default();
                let _ = reply.send(Ok(()));
            }
            Ok(AudioCommand::Seek { position, reply }) => {
                let result = player
                    .try_seek(position)
                    .map_err(|_| AudioEngineError::SeekUnsupported);
                let _ = reply.send(result);
            }
            Ok(AudioCommand::SetVolume { volume, reply }) => {
                current_volume = volume.clamp(0.0, 1.0);
                player.set_volume(current_volume);
                let _ = reply.send(Ok(()));
            }
            Ok(AudioCommand::SetOutputDevice { device_id, reply }) => {
                let result = replace_output(
                    &device_id,
                    &snapshot,
                    &player,
                    loaded_source.as_ref(),
                    current_volume,
                );
                match result {
                    Ok((next_sink, next_player, next_monitor, resolved_id)) => {
                        device_sink = next_sink;
                        player = next_player;
                        progressive_monitor = next_monitor;
                        selected_output_id = resolved_id;
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
                let _ = reply.send(list_output_devices(&selected_output_id));
            }
            Ok(AudioCommand::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }

        if loaded_source
            .as_ref()
            .is_some_and(|source| source.epoch_guard.validate().is_err())
        {
            player.clear();
            progressive_monitor = None;
            loaded_source = None;
            *snapshot
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = AudioEngineSnapshot::default();
        }

        let output_interrupted = snapshot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .output_error
            .is_some();
        if output_interrupted && last_recovery_attempt.elapsed() >= Duration::from_secs(2) {
            last_recovery_attempt = Instant::now();
            if let Ok((next_sink, next_player, next_monitor, resolved_id)) = replace_output(
                DEFAULT_OUTPUT_ID,
                &snapshot,
                &player,
                loaded_source.as_ref(),
                current_volume,
            ) {
                tracing::info!(target: "audio", "recovered playback on the system default output");
                device_sink = next_sink;
                player = next_player;
                progressive_monitor = next_monitor;
                selected_output_id = resolved_id;
                snapshot
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .output_error = None;
            }
        }

        let mut current = snapshot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if current.loaded {
            current.position_ms = duration_ms(player.get_pos());
            current.paused = player.is_paused();
            current.ended = player.empty();
            current.playing = !current.paused && !current.ended && current.output_error.is_none();
            if let Some(monitor) = &progressive_monitor {
                current.buffering = monitor.is_waiting();
                current.source_error = monitor.error();
                current.source_url_expired =
                    monitor.error_kind() == Some(crate::streaming::ProgressiveError::UrlExpired);
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
        }
        let _keep_output_alive = &device_sink;
    }
}

fn open_output(
    device_id: &str,
    snapshot: &Arc<Mutex<AudioEngineSnapshot>>,
) -> Result<(MixerDeviceSink, Player, String), AudioEngineError> {
    let builder = if device_id == DEFAULT_OUTPUT_ID {
        DeviceSinkBuilder::from_default_device()
            .map_err(|_| AudioEngineError::OutputDeviceUnavailable)?
    } else {
        let device = enumerated_output_devices()?
            .into_iter()
            .find_map(|(device, info)| (info.id == device_id).then_some(device))
            .ok_or(AudioEngineError::OutputDeviceUnavailable)?;
        DeviceSinkBuilder::from_device(device)
            .map_err(|_| AudioEngineError::OutputDeviceOpenFailed)?
    };
    let output_snapshot = Arc::clone(snapshot);
    let mut sink = builder
        .with_error_callback(move |error| {
            tracing::error!(target: "audio", error = %error, "audio output stream failed");
            let mut current = output_snapshot
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            current.playing = false;
            current.output_error = Some("The selected audio output device was interrupted.".into());
        })
        .open_sink_or_fallback()
        .map_err(|_| AudioEngineError::OutputDeviceOpenFailed)?;
    sink.log_on_drop(false);
    let player = Player::connect_new(sink.mixer());
    player.pause();
    Ok((sink, player, device_id.to_owned()))
}

fn replace_output(
    device_id: &str,
    snapshot: &Arc<Mutex<AudioEngineSnapshot>>,
    current_player: &Player,
    loaded_source: Option<&PreparedPlaybackSource>,
    volume: f32,
) -> Result<(MixerDeviceSink, Player, Option<ProgressiveMonitor>, String), AudioEngineError> {
    let was_paused = current_player.is_paused();
    let position = current_player.get_pos();
    let (sink, player, resolved_id) = open_output(device_id, snapshot)?;
    let monitor = if let Some(source) = loaded_source {
        source
            .epoch_guard
            .validate_and_run(|| {
                let (_, monitor) = load_source_unchecked(&player, source)?;
                if position > Duration::ZERO {
                    player
                        .try_seek(position)
                        .map_err(|_| AudioEngineError::SeekUnsupported)?;
                }
                player.set_volume(volume);
                if !was_paused {
                    player.play();
                }
                Ok(monitor)
            })
            .map_err(|_| AudioEngineError::SourceCancelled)??
    } else {
        None
    };
    Ok((sink, player, monitor, resolved_id))
}

fn load_source(
    player: &Player,
    source: &PreparedPlaybackSource,
) -> Result<(AudioLoadMetadata, Option<ProgressiveMonitor>), AudioEngineError> {
    source
        .epoch_guard
        .validate_and_run(|| load_source_unchecked(player, source))
        .map_err(|_| AudioEngineError::SourceCancelled)?
}

fn load_source_unchecked(
    player: &Player,
    source: &PreparedPlaybackSource,
) -> Result<(AudioLoadMetadata, Option<ProgressiveMonitor>), AudioEngineError> {
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
            let duration = decoder.total_duration().map(duration_ms);
            player.clear();
            player.append(decoder);
            player.pause();
            Ok((
                AudioLoadMetadata {
                    duration_ms: duration,
                    format: source.format,
                },
                None,
            ))
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
            let duration = decoder.total_duration().map(duration_ms);
            let monitor = progressive.monitor();
            player.clear();
            player.append(decoder);
            player.pause();
            Ok((
                AudioLoadMetadata {
                    duration_ms: duration,
                    format: source.format,
                },
                Some(monitor),
            ))
        }
    }
}

fn list_output_devices(selected_id: &str) -> Result<Vec<AudioOutputDevice>, AudioEngineError> {
    let host = rodio::cpal::default_host();
    let default_signature = host
        .default_output_device()
        .and_then(|device| device.description().ok())
        .map(|description| device_signature(&description));
    let default_label = default_signature
        .as_ref()
        .map(|(name, _)| name.as_str())
        .unwrap_or("Unavailable");
    let mut result = vec![AudioOutputDevice {
        id: DEFAULT_OUTPUT_ID.to_owned(),
        label: format!("System default — {default_label}"),
        is_default: true,
        is_selected: selected_id == DEFAULT_OUTPUT_ID,
    }];
    result.extend(
        enumerated_output_devices()?
            .into_iter()
            .map(|(_, mut info)| {
                info.is_default = default_signature
                    .as_ref()
                    .is_some_and(|signature| info.label == signature.0);
                info.is_selected = info.id == selected_id;
                info
            }),
    );
    Ok(result)
}

fn enumerated_output_devices() -> Result<Vec<(Device, AudioOutputDevice)>, AudioEngineError> {
    let host = rodio::cpal::default_host();
    let devices = host
        .output_devices()
        .map_err(|_| AudioEngineError::OutputDeviceUnavailable)?;
    let mut ordinals: HashMap<(String, String), usize> = HashMap::new();
    Ok(devices
        .filter_map(|device| {
            let description = device.description().ok()?;
            let signature = device_signature(&description);
            let ordinal = ordinals.entry(signature.clone()).or_default();
            let id = stable_device_id(&signature.0, &signature.1, *ordinal);
            *ordinal += 1;
            Some((
                device,
                AudioOutputDevice {
                    id,
                    label: signature.0,
                    is_default: false,
                    is_selected: false,
                },
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

fn stable_device_id(name: &str, driver: &str, ordinal: usize) -> String {
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

#[cfg(test)]
pub struct TestAudioEngine {
    state: Mutex<AudioEngineSnapshot>,
    volume: Mutex<f32>,
    loaded_guard: Mutex<Option<PlaybackEpochGuard>>,
    cancel_after_play: Mutex<Option<tokio_util::sync::CancellationToken>>,
}

#[cfg(test)]
impl Default for TestAudioEngine {
    fn default() -> Self {
        Self {
            state: Mutex::new(AudioEngineSnapshot::default()),
            volume: Mutex::new(0.72),
            loaded_guard: Mutex::new(None),
            cancel_after_play: Mutex::new(None),
        }
    }
}

#[cfg(test)]
impl TestAudioEngine {
    pub fn finish(&self) {
        let mut state = self.state.lock().expect("test engine lock");
        state.playing = false;
        state.paused = false;
        state.ended = true;
        state.position_ms = state.duration_ms.unwrap_or(state.position_ms);
    }

    pub fn cancel_after_next_play(&self, cancellation: tokio_util::sync::CancellationToken) {
        *self
            .cancel_after_play
            .lock()
            .expect("test engine cancellation lock") = Some(cancellation);
    }
}

#[cfg(test)]
impl AudioEngine for TestAudioEngine {
    fn load(&self, source: &PreparedPlaybackSource) -> Result<AudioLoadMetadata, AudioEngineError> {
        source
            .epoch_guard
            .validate_and_run(|| {
                let metadata = AudioLoadMetadata {
                    duration_ms: source
                        .timeline_end_ms
                        .map(|end| end - source.timeline_offset_ms),
                    format: source.format,
                };
                *self.state.lock().expect("test engine lock") = AudioEngineSnapshot {
                    loaded: true,
                    paused: true,
                    duration_ms: metadata.duration_ms,
                    ..AudioEngineSnapshot::default()
                };
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
                state.playing = true;
                state.paused = false;
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
        state.playing = true;
        state.paused = false;
        state.ended = false;
        Ok(())
    }

    fn pause(&self) -> Result<(), AudioEngineError> {
        let mut state = self.state.lock().expect("test engine lock");
        state.playing = false;
        state.paused = true;
        Ok(())
    }

    fn stop(&self) -> Result<(), AudioEngineError> {
        *self.state.lock().expect("test engine lock") = AudioEngineSnapshot::default();
        *self.loaded_guard.lock().expect("test engine guard lock") = None;
        *self
            .cancel_after_play
            .lock()
            .expect("test engine cancellation lock") = None;
        Ok(())
    }

    fn seek(&self, position: Duration) -> Result<(), AudioEngineError> {
        self.state.lock().expect("test engine lock").position_ms = duration_ms(position);
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
        }
        self.state.lock().expect("test engine lock").clone()
    }

    fn output_devices(&self) -> Result<Vec<AudioOutputDevice>, AudioEngineError> {
        Ok(vec![AudioOutputDevice {
            id: "test".to_owned(),
            label: "Deterministic test output".to_owned(),
            is_default: true,
            is_selected: true,
        }])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        media::{PlaybackEpochClock, PlaybackEpochGuard},
        player::AudioQuality,
        qqmusic::{AccountEpoch, AudioQualityPreference, PlaybackSourceSelection},
    };
    use tokio_util::sync::CancellationToken;

    #[test]
    fn generated_fixture_decodes_with_known_duration_and_supports_seek() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("fixture.wav");
        write_fixture_wav(&path, Duration::from_millis(750), 4).expect("write fixture");
        let file = File::open(path).expect("open fixture");
        let mut decoder = Decoder::try_from(file).expect("decode fixture");
        let duration = decoder.total_duration().expect("known duration");
        assert!((duration.as_millis() as i64 - 750).abs() <= 1);
        decoder
            .try_seek(Duration::from_millis(500))
            .expect("fixture is seekable");
    }

    #[test]
    fn output_device_ids_are_stable_without_exposing_driver_names() {
        let id = stable_device_id("Headphones", "WASAPI", 0);
        assert_eq!(id, stable_device_id("Headphones", "WASAPI", 0));
        assert_ne!(id, stable_device_id("Headphones", "WASAPI", 1));
        assert!(id.starts_with("device:"));
        assert!(!id.contains("Headphones"));
        assert!(!id.contains("WASAPI"));
    }

    #[test]
    fn retained_guard_rejects_resume_after_account_epoch_changes() {
        let clock = Arc::new(PlaybackEpochClock::default());
        let epoch = AccountEpoch::for_test(11);
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
            },
            epoch_guard: PlaybackEpochGuard::account_bound(epoch, cancellation.clone(), clock),
        };

        engine.load(&source).expect("current source loads");
        engine.pause().expect("source pauses");
        cancellation.cancel();
        assert_eq!(engine.play(), Err(AudioEngineError::SourceCancelled));
        assert!(!engine.snapshot().loaded);
    }
}
