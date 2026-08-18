use std::sync::Arc;

use yaqmc_core::audio::UnavailableAudioEngine;
use yaqmc_core::credentials::{CredentialError, CredentialStore};
use yaqmc_core::player::PlayerSnapshot;
use yaqmc_core::storage::StorageService;
use yaqmc_core::{bootstrap, CoreBootstrapInputs, CoreConfig, CorePaths, HostCommand};

struct TestCredentials;

impl CredentialStore for TestCredentials {
    fn load(&self, _account: &str) -> Result<Option<String>, CredentialError> {
        Ok(None)
    }

    fn save(&self, _account: &str, _secret: &str) -> Result<(), CredentialError> {
        Ok(())
    }

    fn delete(&self, _account: &str) -> Result<(), CredentialError> {
        Ok(())
    }
}

fn supplied_config(root: &std::path::Path) -> CoreConfig {
    CoreConfig {
        paths: CorePaths {
            data_dir: root.join("data"),
            cache_dir: root.join("cache"),
            log_dir: root.join("logs"),
            local_api_config_path: root.join("config").join("local-api.json"),
        },
        release_channel: "test-channel".to_owned(),
        build_commit: "0123456789abcdef0123456789abcdef01234567".to_owned(),
    }
}

fn test_inputs(runtime: tokio::runtime::Handle, root: &std::path::Path) -> CoreBootstrapInputs {
    CoreBootstrapInputs {
        credentials: Arc::new(TestCredentials),
        audio: Arc::new(UnavailableAudioEngine),
        runtime,
        windows_hwnd: None,
        windows_start_error: None,
        plugin_fallback_dir: root.join("plugin-fallback"),
        log_fallback_dir: root.join("log-fallback"),
    }
}

fn boot() -> (
    tempfile::TempDir,
    tokio::runtime::Runtime,
    yaqmc_core::CoreHandle,
) {
    let root = tempfile::tempdir().expect("temp root");
    std::fs::create_dir_all(root.path().join("config")).expect("config dir");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("current-thread runtime");
    let config = supplied_config(root.path());
    let handle = bootstrap(config, test_inputs(runtime.handle().clone(), root.path()))
        .expect("explicit configuration should bootstrap");
    (root, runtime, handle)
}

#[test]
fn bootstrap_preserves_all_injected_paths_and_config_without_path_discovery() {
    let (root, _runtime, handle) = boot();
    let config = supplied_config(root.path());

    assert_eq!(handle.config(), &config);
    assert_eq!(
        handle.config().paths.local_api_config_path,
        root.path().join("config").join("local-api.json"),
    );
    assert_ne!(
        handle.config().paths.local_api_config_path,
        handle.config().paths.data_dir.join("local-api.json"),
    );
}

#[test]
fn bootstrap_owns_one_shared_service_graph() {
    let (_root, _runtime, handle) = boot();
    handle.start_system_media();

    assert!(Arc::ptr_eq(&handle.player(), &handle.player()));
    assert!(Arc::ptr_eq(&handle.storage(), &handle.storage()));
    assert!(Arc::ptr_eq(&handle.qq_music(), &handle.qq_music()));
    assert!(Arc::ptr_eq(&handle.local_api(), &handle.local_api()));
    assert!(Arc::ptr_eq(&handle.plugins(), &handle.plugins()));
    assert!(Arc::ptr_eq(&handle.logging(), &handle.logging()));
    assert!(Arc::ptr_eq(&handle.system_media(), &handle.system_media()));
}

#[test]
fn restored_queue_calls_remember_songs_before_player_restore() {
    let source = include_str!("../src/bootstrap.rs");
    let remember = source
        .find("qq_music.remember_songs(&snapshot.queue)")
        .expect("restored queue provider-reference hydration");
    let restore = source
        .find("player.restore(snapshot)")
        .expect("player queue restoration");
    assert!(remember < restore);

    let root = tempfile::tempdir().expect("temp root");
    std::fs::create_dir_all(root.path().join("config")).expect("config dir");
    let config = supplied_config(root.path());
    let storage = StorageService::open(
        config.paths.data_dir.clone(),
        config.paths.cache_dir.clone(),
    )
    .expect("storage");
    let snapshot = PlayerSnapshot {
        queue: Vec::new(),
        queue_entries: Vec::new(),
        current_index: None,
        current_queue_entry_id: None,
        position_ms: 0,
        is_playing: false,
        volume: 0.41,
        is_muted: false,
        repeat: yaqmc_core::player::RepeatMode::Off,
        playback_order: yaqmc_core::player::PlaybackOrder::Sequential,
        shuffle: false,
        primary_playback_mode: yaqmc_core::player::PrimaryPlaybackMode::Sequential,
        shuffle_traversal: Vec::new(),
        shuffle_cursor: 0,
        playback_history: Vec::new(),
        history_cursor: 0,
        upcoming_queue_entry_ids: Vec::new(),
        playback_state: yaqmc_core::player::PlaybackState::Stopped,
        playback_duration_ms: None,
        playback_error: None,
        source_selection: None,
        session_id: 1,
        snapshot_revision: 1,
        source_generation: 1,
        last_seek_revision: 0,
        sampled_at_ms: 0,
    };
    storage.save_queue(&snapshot).expect("persist queue");
    drop(storage);

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("current-thread runtime");
    let handle = bootstrap(config, test_inputs(runtime.handle().clone(), root.path()))
        .expect("bootstrap with restored queue");
    let restored = runtime.block_on(handle.player().snapshot());
    assert!((restored.volume - 0.41).abs() < f64::EPSILON);
}

#[test]
fn subscribers_receive_typed_host_commands_in_request_order() {
    let (_root, runtime, handle) = boot();
    let mut commands = handle.subscribe_host_commands();
    handle.start_system_media();

    handle
        .request_host_control(HostCommand::RaiseMainWindow)
        .expect("subscriber should receive raise request");
    handle
        .request_host_control(HostCommand::Quit)
        .expect("subscriber should receive quit request");

    assert_eq!(
        commands.try_recv().expect("first command"),
        HostCommand::RaiseMainWindow,
    );
    assert_eq!(
        commands.try_recv().expect("second command"),
        HostCommand::Quit,
    );
    let _ = runtime;
}

#[test]
fn host_command_is_an_exhaustive_typed_surface() {
    fn describe(command: HostCommand) -> &'static str {
        match command {
            HostCommand::RaiseMainWindow => "raise",
            HostCommand::Quit => "quit",
            HostCommand::SurfaceAutoHide(_) => "surfaceAutoHide",
        }
    }

    assert_eq!(describe(HostCommand::RaiseMainWindow), "raise");
    assert_eq!(describe(HostCommand::Quit), "quit");
    assert_eq!(
        describe(HostCommand::SurfaceAutoHide(true)),
        "surfaceAutoHide"
    );
}

#[test]
fn shutdown_is_idempotent_and_propagates_owned_cancellation_state() {
    let (_root, _runtime, handle) = boot();
    let mut shutdown = handle.subscribe_shutdown();

    assert!(!handle.is_shutdown());
    assert!(!*shutdown.borrow());

    handle.shutdown();
    let shutdown_changed = shutdown
        .has_changed()
        .expect("core-owned shutdown sender should still exist");
    assert!(shutdown_changed);
    assert!(handle.is_shutdown());
    assert!(*shutdown.borrow_and_update());

    handle.shutdown();
    assert!(handle.is_shutdown());
    assert!(
        !shutdown
            .has_changed()
            .expect("shutdown sender is still owned"),
        "the idempotent second shutdown must not emit another state transition",
    );
}

#[test]
fn host_command_subscription_precedes_system_media_callback_enablement() {
    let source = include_str!("../src/lib.rs");
    let bootstrap_fn = source
        .find("pub fn bootstrap(")
        .expect("bootstrap constructor");
    let start_media = include_str!("../src/bootstrap.rs")
        .find("SystemMediaIntegration::start(")
        .expect("system-media start");
    assert!(bootstrap_fn > 0 && start_media > 0);

    let (_root, runtime, handle) = boot();
    assert!(!handle
        .host_command_publisher()
        .publish(HostCommand::RaiseMainWindow));
    let mut commands = handle.subscribe_host_commands();
    handle.start_system_media();
    assert!(handle
        .request_host_control(HostCommand::RaiseMainWindow)
        .is_ok());
    assert_eq!(
        runtime
            .block_on(commands.recv())
            .expect("subscribed command"),
        HostCommand::RaiseMainWindow
    );
}
