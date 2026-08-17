use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use yaqmc_core::audio::UnavailableAudioEngine;
use yaqmc_core::credentials::{CredentialError, CredentialStore};
use yaqmc_core::fullscreen_watch::{spawn_fullscreen_watch_every, POLL_INTERVAL};
use yaqmc_core::server::{host_command_event, spawn_host_command_fanout, EventSink};
use yaqmc_core::{bootstrap, CoreBootstrapInputs, CoreConfig, CoreHandle, CorePaths, HostCommand};
use yaqmc_protocol::CHANNEL_HOST_COMMAND;

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

#[derive(Clone, Debug)]
struct RecordedEvent {
    channel: String,
    payload: Value,
}

#[derive(Default)]
struct RecordingSink {
    events: Mutex<Vec<RecordedEvent>>,
}

impl EventSink for RecordingSink {
    fn emit(&self, _seq: u64, channel: &str, payload: &Value) {
        self.events
            .lock()
            .expect("recording sink")
            .push(RecordedEvent {
                channel: channel.to_owned(),
                payload: payload.clone(),
            });
    }
}

fn boot() -> (tempfile::TempDir, CoreHandle) {
    let root = tempfile::tempdir().expect("temp root");
    std::fs::create_dir_all(root.path().join("config")).expect("config dir");
    let config = CoreConfig {
        paths: CorePaths {
            data_dir: root.path().join("data"),
            cache_dir: root.path().join("cache"),
            log_dir: root.path().join("logs"),
            local_api_config_path: root.path().join("config").join("local-api.json"),
        },
        release_channel: "test-channel".to_owned(),
        build_commit: "0123456789abcdef0123456789abcdef01234567".to_owned(),
    };
    let handle = bootstrap(
        config,
        CoreBootstrapInputs {
            credentials: Arc::new(TestCredentials),
            audio: Arc::new(UnavailableAudioEngine),
            runtime: tokio::runtime::Handle::current(),
            windows_hwnd: None,
            windows_start_error: None,
            plugin_fallback_dir: root.path().join("plugin-fallback"),
            log_fallback_dir: root.path().join("log-fallback"),
        },
    )
    .expect("bootstrap");
    (root, handle)
}

#[test]
fn host_command_event_serializes_surface_auto_hide_and_raise_quit() {
    assert_eq!(POLL_INTERVAL, Duration::from_millis(800));
    assert_eq!(yaqmc_protocol::FRAME_HARD_CAP_BYTES, 32 * 1024 * 1024);

    let (hide_channel, hide_payload) = host_command_event(HostCommand::SurfaceAutoHide(true));
    let (show_channel, show_payload) = host_command_event(HostCommand::SurfaceAutoHide(false));
    let (raise_channel, raise_payload) = host_command_event(HostCommand::RaiseMainWindow);
    let (quit_channel, quit_payload) = host_command_event(HostCommand::Quit);

    assert_eq!(hide_channel, CHANNEL_HOST_COMMAND);
    assert_eq!(show_channel, CHANNEL_HOST_COMMAND);
    assert_eq!(raise_channel, CHANNEL_HOST_COMMAND);
    assert_eq!(quit_channel, CHANNEL_HOST_COMMAND);
    assert_eq!(hide_payload, json!({ "surfaceAutoHide": true }));
    assert_eq!(show_payload, json!({ "surfaceAutoHide": false }));
    assert_eq!(raise_payload, json!({ "command": "raise" }));
    assert_eq!(quit_payload, json!({ "command": "quit" }));
    assert_eq!(hide_payload.to_string(), r#"{"surfaceAutoHide":true}"#);
    assert_eq!(show_payload.to_string(), r#"{"surfaceAutoHide":false}"#);
    assert_eq!(raise_payload.to_string(), r#"{"command":"raise"}"#);
    assert_eq!(quit_payload.to_string(), r#"{"command":"quit"}"#);
}

#[cfg(not(windows))]
#[test]
fn linux_foreground_fullscreen_is_not_supported() {
    assert_eq!(
        yaqmc_core::fullscreen_watch::foreground_is_fullscreen(),
        None
    );
}

#[tokio::test]
async fn publishing_host_commands_emits_protocol_json() {
    let (_root, core) = boot();
    let sink = Arc::new(RecordingSink::default());
    spawn_host_command_fanout(
        &tokio::runtime::Handle::current(),
        core.subscribe_host_commands(),
        Arc::clone(&sink) as Arc<dyn EventSink>,
    );

    core.request_host_control(HostCommand::SurfaceAutoHide(true))
        .expect("hide");
    core.request_host_control(HostCommand::SurfaceAutoHide(false))
        .expect("show");
    core.request_host_control(HostCommand::RaiseMainWindow)
        .expect("raise");
    core.request_host_control(HostCommand::Quit).expect("quit");

    let deadline = tokio::time::Instant::now() + Duration::from_millis(500);
    while sink.events.lock().expect("sink").len() < 4 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let payloads: Vec<Value> = sink
        .events
        .lock()
        .expect("sink")
        .iter()
        .map(|event| event.payload.clone())
        .collect();
    assert_eq!(
        payloads,
        vec![
            json!({ "surfaceAutoHide": true }),
            json!({ "surfaceAutoHide": false }),
            json!({ "command": "raise" }),
            json!({ "command": "quit" }),
        ]
    );
    assert!(sink
        .events
        .lock()
        .expect("sink")
        .iter()
        .all(|event| event.channel == CHANNEL_HOST_COMMAND));
}

#[tokio::test]
async fn injected_probe_publishes_surface_auto_hide_edges() {
    let (_root, core) = boot();
    let fullscreen = Arc::new(AtomicBool::new(false));
    let probe_flag = Arc::clone(&fullscreen);
    let mut commands = core.subscribe_host_commands();
    let tick = Duration::from_millis(15);
    spawn_fullscreen_watch_every(
        &tokio::runtime::Handle::current(),
        core.host_command_publisher(),
        core.subscribe_shutdown(),
        Arc::new(move || Some(probe_flag.load(Ordering::SeqCst))),
        tick,
    );

    tokio::time::sleep(tick).await;
    assert!(
        matches!(
            commands.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ),
        "false → false is not an edge"
    );

    fullscreen.store(true, Ordering::SeqCst);
    let hide = tokio::time::timeout(Duration::from_millis(200), commands.recv())
        .await
        .expect("hide timeout")
        .expect("hide");
    assert_eq!(hide, HostCommand::SurfaceAutoHide(true));

    tokio::time::sleep(tick * 2).await;
    assert!(
        matches!(
            commands.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ),
        "unchanged fullscreen must not re-emit"
    );

    fullscreen.store(false, Ordering::SeqCst);
    let show = tokio::time::timeout(Duration::from_millis(200), commands.recv())
        .await
        .expect("restore timeout")
        .expect("restore");
    assert_eq!(show, HostCommand::SurfaceAutoHide(false));

    core.shutdown();
}
