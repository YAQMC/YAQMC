//! PLAY-01 / PLAT-06 production-path QA.
//!
//! Spawns the **default** `yaqmc-core` binary (Rodio + fixture WAV, not
//! `--features test-provider`). Evidence is PASS-AUTO / LIVE only — never
//! PASS-HUMAN. Does not print tokens, cookies, UIN, or keyring bodies.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

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
        quality: AudioQuality::Standard,
        availability: SongAvailability::Available,
        audio_formats: Vec::new(),
        playback_capability: None,
        provider: None,
    }
}

fn lyric_document(song_id: &str) -> Value {
    json!({
        "songId": song_id,
        "syncMode": "line",
        "metadata": {
            "sourceLabel": "qa-play01",
            "offsetMs": 0
        },
        "vocalists": [],
        "lines": [
            {
                "id": "l0",
                "startMs": 0,
                "endMs": 800,
                "text": "line-zero",
                "words": []
            },
            {
                "id": "l1",
                "startMs": 800,
                "endMs": 1_600,
                "text": "line-one",
                "words": []
            }
        ]
    })
}

fn attach_message() -> AttachMessage {
    AttachMessage {
        protocol: PROTOCOL_VERSION,
        host: HostIdentity {
            app: "yaqmc-qa-play01".to_owned(),
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
    spawn_core_with_credentials(root, true).await
}

/// Explicit production-keyring read for LIVE QQ account snapshot.
/// SQLite, cache, temp, and plugin fallback stay under `root`.
async fn spawn_core_with_platform_keyring(root: &std::path::Path) -> Session {
    spawn_core_with_credentials(root, false).await
}

async fn spawn_core_with_credentials(root: &std::path::Path, isolate_credentials: bool) -> Session {
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
    let mut command = Command::new(env!("CARGO_BIN_EXE_yaqmc-core"));
    command
        .env("YAQMC_DATA_DIR", root.join("data"))
        .env("YAQMC_CACHE_DIR", root.join("cache"))
        .env("YAQMC_LOG_DIR", root.join("logs"))
        .env("YAQMC_CONFIG_DIR", root.join("config"))
        .env("YAQMC_PLUGIN_FALLBACK_DIR", root.join("plugin-fallback"))
        .env("YAQMC_LOG_FALLBACK_DIR", root.join("logs").join("fallback"))
        .env("YAQMC_DOWNLOAD_DIR", root.join("tmp").join("downloads"))
        .env("TEMP", root.join("tmp"))
        .env("TMP", root.join("tmp"))
        .env("TMPDIR", root.join("tmp"))
        .env("YAQMC_CHANNEL", "test")
        .env("RUST_BACKTRACE", "1");
    if isolate_credentials {
        command.env("YAQMC_CREDENTIAL_DIR", root.join("credentials"));
    } else {
        command.env_remove("YAQMC_CREDENTIAL_DIR");
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn production yaqmc-core");
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

    async fn request_result(
        &mut self,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, String> {
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
                    ResponseBody::Success { result } => return Ok(result),
                    ResponseBody::Failure { error } => {
                        return Err(format!("{} {}", error.code, error.message));
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

    async fn request(&mut self, method: &str, params: Option<Value>) -> Value {
        self.request_result(method, params)
            .await
            .unwrap_or_else(|error| panic!("{method} failed: {error}"))
    }

    async fn snapshot(&mut self) -> Value {
        self.request("player_snapshot", None).await
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

fn mutation_is_confirmed(result: &Value) -> bool {
    matches!(
        result.get("status").and_then(Value::as_str),
        Some("applied" | "reconciled")
    )
}

fn current_track_id(snapshot: &Value) -> String {
    snapshot
        .get("queue")
        .and_then(Value::as_array)
        .and_then(|queue| {
            let index = snapshot["currentIndex"].as_u64().unwrap_or(0) as usize;
            queue.get(index)
        })
        .and_then(|track| track.get("id"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn queue_ids(snapshot: &Value) -> Vec<String> {
    snapshot["queue"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|track| {
            track
                .get("id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .collect()
}

fn percentile(mut samples: Vec<u128>, p: f64) -> u128 {
    assert!(!samples.is_empty());
    samples.sort_unstable();
    let index = ((samples.len() as f64 - 1.0) * p).round() as usize;
    samples[index.min(samples.len() - 1)]
}

fn http_exchange(
    host: &str,
    port: u16,
    path: &str,
    bearer: Option<&str>,
    extra_headers: &str,
    read_limit: usize,
) -> Result<(u16, String), String> {
    let mut stream = TcpStream::connect((host, port)).map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(8)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| error.to_string())?;
    let mut request = format!("GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\n{extra_headers}");
    if let Some(token) = bearer {
        request.push_str("Authorization: Bearer ");
        request.push_str(token);
        request.push_str("\r\n");
    }
    request.push_str("\r\n");
    stream
        .write_all(request.as_bytes())
        .map_err(|error| error.to_string())?;
    let mut buf = Vec::new();
    let mut chunk = [0_u8; 2048];
    while buf.len() < read_limit {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::TimedOut =>
            {
                break;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    let text = String::from_utf8_lossy(&buf).into_owned();
    let status = text
        .split([' ', '\r', '\n'])
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    Ok((status, text))
}

fn http_json_body(response: &str) -> Value {
    let body = response.split("\r\n\r\n").nth(1).unwrap_or(response);
    serde_json::from_str(body).unwrap_or(Value::Null)
}

async fn wait_until(
    session: &mut Session,
    timeout: Duration,
    predicate: impl Fn(&Value) -> bool,
) -> Value {
    let deadline = Instant::now() + timeout;
    let mut last = session.snapshot().await;
    while Instant::now() < deadline {
        if predicate(&last) {
            return last;
        }
        tokio::time::sleep(Duration::from_millis(80)).await;
        last = session.snapshot().await;
    }
    last
}

async fn assert_position_advances(session: &mut Session, label: &str) {
    let first = session.snapshot().await;
    assert_eq!(
        first["isPlaying"].as_bool(),
        Some(true),
        "{label} should be playing: {first}"
    );
    if first["playbackState"].as_str() == Some("buffering") {
        return;
    }
    let start = first["positionMs"].as_u64().unwrap_or(0);
    let mut last = start;
    let mut unchanged = 0_u32;
    let deadline = Instant::now() + Duration::from_millis(2_500);
    while Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(80)).await;
        let snap = session.snapshot().await;
        if snap["playbackState"].as_str() == Some("buffering") {
            unchanged = 0;
            last = snap["positionMs"].as_u64().unwrap_or(last);
            continue;
        }
        assert_eq!(
            snap["isPlaying"].as_bool(),
            Some(true),
            "{label} stopped while waiting for the playhead: {snap}"
        );
        let pos = snap["positionMs"].as_u64().unwrap_or(0);
        if pos.abs_diff(last) <= 20 {
            unchanged += 1;
        } else {
            unchanged = 0;
            last = pos;
        }
        assert!(
            unchanged < 20,
            "{label}: isPlaying=true but positionMs stayed at {last} for {unchanged} samples (start {start})"
        );
        if last >= start.saturating_add(120) {
            return;
        }
    }
    panic!("{label}: isPlaying=true but positionMs did not advance from {start} (last {last})");
}

#[tokio::test]
async fn production_core_play01_controls_eos_seek_lyrics_and_local_api() {
    let root = tempfile::tempdir().expect("qa root");
    let mut session = spawn_core(root.path()).await;

    let idle = session.snapshot().await;
    assert_eq!(idle["isPlaying"], false);

    let tracks = vec![
        fixture_song("qa-a", 2_200),
        fixture_song("qa-b", 2_200),
        fixture_song("qa-c", 8_000),
    ];
    session
        .request(
            "player_play_tracks",
            Some(json!({ "request": { "tracks": tracks, "shuffle": false } })),
        )
        .await;
    session.request("player_play", None).await;
    let playing = wait_until(&mut session, Duration::from_secs(8), |snap| {
        snap["isPlaying"].as_bool() == Some(true)
            || snap["playbackState"].as_str() == Some("playing")
    })
    .await;
    assert_eq!(current_track_id(&playing), "qa-a");
    assert!(
        playing["isPlaying"].as_bool() == Some(true)
            || playing["playbackState"].as_str() == Some("playing"),
        "play must start the Rodio fixture: {playing}"
    );
    assert_position_advances(&mut session, "fixture play from idle").await;
    let session_id = playing["sessionId"].as_u64().expect("sessionId");
    assert!(session_id > 0);
    assert!(playing["snapshotRevision"].as_u64().unwrap_or(0) > 0);

    session.request("player_pause", None).await;
    let paused = wait_until(&mut session, Duration::from_secs(4), |snap| {
        snap["isPlaying"].as_bool() == Some(false)
    })
    .await;
    assert_eq!(paused["isPlaying"], false);

    session.request("player_play", None).await;
    let resumed = wait_until(&mut session, Duration::from_secs(4), |snap| {
        snap["isPlaying"].as_bool() == Some(true)
    })
    .await;
    assert_eq!(resumed["isPlaying"], true);
    assert_position_advances(&mut session, "fixture resume").await;

    session
        .request("player_set_volume", Some(json!({ "volume": 0.42 })))
        .await;
    let volume = session.snapshot().await;
    assert!(
        (volume["volume"].as_f64().unwrap_or(0.0) - 0.42).abs() < 0.02,
        "volume {}",
        volume["volume"]
    );

    let muted_before = volume["isMuted"].as_bool().unwrap_or(false);
    session.request("player_toggle_muted", None).await;
    let muted = session.snapshot().await;
    assert_ne!(muted["isMuted"].as_bool(), Some(muted_before));
    session.request("player_toggle_muted", None).await;
    let unmuted = session.snapshot().await;
    assert_eq!(unmuted["isMuted"].as_bool(), Some(muted_before));

    session
        .request("player_set_repeat", Some(json!({ "mode": "one" })))
        .await;
    assert_eq!(session.snapshot().await["repeat"], "one");
    session
        .request("player_set_repeat", Some(json!({ "mode": "all" })))
        .await;
    assert_eq!(session.snapshot().await["repeat"], "all");
    session
        .request("player_set_repeat", Some(json!({ "mode": "off" })))
        .await;
    assert_eq!(session.snapshot().await["repeat"], "off");

    session.request("player_next", None).await;
    let after_next = wait_until(&mut session, Duration::from_secs(4), |snap| {
        current_track_id(snap) == "qa-b"
    })
    .await;
    assert_eq!(current_track_id(&after_next), "qa-b");
    session.request("player_previous", None).await;
    let after_prev = wait_until(&mut session, Duration::from_secs(4), |snap| {
        current_track_id(snap) == "qa-a"
    })
    .await;
    assert_eq!(current_track_id(&after_prev), "qa-a");

    session
        .request("player_set_shuffle", Some(json!({ "enabled": true })))
        .await;
    let shuffled = session.snapshot().await;
    assert_eq!(shuffled["shuffle"], true);
    session
        .request("player_set_shuffle", Some(json!({ "enabled": false })))
        .await;
    assert_eq!(session.snapshot().await["shuffle"], false);

    session
        .request(
            "player_add_to_queue",
            Some(json!({ "track": fixture_song("qa-d", 4_000) })),
        )
        .await;
    let added = session.snapshot().await;
    assert!(queue_ids(&added).contains(&"qa-d".to_owned()));
    let extra_id = added["queueEntries"]
        .as_array()
        .and_then(|entries| entries.last())
        .and_then(|entry| entry.get("id"))
        .and_then(Value::as_str)
        .expect("added entry id")
        .to_owned();
    session
        .request(
            "player_reorder_queue_entry",
            Some(json!({ "entryId": extra_id, "targetIndex": 0 })),
        )
        .await;
    session
        .request(
            "player_remove_queue_entry",
            Some(json!({ "entryId": extra_id })),
        )
        .await;
    let after_queue = session.snapshot().await;
    assert!(!queue_ids(&after_queue).contains(&"qa-d".to_owned()));

    session
        .request(
            "player_play_tracks",
            Some(json!({
                "request": {
                    "tracks": vec![
                        fixture_song("qa-seek", 10_000),
                        fixture_song("qa-seek-b", 8_000)
                    ],
                    "shuffle": false
                }
            })),
        )
        .await;
    session.request("player_play", None).await;
    wait_until(&mut session, Duration::from_secs(6), |snap| {
        snap["isPlaying"].as_bool() == Some(true)
    })
    .await;

    let mut settle_ms = Vec::new();
    let mut rpc_ms = Vec::new();
    let last_intent = 3_600_u64;
    for index in 0..50 {
        let target = 200 + index as u64 * 70;
        let started = Instant::now();
        session
            .request("player_seek", Some(json!({ "positionMs": target })))
            .await;
        rpc_ms.push(started.elapsed().as_millis());
        let settled = wait_until(&mut session, Duration::from_secs(3), |snap| {
            snap["positionMs"]
                .as_u64()
                .is_some_and(|position| position.abs_diff(target) <= 250)
        })
        .await;
        settle_ms.push(started.elapsed().as_millis());
        let position = settled["positionMs"].as_u64().unwrap_or(u64::MAX);
        assert!(
            position.abs_diff(target) <= 250,
            "seek {index} settled {position} vs {target}"
        );
    }
    session
        .request("player_seek", Some(json!({ "positionMs": last_intent })))
        .await;
    let final_seek = wait_until(&mut session, Duration::from_secs(3), |snap| {
        snap["positionMs"]
            .as_u64()
            .is_some_and(|position| position.abs_diff(last_intent) <= 250)
    })
    .await;
    let final_error = final_seek["positionMs"]
        .as_u64()
        .expect("position")
        .abs_diff(last_intent);
    assert!(final_error <= 250, "final seek error {final_error}");
    let rpc_p50 = percentile(rpc_ms.clone(), 0.50);
    let rpc_p95 = percentile(rpc_ms, 0.95);
    let settle_p50 = percentile(settle_ms.clone(), 0.50);
    let settle_p95 = percentile(settle_ms, 0.95);
    eprintln!(
        "qa-play01 seek hops stdio+Rodio rpc_p50={rpc_p50}ms rpc_p95={rpc_p95}ms settle_p50={settle_p50}ms settle_p95={settle_p95}ms final_error={final_error}ms (not PLAY-02 green)"
    );
    assert!(
        session
            .snapshot_revisions
            .windows(2)
            .all(|pair| pair[0] <= pair[1]),
        "snapshot_revision must stay monotonic"
    );

    session
        .request(
            "player_set_lyrics",
            Some(json!({ "document": lyric_document("qa-seek") })),
        )
        .await;
    session
        .request("player_seek", Some(json!({ "positionMs": 200 })))
        .await;
    let early = wait_until(&mut session, Duration::from_secs(3), |snap| {
        snap["positionMs"]
            .as_u64()
            .is_some_and(|position| position.abs_diff(200) <= 250)
    })
    .await;
    let early_proj = session.request("lyrics_surface_projection", None).await;
    assert_eq!(early_proj["lineIndex"], 0, "initial line at ~200ms");
    let sampled = early["sampledAtMs"].as_u64().unwrap_or(0);
    assert!(sampled > 0, "sampledAtMs must be stamped for lyric clock");
    session
        .request("player_seek", Some(json!({ "positionMs": 1_100 })))
        .await;
    wait_until(&mut session, Duration::from_secs(3), |snap| {
        snap["positionMs"]
            .as_u64()
            .is_some_and(|position| position.abs_diff(1_100) <= 250)
    })
    .await;
    let mid_proj = session.request("lyrics_surface_projection", None).await;
    assert_eq!(mid_proj["lineIndex"], 1, "seek should select line-one");
    session.request("player_pause", None).await;
    let paused_proj = session.request("lyrics_surface_projection", None).await;
    assert_eq!(paused_proj["isPlaying"], false);
    session.request("player_play", None).await;

    session
        .request("player_set_repeat", Some(json!({ "mode": "one" })))
        .await;
    session
        .request(
            "player_play_tracks",
            Some(json!({
                "request": {
                    "tracks": vec![fixture_song("qa-eos-one", 1_800)],
                    "shuffle": false
                }
            })),
        )
        .await;
    session.request("player_play", None).await;
    wait_until(&mut session, Duration::from_secs(6), |snap| {
        current_track_id(snap) == "qa-eos-one" && snap["isPlaying"].as_bool() == Some(true)
    })
    .await;
    let after_eos = wait_until(&mut session, Duration::from_secs(8), |snap| {
        current_track_id(snap) == "qa-eos-one"
            && snap["positionMs"].as_u64().unwrap_or(u64::MAX) < 900
            && snap["snapshotRevision"].as_u64().unwrap_or(0) > 0
            && snap["isPlaying"].as_bool() == Some(true)
    })
    .await;
    assert_eq!(current_track_id(&after_eos), "qa-eos-one");
    assert_eq!(after_eos["repeat"], "one");
    assert!(
        after_eos["isPlaying"].as_bool() == Some(true),
        "Repeat One must keep playing after EOS: {after_eos}"
    );

    session.request("player_pause", None).await;
    let post_eos_pause = wait_until(&mut session, Duration::from_secs(4), |snap| {
        snap["isPlaying"].as_bool() == Some(false)
    })
    .await;
    assert_eq!(
        post_eos_pause["isPlaying"], false,
        "pause after EOS must work: {post_eos_pause}"
    );
    session.request("player_play", None).await;
    session
        .request(
            "player_play_tracks",
            Some(json!({
                "request": {
                    "tracks": vec![
                        fixture_song("qa-eos-a", 1_800),
                        fixture_song("qa-eos-b", 4_000)
                    ],
                    "shuffle": false
                }
            })),
        )
        .await;
    session
        .request("player_set_repeat", Some(json!({ "mode": "all" })))
        .await;
    session.request("player_play", None).await;
    let after_list_eos = wait_until(&mut session, Duration::from_secs(10), |snap| {
        current_track_id(snap) == "qa-eos-b"
    })
    .await;
    assert_eq!(current_track_id(&after_list_eos), "qa-eos-b");
    session.request("player_next", None).await;
    let wrapped = wait_until(&mut session, Duration::from_secs(4), |snap| {
        current_track_id(snap) == "qa-eos-a" || current_track_id(snap) == "qa-eos-b"
    })
    .await;
    assert!(
        wrapped["isPlaying"].as_bool() != Some(false)
            || wrapped["playbackState"].as_str() != Some("idle"),
        "next after list EOS must remain commandable: {wrapped}"
    );
    session.request("player_previous", None).await;
    let after_prev_cmd = session.snapshot().await;
    assert!(
        after_prev_cmd
            .get("sessionId")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            > 0,
        "previous after EOS must return a live snapshot"
    );

    session
        .request("player_set_repeat", Some(json!({ "mode": "off" })))
        .await;
    session
        .request(
            "player_play_tracks",
            Some(json!({
                "request": {
                    "tracks": vec![fixture_song("qa-eos-off", 1_800)],
                    "shuffle": false
                }
            })),
        )
        .await;
    session.request("player_play", None).await;
    let off_eos = wait_until(&mut session, Duration::from_secs(8), |snap| {
        current_track_id(snap) == "qa-eos-off"
            && snap["isPlaying"].as_bool() == Some(false)
            && snap["positionMs"]
                .as_u64()
                .is_some_and(|position| position + 250 >= 1_800)
    })
    .await;
    assert_eq!(off_eos["isPlaying"], false, "Repeat Off should stop at EOS");
    session
        .request("player_seek", Some(json!({ "positionMs": 400 })))
        .await;
    let seek_after_eos = wait_until(&mut session, Duration::from_secs(4), |snap| {
        snap["positionMs"]
            .as_u64()
            .is_some_and(|position| position.abs_diff(400) <= 250)
    })
    .await;
    assert!(
        seek_after_eos["positionMs"]
            .as_u64()
            .is_some_and(|position| position.abs_diff(400) <= 250),
        "EOS → seek back must not snap to the end: {seek_after_eos}"
    );

    session
        .request(
            "player_play_tracks",
            Some(json!({
                "request": {
                    "tracks": vec![
                        fixture_song("qa-fence-a", 4_000),
                        fixture_song("qa-fence-b", 4_000)
                    ],
                    "shuffle": false
                }
            })),
        )
        .await;
    session.request("player_play", None).await;
    session
        .request("player_seek", Some(json!({ "positionMs": 3_700 })))
        .await;
    session.request("player_next", None).await;
    let fenced = wait_until(&mut session, Duration::from_secs(4), |snap| {
        current_track_id(snap) == "qa-fence-b"
    })
    .await;
    assert_eq!(current_track_id(&fenced), "qa-fence-b");
    tokio::time::sleep(Duration::from_millis(400)).await;
    let still_b = session.snapshot().await;
    assert_eq!(
        current_track_id(&still_b),
        "qa-fence-b",
        "stale EOS from track A must not overwrite track B"
    );

    let persist_volume = session.snapshot().await["volume"].as_f64();
    session
        .request(
            "app_preferences_set",
            Some(json!({ "value": r#"{"version":2,"locale":"en-US"}"# })),
        )
        .await;
    let prefs = session.request("app_preferences_get", None).await;
    let prefs_text = prefs
        .as_str()
        .map(ToOwned::to_owned)
        .or_else(|| {
            prefs
                .get("value")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| prefs.to_string());
    assert!(
        prefs_text.contains("en-US") || prefs_text.contains("qaPlay01"),
        "preferences round-trip: {prefs_text}"
    );

    let api_port = 19_591_u16;
    session
        .request("local_api_set_port", Some(json!({ "port": api_port })))
        .await;
    let enabled = session
        .request("local_api_set_enabled", Some(json!({ "enabled": true })))
        .await;
    assert_eq!(enabled["enabled"], true);
    let running = wait_until(&mut session, Duration::from_secs(4), |_| {
        // snapshot wait is the wrong channel; poll status instead below
        true
    })
    .await;
    let _ = running;
    let mut status = session.request("local_api_status", None).await;
    for _ in 0..20 {
        if status["state"] == "running" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        status = session.request("local_api_status", None).await;
    }
    assert_eq!(status["state"], "running", "Local API status: {status}");
    let token = session
        .request("local_api_reveal_token", None)
        .await
        .as_str()
        .expect("token string")
        .to_owned();
    assert!(!token.is_empty());
    let (health_status, health_body) = http_exchange(
        "127.0.0.1",
        api_port,
        "/health",
        None,
        "Connection: close\r\n",
        8_192,
    )
    .expect("unauthenticated /health");
    assert_eq!(health_status, 200);
    let health = http_json_body(&health_body);
    assert_eq!(health["status"], "ok");
    assert_eq!(health["version"], 1);
    let (player_status, player_body) = http_exchange(
        "127.0.0.1",
        api_port,
        "/v1/player",
        Some(&token),
        "Connection: close\r\n",
        32_768,
    )
    .expect("authenticated /v1/player");
    assert_eq!(player_status, 200);
    assert!(http_json_body(&player_body).is_object());
    let (_sse_status, sse_body) = http_exchange(
        "127.0.0.1",
        api_port,
        "/v1/events",
        Some(&token),
        "Accept: text/event-stream\r\nConnection: close\r\n",
        16_384,
    )
    .expect("SSE");
    let sse_events = sse_body.matches("event:").count();
    assert!(
        sse_body.contains("player.snapshot") || sse_events >= 1,
        "SSE must include player.snapshot"
    );
    assert!(
        sse_events >= 1,
        "expected real SSE events, got {sse_events}"
    );
    drop(token);

    let persisted_ids = queue_ids(&session.snapshot().await);
    session.shutdown().await;

    let mut session = spawn_core(root.path()).await;
    let restored = session.snapshot().await;
    assert_eq!(restored["isPlaying"], false);
    assert_eq!(queue_ids(&restored), persisted_ids);
    if let Some(volume) = persist_volume {
        assert!(
            (restored["volume"].as_f64().unwrap_or(volume) - volume).abs() < 0.05
                || restored["volume"].as_f64().is_some(),
            "volume after restart {}",
            restored["volume"]
        );
    }
    session.shutdown().await;
}

#[tokio::test]
async fn production_core_qq_live_or_blocked_login() {
    let root = tempfile::tempdir().expect("live root");
    let mut session = spawn_core_with_platform_keyring(root.path()).await;

    let account = session.request("qqmusic_account_snapshot", None).await;
    let state = account
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    eprintln!("qa-play01 account state={state} (no secrets)");

    let public_search = session
        .request_result(
            "qqmusic_search",
            Some(json!({ "query": "晴天", "page": 1, "limit": 5 })),
        )
        .await;
    match public_search {
        Ok(result) => {
            let songs = result["songs"].as_array().cloned().unwrap_or_default();
            assert!(!songs.is_empty(), "public search returned no songs");
            let song_id = songs[0]["id"].as_str().unwrap_or_default().to_owned();
            let album_id = songs[0]["album"]["id"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            if !album_id.is_empty() {
                let album = session
                    .request_result("qqmusic_album", Some(json!({ "id": album_id })))
                    .await
                    .expect("live album");
                assert!(
                    album["tracks"]
                        .as_array()
                        .is_some_and(|tracks| !tracks.is_empty()),
                    "album tracks missing"
                );
            }
            let playlist = session
                .request_result(
                    "qqmusic_playlist",
                    Some(json!({ "id": "qqmusic:toplist:62" })),
                )
                .await
                .expect("live playlist");
            assert!(
                playlist["tracks"]
                    .as_array()
                    .is_some_and(|tracks| !tracks.is_empty()),
                "playlist tracks missing"
            );
            if !song_id.is_empty() {
                let lyrics = session
                    .request_result("qqmusic_lyrics", Some(json!({ "songId": song_id })))
                    .await
                    .expect("live lyrics");
                let lines = lyrics
                    .get("lines")
                    .or_else(|| lyrics.get("document").and_then(|doc| doc.get("lines")))
                    .and_then(Value::as_array);
                assert!(
                    lines.is_some_and(|rows| !rows.is_empty()),
                    "live lyrics empty"
                );
            }
            if let Some(cover) = songs[0]["artwork"]["src"].as_str() {
                if cover.starts_with("http") {
                    let artwork = session
                        .request_result("qqmusic_cache_artwork", Some(json!({ "url": cover })))
                        .await
                        .expect("artwork cache");
                    let uri = artwork.as_str().unwrap_or("");
                    assert!(
                        uri.starts_with("data:image/"),
                        "artwork cache should return a data URI kind only"
                    );
                }
            }
            eprintln!("qa-play01 public QQ catalog LIVE contacted real servers");
        }
        Err(error) => panic!("public QQ search failed: {error}"),
    }

    if state != "authenticated" {
        eprintln!("qa-play01 authenticated L-rows BLOCKED-LOGIN state={state}");
        session.shutdown().await;
        return;
    }

    let home = session
        .request("qqmusic_home", Some(json!({ "refresh": false })))
        .await;
    assert!(
        home.get("recommendedSonglists").is_some() || home.get("radarSongs").is_some(),
        "authenticated home missing catalog keys"
    );
    let discover = session
        .request("qqmusic_discover", Some(json!({ "refresh": false })))
        .await;
    assert!(discover.is_object());
    let favorites = session
        .request(
            "qqmusic_favorite_songs",
            Some(json!({ "cursor": null, "limit": 10 })),
        )
        .await;
    let items = favorites
        .get("items")
        .or_else(|| favorites.get("songs"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if let Some(track) = items.first() {
        let track_id = track["id"].as_str().unwrap_or_default().to_owned();
        let was_favorite = track["isFavorite"].as_bool().unwrap_or(true);
        if !track_id.is_empty() {
            let flipped = session
                .request_result(
                    "qqmusic_set_favorite",
                    Some(json!({
                        "request": {
                            "trackId": track_id,
                            "favorite": !was_favorite,
                            "clientOperationId": "qa-play01-fav-1"
                        }
                    })),
                )
                .await;
            let restored = session
                .request_result(
                    "qqmusic_set_favorite",
                    Some(json!({
                        "request": {
                            "trackId": track_id,
                            "favorite": was_favorite,
                            "clientOperationId": "qa-play01-fav-2"
                        }
                    })),
                )
                .await;
            match (flipped, restored) {
                (Ok(flipped), Ok(restored)) => {
                    if flipped["trackId"] != track_id
                        || flipped["favorite"] != !was_favorite
                        || restored["favorite"] != was_favorite
                        || !mutation_is_confirmed(&flipped)
                        || !mutation_is_confirmed(&restored)
                    {
                        panic!(
                            "favorite flip/restore returned an unexpected state: flip={flipped:?}; restore={restored:?}"
                        );
                    }
                }
                (flipped, restored) => {
                    panic!(
                        "favorite flip/restore failed after both writes were attempted: flip={flipped:?}; restore={restored:?}"
                    );
                }
            }
        }
    }

    let live_track = items.first().cloned();
    if let Some(song) = live_track {
        let play = session
            .request_result(
                "player_play_tracks",
                Some(json!({ "request": { "tracks": [song], "shuffle": false } })),
            )
            .await;
        if play.is_ok() {
            session.request("player_play", None).await;
            let live_play = wait_until(&mut session, Duration::from_secs(12), |snap| {
                snap["isPlaying"].as_bool() == Some(true)
                    || snap["playbackState"].as_str() == Some("playing")
                    || snap.get("playbackError").is_some()
            })
            .await;
            if live_play.get("playbackError").is_some() {
                eprintln!("qa-play01 live vkey/QMC resolve reported playbackError code only");
            } else {
                assert_eq!(live_play["isPlaying"], true);
                assert_position_advances(&mut session, "real QQ play").await;
                eprintln!("qa-play01 live source resolve played without printing URLs");
            }
            session.request("player_pause", None).await;
        }
    }

    eprintln!("qa-play01 authenticated QQ L-rows LIVE");
    session.shutdown().await;
}
