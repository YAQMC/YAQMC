//! Read-only Provider file capabilities. Native hosts retain paths/SAF URIs;
//! Core brokers bounded calls, metadata and media without exposing either.
use std::{
    collections::{HashMap, VecDeque},
    io::{self, BufReader, Read, Seek, SeekFrom},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use lofty::{
    config::{apply_global_options, GlobalOptions, ParseOptions},
    file::{AudioFile, TaggedFileExt},
    prelude::Accessor,
    probe::Probe,
};
use serde_json::{json, Value};
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;

pub const CHANNEL: &str = "host://provider-local-files";
pub const MAX_BYTES: usize = 512 * 1024;
const MAX_ENTRIES: u32 = 200;
const MAX_VISITED: usize = 100_000;

fn error(code: &str) -> String {
    format!("local-files.{code}")
}
fn token() -> String {
    format!("{:032x}", rand::random::<u128>())
}

struct Pending {
    request: Value,
    active: Arc<AtomicBool>,
    reply: mpsc::SyncSender<Result<Value, String>>,
}

#[derive(Clone)]
pub struct LocalFilesBridge {
    events: broadcast::Sender<Value>,
    pending: Arc<Mutex<HashMap<String, Pending>>>,
}

impl Default for LocalFilesBridge {
    fn default() -> Self {
        Self {
            events: broadcast::channel(64).0,
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl LocalFilesBridge {
    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.events.subscribe()
    }

    /// Only reachable through the Host-only protocol method. Authorization
    /// matches a still-pending Core request, not a guest-supplied identity.
    pub fn dispatch(&self, params: &Value) -> Result<Value, String> {
        match params["operation"].as_str() {
            Some("authorize") => {
                let pending = self.pending.lock().unwrap_or_else(|p| p.into_inner());
                let allowed = params["request"]["requestId"]
                    .as_str()
                    .and_then(|id| pending.get(id))
                    .is_some_and(|p| {
                        p.active.load(Ordering::Acquire) && p.request == params["request"]
                    });
                Ok(json!({"ok": allowed}))
            }
            Some("complete") => {
                let id = params["requestId"]
                    .as_str()
                    .ok_or_else(|| error("invalid-request"))?;
                let pending = self
                    .pending
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(id);
                if let Some(pending) = pending {
                    let result = if !pending.active.load(Ordering::Acquire) {
                        Err(error("revoked"))
                    } else if params["error"].is_string() {
                        // Never reflect native exception details or paths.
                        Err(error("native-operation-failed"))
                    } else {
                        Ok(params["value"].clone())
                    };
                    let _ = pending.reply.send(result);
                }
                Ok(Value::Null)
            }
            _ => Err(error("invalid-request")),
        }
    }

    fn call(
        &self,
        session: &LocalFileSession,
        method: &str,
        payload: Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, String> {
        session.check()?;
        let id = token();
        let request =
            json!({"requestId": id, "token": session.token, "method": method, "payload": payload});
        let (reply, receive) = mpsc::sync_channel(1);
        {
            let mut pending = self.pending.lock().unwrap_or_else(|p| p.into_inner());
            if pending.len() >= 32 {
                return Err(error("busy"));
            }
            pending.insert(
                id.clone(),
                Pending {
                    request: request.clone(),
                    active: session.active.clone(),
                    reply,
                },
            );
        }
        let result = (|| {
            self.events
                .send(json!({"requestId": id, "request": request}))
                .map_err(|_| error("host-unavailable"))?;
            let timeout = if method == "files.pickDirectory" {
                Duration::from_secs(90)
            } else {
                Duration::from_secs(15)
            };
            let started = Instant::now();
            loop {
                session.check()?;
                if cancellation.is_cancelled() {
                    return Err(error("cancelled"));
                }
                if started.elapsed() >= timeout {
                    return Err(error("timeout"));
                }
                match receive.recv_timeout(Duration::from_millis(25)) {
                    Ok(result) => {
                        session.check()?;
                        if cancellation.is_cancelled() {
                            return Err(error("cancelled"));
                        }
                        return result;
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => (),
                    Err(_) => return Err(error("host-unavailable")),
                }
            }
        })();
        self.pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&id);
        // Removing this request ID revokes only this operation. Late picker
        // results fail native authorization without invalidating existing roots.
        result
    }
}

struct Scan {
    root: String,
    tags: bool,
    directories: VecDeque<(String, u64)>,
    entries: VecDeque<Value>,
    visited: usize,
}

pub struct LocalFileSession {
    bridge: LocalFilesBridge,
    token: String,
    enabled: AtomicBool,
    active: Arc<AtomicBool>,
    roots: Mutex<Vec<String>>,
    scans: Mutex<HashMap<String, Scan>>,
}

impl LocalFileSession {
    pub fn new(bridge: LocalFilesBridge) -> Self {
        Self {
            bridge,
            token: token(),
            enabled: AtomicBool::new(false),
            active: Arc::new(AtomicBool::new(true)),
            roots: Mutex::new(Vec::new()),
            scans: Mutex::new(HashMap::new()),
        }
    }
    pub fn enable(&self) {
        self.enabled.store(true, Ordering::Release);
    }
    pub fn revoke(&self) {
        if self.active.swap(false, Ordering::AcqRel) {
            self.roots.lock().unwrap_or_else(|p| p.into_inner()).clear();
            self.scans.lock().unwrap_or_else(|p| p.into_inner()).clear();
            let _ = self.bridge.events.send(json!({"release": self.token}));
        }
    }
    fn check(&self) -> Result<(), String> {
        if self.enabled.load(Ordering::Acquire) && self.active.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err(error("revoked"))
        }
    }
    fn root(&self, root: &str) -> Result<(), String> {
        self.check()?;
        if self
            .roots
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .any(|r| r == root)
        {
            Ok(())
        } else {
            Err(error("invalid-root"))
        }
    }
    pub fn list_roots(&self) -> Result<Vec<String>, String> {
        self.check()?;
        Ok(self.roots.lock().unwrap_or_else(|p| p.into_inner()).clone())
    }
    pub fn request_root(
        &self,
        title: &str,
        cancellation: &CancellationToken,
    ) -> Result<Option<String>, String> {
        self.check()?;
        if title.chars().count() > 80 || title.chars().any(char::is_control) {
            return Err(error("invalid-title"));
        }
        if self.roots.lock().unwrap_or_else(|p| p.into_inner()).len() >= 16 {
            return Err(error("root-limit"));
        }
        let selected = self
            .bridge
            .call(self, "files.pickDirectory", json!({}), cancellation)?;
        if selected.is_null() {
            return Ok(None);
        }
        let root = selected["handle"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 128)
            .ok_or_else(|| error("invalid-selection"))?
            .to_owned();
        let mut roots = self.roots.lock().unwrap_or_else(|p| p.into_inner());
        self.check()?;
        if roots.len() >= 16 {
            return Err(error("root-limit"));
        }
        roots.push(root.clone());
        Ok(Some(root))
    }
    pub fn stat(
        &self,
        root: &str,
        relative: &str,
        cancellation: &CancellationToken,
    ) -> Result<Value, String> {
        self.root(root)?;
        validate_relative(relative)?;
        self.bridge.call(
            self,
            "files.stat",
            json!({"handle": root, "path": relative}),
            cancellation,
        )
    }
    pub fn read_chunk(
        &self,
        root: &str,
        relative: &str,
        offset: u64,
        length: u32,
        cancellation: &CancellationToken,
    ) -> Result<Vec<u8>, String> {
        self.root(root)?;
        validate_relative(relative)?;
        if !audio_file(relative) && !cover_file(relative) {
            return Err(error("unsupported-format"));
        }
        if length == 0 || length as usize > MAX_BYTES || offset > 9_007_199_254_740_991 {
            return Err(error("invalid-range"));
        }
        let result = self.bridge.call(self, "files.readFile", json!({"handle": root, "path": relative, "offset": offset, "length": length, "encoding": "base64"}), cancellation)?;
        let encoded = result["data"]
            .as_str()
            .filter(|s| s.len() <= MAX_BYTES * 2)
            .ok_or_else(|| error("invalid-response"))?;
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| error("invalid-response"))?;
        if bytes.len() > length as usize {
            return Err(error("invalid-response"));
        }
        Ok(bytes)
    }

    /// Bounded recursive traversal. Continuations are single-use session IDs,
    /// never absolute paths or caller-controlled traversal state.
    pub fn walk(
        &self,
        root: &str,
        cursor: &str,
        limit: u32,
        tags: bool,
        cancellation: &CancellationToken,
    ) -> Result<String, String> {
        self.root(root)?;
        if limit == 0 || limit > if tags { 20 } else { MAX_ENTRIES } {
            return Err(error("invalid-limit"));
        }
        let mut scan = if cursor.is_empty() {
            Scan {
                root: root.into(),
                tags,
                directories: VecDeque::from([(String::new(), 0)]),
                entries: VecDeque::new(),
                visited: 0,
            }
        } else {
            self.scans
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(cursor)
                .filter(|s| s.root == root && s.tags == tags)
                .ok_or_else(|| error("invalid-cursor"))?
        };
        let mut output = Vec::new();
        let mut budget = 1000;
        while output.len() < limit as usize && budget > 0 {
            self.check()?;
            if cancellation.is_cancelled() {
                return Err(error("cancelled"));
            }
            if let Some(entry) = scan.entries.pop_front() {
                budget -= 1;
                let relative = entry["relative"]
                    .as_str()
                    .ok_or_else(|| error("invalid-response"))?;
                if entry["type"] == "directory" {
                    if scan.directories.len() >= 4096 || relative.split('/').count() > 32 {
                        return Err(error("scan-limit"));
                    }
                    scan.directories.push_back((relative.to_owned(), 0));
                    if !tags {
                        output.push(entry);
                    }
                } else if audio_file(relative) || (!tags && cover_file(relative)) {
                    output.push(if tags {
                        self.metadata(root, entry, cancellation)
                    } else {
                        entry
                    });
                }
                continue;
            }
            let Some((directory, offset)) = scan.directories.pop_front() else {
                break;
            };
            let page = self.bridge.call(
                self,
                "files.list",
                json!({"handle": root, "path": directory, "cursor": offset, "limit": 200}),
                cancellation,
            )?;
            let entries = page["entries"]
                .as_array()
                .filter(|v| v.len() <= 200)
                .ok_or_else(|| error("invalid-response"))?;
            // Count filtered entries too: a directory of hidden files cannot bypass quotas.
            budget -= 1;
            let examined = page["scanned"].as_u64().unwrap_or(entries.len() as u64);
            if examined < entries.len() as u64 || examined > 1000 {
                return Err(error("invalid-response"));
            }
            scan.visited += examined as usize;
            if scan.visited > MAX_VISITED {
                return Err(error("scan-limit"));
            }
            if let Some(next) = page["nextCursor"].as_u64() {
                if next <= offset || next > 1_000_000 {
                    return Err(error("invalid-response"));
                }
                scan.directories.push_front((directory.clone(), next));
            }
            for entry in entries {
                let Some(name) = entry["name"].as_str() else {
                    continue;
                };
                if name.starts_with('.') || validate_relative(name).is_err() || name.contains('/') {
                    continue;
                }
                let relative = if directory.is_empty() {
                    name.to_owned()
                } else {
                    format!("{directory}/{name}")
                };
                if validate_relative(&relative).is_err() {
                    continue;
                }
                let mut item = entry.clone();
                item["relative"] = json!(relative);
                scan.entries.push_back(item);
            }
        }
        let next = if !scan.entries.is_empty() || !scan.directories.is_empty() {
            let mut scans = self.scans.lock().unwrap_or_else(|p| p.into_inner());
            if scans.len() >= 8 {
                return Err(error("cursor-limit"));
            }
            let id = token();
            scans.insert(id.clone(), scan);
            Some(id)
        } else {
            None
        };
        self.check()?;
        serde_json::to_string(&json!({"entries": output, "nextCursor": next}))
            .map_err(|_| error("invalid-response"))
    }

    fn metadata(&self, root: &str, mut entry: Value, cancellation: &CancellationToken) -> Value {
        let parse = || -> Result<Value, String> {
            let relative = entry["relative"]
                .as_str()
                .ok_or_else(|| error("invalid-response"))?;
            let size = entry["size"]
                .as_u64()
                .ok_or_else(|| error("unknown-size"))?;
            let reader = RemoteReader {
                session: self,
                root,
                relative,
                position: 0,
                size,
                remaining: 4 * 1024 * 1024,
                cancellation: cancellation.clone(),
            };
            // Lofty's options are thread-local. Bound each allocation and actual bytes read.
            apply_global_options(
                GlobalOptions::new()
                    .allocation_limit(1024 * 1024)
                    .use_custom_resolvers(false)
                    .preserve_format_specific_items(false),
            );
            let parsed = Probe::new(BufReader::with_capacity(32 * 1024, reader))
                .options(ParseOptions::new())
                .guess_file_type()
                .map_err(|_| error("metadata"))?
                .read()
                .map_err(|_| error("metadata"))?;
            let properties = parsed.properties();
            let mut metadata = json!({"durationMs": properties.duration().as_millis() as u64, "sampleRateHz": properties.sample_rate(), "bitDepth": properties.bit_depth(), "bitrateKbps": properties.audio_bitrate()});
            if let Some(tag) = parsed.primary_tag().or_else(|| parsed.first_tag()) {
                let bounded = |s: Option<std::borrow::Cow<'_, str>>| {
                    s.map(|s| {
                        s.chars()
                            .filter(|c| !c.is_control())
                            .take(512)
                            .collect::<String>()
                    })
                };
                metadata["title"] = json!(bounded(tag.title()));
                metadata["artist"] = json!(bounded(tag.artist()));
                metadata["album"] = json!(bounded(tag.album()));
                metadata["trackNumber"] = json!(tag.track());
                metadata["discNumber"] = json!(tag.disk());
                if let Some(picture) = tag.pictures().iter().find(|p| p.data().len() <= 64 * 1024) {
                    let mime = picture.mime_type().map(|m| m.as_str()).unwrap_or("");
                    if ["image/png", "image/jpeg", "image/webp"].contains(&mime) {
                        metadata["artworkDataUri"] = json!(format!(
                            "data:{mime};base64,{}",
                            STANDARD.encode(picture.data())
                        ));
                    }
                }
            }
            Ok(metadata)
        };
        match parse() {
            Ok(metadata) => entry["metadata"] = metadata,
            Err(_) => entry["metadataError"] = json!("unreadable-or-limit-exceeded"),
        }
        entry
    }
}

impl Drop for LocalFileSession {
    fn drop(&mut self) {
        self.revoke();
    }
}

pub fn audio_file(relative: &str) -> bool {
    relative.rsplit_once('.').is_some_and(|(_, ext)| {
        [
            "mp3", "flac", "wav", "aac", "m4a", "mp4", "ogg", "opus", "aiff", "aif", "ape", "wv",
        ]
        .contains(&ext.to_ascii_lowercase().as_str())
    })
}

fn cover_file(relative: &str) -> bool {
    relative.rsplit('/').next().is_some_and(|name| {
        [
            "cover.jpg",
            "cover.jpeg",
            "cover.png",
            "folder.jpg",
            "folder.png",
        ]
        .contains(&name.to_ascii_lowercase().as_str())
    })
}

pub fn validate_relative(relative: &str) -> Result<(), String> {
    if relative.len() > 2048
        || relative.is_empty()
        || relative.split('/').any(|s| {
            s.is_empty()
                || s == "."
                || s == ".."
                || s.starts_with('.')
                || s.ends_with(['.', ' '])
                || s.len() > 255
                || s.chars()
                    .any(|c| c.is_control() || "\\:<>\"|?*".contains(c))
        })
    {
        Err(error("invalid-path"))
    } else {
        Ok(())
    }
}

struct RemoteReader<'a> {
    session: &'a LocalFileSession,
    root: &'a str,
    relative: &'a str,
    position: u64,
    size: u64,
    remaining: usize,
    cancellation: CancellationToken,
}
impl Read for RemoteReader<'_> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if self.position >= self.size || output.is_empty() {
            return Ok(0);
        }
        let length = output
            .len()
            .min(MAX_BYTES)
            .min(usize::try_from(self.size - self.position).unwrap_or(usize::MAX));
        if length > self.remaining {
            return Err(io::Error::other("metadata byte limit"));
        }
        let bytes = self
            .session
            .read_chunk(
                self.root,
                self.relative,
                self.position,
                length as u32,
                &self.cancellation,
            )
            .map_err(io::Error::other)?;
        output[..bytes.len()].copy_from_slice(&bytes);
        self.position += bytes.len() as u64;
        self.remaining -= bytes.len();
        Ok(bytes.len())
    }
}
impl Seek for RemoteReader<'_> {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let position = match from {
            SeekFrom::Start(n) => n as i128,
            SeekFrom::End(n) => self.size as i128 + n as i128,
            SeekFrom::Current(n) => self.position as i128 + n as i128,
        };
        if position < 0 || position > self.size as i128 {
            return Err(io::Error::other("metadata seek limit"));
        }
        self.position = position as u64;
        Ok(self.position)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compressed_id3_frames_cannot_expand_outside_the_native_read_budget() {
        // A v2.3 APIC frame with compression set. Keep the payload harmless;
        // rejection must happen before decompression, independently of its size.
        let data = b"ID3\x03\0\0\0\0\0\x16APIC\0\0\0\x0c\0\x80\0\0\0\x80\x78\x9c\x03\0\0\0\0\x01";
        let failure = Probe::with_file_type(io::Cursor::new(data), lofty::file::FileType::Mpeg)
            .options(ParseOptions::new().read_properties(false))
            .read()
            .err()
            .expect("compressed ID3 must be refused before decompression");
        assert!(
            failure.to_string().contains("support is disabled"),
            "{failure}"
        );
    }

    fn harness(
        handler: impl Fn(&Value) -> Value + Send + Sync + 'static,
    ) -> (Arc<LocalFileSession>, tokio::task::JoinHandle<()>) {
        let bridge = LocalFilesBridge::default();
        let mut events = bridge.subscribe();
        let session = Arc::new(LocalFileSession::new(bridge.clone()));
        session.enable();
        let native = tokio::spawn(async move {
            while let Ok(event) = events.recv().await {
                if event["release"].is_string() {
                    continue;
                }
                let request = &event["request"];
                assert_eq!(
                    bridge
                        .dispatch(&json!({"operation": "authorize", "request": request}))
                        .unwrap()["ok"],
                    true
                );
                let mut forged = request.clone();
                forged["token"] = json!("other-plugin");
                assert_eq!(
                    bridge
                        .dispatch(&json!({"operation": "authorize", "request": forged}))
                        .unwrap()["ok"],
                    false
                );
                let value = handler(request);
                bridge.dispatch(&json!({"operation": "complete", "requestId": event["requestId"], "value": value})).unwrap();
                assert_eq!(
                    bridge
                        .dispatch(&json!({"operation": "authorize", "request": request}))
                        .unwrap()["ok"],
                    false
                );
            }
        });
        (session, native)
    }

    async fn choose(session: Arc<LocalFileSession>) -> String {
        tokio::task::spawn_blocking(move || {
            session
                .request_root("Choose audio", &CancellationToken::new())
                .unwrap()
                .unwrap()
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn native_responses_are_bound_to_live_calls_and_roots_are_session_scoped() {
        let (session, native) = harness(|request| match request["method"].as_str().unwrap() {
            "files.pickDirectory" => json!({"handle": "r1"}),
            "files.readFile" => json!({"data": "AAH/"}),
            _ => panic!("unexpected native request"),
        });
        let root = choose(session.clone()).await;
        assert_eq!(session.list_roots().unwrap(), vec![root.clone()]);
        let reader = session.clone();
        let bytes = tokio::task::spawn_blocking(move || {
            reader.read_chunk(&root, "song.flac", 0, 3, &CancellationToken::new())
        })
        .await
        .unwrap()
        .unwrap();
        assert_eq!(bytes, vec![0, 1, 255]);
        assert!(session
            .read_chunk("foreign-root", "song.flac", 0, 1, &CancellationToken::new())
            .is_err());
        session.revoke();
        assert!(session.list_roots().is_err());
        native.abort();
    }

    #[tokio::test]
    async fn recursive_walk_is_paginated_filters_hidden_and_non_audio_and_rejects_replayed_cursors()
    {
        let (session, native) = harness(|request| {
            if request["method"] == "files.pickDirectory" {
                return json!({"handle": "r1"});
            }
            let entries = if request["payload"]["path"] == "" {
                json!([{"name":"Albums","type":"directory"},{"name":".hidden","type":"directory"},{"name":"secret.txt","type":"file"}])
            } else {
                json!([{"name":"a.flac","type":"file","size":3},{"name":"b.wav","type":"file","size":4}])
            };
            json!({"entries":entries,"nextCursor":null})
        });
        let root = choose(session.clone()).await;
        let s = session.clone();
        let r = root.clone();
        let first: Value = serde_json::from_str(
            &tokio::task::spawn_blocking(move || {
                s.walk(&r, "", 1, false, &CancellationToken::new())
            })
            .await
            .unwrap()
            .unwrap(),
        )
        .unwrap();
        assert_eq!(first["entries"][0]["relative"], "Albums");
        let cursor = first["nextCursor"].as_str().unwrap().to_owned();
        let s = session.clone();
        let r = root.clone();
        let c = cursor.clone();
        let second: Value = serde_json::from_str(
            &tokio::task::spawn_blocking(move || {
                s.walk(&r, &c, 200, false, &CancellationToken::new())
            })
            .await
            .unwrap()
            .unwrap(),
        )
        .unwrap();
        assert_eq!(second["entries"].as_array().unwrap().len(), 2);
        assert!(second["nextCursor"].is_null());
        assert!(session
            .walk(&root, &cursor, 200, false, &CancellationToken::new())
            .is_err());
        native.abort();
    }

    #[tokio::test]
    async fn cancellation_revokes_only_the_pending_picker_and_preserves_existing_roots() {
        let bridge = LocalFilesBridge::default();
        let mut events = bridge.subscribe();
        let session = Arc::new(LocalFileSession::new(bridge.clone()));
        session.enable();
        session.roots.lock().unwrap().push("existing-root".into());
        let cancellation = CancellationToken::new();
        let cancel = cancellation.clone();
        let s = session.clone();
        let picker = tokio::task::spawn_blocking(move || s.request_root("Choose", &cancel));
        let event = events.recv().await.unwrap();
        cancellation.cancel();
        assert!(picker.await.unwrap().is_err());
        bridge.dispatch(&json!({"operation":"complete","requestId":event["requestId"],"value":{"handle":"late"}})).unwrap();
        assert_eq!(session.list_roots().unwrap(), vec!["existing-root"]);
        assert_eq!(
            bridge
                .dispatch(&json!({"operation":"authorize", "request": event["request"]}))
                .unwrap()["ok"],
            false
        );
    }

    #[tokio::test]
    async fn identical_calls_cannot_authorize_a_retired_request_id() {
        let bridge = LocalFilesBridge::default();
        let mut events = bridge.subscribe();
        let session = Arc::new(LocalFileSession::new(bridge.clone()));
        session.enable();
        let cancel = CancellationToken::new();
        let signal = cancel.clone();
        let s = session.clone();
        let first = tokio::task::spawn_blocking(move || s.request_root("Choose", &signal));
        let retired = events.recv().await.unwrap();
        cancel.cancel();
        assert!(first.await.unwrap().is_err());
        let s = session.clone();
        let second = tokio::task::spawn_blocking(move || {
            s.request_root("Choose", &CancellationToken::new())
        });
        let active = events.recv().await.unwrap();
        assert_ne!(retired["requestId"], active["requestId"]);
        assert_eq!(
            bridge
                .dispatch(&json!({"operation":"authorize","request":retired["request"]}))
                .unwrap()["ok"],
            false
        );
        assert_eq!(
            bridge
                .dispatch(&json!({"operation":"authorize","request":active["request"]}))
                .unwrap()["ok"],
            true
        );
        bridge
            .dispatch(&json!({"operation":"complete","requestId":active["requestId"],"value":null}))
            .unwrap();
        assert_eq!(second.await.unwrap().unwrap(), None);
    }

    #[test]
    fn paths_and_ranges_cannot_escape_or_bypass_audio_scope() {
        for value in [
            "",
            "/x",
            "../x",
            "a/../x",
            "a//x",
            "C:/x",
            "a\\x",
            ".hidden/song.mp3",
            "x\0.mp3",
        ] {
            assert!(validate_relative(value).is_err(), "{value:?}");
        }
        assert!(validate_relative("Albums/中文.flac").is_ok());
        assert!(audio_file("x.FLAC"));
        assert!(!audio_file("secret.txt"));
        let session = LocalFileSession::new(LocalFilesBridge::default());
        assert!(
            session.list_roots().is_err(),
            "ungranted capability is unavailable"
        );
    }

    #[tokio::test]
    async fn traversal_quota_counts_filtered_physical_entries() {
        let (session, native) = harness(|request| {
            if request["method"] == "files.pickDirectory" {
                return json!({"handle":"root"});
            }
            json!({"entries":[],"scanned":1000,"nextCursor":request["payload"]["cursor"].as_u64().unwrap()+1000})
        });
        let root = choose(session.clone()).await;
        let result = tokio::task::spawn_blocking(move || {
            session.walk(&root, "", 1, false, &CancellationToken::new())
        })
        .await
        .unwrap();
        assert_eq!(result, Err("local-files.scan-limit".into()));
        native.abort();
    }
}
