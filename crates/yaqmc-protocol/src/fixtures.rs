//! Golden contract fixtures for `cargo test -p yaqmc-protocol --features fixtures`.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};

use crate::envelope::{
    AttachMessage, CoreError, CoreIdentity, CoreMessage, HostIdentity, PlatformAttach,
    PlatformKind, ResponseBody, ShutdownReason,
};
use crate::registry::{methods, MethodOwner, TimeoutClass, PROTOCOL_ONLY_METHODS};
use crate::{
    ErrorCode, CHANNEL_ACCOUNT_CHANGED, CHANNEL_API_EVENT, CHANNEL_APP_OPEN_SETTINGS,
    CHANNEL_CORE_LOG, CHANNEL_HOST_COMMAND, CHANNEL_HOST_CORE_STATUS, CHANNEL_HOST_UPDATE,
    CHANNEL_LYRICS_DOCUMENT, CHANNEL_LYRICS_PROJECTION, CHANNEL_LYRICS_SURFACE_CLOSED,
    CHANNEL_PLAYER_SNAPSHOT, CHANNEL_PLUGIN_CHANGED, CHANNEL_PREFERENCES_CHANGED,
    CORE_EVENT_CHANNELS, DEFAULT_METHOD_PAYLOAD_BYTES, FRAME_HARD_CAP_BYTES, HANDSHAKE_TIMEOUT,
    HOST_EVENT_CHANNELS, PROTOCOL_VERSION, SHUTDOWN_TIMEOUT,
};

pub fn contract_fixtures_dir() -> PathBuf {
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../..")
                .join("target")
        });
    target.join("contract-fixtures")
}

pub fn emit_contract_fixtures(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    write_json(dir, "constants.json", &constants())?;
    write_json(dir, "envelopes.json", &envelopes())?;
    write_json(dir, "methods.json", &method_fixtures())?;
    write_json(dir, "channels.json", &channels())?;
    write_json(dir, "events.json", &events())?;
    write_json(dir, "requests.json", &requests())?;
    write_json(dir, "responses.json", &responses())?;
    Ok(())
}

fn write_json(dir: &Path, name: &str, value: &Value) -> io::Result<()> {
    let mut encoded = serde_json::to_string_pretty(value)?;
    encoded.push('\n');
    fs::write(dir.join(name), encoded)
}

fn to_value(message: &CoreMessage) -> Value {
    serde_json::to_value(message).expect("core message fixture")
}

fn core_identity() -> CoreIdentity {
    CoreIdentity {
        version: "0.1.0".to_owned(),
        commit: "0123456789abcdef0123456789abcdef01234567".to_owned(),
        channel: "stable".to_owned(),
    }
}

fn attach_message() -> AttachMessage {
    AttachMessage {
        protocol: PROTOCOL_VERSION,
        host: HostIdentity {
            app: "yaqmc".to_owned(),
            version: "0.1.0".to_owned(),
        },
        platform: PlatformAttach {
            main_window_handle: Some("0000000000123456".to_owned()),
            platform_kind: PlatformKind::Windows,
            display_backend: None,
        },
    }
}

fn constants() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "frameHardCapBytes": FRAME_HARD_CAP_BYTES,
        "defaultMethodPayloadBytes": DEFAULT_METHOD_PAYLOAD_BYTES,
        "handshakeTimeoutMs": HANDSHAKE_TIMEOUT.as_millis() as u64,
        "shutdownTimeoutMs": SHUTDOWN_TIMEOUT.as_millis() as u64,
        "protocolOnlyMethods": PROTOCOL_ONLY_METHODS,
        "errorCodes": [
            ErrorCode::CommandError.as_str(),
            ErrorCode::Unavailable.as_str(),
            ErrorCode::Timeout.as_str(),
            ErrorCode::Protocol.as_str(),
            ErrorCode::Denied.as_str(),
        ],
    })
}

fn envelopes() -> Value {
    json!({
        "hello": to_value(&CoreMessage::Hello {
            protocol: PROTOCOL_VERSION,
            core: core_identity(),
        }),
        "attach": to_value(&CoreMessage::Attach(attach_message())),
        "ready": to_value(&CoreMessage::Ready),
        "request": to_value(&CoreMessage::Request {
            id: 7,
            method: "player_snapshot".to_owned(),
            params: None,
        }),
        "requestWithParams": to_value(&CoreMessage::Request {
            id: 8,
            method: "player_seek".to_owned(),
            params: Some(json!({ "positionMs": 1000 })),
        }),
        "responseSuccess": to_value(&CoreMessage::Response {
            id: 7,
            body: ResponseBody::success(json!({ "ok": true })),
        }),
        "responseFailure": to_value(&CoreMessage::Response {
            id: 7,
            body: ResponseBody::failure(CoreError {
                code: ErrorCode::CommandError.as_str().to_owned(),
                message: "queue is empty".to_owned(),
                details: None,
                retryable: false,
            }),
        }),
        "event": to_value(&CoreMessage::Event {
            seq: 1,
            channel: CHANNEL_PLAYER_SNAPSHOT.to_owned(),
            payload: player_snapshot_payload(),
        }),
        "shutdown": to_value(&CoreMessage::Shutdown {
            reason: ShutdownReason::Quit,
        }),
        "shutdownAck": to_value(&CoreMessage::ShutdownAck),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MethodFixture {
    name: &'static str,
    owner: &'static str,
    main_window_only: bool,
    timeout_class: &'static str,
    timeout_ms: u64,
    allowed_origins: Vec<String>,
    request_cap: u32,
    response_cap: u32,
}

fn method_fixtures() -> Value {
    let rows: Vec<MethodFixture> = methods()
        .iter()
        .copied()
        .map(|spec| MethodFixture {
            name: spec.name,
            owner: match spec.owner {
                MethodOwner::Core => "core",
                MethodOwner::Host => "host",
            },
            main_window_only: spec.main_window_only,
            timeout_class: match spec.timeout_class {
                TimeoutClass::Control => "control",
                TimeoutClass::Standard => "standard",
                TimeoutClass::Long => "long",
            },
            timeout_ms: spec.timeout_class.duration().as_millis() as u64,
            allowed_origins: spec
                .allowed_origins
                .iter()
                .map(ToString::to_string)
                .collect(),
            request_cap: spec.request_cap,
            response_cap: spec.response_cap,
        })
        .collect();
    serde_json::to_value(rows).expect("method fixtures")
}

fn channels() -> Value {
    json!({
        "core": CORE_EVENT_CHANNELS,
        "host": HOST_EVENT_CHANNELS,
    })
}

fn events() -> Value {
    json!({
        CHANNEL_API_EVENT: to_value(&CoreMessage::Event {
            seq: 1,
            channel: CHANNEL_API_EVENT.to_owned(),
            payload: json!({
                "version": 1,
                "type": "player.playback",
                "timestampMs": 1_700_000_000_000_u64,
                "data": player_snapshot_payload(),
            }),
        }),
        CHANNEL_PLAYER_SNAPSHOT: to_value(&CoreMessage::Event {
            seq: 2,
            channel: CHANNEL_PLAYER_SNAPSHOT.to_owned(),
            payload: player_snapshot_payload(),
        }),
        CHANNEL_LYRICS_PROJECTION: to_value(&CoreMessage::Event {
            seq: 3,
            channel: CHANNEL_LYRICS_PROJECTION.to_owned(),
            payload: lyrics_projection_payload(),
        }),
        CHANNEL_LYRICS_DOCUMENT: to_value(&CoreMessage::Event {
            seq: 4,
            channel: CHANNEL_LYRICS_DOCUMENT.to_owned(),
            payload: lyrics_document_payload(),
        }),
        CHANNEL_PLUGIN_CHANGED: to_value(&CoreMessage::Event {
            seq: 5,
            channel: CHANNEL_PLUGIN_CHANGED.to_owned(),
            payload: json!({ "pluginId": "example", "enabled": true }),
        }),
        CHANNEL_PREFERENCES_CHANGED: to_value(&CoreMessage::Event {
            seq: 6,
            channel: CHANNEL_PREFERENCES_CHANGED.to_owned(),
            payload: json!({ "key": "appearance.theme" }),
        }),
        CHANNEL_HOST_COMMAND: to_value(&CoreMessage::Event {
            seq: 7,
            channel: CHANNEL_HOST_COMMAND.to_owned(),
            payload: json!({ "command": "raise" }),
        }),
        CHANNEL_CORE_LOG: to_value(&CoreMessage::Event {
            seq: 8,
            channel: CHANNEL_CORE_LOG.to_owned(),
            payload: json!({ "level": "info", "target": "core.protocol", "message": "host attached" }),
        }),
        CHANNEL_ACCOUNT_CHANGED: to_value(&CoreMessage::Event {
            seq: 9,
            channel: CHANNEL_ACCOUNT_CHANGED.to_owned(),
            payload: json!({ "signedIn": false }),
        }),
        CHANNEL_LYRICS_SURFACE_CLOSED: to_value(&CoreMessage::Event {
            seq: 10,
            channel: CHANNEL_LYRICS_SURFACE_CLOSED.to_owned(),
            payload: json!({ "surface": "lyrics-desktop" }),
        }),
        CHANNEL_APP_OPEN_SETTINGS: to_value(&CoreMessage::Event {
            seq: 11,
            channel: CHANNEL_APP_OPEN_SETTINGS.to_owned(),
            payload: json!({ "section": "playback" }),
        }),
        CHANNEL_HOST_CORE_STATUS: to_value(&CoreMessage::Event {
            seq: 12,
            channel: CHANNEL_HOST_CORE_STATUS.to_owned(),
            payload: json!({ "status": "ready" }),
        }),
        CHANNEL_HOST_UPDATE: to_value(&CoreMessage::Event {
            seq: 13,
            channel: CHANNEL_HOST_UPDATE.to_owned(),
            payload: json!({
                "state": "available",
                "canInstall": true,
                "allowPrerelease": false,
                "channel": "latest",
                "version": "1.2.3",
                "releaseUrl": "https://github.com/YAQMC/YAQMC/releases"
            }),
        }),
    })
}

fn sample_song() -> Value {
    json!({
        "id": "track-0",
        "title": "track-0",
        "artists": [{ "id": "artist", "name": "Artist" }],
        "album": { "id": "album", "title": "Album" },
        "artwork": {
            "src": "/cover.svg",
            "alt": "Cover",
            "dominantColor": "#000000"
        },
        "durationMs": 10_000,
        "trackNumber": 1,
        "isFavorite": false,
        "quality": "lossless",
        "availability": { "status": "available" }
    })
}

fn player_snapshot_payload() -> Value {
    json!({
        "queue": [sample_song()],
        "queueEntries": [{ "id": "entry-0", "track": sample_song() }],
        "currentIndex": 0,
        "currentQueueEntryId": "entry-0",
        "positionMs": 1200,
        "isPlaying": false,
        "volume": 0.72,
        "isMuted": false,
        "repeat": "off",
        "playbackOrder": "sequential",
        "shuffle": false,
        "primaryPlaybackMode": "sequential",
        "shuffleTraversal": [],
        "shuffleCursor": 0,
        "playbackHistory": [],
        "historyCursor": 0,
        "upcomingQueueEntryIds": ["entry-0"],
        "playbackState": "paused",
        "playbackDurationMs": 10_000,
        "sessionId": 1,
        "snapshotRevision": 4,
        "sourceGeneration": 1,
        "lastSeekRevision": 2
    })
}

fn lyrics_projection_payload() -> Value {
    json!({
        "timestampMs": 1_700_000_000_000_u64,
        "sessionId": 1,
        "currentTrack": sample_song(),
        "positionMs": 1200,
        "isPlaying": false,
        "playbackState": "paused",
        "playbackDurationMs": 10_000,
        "syncMode": "line",
        "lineIndex": 0,
        "wordIndex": null,
        "currentLine": {
            "id": "line-0",
            "startMs": 0,
            "endMs": 2000,
            "text": "hello"
        },
        "nextLine": {
            "id": "line-1",
            "startMs": 2000,
            "endMs": 4000,
            "text": "world"
        }
    })
}

fn lyrics_document_payload() -> Value {
    json!({
        "songId": "track-0",
        "syncMode": "line",
        "metadata": {
            "sourceLabel": "fixture",
            "offsetMs": 0
        },
        "vocalists": [],
        "lines": [{
            "id": "line-0",
            "startMs": 0,
            "endMs": 2000,
            "text": "hello"
        }]
    })
}

fn requests() -> Value {
    json!({
        "player_snapshot": to_value(&CoreMessage::Request {
            id: 1,
            method: "player_snapshot".to_owned(),
            params: None,
        }),
        "player_play": to_value(&CoreMessage::Request {
            id: 2,
            method: "player_play".to_owned(),
            params: None,
        }),
        "player_seek": to_value(&CoreMessage::Request {
            id: 3,
            method: "player_seek".to_owned(),
            params: Some(json!({ "positionMs": 4800 })),
        }),
        "player_next": to_value(&CoreMessage::Request {
            id: 4,
            method: "player_next".to_owned(),
            params: None,
        }),
        "player_play_tracks": to_value(&CoreMessage::Request {
            id: 5,
            method: "player_play_tracks".to_owned(),
            params: Some(json!({
                "request": {
                    "tracks": [sample_song()],
                    "shuffle": false
                }
            })),
        }),
        "player_reorder_queue_entry": to_value(&CoreMessage::Request {
            id: 6,
            method: "player_reorder_queue_entry".to_owned(),
            params: Some(json!({ "entryId": "entry-0", "targetIndex": 0 })),
        }),
        "player_remove_queue_entry": to_value(&CoreMessage::Request {
            id: 7,
            method: "player_remove_queue_entry".to_owned(),
            params: Some(json!({ "entryId": "entry-1" })),
        }),
        "player_play_queue_entry": to_value(&CoreMessage::Request {
            id: 8,
            method: "player_play_queue_entry".to_owned(),
            params: Some(json!({ "entryId": "entry-0" })),
        }),
        "core_ping": to_value(&CoreMessage::Request {
            id: 9,
            method: "core_ping".to_owned(),
            params: None,
        }),
        "platform_attach": to_value(&CoreMessage::Request {
            id: 10,
            method: "platform_attach".to_owned(),
            params: Some(serde_json::to_value(attach_message().platform).expect("platform")),
        }),
        "core_shutdown_prepare": to_value(&CoreMessage::Request {
            id: 11,
            method: "core_shutdown_prepare".to_owned(),
            params: None,
        }),
        "auth_oauth_prepare": to_value(&CoreMessage::Request {
            id: 12,
            method: "auth_oauth_prepare".to_owned(),
            params: Some(json!({ "providerKind": "qq" })),
        }),
        "auth_oauth_complete": to_value(&CoreMessage::Request {
            id: 13,
            method: "auth_oauth_complete".to_owned(),
            params: Some(json!({
                "attemptId": "attempt-0",
                "callbackUrl": "https://example.invalid/callback"
            })),
        }),
        "auth_oauth_cancel": to_value(&CoreMessage::Request {
            id: 14,
            method: "auth_oauth_cancel".to_owned(),
            params: Some(json!({ "attemptId": "attempt-0" })),
        }),
        "diagnostics_export_bundle_to": to_value(&CoreMessage::Request {
            id: 15,
            method: "diagnostics_export_bundle_to".to_owned(),
            params: Some(json!({
                "path": "/tmp/YAQMC-diagnostics.zip",
                "request": { "includeLogs": true }
            })),
        }),
        "preferences_set_background_from": to_value(&CoreMessage::Request {
            id: 16,
            method: "preferences_set_background_from".to_owned(),
            params: Some(json!({ "path": "/tmp/background.png" })),
        }),
        "plugin_install_from": to_value(&CoreMessage::Request {
            id: 17,
            method: "plugin_install_from".to_owned(),
            params: Some(json!({
                "request": { "path": "/tmp/plugin.yaqmc-plugin", "enable": false, "grant": [] }
            })),
        }),
    })
}

fn responses() -> Value {
    json!({
        "player_snapshot": to_value(&CoreMessage::Response {
            id: 1,
            body: ResponseBody::success(player_snapshot_payload()),
        }),
        "core_ping": to_value(&CoreMessage::Response {
            id: 9,
            body: ResponseBody::success(json!({ "ok": true })),
        }),
        "auth_oauth_prepare": to_value(&CoreMessage::Response {
            id: 12,
            body: ResponseBody::success(json!({
                "attemptId": "attempt-0",
                "url": "https://example.invalid/authorize",
                "navigationAllowlist": ["https://example.invalid/*"],
                "callbackMatcher": { "urlPrefix": "https://example.invalid/callback" }
            })),
        }),
        "hostDenied": to_value(&CoreMessage::Response {
            id: 99,
            body: ResponseBody::failure(CoreError {
                code: ErrorCode::Denied.as_str().to_owned(),
                message: "player_snapshot is not allowed from lyrics-desktop".to_owned(),
                details: None,
                retryable: false,
            }),
        }),
    })
}
