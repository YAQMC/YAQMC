//! Plugin-owned playlist documents. No platform-account writes or media URLs.
use super::*;
use serde_json::{json, Value};

const MAX_DOCUMENT: usize = 256 * 1024;
const MAX_STORE: u64 = 2 * 1024 * 1024;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Track {
    provider_id: String,
    track_id: String,
    title: String,
    #[serde(default)]
    artists: Vec<String>,
    #[serde(default)]
    album: String,
    #[serde(default)]
    duration_ms: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Playlist {
    id: String,
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    tracks: Vec<Track>,
}
fn text(value: &str, limit: usize, required: bool) -> bool {
    (!required || !value.trim().is_empty())
        && value.chars().count() <= limit
        && !value.chars().any(char::is_control)
}
fn valid(p: &Playlist) -> bool {
    let mut seen = HashSet::new();
    text(&p.id, 64, true)
        && text(&p.name, 120, true)
        && text(&p.description, 2048, false)
        && p.tracks.len() <= 2000
        && p.tracks.iter().all(|t| {
            text(&t.provider_id, 160, true)
                && text(&t.track_id, 256, true)
                && text(&t.title, 256, true)
                && text(&t.album, 256, false)
                && t.artists.len() <= 8
                && t.artists.iter().all(|a| text(a, 120, true))
                && t.duration_ms <= 86_400_000
                && seen.insert((&t.provider_id, &t.track_id))
        })
        && serde_json::to_vec(p).is_ok_and(|b| b.len() <= MAX_DOCUMENT)
}
impl ExtensionHost {
    pub(crate) fn playlists_call(
        &self,
        plugin_id: &str,
        method: &str,
        payload: &Value,
    ) -> Result<Value, String> {
        let fail = || "playlists.invalid-document".to_owned();
        if serde_json::to_vec(payload).map_or(true, |b| b.len() > 512 * 1024) {
            return Err(fail());
        }
        // Serialize the entire read/modify/atomic-write transaction with host data mutations.
        let _guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let path = self.root.join(format!("{plugin_id}.playlists.json"));
        let mut list: Vec<Playlist> = match fs::metadata(&path) {
            Ok(meta) if meta.len() <= MAX_STORE => {
                serde_json::from_slice(&fs::read(&path).map_err(|_| fail())?).map_err(|_| fail())?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            _ => return Err(fail()),
        };
        if list.len() > 100 || !list.iter().all(valid) {
            return Err(fail());
        }
        if method == "playlists.list" {
            return Ok(json!(list.iter().map(|p| json!({"id":p.id,"name":p.name,"description":p.description,"trackCount":p.tracks.len()})).collect::<Vec<_>>()));
        }
        let id = payload["id"].as_str().unwrap_or("");
        let index = list.iter().position(|p| p.id == id);
        if method == "playlists.get" || method == "playlists.export" {
            let p = index.map(|i| &list[i]).ok_or("playlists.not-found")?;
            if method == "playlists.get" {
                return Ok(json!(p));
            }
            return Ok(
                json!({"format":"yaqmc.playlist","version":1,"playlist":{"name":p.name,"description":p.description,"tracks":p.tracks}}),
            );
        }
        let response = match method {
            "playlists.remove" => {
                list.remove(index.ok_or("playlists.not-found")?);
                json!({"ok":true})
            }
            "playlists.create" | "playlists.import" | "playlists.update" => {
                let mut input = if method == "playlists.import" {
                    let doc = &payload["document"];
                    if doc["format"] != "yaqmc.playlist"
                        || doc["version"] != 1
                        || !doc.as_object().is_some_and(|o| {
                            o.keys()
                                .all(|k| ["format", "version", "playlist"].contains(&k.as_str()))
                        })
                    {
                        return Err(fail());
                    }
                    doc["playlist"].clone()
                } else {
                    payload.clone()
                };
                if !input.is_object() {
                    return Err(fail());
                }
                if method != "playlists.update" {
                    if list.len() >= 100 || input.get("id").is_some() {
                        return Err("playlists.limit-or-invalid-id".into());
                    }
                    input["id"] = json!(format!("{:032x}", rand::random::<u128>()));
                    input
                        .as_object_mut()
                        .unwrap()
                        .entry("description")
                        .or_insert(json!(""));
                    input
                        .as_object_mut()
                        .unwrap()
                        .entry("tracks")
                        .or_insert(json!([]));
                } else {
                    let previous = &list[index.ok_or("playlists.not-found")?];
                    for (key, value) in [
                        ("name", json!(previous.name)),
                        ("description", json!(previous.description)),
                        ("tracks", json!(previous.tracks)),
                    ] {
                        input.as_object_mut().unwrap().entry(key).or_insert(value);
                    }
                }
                let playlist: Playlist = serde_json::from_value(input).map_err(|_| fail())?;
                if !valid(&playlist) {
                    return Err(fail());
                }
                let result = json!(playlist);
                if method == "playlists.update" {
                    list[index.unwrap()] = playlist;
                } else {
                    list.push(playlist);
                }
                result
            }
            _ => return Err("playlists.unknown-method".into()),
        };
        let encoded = serde_json::to_vec(&list).map_err(|_| fail())?;
        if encoded.len() as u64 > MAX_STORE {
            return Err("playlists.quota".into());
        }
        updates::atomic_bytes(&path, &encoded).map_err(|_| "playlists.save-failed".to_owned())?;
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn documents_are_persistent_isolated_and_bad_updates_preserve_data() {
        let root = tempfile::tempdir().unwrap();
        let host = ExtensionHost::open(root.path().into()).unwrap();
        let created = host.playlists_call("dev.a", "playlists.create", &json!({"name":"My songs","tracks":[{"providerId":"qqmusic","trackId":"1","title":"Song"}]})).unwrap();
        let id = created["id"].as_str().unwrap();
        assert!(host
            .playlists_call("dev.b", "playlists.get", &json!({"id":id}))
            .is_err());
        assert!(host.playlists_call("dev.a", "playlists.update", &json!({"id":id,"tracks":[{"providerId":"qqmusic","trackId":"1","title":"bad","url":"https://evil.invalid"}]})).is_err());
        assert_eq!(
            host.playlists_call("dev.a", "playlists.get", &json!({"id":id}))
                .unwrap(),
            created
        );
        let doc = host
            .playlists_call("dev.a", "playlists.export", &json!({"id":id}))
            .unwrap();
        let copy = host
            .playlists_call("dev.a", "playlists.import", &json!({"document":doc}))
            .unwrap();
        assert_ne!(copy["id"], created["id"]);
        drop(host);
        let host = ExtensionHost::open(root.path().into()).unwrap();
        assert_eq!(
            host.playlists_call("dev.a", "playlists.list", &Value::Null)
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            2
        );
        host.playlists_call("dev.a", "playlists.remove", &json!({"id":id}))
            .unwrap();
        assert!(host
            .playlists_call("dev.a", "playlists.get", &json!({"id":id}))
            .is_err());
    }

    #[test]
    fn concurrent_creates_do_not_lose_updates_and_duplicates_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        let host = Arc::new(ExtensionHost::open(root.path().into()).unwrap());
        let workers: Vec<_> = (0..12)
            .map(|n| {
                let host = host.clone();
                std::thread::spawn(move || {
                    host.playlists_call(
                        "dev.a",
                        "playlists.create",
                        &json!({"name":format!("{n}")}),
                    )
                    .unwrap()
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(
            host.playlists_call("dev.a", "playlists.list", &Value::Null)
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            12
        );
        let track = json!({"providerId":"qqmusic","trackId":"1","title":"Song"});
        assert!(host
            .playlists_call(
                "dev.a",
                "playlists.create",
                &json!({"name":"Bad","tracks":[track,track]})
            )
            .is_err());
        assert!(host
            .playlists_call(
                "dev.a",
                "playlists.create",
                &json!({"name":"x".repeat(121)})
            )
            .is_err());
        assert_eq!(
            host.playlists_call("dev.a", "playlists.list", &Value::Null)
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            12
        );
    }
}
