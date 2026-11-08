use super::{valid_sha256, ReleaseChannel, ReleaseInfo, UpdatePolicy};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{redirect::Policy, Url};
use ring::signature::{UnparsedPublicKey, ED25519};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path, time::Duration};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

pub const MAX_FEED_BYTES: u64 = 1024 * 1024;
const FEED_DOMAIN: &[u8] = b"YAQMC-PLUGIN-FEED-v1\0";
const RELEASE_DOMAIN: &[u8] = b"YAQMC-PLUGIN-RELEASE-v1\0";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrustedSource {
    pub id: String,
    pub plugin_id: String,
    pub name: String,
    pub repository: String,
    pub feed_url: String,
    pub key_id: String,
    pub public_key: String,
    pub download_origins: Vec<String>,
}

pub fn builtin_sources() -> Vec<TrustedSource> {
    // A malformed build-time trust file is a build/release error, never a reason
    // to fetch unsigned metadata. There are intentionally no production keys yet.
    serde_json::from_str(include_str!("sources.json")).expect("built-in plugin update sources")
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedEnvelope {
    pub key_id: String,
    pub payload: String,
    pub signature: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseRecord {
    pub plugin_id: String,
    pub version: String,
    #[serde(flatten)]
    pub release: ReleaseInfo,
    pub sha256: String,
    pub size: u64,
    pub url: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Feed {
    pub schema_version: u32,
    pub plugin_id: String,
    pub sequence: u64,
    pub expires_at_ms: u64,
    pub releases: Vec<SignedEnvelope>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableRelease {
    pub release_id: String,
    pub source_id: String,
    pub expires_at_ms: u64,
    #[serde(flatten)]
    pub record: ReleaseRecord,
}

fn verify<T: DeserializeOwned>(
    envelope: &SignedEnvelope,
    source: &TrustedSource,
    domain: &[u8],
) -> Result<T, String> {
    if envelope.key_id != source.key_id {
        return Err("update-signature-key-mismatch".into());
    }
    let key = STANDARD
        .decode(&source.public_key)
        .map_err(|_| "update-public-key-invalid")?;
    let payload = STANDARD
        .decode(&envelope.payload)
        .map_err(|_| "update-payload-invalid")?;
    let signature = STANDARD
        .decode(&envelope.signature)
        .map_err(|_| "update-signature-invalid")?;
    if key.len() != 32 || signature.len() != 64 || payload.len() as u64 > MAX_FEED_BYTES {
        return Err("update-signature-invalid".into());
    }
    let mut message = Vec::with_capacity(domain.len() + payload.len());
    message.extend_from_slice(domain);
    message.extend_from_slice(&payload);
    UnparsedPublicKey::new(&ED25519, &key)
        .verify(&message, &signature)
        .map_err(|_| "update-signature-invalid")?;
    serde_json::from_slice(&payload).map_err(|_| "update-payload-invalid".into())
}

pub fn verify_feed(
    bytes: &[u8],
    source: &TrustedSource,
    policy: &mut UpdatePolicy,
    now_ms: u64,
) -> Result<Vec<AvailableRelease>, String> {
    if bytes.len() as u64 > MAX_FEED_BYTES {
        return Err("update-feed-too-large".into());
    }
    let envelope: SignedEnvelope =
        serde_json::from_slice(bytes).map_err(|_| "update-feed-invalid")?;
    let feed: Feed = verify(&envelope, source, FEED_DOMAIN)?;
    let digest = format!("{:x}", Sha256::digest(envelope.payload.as_bytes()));
    if feed.schema_version != 1
        || feed.plugin_id != source.plugin_id
        || feed.sequence == 0
        || feed.sequence > 9_007_199_254_740_991
        || feed.releases.len() > 256
    {
        return Err("update-feed-invalid".into());
    }
    if feed.expires_at_ms > 9_007_199_254_740_991 {
        return Err("update-feed-invalid".into());
    }
    if feed.expires_at_ms <= now_ms {
        return Err("update-feed-expired".into());
    }
    if feed.sequence < policy.feed_sequence
        || (feed.sequence == policy.feed_sequence
            && !policy.feed_digest.is_empty()
            && policy.feed_digest != digest)
    {
        return Err("update-feed-replayed".into());
    }
    let mut seen = policy.releases_seen.clone();
    let previous_max = seen.keys().next_back().copied().unwrap_or_default();
    let mut releases = Vec::new();
    let mut in_feed = BTreeMap::new();
    for signed in &feed.releases {
        let record: ReleaseRecord = verify(signed, source, RELEASE_DOMAIN)?;
        if record.plugin_id != source.plugin_id
            || semver::Version::parse(&record.version).is_err()
            || !record.release.valid()
            || !valid_sha256(&record.sha256)
            || record.size == 0
            || record.size > crate::plugin::COMPONENT_MAX_COMPRESSED_BYTES
        {
            return Err("update-release-invalid".into());
        }
        validate_url(&record.url, &source.download_origins)?;
        let release_digest = format!("{:x}", Sha256::digest(signed.payload.as_bytes()));
        let seq = record.release.release_sequence;
        if in_feed.insert(seq, ()).is_some()
            || seen.get(&seq).is_some_and(|old| old != &release_digest)
            || (seq <= previous_max && !seen.contains_key(&seq))
        {
            return Err("update-release-equivocation".into());
        }
        seen.insert(seq, release_digest.clone());
        releases.push(AvailableRelease {
            release_id: release_digest,
            source_id: source.id.clone(),
            expires_at_ms: feed.expires_at_ms,
            record,
        });
    }
    policy.feed_sequence = feed.sequence;
    policy.feed_digest = digest;
    policy.releases_seen = seen;
    Ok(releases)
}

pub fn select_release(
    releases: &[AvailableRelease],
    channel: ReleaseChannel,
) -> Option<&AvailableRelease> {
    releases
        .iter()
        .filter(|r| r.record.release.channel == channel)
        .max_by(|a, b| {
            let a_version = semver::Version::parse(&a.record.version).expect("verified release");
            let b_version = semver::Version::parse(&b.record.version).expect("verified release");
            a_version.cmp_precedence(&b_version).then(
                a.record
                    .release
                    .release_sequence
                    .cmp(&b.record.release.release_sequence),
            )
        })
}

fn validate_url(value: &str, origins: &[String]) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "update-url-invalid")?;
    if value.len() > 4096
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || !origins.contains(&url.origin().ascii_serialization())
    {
        return Err("update-url-not-trusted".into());
    }
    Ok(url)
}

#[derive(Clone, Default)]
pub(crate) struct UpdateHttp {
    // Test routing is absent from production builds and cannot be deserialized.
    #[cfg(test)]
    endpoint: Option<String>,
}

impl UpdateHttp {
    #[cfg(test)]
    pub(crate) fn for_test(endpoint: String) -> Self {
        Self {
            endpoint: Some(endpoint),
        }
    }

    async fn response(&self, url: &str, origins: &[String]) -> Result<reqwest::Response, String> {
        let response = self.request(url, origins, &[]).await?;
        if !response.status().is_success() {
            return Err("update-http-failed".into());
        }
        Ok(response)
    }

    /// Follows at most three redirects, re-validating every hop against `origins`
    /// and the private-address filter. Returns the final response of any status.
    /// Only the caller's fixed headers are sent; never credentials or cookies.
    pub(crate) async fn request(
        &self,
        url: &str,
        origins: &[String],
        headers: &[(&str, &str)],
    ) -> Result<reqwest::Response, String> {
        let mut current = url.to_owned();
        for hop in 0..=3 {
            let url = validate_url(&current, origins)?;
            let (client, target) = self.client_target(&url).await?;
            let mut request = client
                .get(target)
                .header(reqwest::header::ACCEPT_ENCODING, "identity");
            for (name, value) in headers {
                request = request.header(*name, *value);
            }
            let response = request.send().await.map_err(|error| {
                if error.is_timeout() {
                    "update-download-timeout"
                } else {
                    "update-download-failed"
                }
            })?;
            if response.status().is_redirection()
                && response.status() != reqwest::StatusCode::NOT_MODIFIED
            {
                if hop == 3 {
                    return Err("update-too-many-redirects".into());
                }
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or("update-redirect-invalid")?;
                current = url
                    .join(location)
                    .map_err(|_| "update-redirect-invalid")?
                    .to_string();
                continue;
            }
            return Ok(response);
        }
        Err("update-too-many-redirects".into())
    }

    pub async fn fetch_feed(
        &self,
        source: &TrustedSource,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>, String> {
        let origin = Url::parse(&source.feed_url)
            .map_err(|_| "update-url-invalid")?
            .origin()
            .ascii_serialization();
        let action = async {
            let mut response = self.response(&source.feed_url, &[origin]).await?;
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| "update-download-failed")?
            {
                if bytes.len() as u64 + chunk.len() as u64 > MAX_FEED_BYTES {
                    return Err("update-feed-too-large".into());
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(bytes)
        };
        tokio::select! {
            _ = cancel.cancelled() => Err("update-cancelled".into()),
            result = tokio::time::timeout(Duration::from_secs(30), action) => result.map_err(|_| "update-download-timeout")?,
        }
    }

    pub async fn download(
        &self,
        record: &ReleaseRecord,
        source: &TrustedSource,
        path: &Path,
        cancel: &CancellationToken,
        progress: impl Fn(u64),
    ) -> Result<(), String> {
        let sha256 = self
            .download_to(
                &record.url,
                &source.download_origins,
                &[],
                record.size,
                Some(record.size),
                path,
                cancel,
                progress,
            )
            .await?;
        if sha256 != record.sha256 {
            let _ = tokio::fs::remove_file(path).await;
            return Err("update-hash-mismatch".into());
        }
        Ok(())
    }

    /// Streams a bounded body into a new private file and returns its SHA-256.
    /// Any failure, timeout or cancellation removes the partial file.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn download_to(
        &self,
        url: &str,
        origins: &[String],
        headers: &[(&str, &str)],
        max_bytes: u64,
        expected_size: Option<u64>,
        path: &Path,
        cancel: &CancellationToken,
        progress: impl Fn(u64),
    ) -> Result<String, String> {
        let mut created = false;
        let action = async {
            let mut response = self.request(url, origins, headers).await?;
            if !response.status().is_success() {
                return Err("update-http-failed".into());
            }
            if response.content_length().is_some_and(|size| {
                size > max_bytes || expected_size.is_some_and(|expected| size != expected)
            }) {
                return Err("update-size-mismatch".into());
            }
            let mut file = tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .await
                .map_err(|_| "update-file-failed")?;
            created = true;
            let mut total = 0u64;
            let mut digest = Sha256::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| "update-download-failed")?
            {
                total = total
                    .checked_add(chunk.len() as u64)
                    .ok_or("update-size-mismatch")?;
                if total > max_bytes {
                    return Err("update-size-mismatch".into());
                }
                digest.update(&chunk);
                file.write_all(&chunk)
                    .await
                    .map_err(|_| "update-file-failed")?;
                progress(total);
            }
            file.sync_all().await.map_err(|_| "update-file-failed")?;
            if expected_size.is_some_and(|expected| total != expected) {
                return Err("update-hash-mismatch".into());
            }
            Ok::<String, String>(format!("{:x}", digest.finalize()))
        };
        let result = tokio::select! {
            _ = cancel.cancelled() => Err("update-cancelled".into()),
            result = tokio::time::timeout(Duration::from_secs(300), action) => result.map_err(|_| "update-download-timeout".to_owned()).and_then(|v| v),
        };
        if result.is_err() && created {
            let _ = tokio::fs::remove_file(path).await;
        }
        result
    }

    async fn client_target(&self, url: &Url) -> Result<(reqwest::Client, Url), String> {
        let builder = reqwest::Client::builder()
            .user_agent(concat!("YAQMC/", env!("CARGO_PKG_VERSION")))
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(30));
        #[cfg(test)]
        if let Some(endpoint) = &self.endpoint {
            let mut target = Url::parse(endpoint).map_err(|_| "test-endpoint-invalid")?;
            target.set_path(url.path());
            target.set_query(url.query());
            return Ok((
                builder
                    .no_proxy()
                    .build()
                    .map_err(|_| "update-client-failed")?,
                target,
            ));
        }
        let host = url.host_str().ok_or("update-url-invalid")?;
        let addresses = tokio::time::timeout(
            Duration::from_secs(10),
            tokio::net::lookup_host((host, url.port_or_known_default().unwrap_or(443))),
        )
        .await
        .map_err(|_| "update-dns-timeout")?
        .map_err(|_| "update-dns-failed")?
        .collect::<Vec<_>>();
        if addresses.is_empty() || addresses.iter().any(|a| blocked_update_ip(a.ip())) {
            return Err("update-private-address-denied".into());
        }
        let client = builder
            .resolve_to_addrs(host, &addresses)
            .build()
            .map_err(|_| "update-client-failed")?;
        Ok((client, url.clone()))
    }
}

fn blocked_update_ip(ip: std::net::IpAddr) -> bool {
    if crate::plugin::permissions::is_blocked_ip(ip) {
        return true;
    }
    match ip {
        std::net::IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            (a == 100 && (64..=127).contains(&b))
                || (a == 198 && (18..=19).contains(&b))
                || (a == 192 && b == 0 && c == 0)
        }
        std::net::IpAddr::V6(ip) => {
            let words = ip.segments();
            ip.to_ipv4().is_some_and(blocked_update_ip_v4)
                || (words[0] & 0xffc0 == 0xfec0)
                || (words[0] == 0x64 && words[1] == 0xff9b)
                || words[0] == 0x2002
                || (words[0] == 0x2001 && words[1] == 0)
        }
    }
}
fn blocked_update_ip_v4(ip: std::net::Ipv4Addr) -> bool {
    blocked_update_ip(ip.into())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};
    fn vector() -> (TrustedSource, SignedEnvelope) {
        let value: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/plugin-release-vector.json"
        ))
        .unwrap();
        (
            serde_json::from_value(value["source"].clone()).unwrap(),
            serde_json::from_value(value["envelope"].clone()).unwrap(),
        )
    }
    pub(crate) fn signed<T: Serialize>(value: &T, domain: &[u8]) -> SignedEnvelope {
        let pair = Ed25519KeyPair::from_seed_unchecked(&[7; 32]).unwrap();
        let payload = serde_json::to_vec(value).unwrap();
        let message = [domain, payload.as_slice()].concat();
        SignedEnvelope {
            key_id: "test-key".into(),
            payload: STANDARD.encode(payload),
            signature: STANDARD.encode(pair.sign(&message)),
        }
    }

    type Reply = (u16, Vec<String>, Vec<u8>);
    pub(crate) struct TestServer {
        pub http: UpdateHttp,
        pub routes: std::sync::Arc<std::sync::Mutex<BTreeMap<String, Reply>>>,
        pub requests: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        task: tokio::task::JoinHandle<()>,
    }
    impl Drop for TestServer {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    impl TestServer {
        pub async fn start() -> Self {
            use tokio::io::AsyncReadExt;
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let http = UpdateHttp::for_test(format!("http://{}", listener.local_addr().unwrap()));
            let routes =
                std::sync::Arc::new(std::sync::Mutex::new(BTreeMap::<String, Reply>::new()));
            let state = routes.clone();
            let requests = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let request_count = requests.clone();
            let task = tokio::spawn(async move {
                loop {
                    let Ok((mut stream, _)) = listener.accept().await else {
                        break;
                    };
                    let state = state.clone();
                    let request_count = request_count.clone();
                    tokio::spawn(async move {
                        let mut request = vec![0; 8192];
                        let n = stream.read(&mut request).await.unwrap();
                        let text = String::from_utf8_lossy(&request[..n]);
                        request_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        assert!(!text.to_lowercase().contains("authorization:"));
                        assert!(!text.to_lowercase().contains("cookie:"));
                        let path = text.split_whitespace().nth(1).unwrap_or("/");
                        let (status, headers, body) = state
                            .lock()
                            .unwrap()
                            .get(path)
                            .cloned()
                            .unwrap_or((404, vec![], vec![]));
                        if status == 0 {
                            tokio::time::sleep(Duration::from_secs(360)).await;
                            return;
                        }
                        let header = format!("HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n", body.len(), headers.iter().map(|h| format!("{h}\r\n")).collect::<String>());
                        if stream.write_all(header.as_bytes()).await.is_err() {
                            return;
                        }
                        for chunk in body.chunks(16384) {
                            if stream.write_all(chunk).await.is_err() {
                                return;
                            }
                            tokio::task::yield_now().await;
                        }
                    });
                }
            });
            Self {
                http,
                routes,
                task,
                requests,
            }
        }
        pub fn put(&self, path: &str, body: Vec<u8>) {
            self.routes
                .lock()
                .unwrap()
                .insert(path.into(), (200, vec![], body));
        }
    }

    #[tokio::test]
    async fn streaming_hash_limits_redirects_cancel_and_disk_errors() {
        let server = TestServer::start().await;
        let (source, envelope) = vector();
        let mut record = verify_feed(
            &serde_json::to_vec(&envelope).unwrap(),
            &source,
            &mut UpdatePolicy::default(),
            1,
        )
        .unwrap()
        .remove(0)
        .record;
        let bytes = vec![13u8; 128 * 1024];
        record.size = bytes.len() as u64;
        record.sha256 = format!("{:x}", Sha256::digest(&bytes));
        server.put("/plugin.yaqmc-plugin", bytes.clone());
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("download");
        let cancel = CancellationToken::new();
        server
            .http
            .download(&record, &source, &path, &cancel, |_| {})
            .await
            .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        std::fs::remove_file(&path).unwrap();
        record.sha256 = "f".repeat(64);
        assert!(server
            .http
            .download(&record, &source, &path, &cancel, |_| {})
            .await
            .unwrap_err()
            .contains("hash"));
        assert!(!path.exists());
        server.routes.lock().unwrap().insert(
            "/plugin.yaqmc-plugin".into(),
            (
                302,
                vec!["Location: https://evil.example/package".into()],
                vec![],
            ),
        );
        assert!(server
            .http
            .download(&record, &source, &path, &cancel, |_| {})
            .await
            .unwrap_err()
            .contains("not-trusted"));
        server.routes.lock().unwrap().insert(
            "/plugin.yaqmc-plugin".into(),
            (302, vec!["Location: /plugin.yaqmc-plugin".into()], vec![]),
        );
        assert!(server
            .http
            .download(&record, &source, &path, &cancel, |_| {})
            .await
            .unwrap_err()
            .contains("redirects"));
        server
            .routes
            .lock()
            .unwrap()
            .insert("/plugin.yaqmc-plugin".into(), (0, vec![], vec![]));
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            stop.cancel();
        });
        assert!(server
            .http
            .download(&record, &source, &path, &cancel, |_| {})
            .await
            .unwrap_err()
            .contains("cancelled"));
        assert!(!path.exists());
        server.put("/feed", vec![b' '; MAX_FEED_BYTES as usize + 1]);
        assert!(server
            .http
            .fetch_feed(&source, &CancellationToken::new())
            .await
            .unwrap_err()
            .contains("too-large"));
        server.put("/plugin.yaqmc-plugin", bytes);
        // A nonexistent parent deterministically exercises the same cleanup path
        // used when a filesystem rejects writes (including disk exhaustion).
        assert!(server
            .http
            .download(
                &record,
                &source,
                &root.path().join("absent/file"),
                &CancellationToken::new(),
                |_| {}
            )
            .await
            .unwrap_err()
            .contains("file-failed"));
    }
    #[test]
    fn verifies_node_vector_and_rejects_tamper_expiry_and_replay() {
        let (source, envelope) = vector();
        let pair = Ed25519KeyPair::from_seed_unchecked(&[7; 32]).unwrap();
        assert_eq!(source.public_key, STANDARD.encode(pair.public_key()));
        let bytes = serde_json::to_vec(&envelope).unwrap();
        let mut policy = UpdatePolicy::default();
        let releases = verify_feed(&bytes, &source, &mut policy, 1).unwrap();
        assert_eq!(releases[0].record.release.build_id, "test-1");
        assert_eq!(policy.feed_sequence, 1);
        assert!(verify_feed(&bytes, &source, &mut policy, 4_102_444_800_000)
            .unwrap_err()
            .contains("expired"));
        let mut changed = envelope.clone();
        changed.signature = STANDARD.encode([0; 64]);
        assert!(verify_feed(
            &serde_json::to_vec(&changed).unwrap(),
            &source,
            &mut policy,
            1
        )
        .is_err());
        let mut feed: Feed = verify(&envelope, &source, FEED_DOMAIN).unwrap();
        feed.expires_at_ms += 1000;
        assert!(verify_feed(
            &serde_json::to_vec(&signed(&feed, FEED_DOMAIN)).unwrap(),
            &source,
            &mut policy,
            1
        )
        .unwrap_err()
        .contains("replayed"));
        feed.sequence = 2;
        verify_feed(
            &serde_json::to_vec(&signed(&feed, FEED_DOMAIN)).unwrap(),
            &source,
            &mut policy,
            1,
        )
        .unwrap();
        assert!(verify_feed(&bytes, &source, &mut policy, 1)
            .unwrap_err()
            .contains("replayed"));
        let mut record = releases[0].record.clone();
        record.sha256 = "b".repeat(64);
        feed.sequence = 3;
        feed.releases = vec![signed(&record, RELEASE_DOMAIN)];
        assert!(verify_feed(
            &serde_json::to_vec(&signed(&feed, FEED_DOMAIN)).unwrap(),
            &source,
            &mut policy,
            1
        )
        .unwrap_err()
        .contains("equivocation"));
        assert_eq!(
            policy.feed_sequence, 2,
            "failed verification must not advance trust state"
        );
    }
    #[test]
    fn validates_https_origins_and_channel_selection() {
        let (source, envelope) = vector();
        for url in [
            "http://example.com/a",
            "https://evil.example/a",
            "https://user:secret@example.com/a",
            "https://example.com/a#fragment",
        ] {
            assert!(validate_url(url, &source.download_origins).is_err());
        }
        let mut releases = verify_feed(
            &serde_json::to_vec(&envelope).unwrap(),
            &source,
            &mut UpdatePolicy::default(),
            1,
        )
        .unwrap();
        let mut beta = releases[0].clone();
        beta.record.version = "2.0.0-beta.1".into();
        beta.record.release.channel = ReleaseChannel::Beta;
        releases.push(beta);
        assert_eq!(
            select_release(&releases, ReleaseChannel::Stable)
                .unwrap()
                .record
                .version,
            "1.1.0"
        );
        assert_eq!(
            select_release(&releases, ReleaseChannel::Beta)
                .unwrap()
                .record
                .version,
            "2.0.0-beta.1"
        );
    }
    #[tokio::test]
    async fn private_targets_and_cancelled_downloads_are_rejected() {
        assert!(UpdateHttp::default()
            .response("https://127.0.0.1/test", &["https://127.0.0.1".into()])
            .await
            .unwrap_err()
            .contains("private"));
        let (mut source, envelope) = vector();
        let mut record = verify_feed(
            &serde_json::to_vec(&envelope).unwrap(),
            &source,
            &mut UpdatePolicy::default(),
            1,
        )
        .unwrap()
        .remove(0)
        .record;
        source.download_origins = vec!["https://127.0.0.1".into()];
        record.url = "https://127.0.0.1/test".into();
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("download");
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(UpdateHttp::default()
            .download(&record, &source, &path, &cancel, |_| {})
            .await
            .is_err());
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn no_data_timeout_and_cancellation_after_writing_remove_partial_files() {
        let server = TestServer::start().await;
        let (source, envelope) = vector();
        let mut record = verify_feed(
            &serde_json::to_vec(&envelope).unwrap(),
            &source,
            &mut UpdatePolicy::default(),
            1,
        )
        .unwrap()
        .remove(0)
        .record;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("partial");
        let body = vec![5; 1024 * 1024];
        record.size = body.len() as u64;
        record.sha256 = format!("{:x}", Sha256::digest(&body));
        server.put("/plugin.yaqmc-plugin", body);
        let cancel = CancellationToken::new();
        let result = server
            .http
            .download(&record, &source, &path, &cancel, |_| cancel.cancel())
            .await;
        assert_eq!(result.unwrap_err(), "update-cancelled");
        assert!(!path.exists());
        server
            .routes
            .lock()
            .unwrap()
            .insert("/plugin.yaqmc-plugin".into(), (0, vec![], vec![]));
        let started = std::time::Instant::now();
        assert!(server
            .http
            .download(&record, &source, &path, &CancellationToken::new(), |_| {})
            .await
            .is_err());
        assert!(started.elapsed() < Duration::from_secs(40));
        assert!(!path.exists());
    }

    #[test]
    fn transition_addresses_cannot_bypass_private_network_filter() {
        for ip in [
            "127.0.0.1",
            "100.64.0.1",
            "198.18.0.1",
            "::ffff:127.0.0.1",
            "::127.0.0.1",
            "fec0::1",
            "64:ff9b::7f00:1",
            "2002:7f00:1::",
        ] {
            assert!(blocked_update_ip(ip.parse().unwrap()), "{ip}");
        }
        assert!(!blocked_update_ip("2606:4700:4700::1111".parse().unwrap()));
    }
}
