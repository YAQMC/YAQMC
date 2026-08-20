use crate::player::{PlaybackState, PlayerService, PlayerSnapshot, RepeatMode};
use crate::HostCommand;
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const MPRIS_SEEKED_SLACK_MS: u64 = 1_500;
const MAX_POSITION_EXTRAPOLATION_MS: u64 = 1_000;
const MPRIS_PROGRESS_TICK_MS: u64 = 100;
const MPRIS_PROGRESS_HEARTBEAT_MS: u64 = 250;

#[cfg(target_os = "windows")]
use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
    SeekDirection,
};

pub use crate::platform::SystemMediaStatus;
pub use crate::HostCommandPublisher;

/// Host-supplied values required by the platform-native system-media adapters.
///
/// The numeric HWND is intentionally opaque to Core. `None` is expected outside
/// Windows and retains the existing unavailable status when Windows has no main
/// window. Native callbacks use the supplied runtime because they can arrive on
/// an OS thread with no Tokio context.
#[derive(Clone)]
pub struct SystemMediaStartConfig {
    pub windows_hwnd: Option<isize>,
    /// Host HWND lookup error, if resolving the main window failed.
    pub windows_start_error: Option<String>,
    pub runtime: tokio::runtime::Handle,
    pub host_commands: HostCommandPublisher,
}

#[derive(Clone, Debug, PartialEq)]
struct ProjectedMetadata {
    track_id: String,
    title: String,
    album: String,
    artists: Vec<String>,
    artwork_url: Option<String>,
    duration_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq)]
struct MediaProjection {
    metadata: Option<ProjectedMetadata>,
    playback: PlaybackState,
    repeat: RepeatMode,
    shuffle: bool,
    volume: f64,
    position_ms: u64,
    can_go_next: bool,
    can_go_previous: bool,
    can_seek: bool,
    seeked: bool,
}

impl MediaProjection {
    fn from_snapshot(snapshot: &PlayerSnapshot, seeked: bool) -> Self {
        let track = snapshot
            .current_index
            .and_then(|index| snapshot.queue.get(index));
        Self {
            metadata: track.map(|track| ProjectedMetadata {
                track_id: mpris_track_id(&track.id),
                title: track.title.clone(),
                album: track.album.title.clone(),
                artists: track
                    .artists
                    .iter()
                    .map(|artist| artist.name.clone())
                    .collect(),
                artwork_url: valid_cover_url(&track.artwork.src).map(str::to_owned),
                duration_ms: snapshot.playback_duration_ms,
            }),
            playback: snapshot.playback_state,
            repeat: snapshot.repeat,
            shuffle: snapshot.shuffle,
            volume: if snapshot.is_muted {
                0.0
            } else {
                snapshot.volume
            },
            position_ms: reported_position_ms(snapshot),
            can_go_next: track.is_some() && snapshot.queue.len() > 1,
            can_go_previous: track.is_some(),
            can_seek: track.is_some() && snapshot.playback_duration_ms.is_some(),
            seeked,
        }
    }
}

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn clamp_playback_position(position_ms: u64, duration_ms: Option<u64>) -> u64 {
    duration_ms
        .map(|duration| position_ms.min(duration))
        .unwrap_or(position_ms)
}

fn reported_position_ms_at(snapshot: &PlayerSnapshot, now_ms: u64) -> u64 {
    let base = snapshot.position_ms;
    if snapshot.playback_state != PlaybackState::Playing || snapshot.sampled_at_ms == 0 {
        return clamp_playback_position(base, snapshot.playback_duration_ms);
    }
    let age_ms = now_ms
        .saturating_sub(snapshot.sampled_at_ms)
        .min(MAX_POSITION_EXTRAPOLATION_MS);
    clamp_playback_position(base.saturating_add(age_ms), snapshot.playback_duration_ms)
}

fn reported_position_ms(snapshot: &PlayerSnapshot) -> u64 {
    reported_position_ms_at(snapshot, unix_now_ms())
}

fn mpris_position_jump_is_seeked(
    previous_position_ms: u64,
    previous_playing: bool,
    next_position_ms: u64,
    elapsed_ms: u64,
) -> bool {
    let expected = if previous_playing {
        previous_position_ms.saturating_add(elapsed_ms)
    } else {
        previous_position_ms
    };
    if next_position_ms > expected.saturating_add(MPRIS_SEEKED_SLACK_MS) {
        return true;
    }
    // Repeat One / seek-back jump backwards. Falling behind the expected
    // 1x timeline is worker lag, not a seek — do not emit Seeked for that.
    next_position_ms.saturating_add(MPRIS_SEEKED_SLACK_MS) < previous_position_ms
}

fn mpris_should_heartbeat_seeked(playing: bool, since_last_seeked_ms: u64) -> bool {
    playing && since_last_seeked_ms >= MPRIS_PROGRESS_HEARTBEAT_MS
}

fn mpris_should_emit_seeked(
    previous: Option<&MediaProjection>,
    next: &MediaProjection,
    elapsed_ms: u64,
) -> bool {
    if next.seeked {
        return true;
    }
    let Some(previous) = previous else {
        return next.playback == PlaybackState::Playing;
    };
    if previous
        .metadata
        .as_ref()
        .map(|metadata| metadata.track_id.as_str())
        != next
            .metadata
            .as_ref()
            .map(|metadata| metadata.track_id.as_str())
    {
        return true;
    }
    if previous.playback != PlaybackState::Playing && next.playback == PlaybackState::Playing {
        return true;
    }
    mpris_position_jump_is_seeked(
        previous.position_ms,
        previous.playback == PlaybackState::Playing,
        next.position_ms,
        elapsed_ms,
    )
}

#[cfg(target_os = "linux")]
async fn recv_latest_projection(
    receiver: &mut tokio::sync::mpsc::UnboundedReceiver<MediaProjection>,
) -> Option<MediaProjection> {
    let mut projection = receiver.recv().await?;
    while let Ok(newer) = receiver.try_recv() {
        let seeked = projection.seeked || newer.seeked;
        projection = newer;
        projection.seeked = seeked;
    }
    Some(projection)
}

#[cfg(target_os = "linux")]
struct MprisProgressClock {
    position_ms: u64,
    duration_ms: Option<u64>,
    playing: bool,
    origin: std::time::Instant,
}

#[cfg(target_os = "linux")]
impl MprisProgressClock {
    fn new() -> Self {
        Self {
            position_ms: 0,
            duration_ms: None,
            playing: false,
            origin: std::time::Instant::now(),
        }
    }

    fn sync(&mut self, projection: &MediaProjection) {
        self.position_ms = projection.position_ms;
        self.duration_ms = projection
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.duration_ms);
        self.playing = projection.playback == PlaybackState::Playing;
        self.origin = std::time::Instant::now();
    }

    fn current_ms(&self) -> u64 {
        let raw = if self.playing {
            self.position_ms
                .saturating_add(self.origin.elapsed().as_millis() as u64)
        } else {
            self.position_ms
        };
        clamp_playback_position(raw, self.duration_ms)
    }
}

pub struct SystemMediaIntegration {
    status: Mutex<SystemMediaStatus>,
    #[cfg(target_os = "linux")]
    linux_sender: Mutex<Option<tokio::sync::mpsc::UnboundedSender<MediaProjection>>>,
    #[cfg(target_os = "windows")]
    controls: Mutex<Option<MediaControls>>,
    #[cfg(target_os = "windows")]
    last_projection: Mutex<Option<MediaProjection>>,
}

impl SystemMediaIntegration {
    pub fn start(config: SystemMediaStartConfig, player: Arc<PlayerService>) -> Arc<Self> {
        let integration = Arc::new(Self {
            status: Mutex::new(SystemMediaStatus {
                available: false,
                backend: backend_name(),
                specification: specification_name(),
                error: None,
            }),
            #[cfg(target_os = "linux")]
            linux_sender: Mutex::new(None),
            #[cfg(target_os = "windows")]
            controls: Mutex::new(None),
            #[cfg(target_os = "windows")]
            last_projection: Mutex::new(None),
        });

        #[cfg(target_os = "linux")]
        integration.initialize_linux(config, player);
        #[cfg(target_os = "windows")]
        integration.initialize_windows(config, player);
        #[cfg(not(any(target_os = "linux", target_os = "windows")))]
        {
            let _ = (config, player);
            integration.set_error("system media controls are not implemented on this platform");
        }
        integration
    }

    /// (Re)bind Windows SMTC to a host HWND delivered after Core start.
    ///
    /// Electron creates the BrowserWindow after spawning Core, so `start()`
    /// often runs with `windows_hwnd: None` and records unavailable. A later
    /// `platform_attach` handle recovers that error state. Linux MPRIS needs
    /// no HWND; this is a no-op there.
    pub fn attach_hwnd(
        &self,
        hwnd: isize,
        player: Arc<PlayerService>,
        host_commands: HostCommandPublisher,
        runtime: tokio::runtime::Handle,
    ) {
        #[cfg(target_os = "windows")]
        {
            *self
                .controls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
            *self
                .last_projection
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
            self.initialize_windows(
                SystemMediaStartConfig {
                    windows_hwnd: Some(hwnd),
                    windows_start_error: None,
                    runtime,
                    host_commands,
                },
                player,
            );
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (hwnd, player, host_commands, runtime);
        }
    }

    pub fn status(&self) -> SystemMediaStatus {
        self.status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn update(&self, snapshot: &PlayerSnapshot, seeked: bool) {
        let projection = MediaProjection::from_snapshot(snapshot, seeked);
        #[cfg(target_os = "linux")]
        if let Some(sender) = self
            .linux_sender
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
        {
            if sender.send(projection.clone()).is_err() {
                self.set_error("MPRIS worker stopped unexpectedly");
            }
        }
        #[cfg(target_os = "windows")]
        self.update_windows(&projection);
        #[cfg(not(any(target_os = "linux", target_os = "windows")))]
        let _ = projection;
    }

    fn set_error(&self, error: impl Into<String>) {
        let mut status = self
            .status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        status.available = false;
        status.error = Some(error.into());
    }

    fn set_ready(&self) {
        let mut status = self
            .status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        status.available = true;
        status.error = None;
    }

    #[cfg(target_os = "linux")]
    fn initialize_linux(&self, config: SystemMediaStartConfig, player: Arc<PlayerService>) {
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        let (ready_sender, ready_receiver) = std::sync::mpsc::sync_channel(1);
        match std::thread::Builder::new()
            .name("yaqmc-mpris".to_owned())
            .spawn(move || {
                run_mpris_worker(
                    config.runtime,
                    config.host_commands,
                    player,
                    receiver,
                    ready_sender,
                )
            }) {
            Ok(_) => {}
            Err(error) => {
                self.set_error(error.to_string());
                return;
            }
        }
        match ready_receiver.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(Ok(())) => {
                *self
                    .linux_sender
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(sender);
                self.set_ready();
                tracing::info!(target: "mpris", specification = "MPRIS 2.2", "MPRIS service ready");
            }
            Ok(Err(error)) => self.set_error(error),
            Err(_) => self.set_error("MPRIS service initialization timed out"),
        }
    }

    #[cfg(target_os = "windows")]
    fn initialize_windows(&self, config: SystemMediaStartConfig, player: Arc<PlayerService>) {
        let Some(hwnd) = config.windows_hwnd else {
            // Missing HWND: keep unavailable. Do not create a hidden
            // message window (plan R-3 is NEEDS ACCEPTANCE TEST).
            self.set_error(
                config
                    .windows_start_error
                    .unwrap_or_else(|| "main window is unavailable".to_owned()),
            );
            return;
        };
        let mut controls = match MediaControls::new(PlatformConfig {
            dbus_name: "yaqmc",
            display_name: "YAQMC",
            hwnd: Some(hwnd as *mut std::ffi::c_void),
        }) {
            Ok(controls) => controls,
            Err(error) => {
                self.set_error(error.to_string());
                return;
            }
        };
        let runtime = config.runtime;
        let host_commands = config.host_commands;
        if let Err(error) = controls.attach(move |event| {
            let _ = dispatch_windows_event(
                host_commands.clone(),
                runtime.clone(),
                Arc::clone(&player),
                event,
            );
        }) {
            self.set_error(error.to_string());
            return;
        }
        *self
            .controls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(controls);
        self.set_ready();
        tracing::info!(target: "smtc", "Windows SMTC ready");
    }

    #[cfg(target_os = "windows")]
    fn update_windows(&self, projection: &MediaProjection) {
        let mut controls = self
            .controls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(controls) = controls.as_mut() else {
            return;
        };
        let mut previous = self
            .last_projection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if previous.as_ref().and_then(|value| value.metadata.as_ref())
            != projection.metadata.as_ref()
        {
            let result = if let Some(metadata) = &projection.metadata {
                let artist = metadata.artists.join(", ");
                controls.set_metadata(MediaMetadata {
                    title: Some(&metadata.title),
                    album: Some(&metadata.album),
                    artist: (!artist.is_empty()).then_some(artist.as_str()),
                    cover_url: metadata.artwork_url.as_deref(),
                    duration: metadata.duration_ms.map(std::time::Duration::from_millis),
                })
            } else {
                controls.set_metadata(MediaMetadata::default())
            };
            if let Err(error) = result {
                tracing::warn!(target: "smtc", error = %error, "SMTC metadata update failed");
            }
        }
        let state_changed = previous
            .as_ref()
            .is_none_or(|value| value.playback != projection.playback);
        let position_changed = previous.as_ref().is_none_or(|value| {
            value.position_ms.abs_diff(projection.position_ms) >= 1_500 || projection.seeked
        });
        if state_changed || position_changed {
            let position = Some(MediaPosition(std::time::Duration::from_millis(
                projection.position_ms,
            )));
            let playback = match projection.playback {
                PlaybackState::Playing => MediaPlayback::Playing { progress: position },
                PlaybackState::Paused | PlaybackState::Loading | PlaybackState::Buffering => {
                    MediaPlayback::Paused { progress: position }
                }
                _ => MediaPlayback::Stopped,
            };
            if let Err(error) = controls.set_playback(playback) {
                tracing::warn!(target: "smtc", error = %error, "SMTC playback update failed");
            }
        }
        *previous = Some(projection.clone());
    }
}

#[cfg(target_os = "linux")]
fn run_mpris_worker(
    callback_runtime: tokio::runtime::Handle,
    host_commands: HostCommandPublisher,
    player_service: Arc<PlayerService>,
    mut receiver: tokio::sync::mpsc::UnboundedReceiver<MediaProjection>,
    ready: std::sync::mpsc::SyncSender<Result<(), String>>,
) {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            let _ = ready.send(Err(error.to_string()));
            return;
        }
    };
    let local = tokio::task::LocalSet::new();
    local.block_on(&runtime, async move {
        use mpris_server::{LoopStatus, Metadata, PlaybackStatus, Player, Time};

        let instance_name = format!("yaqmc.instance{}", std::process::id());
        let player = match Player::builder(&instance_name)
            .identity("YAQMC")
            .desktop_entry("org.yaqmc.desktop")
            .can_quit(true)
            .can_raise(true)
            .can_control(true)
            .build()
            .await
        {
            Ok(player) => player,
            Err(error) => {
                let _ = ready.send(Err(error.to_string()));
                return;
            }
        };

        connect_linux_callbacks(&player, host_commands, callback_runtime, player_service);
        tokio::task::spawn_local(player.run());
        let _ = ready.send(Ok(()));
        let mut previous: Option<MediaProjection> = None;
        let mut applied_at = std::time::Instant::now();
        let mut last_seeked_at = applied_at;
        let mut clock = MprisProgressClock::new();
        let mut ticker = tokio::time::interval(std::time::Duration::from_millis(
            MPRIS_PROGRESS_TICK_MS,
        ));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        ticker.tick().await;
        loop {
            tokio::select! {
                projection = recv_latest_projection(&mut receiver) => {
                    let Some(projection) = projection else {
                        break;
                    };
                    let now = std::time::Instant::now();
                    let elapsed_ms = now.saturating_duration_since(applied_at).as_millis() as u64;
                    let emit_seeked =
                        mpris_should_emit_seeked(previous.as_ref(), &projection, elapsed_ms);
                    let metadata_changed = previous.as_ref().and_then(|value| value.metadata.as_ref())
                        != projection.metadata.as_ref();
                    if metadata_changed {
                        let metadata = projection
                            .metadata
                            .as_ref()
                            .map(mpris_metadata)
                            .unwrap_or_else(Metadata::new);
                        log_mpris_result("metadata", player.set_metadata(metadata).await);
                    }
                    if previous
                        .as_ref()
                        .is_none_or(|value| value.playback != projection.playback)
                    {
                        let status = match projection.playback {
                            PlaybackState::Playing => PlaybackStatus::Playing,
                            PlaybackState::Paused
                            | PlaybackState::Loading
                            | PlaybackState::Buffering => PlaybackStatus::Paused,
                            _ => PlaybackStatus::Stopped,
                        };
                        log_mpris_result(
                            "playback status",
                            player.set_playback_status(status).await,
                        );
                    }
                    if previous
                        .as_ref()
                        .is_none_or(|value| value.repeat != projection.repeat)
                    {
                        let status = match projection.repeat {
                            RepeatMode::Off => LoopStatus::None,
                            RepeatMode::One => LoopStatus::Track,
                            RepeatMode::All => LoopStatus::Playlist,
                        };
                        log_mpris_result("loop status", player.set_loop_status(status).await);
                    }
                    if previous
                        .as_ref()
                        .is_none_or(|value| value.shuffle != projection.shuffle)
                    {
                        log_mpris_result("shuffle", player.set_shuffle(projection.shuffle).await);
                    }
                    if previous
                        .as_ref()
                        .is_none_or(|value| (value.volume - projection.volume).abs() > f64::EPSILON)
                    {
                        log_mpris_result("volume", player.set_volume(projection.volume).await);
                    }
                    if previous
                        .as_ref()
                        .is_none_or(|value| value.can_go_next != projection.can_go_next)
                    {
                        log_mpris_result(
                            "CanGoNext",
                            player.set_can_go_next(projection.can_go_next).await,
                        );
                    }
                    if previous
                        .as_ref()
                        .is_none_or(|value| value.can_go_previous != projection.can_go_previous)
                    {
                        log_mpris_result(
                            "CanGoPrevious",
                            player.set_can_go_previous(projection.can_go_previous).await,
                        );
                    }
                    if previous
                        .as_ref()
                        .is_none_or(|value| value.can_seek != projection.can_seek)
                    {
                        log_mpris_result("CanSeek", player.set_can_seek(projection.can_seek).await);
                        log_mpris_result("CanPlay", player.set_can_play(projection.can_seek).await);
                        log_mpris_result(
                            "CanPause",
                            player.set_can_pause(projection.can_seek).await,
                        );
                    }
                    clock.sync(&projection);
                    let position = Time::from_millis(millis_i64(clock.current_ms()));
                    player.set_position(position);
                    if emit_seeked {
                        log_mpris_result("Seeked", player.seeked(position).await);
                        last_seeked_at = std::time::Instant::now();
                    }
                    previous = Some(projection);
                    applied_at = now;
                }
                _ = ticker.tick() => {
                    if !clock.playing {
                        continue;
                    }
                    let position = Time::from_millis(millis_i64(clock.current_ms()));
                    player.set_position(position);
                    let since_ms = last_seeked_at.elapsed().as_millis() as u64;
                    if mpris_should_heartbeat_seeked(clock.playing, since_ms) {
                        log_mpris_result("Seeked", player.seeked(position).await);
                        last_seeked_at = std::time::Instant::now();
                    }
                }
            }
        }
    });
}

#[cfg(target_os = "linux")]
fn connect_linux_callbacks(
    player: &mpris_server::Player,
    host_commands: HostCommandPublisher,
    runtime: tokio::runtime::Handle,
    player_service: Arc<PlayerService>,
) {
    let raise_commands = host_commands.clone();
    player.connect_raise(move |_| {
        let _ = raise_commands.publish(HostCommand::RaiseMainWindow);
    });
    player.connect_quit(move |_| {
        let _ = host_commands.publish(HostCommand::Quit);
    });

    let service = Arc::clone(&player_service);
    let command_runtime = runtime.clone();
    player.connect_play(move |_| {
        let _ = spawn_command(&command_runtime, Arc::clone(&service), LinuxCommand::Play);
    });
    let service = Arc::clone(&player_service);
    let command_runtime = runtime.clone();
    player.connect_pause(move |_| {
        let _ = spawn_command(&command_runtime, Arc::clone(&service), LinuxCommand::Pause);
    });
    let service = Arc::clone(&player_service);
    let command_runtime = runtime.clone();
    player.connect_play_pause(move |_| {
        let _ = spawn_command(&command_runtime, Arc::clone(&service), LinuxCommand::Toggle);
    });
    let service = Arc::clone(&player_service);
    let command_runtime = runtime.clone();
    player.connect_stop(move |_| {
        let _ = spawn_command(&command_runtime, Arc::clone(&service), LinuxCommand::Stop);
    });
    let service = Arc::clone(&player_service);
    let command_runtime = runtime.clone();
    player.connect_next(move |_| {
        let _ = spawn_command(&command_runtime, Arc::clone(&service), LinuxCommand::Next);
    });
    let service = Arc::clone(&player_service);
    let command_runtime = runtime.clone();
    player.connect_previous(move |_| {
        let _ = spawn_command(
            &command_runtime,
            Arc::clone(&service),
            LinuxCommand::Previous,
        );
    });

    let service = Arc::clone(&player_service);
    let callback_runtime = runtime.clone();
    player.connect_seek(move |_, offset| {
        let _ = dispatch_mpris_callback(
            &callback_runtime,
            Arc::clone(&service),
            SystemMediaPlayerCommand::SeekRelative(offset.as_millis()),
        );
    });
    let service = Arc::clone(&player_service);
    let callback_runtime = runtime.clone();
    player.connect_set_position(move |_, track_id, position| {
        let _ = dispatch_mpris_callback(
            &callback_runtime,
            Arc::clone(&service),
            SystemMediaPlayerCommand::SetPosition {
                position_ms: position.as_millis().max(0) as u64,
                expected_mpris_track_id: Some(track_id.to_string()),
            },
        );
    });
    let service = Arc::clone(&player_service);
    let callback_runtime = runtime.clone();
    player.connect_set_shuffle(move |_, shuffle| {
        let _ = dispatch_mpris_callback(
            &callback_runtime,
            Arc::clone(&service),
            SystemMediaPlayerCommand::SetShuffle(shuffle),
        );
    });
    let service = Arc::clone(&player_service);
    let callback_runtime = runtime.clone();
    player.connect_set_loop_status(move |_, status| {
        let repeat = repeat_mode_for_mpris(status);
        let _ = dispatch_mpris_callback(
            &callback_runtime,
            Arc::clone(&service),
            SystemMediaPlayerCommand::SetRepeat(repeat),
        );
    });
    let callback_runtime = runtime;
    player.connect_set_volume(move |_, volume| {
        let _ = dispatch_mpris_callback(
            &callback_runtime,
            Arc::clone(&player_service),
            SystemMediaPlayerCommand::SetVolume(volume),
        );
    });
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy)]
pub(crate) enum LinuxCommand {
    Play,
    Pause,
    Toggle,
    Stop,
    Next,
    Previous,
}

#[cfg(target_os = "linux")]
pub(crate) fn spawn_command(
    runtime: &tokio::runtime::Handle,
    player: Arc<PlayerService>,
    command: LinuxCommand,
) -> tokio::task::JoinHandle<()> {
    let command = match command {
        LinuxCommand::Play => SystemMediaPlayerCommand::Play,
        LinuxCommand::Pause => SystemMediaPlayerCommand::Pause,
        LinuxCommand::Toggle => SystemMediaPlayerCommand::Toggle,
        LinuxCommand::Stop => SystemMediaPlayerCommand::Stop,
        LinuxCommand::Next => SystemMediaPlayerCommand::Next,
        LinuxCommand::Previous => SystemMediaPlayerCommand::Previous,
    };
    dispatch_player_command_on_runtime(runtime, player, command, SystemMediaCallbackOrigin::Mpris)
}

#[cfg(target_os = "linux")]
pub(crate) fn dispatch_mpris_callback(
    runtime: &tokio::runtime::Handle,
    player: Arc<PlayerService>,
    command: SystemMediaPlayerCommand,
) -> tokio::task::JoinHandle<()> {
    dispatch_player_command_on_runtime(runtime, player, command, SystemMediaCallbackOrigin::Mpris)
}

#[cfg(target_os = "linux")]
fn mpris_metadata(metadata: &ProjectedMetadata) -> mpris_server::Metadata {
    use mpris_server::{Metadata, Time, TrackId};
    let track_id = TrackId::try_from(metadata.track_id.clone()).unwrap_or(TrackId::NO_TRACK);
    let mut builder = Metadata::builder()
        .trackid(track_id)
        .title(metadata.title.clone())
        .album(metadata.album.clone())
        .artist(metadata.artists.clone());
    if let Some(duration_ms) = metadata.duration_ms {
        builder = builder.length(Time::from_millis(millis_i64(duration_ms)));
    }
    if let Some(artwork_url) = &metadata.artwork_url {
        builder = builder.art_url(artwork_url.clone());
    }
    builder.build()
}

#[derive(Clone)]
#[allow(dead_code)] // Some commands are only emitted by the Linux MPRIS adapter.
pub(crate) enum SystemMediaPlayerCommand {
    Play,
    Pause,
    Toggle,
    Stop,
    Next,
    Previous,
    SeekRelative(i64),
    SetPosition {
        position_ms: u64,
        expected_mpris_track_id: Option<String>,
    },
    SetShuffle(bool),
    SetRepeat(RepeatMode),
    SetVolume(f64),
}

#[derive(Clone, Copy)]
#[allow(dead_code)] // Each variant is used only by its platform-native callback adapter.
pub(crate) enum SystemMediaCallbackOrigin {
    Mpris,
    Smtc,
}

pub(crate) fn dispatch_player_command_on_runtime(
    runtime: &tokio::runtime::Handle,
    player: Arc<PlayerService>,
    command: SystemMediaPlayerCommand,
    origin: SystemMediaCallbackOrigin,
) -> tokio::task::JoinHandle<()> {
    runtime.spawn(async move {
        let result = match command {
            SystemMediaPlayerCommand::Play => player.play().await,
            SystemMediaPlayerCommand::Pause => player.pause().await,
            SystemMediaPlayerCommand::Toggle => player.toggle().await,
            SystemMediaPlayerCommand::Stop => player.stop().await,
            SystemMediaPlayerCommand::Next => player.next().await,
            SystemMediaPlayerCommand::Previous => player.previous().await,
            SystemMediaPlayerCommand::SeekRelative(offset_ms) => {
                let position_ms = player.snapshot().await.position_ms;
                player
                    .seek(relative_seek_target(position_ms, offset_ms))
                    .await
            }
            SystemMediaPlayerCommand::SetPosition {
                position_ms,
                expected_mpris_track_id,
            } => {
                let snapshot = player.snapshot().await;
                let current_track = snapshot
                    .current_index
                    .and_then(|index| snapshot.queue.get(index))
                    .map(|track| mpris_track_id(&track.id));
                if expected_mpris_track_id.as_deref().is_none_or(|requested| {
                    mpris_position_request_is_current(current_track.as_deref(), requested)
                }) {
                    player.seek(position_ms).await
                } else {
                    Ok(snapshot)
                }
            }
            SystemMediaPlayerCommand::SetShuffle(shuffle) => Ok(player.set_shuffle(shuffle).await),
            SystemMediaPlayerCommand::SetRepeat(repeat) => Ok(player.set_repeat(repeat).await),
            SystemMediaPlayerCommand::SetVolume(volume) => {
                player.set_volume(clamp_system_media_volume(volume)).await
            }
        };
        if let Err(error) = result {
            match origin {
                SystemMediaCallbackOrigin::Mpris => {
                    tracing::debug!(target: "mpris", error = %error, "MPRIS command rejected");
                }
                SystemMediaCallbackOrigin::Smtc => {
                    tracing::debug!(target: "smtc", error = %error, "SMTC command rejected");
                }
            }
        }
    })
}

#[cfg(target_os = "linux")]
pub(crate) fn repeat_mode_for_mpris(status: mpris_server::LoopStatus) -> RepeatMode {
    match status {
        mpris_server::LoopStatus::None => RepeatMode::Off,
        mpris_server::LoopStatus::Track => RepeatMode::One,
        mpris_server::LoopStatus::Playlist => RepeatMode::All,
    }
}

#[cfg(target_os = "linux")]
fn log_mpris_result(label: &str, result: mpris_server::zbus::Result<()>) {
    if let Err(error) = result {
        tracing::warn!(target: "mpris", property = label, error = %error, "MPRIS projection update failed");
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn dispatch_windows_event(
    host_commands: HostCommandPublisher,
    runtime: tokio::runtime::Handle,
    player: Arc<PlayerService>,
    event: MediaControlEvent,
) -> Option<tokio::task::JoinHandle<()>> {
    match event {
        MediaControlEvent::Raise => {
            host_commands.publish(HostCommand::RaiseMainWindow);
            None
        }
        MediaControlEvent::Quit => {
            host_commands.publish(HostCommand::Quit);
            None
        }
        MediaControlEvent::OpenUri(_) => None,
        MediaControlEvent::Play => Some(SystemMediaPlayerCommand::Play),
        MediaControlEvent::Pause => Some(SystemMediaPlayerCommand::Pause),
        MediaControlEvent::Toggle => Some(SystemMediaPlayerCommand::Toggle),
        MediaControlEvent::Next => Some(SystemMediaPlayerCommand::Next),
        MediaControlEvent::Previous => Some(SystemMediaPlayerCommand::Previous),
        MediaControlEvent::Stop => Some(SystemMediaPlayerCommand::Stop),
        MediaControlEvent::Seek(direction) => Some(SystemMediaPlayerCommand::SeekRelative(
            smtc_seek_offset(direction, std::time::Duration::from_secs(10)),
        )),
        MediaControlEvent::SeekBy(direction, duration) => Some(
            SystemMediaPlayerCommand::SeekRelative(smtc_seek_offset(direction, duration)),
        ),
        MediaControlEvent::SetPosition(position) => Some(SystemMediaPlayerCommand::SetPosition {
            position_ms: duration_ms(position.0),
            expected_mpris_track_id: None,
        }),
        MediaControlEvent::SetVolume(volume) => Some(SystemMediaPlayerCommand::SetVolume(volume)),
    }
    .map(|command| {
        dispatch_player_command_on_runtime(
            &runtime,
            player,
            command,
            SystemMediaCallbackOrigin::Smtc,
        )
    })
}

#[cfg(target_os = "windows")]
fn smtc_seek_offset(direction: SeekDirection, amount: std::time::Duration) -> i64 {
    let amount = duration_ms(amount).min(i64::MAX as u64) as i64;
    match direction {
        SeekDirection::Forward => amount,
        SeekDirection::Backward => -amount,
    }
}

/// Parse `PlatformAttach.mainWindowHandle` (Electron hex, optional `0x`).
pub fn parse_window_handle_hex(value: &str) -> Result<isize, String> {
    let trimmed = value.trim();
    let hex = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(trimmed);
    if hex.is_empty() || hex.len() > 16 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("invalid window handle hex: {value}"));
    }
    u64::from_str_radix(hex, 16)
        .map(|parsed| parsed as isize)
        .map_err(|error| error.to_string())
}

fn valid_cover_url(value: &str) -> Option<&str> {
    (value.starts_with("https://") || value.starts_with("file://")).then_some(value)
}

pub(crate) fn mpris_track_id(track_id: &str) -> String {
    let digest = Sha256::digest(track_id.as_bytes());
    let suffix = digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("/org/yaqmc/track/{suffix}")
}

fn relative_seek_target(current_position_ms: u64, offset_ms: i64) -> u64 {
    if offset_ms >= 0 {
        current_position_ms.saturating_add(offset_ms as u64)
    } else {
        current_position_ms.saturating_sub(offset_ms.unsigned_abs())
    }
}

fn mpris_position_request_is_current(current_track: Option<&str>, requested_track: &str) -> bool {
    current_track == Some(requested_track)
}

fn clamp_system_media_volume(volume: f64) -> f64 {
    volume.clamp(0.0, 1.0)
}

#[cfg(target_os = "linux")]
fn millis_i64(value: u64) -> i64 {
    value.min(i64::MAX as u64) as i64
}

#[cfg(target_os = "windows")]
fn duration_ms(duration: std::time::Duration) -> u64 {
    duration.as_millis().min(u64::MAX as u128) as u64
}

const fn backend_name() -> &'static str {
    #[cfg(target_os = "linux")]
    {
        "mpris-server 0.10 (zbus)"
    }
    #[cfg(target_os = "windows")]
    {
        "Windows SMTC (souvlaki)"
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        "Unavailable"
    }
}

const fn specification_name() -> &'static str {
    #[cfg(target_os = "linux")]
    {
        "MPRIS 2.2"
    }
    #[cfg(target_os = "windows")]
    {
        "Windows System Media Transport Controls"
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        "None"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_electron_hex_window_handles() {
        assert_eq!(
            parse_window_handle_hex("0000000000123456").unwrap(),
            0x0012_3456
        );
        assert_eq!(parse_window_handle_hex("0x123456").unwrap(), 0x123456);
        assert_eq!(
            parse_window_handle_hex("DEADBEEF").unwrap(),
            0xDEAD_BEEF_u64 as isize
        );
        assert!(parse_window_handle_hex("not-hex").is_err());
        assert!(parse_window_handle_hex("").is_err());
        assert!(parse_window_handle_hex("0x").is_err());
        assert!(parse_window_handle_hex("1234567890abcdef0").is_err());
    }

    #[test]
    fn mpris_track_ids_are_stable_valid_object_paths() {
        let first = mpris_track_id("qqmusic:0039MnYb0qxYhV");
        assert_eq!(first, mpris_track_id("qqmusic:0039MnYb0qxYhV"));
        assert!(first.starts_with("/org/yaqmc/track/"));
        assert!(!first.contains(':'));
    }

    #[test]
    fn projection_does_not_expose_playback_urls() {
        assert!(valid_cover_url("https://example.test/cover.jpg").is_some());
        assert!(valid_cover_url("http://signed.example.test/song.mp3?token=x").is_none());
    }

    #[test]
    fn projection_preserves_repeat_shuffle_volume_and_muting() {
        let snapshot = PlayerSnapshot {
            queue: Vec::new(),
            queue_entries: Vec::new(),
            current_index: None,
            current_queue_entry_id: None,
            position_ms: 4_200,
            is_playing: false,
            volume: 0.64,
            is_muted: false,
            repeat: RepeatMode::One,
            playback_order: crate::player::PlaybackOrder::Shuffle,
            shuffle: true,
            primary_playback_mode: crate::player::PrimaryPlaybackMode::RepeatOne,
            shuffle_traversal: Vec::new(),
            shuffle_cursor: 0,
            playback_history: Vec::new(),
            history_cursor: 0,
            upcoming_queue_entry_ids: Vec::new(),
            playback_state: PlaybackState::Paused,
            playback_duration_ms: None,
            playback_error: None,
            source_selection: None,
            session_id: 0,
            snapshot_revision: 0,
            source_generation: 0,
            last_seek_revision: 0,
            sampled_at_ms: 0,
        };
        let projected = MediaProjection::from_snapshot(&snapshot, true);
        assert_eq!(projected.repeat, RepeatMode::One);
        assert!(projected.shuffle);
        assert_eq!(projected.volume, 0.64);
        assert_eq!(projected.position_ms, 4_200);
        assert!(projected.seeked);

        let muted = MediaProjection::from_snapshot(
            &PlayerSnapshot {
                is_muted: true,
                ..snapshot
            },
            false,
        );
        assert_eq!(muted.volume, 0.0);
    }

    fn test_media_projection(
        track: &str,
        position_ms: u64,
        playback: PlaybackState,
        seeked: bool,
    ) -> MediaProjection {
        MediaProjection {
            metadata: Some(ProjectedMetadata {
                track_id: mpris_track_id(track),
                title: track.to_owned(),
                album: "Album".to_owned(),
                artists: vec!["Artist".to_owned()],
                artwork_url: None,
                duration_ms: Some(60_000),
            }),
            playback,
            repeat: RepeatMode::Off,
            shuffle: false,
            volume: 1.0,
            position_ms,
            can_go_next: true,
            can_go_previous: true,
            can_seek: true,
            seeked,
        }
    }

    #[test]
    fn reported_position_extrapolates_only_while_playing_and_stays_clamped() {
        let paused = PlayerSnapshot {
            playback_state: PlaybackState::Paused,
            position_ms: 4_200,
            sampled_at_ms: 10_000,
            playback_duration_ms: Some(60_000),
            ..PlayerSnapshot {
                queue: Vec::new(),
                queue_entries: Vec::new(),
                current_index: None,
                current_queue_entry_id: None,
                position_ms: 0,
                is_playing: false,
                volume: 1.0,
                is_muted: false,
                repeat: RepeatMode::Off,
                playback_order: crate::player::PlaybackOrder::Sequential,
                shuffle: false,
                primary_playback_mode: crate::player::PrimaryPlaybackMode::Sequential,
                shuffle_traversal: Vec::new(),
                shuffle_cursor: 0,
                playback_history: Vec::new(),
                history_cursor: 0,
                upcoming_queue_entry_ids: Vec::new(),
                playback_state: PlaybackState::Stopped,
                playback_duration_ms: None,
                playback_error: None,
                source_selection: None,
                session_id: 0,
                snapshot_revision: 0,
                source_generation: 0,
                last_seek_revision: 0,
                sampled_at_ms: 0,
            }
        };
        assert_eq!(reported_position_ms_at(&paused, 12_000), 4_200);

        let playing = PlayerSnapshot {
            playback_state: PlaybackState::Playing,
            is_playing: true,
            position_ms: 4_200,
            sampled_at_ms: 10_000,
            playback_duration_ms: Some(4_800),
            ..paused
        };
        assert_eq!(reported_position_ms_at(&playing, 10_400), 4_600);
        assert_eq!(
            reported_position_ms_at(&playing, 20_000),
            4_800,
            "extrapolation must clamp to duration and cap stale age"
        );
    }

    #[test]
    fn mpris_emits_seeked_on_track_change_play_and_discontinuous_jumps() {
        let paused = test_media_projection("one", 12_000, PlaybackState::Paused, false);
        let playing = test_media_projection("one", 12_000, PlaybackState::Playing, false);
        let later = test_media_projection("one", 12_250, PlaybackState::Playing, false);
        let restarted = test_media_projection("one", 0, PlaybackState::Playing, false);
        let next_track = test_media_projection("two", 0, PlaybackState::Playing, false);
        let explicit = test_media_projection("one", 40_000, PlaybackState::Playing, true);

        assert!(mpris_should_emit_seeked(None, &playing, 0));
        assert!(mpris_should_emit_seeked(Some(&paused), &playing, 800));
        assert!(!mpris_should_emit_seeked(Some(&playing), &later, 250));
        assert!(mpris_should_emit_seeked(Some(&playing), &restarted, 250));
        assert!(mpris_should_emit_seeked(Some(&playing), &next_track, 250));
        assert!(mpris_should_emit_seeked(Some(&playing), &explicit, 250));
        let lagged = test_media_projection("one", 10_450, PlaybackState::Playing, false);
        let from = test_media_projection("one", 10_000, PlaybackState::Playing, false);
        assert!(
            !mpris_should_emit_seeked(Some(&from), &lagged, 2_000),
            "falling behind 1x progress is worker lag, not a Seeked event"
        );
        assert!(mpris_should_heartbeat_seeked(true, 250));
        assert!(!mpris_should_heartbeat_seeked(true, 249));
        assert!(!mpris_should_heartbeat_seeked(false, 1_000));
    }
}
