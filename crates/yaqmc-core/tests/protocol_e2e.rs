use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::process::{Child, Command};
use yaqmc_core::player::{
    AlbumSummary, ArtistSummary, Artwork, AudioQuality, Song, SongAvailability,
};
use yaqmc_protocol::{
    host_handshake, AttachMessage, CoreMessage, CoreTransport, HostIdentity, PipeTransport,
    PlatformAttach, PlatformKind, ResponseBody, ShutdownReason, CHANNEL_PLAYER_SNAPSHOT,
    PROTOCOL_VERSION,
};

struct Session {
    child: Child,
    transport: PipeTransport<tokio::process::ChildStdout, tokio::process::ChildStdin>,
    next_id: u64,
    snapshot_revisions: Vec<u64>,
    stderr: Arc<std::sync::Mutex<String>>,
}

fn fixture_song(id: &str, duration_ms: u64) -> Song {
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
            variants: Vec::new(),
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

fn attach_message() -> AttachMessage {
    AttachMessage {
        protocol: PROTOCOL_VERSION,
        host: HostIdentity {
            app: "yaqmc-e2e".to_owned(),
            version: "0.1.0".to_owned(),
        },
        platform: PlatformAttach {
            main_window_handle: None,
            platform_kind: PlatformKind::Windows,
            display_backend: None,
        },
    }
}

async fn spawn_core(root: &std::path::Path) -> Session {
    for dir in [
        "data",
        "cache",
        "logs",
        "config",
        "credentials",
        "tmp",
        "plugin-fallback",
    ] {
        std::fs::create_dir_all(root.join(dir)).expect("session dir");
    }
    let mut child = Command::new(env!("CARGO_BIN_EXE_yaqmc-core"))
        .env("YAQMC_DATA_DIR", root.join("data"))
        .env("YAQMC_CACHE_DIR", root.join("cache"))
        .env("YAQMC_LOG_DIR", root.join("logs"))
        .env("YAQMC_CONFIG_DIR", root.join("config"))
        .env("YAQMC_CREDENTIAL_DIR", root.join("credentials"))
        .env("YAQMC_PLUGIN_FALLBACK_DIR", root.join("plugin-fallback"))
        .env("YAQMC_LOG_FALLBACK_DIR", root.join("logs").join("fallback"))
        .env("YAQMC_DOWNLOAD_DIR", root.join("tmp").join("downloads"))
        .env("TEMP", root.join("tmp"))
        .env("TMP", root.join("tmp"))
        .env("TMPDIR", root.join("tmp"))
        .env("YAQMC_CHANNEL", "test")
        .env("RUST_BACKTRACE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn yaqmc-core");
    let stderr = child.stderr.take().expect("stderr");
    let stdin = child.stdin.take().expect("stdin");
    let stdout = child.stdout.take().expect("stdout");
    let stderr_log = Arc::new(std::sync::Mutex::new(String::new()));
    let captured = Arc::clone(&stderr_log);
    tokio::spawn(async move {
        let mut log = String::new();
        let _ = tokio::io::AsyncReadExt::read_to_string(
            &mut tokio::io::BufReader::new(stderr),
            &mut log,
        )
        .await;
        *captured.lock().expect("stderr log") = log;
    });
    let mut transport = PipeTransport::new(stdout, stdin);
    if let Err(error) = host_handshake(&mut transport, attach_message(), Some("0.1.0")).await {
        tokio::time::sleep(Duration::from_millis(100)).await;
        panic!(
            "handshake: {error}; stderr={}",
            stderr_log.lock().expect("stderr log")
        );
    }
    Session {
        child,
        transport,
        next_id: 1,
        snapshot_revisions: Vec::new(),
        stderr: stderr_log,
    }
}

impl Session {
    fn note_event(&mut self, channel: &str, payload: &Value) {
        if channel == CHANNEL_PLAYER_SNAPSHOT {
            if let Some(revision) = payload.get("snapshotRevision").and_then(Value::as_u64) {
                self.snapshot_revisions.push(revision);
            }
        }
    }

    async fn request(&mut self, method: &str, params: Option<Value>) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        self.transport
            .send(&CoreMessage::Request {
                id,
                method: method.to_owned(),
                params,
                origin: None,
            })
            .await
            .expect("send request");
        loop {
            match self.transport.recv().await {
                Ok(CoreMessage::Response {
                    id: response_id,
                    body,
                }) if response_id == id => match body {
                    ResponseBody::Success { result } => return result,
                    ResponseBody::Failure { error } => {
                        panic!("{method} failed: {} {}", error.code, error.message)
                    }
                },
                Ok(CoreMessage::Event {
                    channel, payload, ..
                }) => self.note_event(&channel, &payload),
                Ok(other) => panic!("unexpected {other:?} while waiting for {method}"),
                Err(error) => {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    let status = self.child.try_wait().ok().flatten();
                    panic!(
                        "{method} recv: {error}; status={status:?}; stderr={}",
                        self.stderr.lock().expect("stderr log")
                    );
                }
            }
        }
    }

    async fn shutdown(mut self) {
        self.transport
            .send(&CoreMessage::Shutdown {
                reason: ShutdownReason::Quit,
            })
            .await
            .expect("shutdown");
        loop {
            match self.transport.recv().await.expect("shutdown-ack") {
                CoreMessage::ShutdownAck => break,
                CoreMessage::Event {
                    channel, payload, ..
                } => self.note_event(&channel, &payload),
                other => panic!("expected shutdown-ack, got {other:?}"),
            }
        }
        let _ = self.child.wait().await;
    }
}

fn current_track_id(snapshot: &Value) -> String {
    let index = snapshot["currentIndex"].as_u64().unwrap_or(0) as usize;
    snapshot["queue"]
        .as_array()
        .and_then(|queue| queue.get(index))
        .and_then(|track| track.get("id"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn queue_entry_ids(snapshot: &Value) -> Vec<String> {
    snapshot["queueEntries"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|entry| {
            entry
                .get("id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .collect()
}

fn assert_revisions_monotonic(revisions: &[u64]) {
    assert!(
        revisions.windows(2).all(|pair| pair[0] <= pair[1]),
        "snapshot_revision must be monotonic, got {revisions:?}"
    );
}

#[tokio::test]
async fn protocol_e2e_covers_handshake_storms_and_shutdown_ack() {
    let root = tempfile::tempdir().expect("e2e root");
    let mut session = spawn_core(root.path()).await;

    let snapshot = session.request("player_snapshot", None).await;
    assert_eq!(snapshot["isPlaying"], false);

    let tracks: Vec<Song> = (0..8)
        .map(|index| fixture_song(&format!("track-{index}"), 10_000))
        .collect();
    let queued = session
        .request(
            "player_play_tracks",
            Some(json!({ "request": { "tracks": tracks, "shuffle": false } })),
        )
        .await;
    assert!(queued["queue"].as_array().expect("queue").len() >= 8);
    let _ = session.request("player_play", None).await;

    let last_seek = 4_800_u64;
    for index in 0..50 {
        let position = 200 + index as u64 * 90;
        session
            .request("player_seek", Some(json!({ "positionMs": position })))
            .await;
    }
    session
        .request("player_seek", Some(json!({ "positionMs": last_seek })))
        .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let settled = session.request("player_snapshot", None).await;
    let position = settled["positionMs"].as_u64().expect("position");
    assert!(
        position.abs_diff(last_seek) <= 250,
        "seek storm settle {position} vs {last_seek}"
    );
    assert_revisions_monotonic(&session.snapshot_revisions);

    let before_next = current_track_id(&settled);
    session
        .request("player_seek", Some(json!({ "positionMs": 7_500 })))
        .await;
    let after_next = session.request("player_next", None).await;
    let next_id = current_track_id(&after_next);
    assert_ne!(next_id, before_next, "next must change the current track");
    assert!(
        !(next_id == before_next && after_next["positionMs"].as_u64().unwrap_or(0) >= 7_000),
        "old session seek must not land on the previous track after next"
    );

    let mut model = queue_entry_ids(&after_next);
    assert!(model.len() >= 2, "need queue entry ids for mutation storm");
    for index in 0..100 {
        match index % 3 {
            0 if model.len() >= 2 => {
                let entry_id = model[model.len() - 1].clone();
                session
                    .request(
                        "player_reorder_queue_entry",
                        Some(json!({ "entryId": entry_id, "targetIndex": 0 })),
                    )
                    .await;
                if let Some(pos) = model.iter().position(|id| id == &entry_id) {
                    let moved = model.remove(pos);
                    model.insert(0, moved);
                }
            }
            1 if model.len() > 2 => {
                let entry_id = model[model.len() - 1].clone();
                session
                    .request(
                        "player_remove_queue_entry",
                        Some(json!({ "entryId": entry_id })),
                    )
                    .await;
                model.retain(|id| id != &entry_id);
            }
            _ => {
                let entry_id = model[index % model.len()].clone();
                session
                    .request(
                        "player_play_queue_entry",
                        Some(json!({ "entryId": entry_id })),
                    )
                    .await;
            }
        }
    }
    let mutated = session.request("player_snapshot", None).await;
    let live = queue_entry_ids(&mutated);
    let unique = live
        .iter()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(unique.len(), live.len(), "entry ids stay unique");
    assert_eq!(live, model, "mutation storm matches serial expectation");
    session.shutdown().await;

    let mut session = spawn_core(root.path()).await;
    let restored = session.request("player_snapshot", None).await;
    assert_eq!(restored["isPlaying"], false);
    let restored_ids: Vec<String> = restored["queue"]
        .as_array()
        .expect("restored queue")
        .iter()
        .filter_map(|track| {
            track
                .get("id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .collect();
    let unique = restored_ids
        .iter()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(unique.len(), restored_ids.len());
    assert!(!restored_ids.is_empty());
    session.shutdown().await;
}

#[tokio::test]
async fn kill_core_during_playback_restores_queue_without_duplicates() {
    let root = tempfile::tempdir().expect("kill root");
    let mut session = spawn_core(root.path()).await;
    let tracks = vec![
        fixture_song("keep-a", 8_000),
        fixture_song("keep-b", 8_000),
        fixture_song("keep-c", 8_000),
    ];
    session
        .request(
            "player_play_tracks",
            Some(json!({ "request": { "tracks": tracks, "shuffle": false } })),
        )
        .await;
    session
        .request("player_seek", Some(json!({ "positionMs": 1_200 })))
        .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    session.child.start_kill().expect("kill core");
    drop(session.transport);
    let _ = session.child.wait().await;

    let mut session = spawn_core(root.path()).await;
    let restored = session.request("player_snapshot", None).await;
    assert_eq!(restored["isPlaying"], false);
    let ids: Vec<&str> = restored["queue"]
        .as_array()
        .expect("queue")
        .iter()
        .filter_map(|track| track.get("id").and_then(Value::as_str))
        .collect();
    assert_eq!(ids, ["keep-a", "keep-b", "keep-c"]);
    let unique = ids
        .iter()
        .copied()
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(unique.len(), ids.len());
    session.shutdown().await;
}

#[tokio::test]
async fn graceful_shutdown_keeps_enabled_example_plugin() {
    let root = tempfile::tempdir().expect("plugin persist root");
    let sakura = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/plugins/style-sakura");
    assert!(
        sakura.join("manifest.json").is_file(),
        "missing example plugin at {}",
        sakura.display()
    );

    let mut session = spawn_core(root.path()).await;
    session
        .request(
            "plugin_set_developer_mode",
            Some(json!({ "enabled": true })),
        )
        .await;
    let installed = session
        .request(
            "plugin_install_unpacked",
            Some(json!({
                "request": {
                    "path": sakura,
                    "enable": true,
                    "grant": []
                }
            })),
        )
        .await;
    assert_eq!(installed["id"], "dev.yaqmc.example.sakura");
    assert_eq!(installed["enabled"], true);
    session.shutdown().await;

    let recovered = yaqmc_core::plugin::ExtensionHost::open(root.path().join("data/plugins"))
        .expect("reopen plugin host after graceful shutdown");
    assert!(
        !recovered.safe_mode(),
        "graceful Shutdown must not enter crash-loop safe mode"
    );
    let record = recovered
        .list()
        .into_iter()
        .find(|item| item.id == "dev.yaqmc.example.sakura")
        .expect("sakura remains installed");
    assert!(record.enabled, "enabled plugin must survive graceful quit");
    assert_eq!(record.status, yaqmc_core::plugin::PluginStatus::Active);
}

#[test]
fn cargo_enables_the_test_provider_feature_for_the_harness() {
    let manifest = include_str!("../Cargo.toml");
    assert!(manifest.contains("test-provider = [\"test-support\"]"));
    assert!(manifest.contains("name = \"protocol_e2e\""));
}
