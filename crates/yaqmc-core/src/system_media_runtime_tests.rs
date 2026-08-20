use std::sync::Arc;

use crate::player::{PlaybackState, PlayerService, RepeatMode};
use crate::system_media::{
    dispatch_player_command_on_runtime, mpris_track_id, HostCommandPublisher,
    SystemMediaCallbackOrigin, SystemMediaPlayerCommand,
};
#[cfg(target_os = "windows")]
use crate::system_media::{SystemMediaIntegration, SystemMediaStartConfig};
use crate::HostCommand;

#[cfg(target_os = "windows")]
use crate::system_media::dispatch_windows_event;
#[cfg(target_os = "windows")]
use souvlaki::{MediaControlEvent, MediaPosition, SeekDirection};

#[cfg(target_os = "linux")]
use crate::system_media::{
    dispatch_mpris_callback, repeat_mode_for_mpris, spawn_command, LinuxCommand,
};

fn system_media_test_song(id: &str) -> crate::player::Song {
    crate::player::Song {
        id: id.to_owned(),
        title: id.to_owned(),
        artists: vec![crate::player::ArtistSummary {
            id: "artist".to_owned(),
            name: "Artist".to_owned(),
        }],
        album: crate::player::AlbumSummary {
            id: "album".to_owned(),
            title: "Album".to_owned(),
        },
        artwork: crate::player::Artwork {
            src: "/cover.svg".to_owned(),
            alt: "Cover".to_owned(),
            dominant_color: "#000000".to_owned(),
            variants: Vec::new(),
        },
        duration_ms: 60_000,
        track_number: 1,
        is_favorite: false,
        quality: crate::player::AudioQuality::Lossless,
        availability: crate::player::SongAvailability::Available,
        audio_formats: Vec::new(),
        playback_capability: None,
        provider: None,
    }
}

fn system_media_test_player(runtime: &tokio::runtime::Runtime) -> Arc<PlayerService> {
    let player = Arc::new(PlayerService::new());
    runtime.block_on(player.hydrate_queue(vec![
        system_media_test_song("track-one"),
        system_media_test_song("track-two"),
    ]));
    player
}

fn complete_native_dispatch(
    runtime: &tokio::runtime::Runtime,
    command: tokio::task::JoinHandle<()>,
) {
    runtime
        .block_on(command)
        .expect("native callback task should complete");
}

#[test]
fn native_callback_dispatch_uses_the_supplied_runtime_and_player_state_machine() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("current-thread runtime");
    let player = system_media_test_player(&runtime);
    let mut events = player.subscribe();

    // This call happens from a normal synchronous test body, where there is
    // no current Tokio runtime. Linux MPRIS and Windows SMTC both use this
    // Core-owned callback route, then drive the explicitly supplied handle.
    complete_native_dispatch(
        &runtime,
        dispatch_player_command_on_runtime(
            runtime.handle(),
            Arc::clone(&player),
            SystemMediaPlayerCommand::Play,
            SystemMediaCallbackOrigin::Smtc,
        ),
    );
    assert_eq!(
        runtime.block_on(player.snapshot()).playback_state,
        PlaybackState::Playing
    );
    complete_native_dispatch(
        &runtime,
        dispatch_player_command_on_runtime(
            runtime.handle(),
            Arc::clone(&player),
            SystemMediaPlayerCommand::Pause,
            SystemMediaCallbackOrigin::Smtc,
        ),
    );
    assert_eq!(
        runtime.block_on(player.snapshot()).playback_state,
        PlaybackState::Paused
    );
    complete_native_dispatch(
        &runtime,
        dispatch_player_command_on_runtime(
            runtime.handle(),
            Arc::clone(&player),
            SystemMediaPlayerCommand::Toggle,
            SystemMediaCallbackOrigin::Smtc,
        ),
    );
    assert_eq!(
        runtime.block_on(player.snapshot()).playback_state,
        PlaybackState::Playing
    );
    complete_native_dispatch(
        &runtime,
        dispatch_player_command_on_runtime(
            runtime.handle(),
            Arc::clone(&player),
            SystemMediaPlayerCommand::SetPosition {
                position_ms: 900,
                expected_mpris_track_id: None,
            },
            SystemMediaCallbackOrigin::Smtc,
        ),
    );
    complete_native_dispatch(
        &runtime,
        dispatch_player_command_on_runtime(
            runtime.handle(),
            Arc::clone(&player),
            SystemMediaPlayerCommand::SeekRelative(-200),
            SystemMediaCallbackOrigin::Smtc,
        ),
    );
    assert_eq!(runtime.block_on(player.snapshot()).position_ms, 700);

    complete_native_dispatch(
        &runtime,
        dispatch_player_command_on_runtime(
            runtime.handle(),
            Arc::clone(&player),
            SystemMediaPlayerCommand::SetPosition {
                position_ms: 1_400,
                expected_mpris_track_id: Some(mpris_track_id("stale-track")),
            },
            SystemMediaCallbackOrigin::Mpris,
        ),
    );
    assert_eq!(
        runtime.block_on(player.snapshot()).position_ms,
        700,
        "stale MPRIS SetPosition must be fenced before reaching PlayerService"
    );

    complete_native_dispatch(
        &runtime,
        dispatch_player_command_on_runtime(
            runtime.handle(),
            Arc::clone(&player),
            SystemMediaPlayerCommand::Next,
            SystemMediaCallbackOrigin::Smtc,
        ),
    );
    assert_eq!(runtime.block_on(player.snapshot()).current_index, Some(1));
    complete_native_dispatch(
        &runtime,
        dispatch_player_command_on_runtime(
            runtime.handle(),
            Arc::clone(&player),
            SystemMediaPlayerCommand::Previous,
            SystemMediaCallbackOrigin::Smtc,
        ),
    );
    assert_eq!(runtime.block_on(player.snapshot()).current_index, Some(0));
    complete_native_dispatch(
        &runtime,
        dispatch_player_command_on_runtime(
            runtime.handle(),
            Arc::clone(&player),
            SystemMediaPlayerCommand::SetShuffle(true),
            SystemMediaCallbackOrigin::Mpris,
        ),
    );
    assert!(runtime.block_on(player.snapshot()).shuffle);
    complete_native_dispatch(
        &runtime,
        dispatch_player_command_on_runtime(
            runtime.handle(),
            Arc::clone(&player),
            SystemMediaPlayerCommand::SetRepeat(RepeatMode::One),
            SystemMediaCallbackOrigin::Mpris,
        ),
    );
    assert_eq!(runtime.block_on(player.snapshot()).repeat, RepeatMode::One);
    complete_native_dispatch(
        &runtime,
        dispatch_player_command_on_runtime(
            runtime.handle(),
            Arc::clone(&player),
            SystemMediaPlayerCommand::SetVolume(2.0),
            SystemMediaCallbackOrigin::Smtc,
        ),
    );
    assert_eq!(runtime.block_on(player.snapshot()).volume, 1.0);
    complete_native_dispatch(
        &runtime,
        dispatch_player_command_on_runtime(
            runtime.handle(),
            Arc::clone(&player),
            SystemMediaPlayerCommand::Stop,
            SystemMediaCallbackOrigin::Smtc,
        ),
    );
    assert_eq!(
        runtime.block_on(player.snapshot()).playback_state,
        PlaybackState::Stopped
    );

    let mut event_types = Vec::new();
    while let Ok(event) = events.try_recv() {
        event_types.push(event.event_type);
    }
    for expected in [
        "player.playback",
        "player.seeked",
        "player.mode",
        "player.volume",
    ] {
        assert!(
            event_types.iter().any(|event_type| event_type == expected),
            "native callback route must publish {expected}; got {event_types:?}"
        );
    }
}

#[cfg(target_os = "windows")]
#[test]
fn smtc_dispatch_translates_native_events_through_handle_to_player() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("current-thread runtime");
    let host_commands = HostCommandPublisher::default();
    let mut received = host_commands.subscribe();
    let player = system_media_test_player(&runtime);
    let mut events = player.subscribe();
    let dispatch = |event| {
        let task = dispatch_windows_event(
            host_commands.clone(),
            runtime.handle().clone(),
            Arc::clone(&player),
            event,
        )
        .expect("player-facing SMTC event should dispatch");
        complete_native_dispatch(&runtime, task);
    };

    dispatch(MediaControlEvent::Play);
    assert_eq!(
        runtime.block_on(player.snapshot()).playback_state,
        PlaybackState::Playing
    );
    dispatch(MediaControlEvent::Pause);
    assert_eq!(
        runtime.block_on(player.snapshot()).playback_state,
        PlaybackState::Paused
    );
    dispatch(MediaControlEvent::Toggle);
    assert_eq!(
        runtime.block_on(player.snapshot()).playback_state,
        PlaybackState::Playing
    );
    dispatch(MediaControlEvent::Seek(SeekDirection::Forward));
    assert_eq!(runtime.block_on(player.snapshot()).position_ms, 10_000);
    dispatch(MediaControlEvent::SeekBy(
        SeekDirection::Backward,
        std::time::Duration::from_millis(1_500),
    ));
    assert_eq!(runtime.block_on(player.snapshot()).position_ms, 8_500);
    dispatch(MediaControlEvent::SetPosition(MediaPosition(
        std::time::Duration::from_millis(1_200),
    )));
    assert_eq!(runtime.block_on(player.snapshot()).position_ms, 1_200);
    dispatch(MediaControlEvent::Next);
    assert_eq!(runtime.block_on(player.snapshot()).current_index, Some(1));
    dispatch(MediaControlEvent::Previous);
    assert_eq!(runtime.block_on(player.snapshot()).current_index, Some(0));
    dispatch(MediaControlEvent::SetVolume(1.4));
    assert_eq!(runtime.block_on(player.snapshot()).volume, 1.0);
    dispatch(MediaControlEvent::Stop);
    assert_eq!(
        runtime.block_on(player.snapshot()).playback_state,
        PlaybackState::Stopped
    );

    assert!(
        events.try_recv().is_ok(),
        "SMTC dispatcher must emit observable PlayerService events"
    );
    assert!(dispatch_windows_event(
        host_commands.clone(),
        runtime.handle().clone(),
        Arc::clone(&player),
        MediaControlEvent::Raise,
    )
    .is_none());
    assert!(dispatch_windows_event(
        host_commands.clone(),
        runtime.handle().clone(),
        Arc::clone(&player),
        MediaControlEvent::Quit,
    )
    .is_none());
    assert!(dispatch_windows_event(
        host_commands.clone(),
        runtime.handle().clone(),
        Arc::clone(&player),
        MediaControlEvent::OpenUri("yaqmc://ignored".to_owned()),
    )
    .is_none());

    assert_eq!(
        runtime.block_on(received.recv()).expect("raise command"),
        HostCommand::RaiseMainWindow
    );
    assert_eq!(
        runtime.block_on(received.recv()).expect("quit command"),
        HostCommand::Quit
    );
}

#[cfg(target_os = "windows")]
#[test]
fn host_hwnd_resolution_error_is_retained_in_system_media_status() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("current-thread runtime");
    let integration = SystemMediaIntegration::start(
        SystemMediaStartConfig {
            windows_hwnd: None,
            windows_start_error: Some("native HWND lookup failed".to_owned()),
            runtime: runtime.handle().clone(),
            host_commands: HostCommandPublisher::default(),
        },
        Arc::new(PlayerService::new()),
    );

    assert_eq!(
        integration.status().error.as_deref(),
        Some("native HWND lookup failed")
    );
}

#[cfg(target_os = "linux")]
#[test]
fn mpris_dispatch_translates_callbacks_through_handle_to_player() {
    use mpris_server::LoopStatus;

    assert_eq!(repeat_mode_for_mpris(LoopStatus::None), RepeatMode::Off);
    assert_eq!(repeat_mode_for_mpris(LoopStatus::Track), RepeatMode::One);
    assert_eq!(repeat_mode_for_mpris(LoopStatus::Playlist), RepeatMode::All);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("current-thread runtime");
    let player = system_media_test_player(&runtime);
    let mut events = player.subscribe();

    for command in [
        LinuxCommand::Play,
        LinuxCommand::Pause,
        LinuxCommand::Toggle,
        LinuxCommand::Next,
        LinuxCommand::Previous,
        LinuxCommand::Stop,
    ] {
        complete_native_dispatch(
            &runtime,
            spawn_command(runtime.handle(), Arc::clone(&player), command),
        );
    }
    assert_eq!(
        runtime.block_on(player.snapshot()).playback_state,
        PlaybackState::Stopped
    );

    let current_track = mpris_track_id("track-one");
    complete_native_dispatch(
        &runtime,
        dispatch_mpris_callback(
            runtime.handle(),
            Arc::clone(&player),
            SystemMediaPlayerCommand::SetPosition {
                position_ms: 1_000,
                expected_mpris_track_id: Some(current_track),
            },
        ),
    );
    complete_native_dispatch(
        &runtime,
        dispatch_mpris_callback(
            runtime.handle(),
            Arc::clone(&player),
            SystemMediaPlayerCommand::SeekRelative(-250),
        ),
    );
    assert_eq!(runtime.block_on(player.snapshot()).position_ms, 750);
    complete_native_dispatch(
        &runtime,
        dispatch_mpris_callback(
            runtime.handle(),
            Arc::clone(&player),
            SystemMediaPlayerCommand::SetPosition {
                position_ms: 2_000,
                expected_mpris_track_id: Some(mpris_track_id("stale-track")),
            },
        ),
    );
    assert_eq!(
        runtime.block_on(player.snapshot()).position_ms,
        750,
        "MPRIS position requests for a stale track must not reach PlayerService"
    );
    complete_native_dispatch(
        &runtime,
        dispatch_mpris_callback(
            runtime.handle(),
            Arc::clone(&player),
            SystemMediaPlayerCommand::SetShuffle(true),
        ),
    );
    assert!(runtime.block_on(player.snapshot()).shuffle);
    complete_native_dispatch(
        &runtime,
        dispatch_mpris_callback(
            runtime.handle(),
            Arc::clone(&player),
            SystemMediaPlayerCommand::SetRepeat(RepeatMode::All),
        ),
    );
    assert_eq!(runtime.block_on(player.snapshot()).repeat, RepeatMode::All);
    complete_native_dispatch(
        &runtime,
        dispatch_mpris_callback(
            runtime.handle(),
            Arc::clone(&player),
            SystemMediaPlayerCommand::SetVolume(-0.1),
        ),
    );
    assert_eq!(runtime.block_on(player.snapshot()).volume, 0.0);
    assert!(
        events.try_recv().is_ok(),
        "MPRIS callback dispatcher must emit observable PlayerService events"
    );

    let commands = HostCommandPublisher::default();
    let mut received = commands.subscribe();
    assert!(commands.publish(HostCommand::RaiseMainWindow));
    assert!(commands.publish(HostCommand::Quit));
    assert_eq!(
        received.try_recv().expect("raise command"),
        HostCommand::RaiseMainWindow
    );
    assert_eq!(
        received.try_recv().expect("quit command"),
        HostCommand::Quit
    );
}
