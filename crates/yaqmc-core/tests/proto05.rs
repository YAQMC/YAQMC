use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use yaqmc_core::audio::UnavailableAudioEngine;
use yaqmc_core::credentials::{CredentialError, CredentialStore};
use yaqmc_core::player::PlayerSnapshot;
use yaqmc_core::server::{
    EventSink, actions_for_player_event, host_command_event, lagged_resync_channels,
    spawn_player_fanout,
};
use yaqmc_core::{CoreBootstrapInputs, CoreConfig, CoreHandle, CorePaths, HostCommand, bootstrap};
use yaqmc_protocol::{
    CHANNEL_ACCOUNT_CHANGED, CHANNEL_API_EVENT, CHANNEL_CORE_LOG, CHANNEL_HOST_COMMAND,
    CHANNEL_LYRICS_DOCUMENT, CHANNEL_LYRICS_PROJECTION, CHANNEL_PLAYER_SNAPSHOT,
    CHANNEL_PLUGIN_CHANGED, CHANNEL_PREFERENCES_CHANGED, CORE_EVENT_CHANNELS,
};

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
    seq: u64,
    channel: String,
    payload: Value,
}

#[derive(Default)]
struct RecordingSink {
    events: Mutex<Vec<RecordedEvent>>,
}

impl EventSink for RecordingSink {
    fn emit(&self, seq: u64, channel: &str, payload: &Value) {
        self.events
            .lock()
            .expect("recording sink")
            .push(RecordedEvent {
                seq,
                channel: channel.to_owned(),
                payload: payload.clone(),
            });
    }
}

impl RecordingSink {
    fn channels(&self) -> Vec<String> {
        self.events
            .lock()
            .expect("recording sink")
            .iter()
            .map(|event| event.channel.clone())
            .collect()
    }

    fn seqs(&self) -> Vec<u64> {
        self.events
            .lock()
            .expect("recording sink")
            .iter()
            .map(|event| event.seq)
            .collect()
    }
}

fn boot() -> (tempfile::TempDir, tokio::runtime::Runtime, CoreHandle) {
    let root = tempfile::tempdir().expect("temp root");
    std::fs::create_dir_all(root.path().join("config")).expect("config dir");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("current-thread runtime");
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
            runtime: runtime.handle().clone(),
            windows_hwnd: None,
            windows_start_error: None,
            plugin_fallback_dir: root.path().join("plugin-fallback"),
            log_fallback_dir: root.path().join("log-fallback"),
        },
    )
    .expect("bootstrap");
    (root, runtime, handle)
}

/// Recorded from the live Tauri `lib.rs` fan-out (§3.2) before the PROTO-05 move.
const TAURI_CHANNEL_MAP_FIXTURE: &[(&str, &[&str], bool, bool, bool)] = &[
    (
        "queue.changed",
        &[CHANNEL_API_EVENT, CHANNEL_PLAYER_SNAPSHOT],
        true,
        true,
        false,
    ),
    (
        "player.track",
        &[
            CHANNEL_API_EVENT,
            CHANNEL_PLAYER_SNAPSHOT,
            CHANNEL_LYRICS_PROJECTION,
        ],
        true,
        true,
        false,
    ),
    (
        "player.playback",
        &[
            CHANNEL_API_EVENT,
            CHANNEL_PLAYER_SNAPSHOT,
            CHANNEL_LYRICS_PROJECTION,
        ],
        true,
        true,
        false,
    ),
    (
        "player.position",
        &[
            CHANNEL_API_EVENT,
            CHANNEL_PLAYER_SNAPSHOT,
            CHANNEL_LYRICS_PROJECTION,
        ],
        true,
        false,
        false,
    ),
    (
        "player.seeked",
        &[
            CHANNEL_API_EVENT,
            CHANNEL_PLAYER_SNAPSHOT,
            CHANNEL_LYRICS_PROJECTION,
        ],
        true,
        false,
        true,
    ),
    (
        "player.volume",
        &[CHANNEL_API_EVENT, CHANNEL_PLAYER_SNAPSHOT],
        true,
        true,
        false,
    ),
    (
        "player.mode",
        &[CHANNEL_API_EVENT, CHANNEL_PLAYER_SNAPSHOT],
        true,
        true,
        false,
    ),
    (
        "player.error",
        &[
            CHANNEL_API_EVENT,
            CHANNEL_PLAYER_SNAPSHOT,
            CHANNEL_LYRICS_PROJECTION,
        ],
        true,
        true,
        false,
    ),
    (
        "lyrics.changed",
        &[
            CHANNEL_API_EVENT,
            CHANNEL_LYRICS_PROJECTION,
            CHANNEL_LYRICS_DOCUMENT,
        ],
        false,
        false,
        false,
    ),
    (
        "lyrics.line",
        &[CHANNEL_API_EVENT, CHANNEL_LYRICS_PROJECTION],
        false,
        false,
        false,
    ),
    (
        "lyrics.word",
        &[CHANNEL_API_EVENT, CHANNEL_LYRICS_PROJECTION],
        false,
        false,
        false,
    ),
];

#[test]
fn player_channel_map_matches_the_recorded_tauri_fanout_fixture() {
    for (event_type, channels, update_system_media, persist_queue, seeked) in
        TAURI_CHANNEL_MAP_FIXTURE
    {
        let actions = actions_for_player_event(event_type);
        assert_eq!(actions.channels, *channels, "{event_type} channels");
        assert_eq!(
            actions.update_system_media, *update_system_media,
            "{event_type} smtc"
        );
        assert_eq!(
            actions.persist_queue, *persist_queue,
            "{event_type} persist"
        );
        assert_eq!(
            actions.system_media_seeked, *seeked,
            "{event_type} seeked flag"
        );
    }
}

#[test]
fn lagged_resync_reemits_authoritative_snapshot_projection_and_document() {
    assert_eq!(
        lagged_resync_channels(),
        &[
            CHANNEL_PLAYER_SNAPSHOT,
            CHANNEL_LYRICS_PROJECTION,
            CHANNEL_LYRICS_DOCUMENT,
        ]
    );
}

#[test]
fn host_commands_map_to_the_protocol_host_channel() {
    let (raise_channel, raise_payload) = host_command_event(HostCommand::RaiseMainWindow);
    let (quit_channel, quit_payload) = host_command_event(HostCommand::Quit);
    assert_eq!(raise_channel, CHANNEL_HOST_COMMAND);
    assert_eq!(quit_channel, CHANNEL_HOST_COMMAND);
    assert_eq!(raise_payload, serde_json::json!({"command": "raise"}));
    assert_eq!(quit_payload, serde_json::json!({"command": "quit"}));
}

#[test]
fn declared_core_channels_include_reserved_unused_account_changed() {
    assert!(CORE_EVENT_CHANNELS.contains(&CHANNEL_PLUGIN_CHANGED));
    assert!(CORE_EVENT_CHANNELS.contains(&CHANNEL_PREFERENCES_CHANGED));
    assert!(CORE_EVENT_CHANNELS.contains(&CHANNEL_CORE_LOG));
    assert!(CORE_EVENT_CHANNELS.contains(&CHANNEL_ACCOUNT_CHANGED));
    let source = include_str!("../src/server/events.rs");
    assert!(
        !source.contains("account://changed") && !source.contains("core://log"),
        "account://changed and core://log stay reserved/unused in the fan-out"
    );
}

#[test]
fn live_fanout_emits_sequenced_mode_channels_and_persists_the_queue() {
    let (_root, runtime, core) = boot();
    let _host_commands = core.subscribe_host_commands();
    let system_media = core.start_system_media();
    let sink = Arc::new(RecordingSink::default());
    spawn_player_fanout(
        runtime.handle(),
        core.player(),
        core.storage(),
        system_media,
        Arc::clone(&sink) as Arc<dyn EventSink>,
    );

    runtime.block_on(async {
        let _ = core.player().set_shuffle(true).await;
        let deadline = tokio::time::Instant::now() + Duration::from_millis(500);
        while sink.channels().len() < 2 && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    });

    assert_eq!(
        sink.channels(),
        vec![
            CHANNEL_API_EVENT.to_owned(),
            CHANNEL_PLAYER_SNAPSHOT.to_owned()
        ]
    );
    assert_eq!(sink.seqs(), vec![1, 2]);
    let stored: PlayerSnapshot = core
        .storage()
        .load_queue()
        .expect("load persisted queue")
        .expect("mode events persist the queue");
    assert!(stored.shuffle);

    let api_payload = sink.events.lock().expect("recording sink")[0]
        .payload
        .clone();
    assert_eq!(api_payload["type"], "player.mode");
    assert_eq!(api_payload["version"], 1);
}

#[test]
fn unknown_player_events_still_emit_api_event_only() {
    let actions = actions_for_player_event("not.a.real.event");
    assert_eq!(actions.channels, &[CHANNEL_API_EVENT]);
    assert!(!actions.update_system_media);
    assert!(!actions.persist_queue);
    assert!(!actions.system_media_seeked);
}

#[test]
fn tauri_shim_no_longer_owns_the_player_channel_map() {
    let tauri = include_str!("../../../src-tauri/src/lib.rs");
    assert!(
        tauri.contains("spawn_player_fanout("),
        "Tauri must call Core fan-out"
    );
    assert!(
        !tauri.contains("\"queue.changed\""),
        "channel map must not remain duplicated in the Tauri shim"
    );
}

#[test]
fn payload_hard_cap_is_unchanged() {
    assert_eq!(yaqmc_protocol::FRAME_HARD_CAP_BYTES, 32 * 1024 * 1024);
    let _unused: Option<Value> = None;
}
