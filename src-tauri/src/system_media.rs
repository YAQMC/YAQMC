use crate::player::{PlaybackState, PlayerService, PlayerSnapshot, RepeatMode};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
    SeekDirection,
};

pub use yaqmc_core::platform::SystemMediaStatus;

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
            position_ms: snapshot.position_ms,
            can_go_next: track.is_some() && snapshot.queue.len() > 1,
            can_go_previous: track.is_some(),
            can_seek: track.is_some() && snapshot.playback_duration_ms.is_some(),
            seeked,
        }
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
    pub fn start(app: &AppHandle, player: Arc<PlayerService>) -> Arc<Self> {
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
        integration.initialize_linux(app, player);
        #[cfg(target_os = "windows")]
        integration.initialize_windows(app, player);
        #[cfg(not(any(target_os = "linux", target_os = "windows")))]
        {
            let _ = (app, player);
            integration.set_error("system media controls are not implemented on this platform");
        }
        integration
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
    fn initialize_linux(&self, app: &AppHandle, player: Arc<PlayerService>) {
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        let (ready_sender, ready_receiver) = std::sync::mpsc::sync_channel(1);
        let event_app = app.clone();
        match std::thread::Builder::new()
            .name("yaqmc-mpris".to_owned())
            .spawn(move || run_mpris_worker(event_app, player, receiver, ready_sender))
        {
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
    fn initialize_windows(&self, app: &AppHandle, player: Arc<PlayerService>) {
        let hwnd = match app
            .get_webview_window("main")
            .ok_or_else(|| "main window is unavailable".to_owned())
            .and_then(|window| {
                window
                    .hwnd()
                    .map(|handle| handle.0)
                    .map_err(|error| error.to_string())
            }) {
            Ok(hwnd) => Some(hwnd),
            Err(error) => {
                self.set_error(error);
                return;
            }
        };
        let mut controls = match MediaControls::new(PlatformConfig {
            dbus_name: "yaqmc",
            display_name: "YAQMC",
            hwnd,
        }) {
            Ok(controls) => controls,
            Err(error) => {
                self.set_error(error.to_string());
                return;
            }
        };
        let event_app = app.clone();
        if let Err(error) = controls
            .attach(move |event| dispatch_windows_event(&event_app, Arc::clone(&player), event))
        {
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
    app: AppHandle,
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

        connect_linux_callbacks(&player, app, player_service);
        tokio::task::spawn_local(player.run());
        let _ = ready.send(Ok(()));
        let mut previous: Option<MediaProjection> = None;
        while let Some(projection) = receiver.recv().await {
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
                    PlaybackState::Paused | PlaybackState::Loading | PlaybackState::Buffering => {
                        PlaybackStatus::Paused
                    }
                    _ => PlaybackStatus::Stopped,
                };
                log_mpris_result("playback status", player.set_playback_status(status).await);
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
                log_mpris_result("CanPause", player.set_can_pause(projection.can_seek).await);
            }
            let position = Time::from_millis(millis_i64(projection.position_ms));
            player.set_position(position);
            if projection.seeked {
                log_mpris_result("Seeked", player.seeked(position).await);
            }
            previous = Some(projection);
        }
    });
}

#[cfg(target_os = "linux")]
fn connect_linux_callbacks(
    player: &mpris_server::Player,
    app: AppHandle,
    player_service: Arc<PlayerService>,
) {
    let raise_app = app.clone();
    player.connect_raise(move |_| show_main_window(&raise_app));
    player.connect_quit(move |_| app.exit(0));

    let service = Arc::clone(&player_service);
    player.connect_play(move |_| spawn_command(Arc::clone(&service), LinuxCommand::Play));
    let service = Arc::clone(&player_service);
    player.connect_pause(move |_| spawn_command(Arc::clone(&service), LinuxCommand::Pause));
    let service = Arc::clone(&player_service);
    player.connect_play_pause(move |_| spawn_command(Arc::clone(&service), LinuxCommand::Toggle));
    let service = Arc::clone(&player_service);
    player.connect_stop(move |_| spawn_command(Arc::clone(&service), LinuxCommand::Stop));
    let service = Arc::clone(&player_service);
    player.connect_next(move |_| spawn_command(Arc::clone(&service), LinuxCommand::Next));
    let service = Arc::clone(&player_service);
    player.connect_previous(move |_| spawn_command(Arc::clone(&service), LinuxCommand::Previous));

    let service = Arc::clone(&player_service);
    player.connect_seek(move |_, offset| {
        let offset_ms = offset.as_millis();
        let service = Arc::clone(&service);
        tauri::async_runtime::spawn(async move {
            let current = service.snapshot().await.position_ms;
            let next = if offset_ms >= 0 {
                current.saturating_add(offset_ms as u64)
            } else {
                current.saturating_sub(offset_ms.unsigned_abs())
            };
            let _ = service.seek(next).await;
        });
    });
    let service = Arc::clone(&player_service);
    player.connect_set_position(move |_, track_id, position| {
        let requested_track = track_id.to_string();
        let position_ms = position.as_millis().max(0) as u64;
        let service = Arc::clone(&service);
        tauri::async_runtime::spawn(async move {
            let snapshot = service.snapshot().await;
            let current_track = snapshot
                .current_index
                .and_then(|index| snapshot.queue.get(index))
                .map(|track| mpris_track_id(&track.id));
            if current_track.as_deref() == Some(requested_track.as_str()) {
                let _ = service.seek(position_ms).await;
            }
        });
    });
    let service = Arc::clone(&player_service);
    player.connect_set_shuffle(move |_, shuffle| {
        let service = Arc::clone(&service);
        tauri::async_runtime::spawn(async move {
            service.set_shuffle(shuffle).await;
        });
    });
    let service = Arc::clone(&player_service);
    player.connect_set_loop_status(move |_, status| {
        use mpris_server::LoopStatus;
        let repeat = match status {
            LoopStatus::None => RepeatMode::Off,
            LoopStatus::Track => RepeatMode::One,
            LoopStatus::Playlist => RepeatMode::All,
        };
        let service = Arc::clone(&service);
        tauri::async_runtime::spawn(async move {
            service.set_repeat(repeat).await;
        });
    });
    player.connect_set_volume(move |_, volume| {
        let service = Arc::clone(&player_service);
        tauri::async_runtime::spawn(async move {
            let _ = service.set_volume(volume.clamp(0.0, 1.0)).await;
        });
    });
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy)]
enum LinuxCommand {
    Play,
    Pause,
    Toggle,
    Stop,
    Next,
    Previous,
}

#[cfg(target_os = "linux")]
fn spawn_command(player: Arc<PlayerService>, command: LinuxCommand) {
    tauri::async_runtime::spawn(async move {
        let result = match command {
            LinuxCommand::Play => player.play().await,
            LinuxCommand::Pause => player.pause().await,
            LinuxCommand::Toggle => player.toggle().await,
            LinuxCommand::Stop => player.stop().await,
            LinuxCommand::Next => player.next().await,
            LinuxCommand::Previous => player.previous().await,
        };
        if let Err(error) = result {
            tracing::debug!(target: "mpris", error = %error, "MPRIS command rejected");
        }
    });
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

#[cfg(target_os = "linux")]
fn log_mpris_result(label: &str, result: mpris_server::zbus::Result<()>) {
    if let Err(error) = result {
        tracing::warn!(target: "mpris", property = label, error = %error, "MPRIS projection update failed");
    }
}

#[cfg(target_os = "windows")]
fn dispatch_windows_event(app: &AppHandle, player: Arc<PlayerService>, event: MediaControlEvent) {
    match event {
        MediaControlEvent::Raise => show_main_window(app),
        MediaControlEvent::Quit => app.exit(0),
        MediaControlEvent::OpenUri(_) => {}
        event => {
            tauri::async_runtime::spawn(async move {
                let result = match event {
                    MediaControlEvent::Play => player.play().await,
                    MediaControlEvent::Pause => player.pause().await,
                    MediaControlEvent::Toggle => player.toggle().await,
                    MediaControlEvent::Next => player.next().await,
                    MediaControlEvent::Previous => player.previous().await,
                    MediaControlEvent::Stop => player.stop().await,
                    MediaControlEvent::Seek(direction) => {
                        seek_relative(&player, direction, std::time::Duration::from_secs(10)).await
                    }
                    MediaControlEvent::SeekBy(direction, duration) => {
                        seek_relative(&player, direction, duration).await
                    }
                    MediaControlEvent::SetPosition(position) => {
                        player.seek(duration_ms(position.0)).await
                    }
                    MediaControlEvent::SetVolume(volume) => {
                        player.set_volume(volume.clamp(0.0, 1.0)).await
                    }
                    MediaControlEvent::OpenUri(_)
                    | MediaControlEvent::Raise
                    | MediaControlEvent::Quit => return,
                };
                if let Err(error) = result {
                    tracing::debug!(target: "smtc", error = %error, "SMTC command rejected");
                }
            });
        }
    }
}

#[cfg(target_os = "windows")]
async fn seek_relative(
    player: &PlayerService,
    direction: SeekDirection,
    amount: std::time::Duration,
) -> Result<PlayerSnapshot, crate::player::PlayerError> {
    let current = player.snapshot().await.position_ms;
    let amount = duration_ms(amount);
    let next = match direction {
        SeekDirection::Forward => current.saturating_add(amount),
        SeekDirection::Backward => current.saturating_sub(amount),
    };
    player.seek(next).await
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn valid_cover_url(value: &str) -> Option<&str> {
    (value.starts_with("https://") || value.starts_with("file://")).then_some(value)
}

fn mpris_track_id(track_id: &str) -> String {
    let digest = Sha256::digest(track_id.as_bytes());
    let suffix = digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("/org/yaqmc/track/{suffix}")
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
}
