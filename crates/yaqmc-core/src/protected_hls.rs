//! Loopback broker for provider-owned DRM-protected HLS sessions.
//!
//! Provider URLs, signed query data and credential handles never leave Core.
//! The browser and native media players receive an unguessable loopback URL
//! whose routes proxy manifests, media ranges and license challenges through
//! the provider-owned [`ProtectedHlsSource`].

use std::{
    collections::{HashMap, VecDeque},
    io,
    net::Ipv4Addr,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    body::{to_bytes, Body, Bytes},
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use yaqmc_provider_api::{PlaybackSourceError, ProtectedHlsSource};

const MAX_MANIFEST_BYTES: usize = 4 * 1024 * 1024;
const MAX_MEDIA_RANGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_LICENSE_BYTES: usize = 1024 * 1024;
const MAX_STATE_BYTES: usize = 8 * 1024;
const MAX_REMOTE_ASSETS: usize = 4096;
const MAX_COMMANDS: usize = 32;
const COMMAND_WAIT: Duration = Duration::from_secs(20);
const PLAYER_HTML: &str = include_str!("../assets/protected_hls_player.html");
const HLS_JS: &[u8] = include_bytes!("../assets/hls.min.js");

#[derive(Clone, Eq, PartialEq)]
pub struct ProtectedHlsEndpoints {
    pub manifest_url: String,
    pub license_url: String,
    pub certificate_url: String,
    pub page_url: String,
}
impl std::fmt::Debug for ProtectedHlsEndpoints {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProtectedHlsEndpoints")
            .field("manifest_url", &"[redacted]")
            .field("license_url", &"[redacted]")
            .field("certificate_url", &"[redacted]")
            .field("page_url", &"[redacted]")
            .finish()
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ProtectedHlsCommand {
    Play,
    Pause,
    Seek {
        #[serde(rename = "positionMs")]
        position_ms: u64,
    },
    Volume {
        #[serde(rename = "volumeMillis")]
        millis: u16,
    },
}

#[derive(Clone, Debug, Default)]
struct BrowserState {
    loaded: bool,
    ready: bool,
    playing: bool,
    paused: bool,
    ended: bool,
    buffering: bool,
    position_ms: u64,
    duration_ms: Option<u64>,
    error_kind: Option<String>,
    error: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct ProtectedHlsSnapshot {
    pub loaded: bool,
    pub playing: bool,
    pub paused: bool,
    pub ended: bool,
    pub buffering: bool,
    pub position_ms: u64,
    pub duration_ms: Option<u64>,
    pub error_kind: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone)]
struct RemoteAsset {
    url: String,
    range: Option<ByteRange>,
}

#[derive(Clone, Copy)]
struct ByteRange {
    offset: u64,
    length: usize,
}

#[derive(Default)]
struct AssetTable {
    next_id: u32,
    values: HashMap<u32, RemoteAsset>,
}

#[derive(Default)]
struct CommandMailbox {
    next_sequence: u64,
    values: VecDeque<(u64, ProtectedHlsCommand)>,
}

#[derive(Clone)]
struct HlsServerState {
    token: String,
    authority: String,
    source: Arc<dyn ProtectedHlsSource>,
    cancellation: CancellationToken,
    assets: Arc<Mutex<AssetTable>>,
    commands: Arc<Mutex<CommandMailbox>>,
    command_notify: Arc<tokio::sync::Notify>,
    browser: Arc<Mutex<BrowserState>>,
}

pub struct ProtectedHlsSession {
    endpoints: ProtectedHlsEndpoints,
    state: Arc<Mutex<BrowserState>>,
    commands: Arc<Mutex<CommandMailbox>>,
    command_notify: Arc<tokio::sync::Notify>,
    cancellation: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}

impl ProtectedHlsSession {
    pub fn start(
        source: Arc<dyn ProtectedHlsSource>,
        runtime: tokio::runtime::Handle,
    ) -> io::Result<Self> {
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let address = listener.local_addr()?;
        let authority = address.to_string();
        let token = random_token();
        let cancellation = CancellationToken::new();
        let browser = Arc::new(Mutex::new(BrowserState {
            loaded: true,
            paused: true,
            ..BrowserState::default()
        }));
        let commands = Arc::new(Mutex::new(CommandMailbox::default()));
        let command_notify = Arc::new(tokio::sync::Notify::new());
        let state = HlsServerState {
            token: token.clone(),
            authority: authority.clone(),
            source,
            cancellation: cancellation.clone(),
            assets: Arc::new(Mutex::new(AssetTable::default())),
            commands: Arc::clone(&commands),
            command_notify: Arc::clone(&command_notify),
            browser: Arc::clone(&browser),
        };
        let app = Router::new()
            .route("/{token}/player", get(player))
            .route("/{token}/config", get(player_config))
            .route("/{token}/hls.js", get(hls_javascript))
            .route("/{token}/assets/{*asset}", get(player_asset))
            .route("/{token}/m3u8", get(manifest))
            .route("/{token}/media/{asset}", get(media))
            .route("/{token}/cert", get(certificate))
            .route("/{token}/license", post(license).options(license_options))
            .route("/{token}/state", post(browser_state))
            .route("/{token}/command", get(command))
            .with_state(state);
        let shutdown = cancellation.clone();
        let _runtime_context = runtime.enter();
        let listener = TcpListener::from_std(listener)?;
        let task = runtime.spawn(async move {
            let result = axum::serve(listener, app)
                .with_graceful_shutdown(async move { shutdown.cancelled().await })
                .await;
            if let Err(error) = result {
                tracing::warn!(
                    target: "player.protected_hls",
                    error = %error,
                    "loopback protected-HLS server stopped unexpectedly"
                );
            }
        });
        let base = format!("http://{authority}/{token}");
        Ok(Self {
            endpoints: ProtectedHlsEndpoints {
                manifest_url: format!("{base}/m3u8"),
                license_url: format!("{base}/license"),
                certificate_url: format!("{base}/cert"),
                page_url: format!("{base}/player"),
            },
            state: browser,
            commands,
            command_notify,
            cancellation,
            task,
        })
    }

    pub fn endpoints(&self) -> ProtectedHlsEndpoints {
        self.endpoints.clone()
    }

    pub fn snapshot(&self) -> ProtectedHlsSnapshot {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        ProtectedHlsSnapshot {
            loaded: state.loaded,
            playing: state.playing,
            paused: state.paused,
            ended: state.ended,
            buffering: state.buffering,
            position_ms: state.position_ms,
            duration_ms: state.duration_ms,
            error_kind: state.error_kind,
            error: state.error,
        }
    }

    pub fn play(&self) {
        self.enqueue(ProtectedHlsCommand::Play);
    }

    pub fn pause(&self) {
        self.enqueue(ProtectedHlsCommand::Pause);
    }

    pub fn seek(&self, position_ms: u64) {
        self.enqueue(ProtectedHlsCommand::Seek { position_ms });
    }

    pub fn set_volume(&self, volume: f32) {
        let millis = (volume.clamp(0.0, 1.0) * 1000.0).round() as u16;
        self.enqueue(ProtectedHlsCommand::Volume { millis });
    }

    fn enqueue(&self, command: ProtectedHlsCommand) {
        let mut mailbox = self
            .commands
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let sequence = mailbox.next_sequence.saturating_add(1);
        mailbox.next_sequence = sequence;
        mailbox.values.push_back((sequence, command));
        while mailbox.values.len() > MAX_COMMANDS {
            mailbox.values.pop_front();
        }
        drop(mailbox);
        self.command_notify.notify_waiters();
    }
}

impl Drop for ProtectedHlsSession {
    fn drop(&mut self) {
        self.cancellation.cancel();
        self.task.abort();
    }
}

fn random_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut token, "{byte:02x}");
    }
    token
}

fn response(status: StatusCode, body: impl Into<Body>) -> Response {
    Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff")
        .body(body.into())
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn text_response(status: StatusCode, value: &str) -> Response {
    response(status, Body::from(value.to_owned()))
}

fn validate_session<'a>(
    state: &HlsServerState,
    token: &'a str,
    headers: &HeaderMap,
) -> Result<&'a str, Box<Response>> {
    if token != state.token {
        return Err(Box::new(text_response(StatusCode::NOT_FOUND, "not found")));
    }
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if host != state.authority {
        return Err(Box::new(text_response(StatusCode::FORBIDDEN, "forbidden")));
    }
    Ok(token)
}

fn validate_post_origin(state: &HlsServerState, headers: &HeaderMap) -> Result<(), Box<Response>> {
    if let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    {
        let expected = format!("http://{}", state.authority);
        if origin != expected {
            return Err(Box::new(text_response(StatusCode::FORBIDDEN, "forbidden")));
        }
    }
    Ok(())
}

async fn player(
    State(state): State<HlsServerState>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = validate_session(&state, &token, &headers) {
        return *response;
    }
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header("x-content-type-options", "nosniff")
        .header(
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'",
        )
        .body(Body::from(
            state.source.browser_player()
                .map(|player| player.html.to_vec())
                .unwrap_or_else(|| PLAYER_HTML.as_bytes().to_vec()),
        ))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProtectedPlayerConfig {
    server_certificate: bool,
}

async fn player_config(
    State(state): State<HlsServerState>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = validate_session(&state, &token, &headers) {
        return *response;
    }
    Json(ProtectedPlayerConfig {
        server_certificate: state.source.requires_application_certificate(),
    })
    .into_response()
}

async fn hls_javascript(
    State(state): State<HlsServerState>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = validate_session(&state, &token, &headers) {
        return *response;
    }
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CACHE_CONTROL, "private, max-age=3600")
        .header(header::CONTENT_TYPE, "text/javascript; charset=utf-8")
        .header("x-content-type-options", "nosniff")
        .body(Body::from(HLS_JS))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn player_asset(
    State(state): State<HlsServerState>,
    Path((token, asset)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = validate_session(&state, &token, &headers) {
        return *response;
    }
    let Some(bytes) = state
        .source
        .browser_player()
        .and_then(|player| player.scripts.get(&format!("assets/{asset}")))
    else {
        return text_response(StatusCode::NOT_FOUND, "player asset not found");
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_TYPE, "text/javascript; charset=utf-8")
        .header("x-content-type-options", "nosniff")
        .body(Body::from(bytes.to_vec()))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn certificate(
    State(state): State<HlsServerState>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = validate_session(&state, &token, &headers) {
        return *response;
    }
    let certificate = match state
        .source
        .fetch_application_certificate(state.cancellation.clone())
        .await
    {
        Ok(Some(certificate)) => certificate,
        Ok(None) => return text_response(StatusCode::NOT_FOUND, "certificate not configured"),
        Err(error) => return playback_error("certificate", error),
    };
    if certificate.status != 200
        || certificate.body.is_empty()
        || certificate.body.len() > MAX_LICENSE_BYTES
    {
        tracing::warn!(
            target: "player.protected_hls",
            stage = "certificate-response",
            upstream_status = certificate.status,
            response_bytes = certificate.body.len(),
            "protected-HLS certificate response is invalid"
        );
        return text_response(StatusCode::BAD_GATEWAY, "invalid application certificate");
    }
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_LENGTH, certificate.body.len())
        .header("x-content-type-options", "nosniff")
        .body(Body::from(certificate.body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn manifest(
    State(state): State<HlsServerState>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = validate_session(&state, &token, &headers) {
        return *response;
    }
    let upstream = match state
        .source
        .fetch_manifest(state.cancellation.clone())
        .await
    {
        Ok(response) => response,
        Err(error) => return playback_error("manifest", error),
    };
    if upstream.status != 200
        || upstream.body.is_empty()
        || upstream.body.len() > MAX_MANIFEST_BYTES
    {
        tracing::warn!(
            target: "player.protected_hls",
            stage = "manifest-response",
            upstream_status = upstream.status,
            response_bytes = upstream.body.len(),
            "protected-HLS manifest response is invalid"
        );
        return text_response(StatusCode::BAD_GATEWAY, "invalid manifest");
    }
    let rewritten = match rewrite_manifest(&state, &upstream.body, state.source.manifest_url()) {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(
                target: "player.protected_hls",
                error = %error,
                "protected-HLS manifest could not be localized"
            );
            return text_response(StatusCode::BAD_GATEWAY, "invalid manifest");
        }
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_TYPE, "application/vnd.apple.mpegurl")
        .header("x-content-type-options", "nosniff")
        .body(Body::from(rewritten))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn media(
    State(state): State<HlsServerState>,
    Path((token, asset_id)): Path<(String, u32)>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = validate_session(&state, &token, &headers) {
        return *response;
    }
    let asset = {
        let assets = state
            .assets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assets.values.get(&asset_id).cloned()
    };
    let Some(asset) = asset else {
        return text_response(StatusCode::NOT_FOUND, "not found");
    };
    let requested = parse_requested_range(&headers);
    let (offset, length) = match requested {
        Ok(Some(range)) => range,
        Ok(None) => asset
            .range
            .map(|range| (range.offset, range.length))
            .unwrap_or((0, MAX_MEDIA_RANGE_BYTES)),
        Err(()) => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, "bytes */*")
                .body(Body::empty())
                .unwrap_or_else(|_| StatusCode::RANGE_NOT_SATISFIABLE.into_response())
        }
    };
    if length == 0 || length > MAX_MEDIA_RANGE_BYTES {
        return text_response(StatusCode::BAD_REQUEST, "invalid range");
    }
    let upstream = match state
        .source
        .fetch_media_range(
            asset.url.clone(),
            offset,
            length,
            state.cancellation.clone(),
        )
        .await
    {
        Ok(response) => response,
        Err(error) => return playback_error("media", error),
    };
    if !matches!(upstream.status, 200 | 206) {
        tracing::warn!(
            target: "player.protected_hls",
            stage = "media-response",
            asset_id,
            upstream_status = upstream.status,
            response_bytes = upstream.body.len(),
            "protected-HLS media response has an unexpected status"
        );
    }
    if upstream.body.len() > length {
        return text_response(StatusCode::BAD_GATEWAY, "oversized media range");
    }
    if upstream.body.starts_with(b"#EXTM3U") {
        return nested_manifest(&state, &asset.url, &upstream.body);
    }
    if upstream.body.is_empty() {
        return text_response(StatusCode::BAD_GATEWAY, "empty media range");
    }
    let status = if requested.unwrap_or(None).is_some() || asset.range.is_some() {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let mut builder = Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "private, max-age=300")
        .header(
            header::CONTENT_TYPE,
            media_content_type(upstream.content_type.as_deref()),
        )
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, upstream.body.len())
        .header("x-content-type-options", "nosniff");
    if status == StatusCode::PARTIAL_CONTENT {
        let end = offset
            .saturating_add(upstream.body.len() as u64)
            .saturating_sub(1);
        if let Some(range) = upstream
            .content_range
            .as_deref()
            .filter(|value| valid_content_range(value))
        {
            builder = builder.header(header::CONTENT_RANGE, range);
        } else if let Some(total) = upstream.content_length.filter(|total| *total > end) {
            builder = builder.header(
                header::CONTENT_RANGE,
                format!("bytes {offset}-{end}/{total}"),
            );
        } else {
            builder = builder.header(header::CONTENT_RANGE, format!("bytes {offset}-{end}/*"));
        }
    }
    builder
        .body(Body::from(upstream.body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn nested_manifest(state: &HlsServerState, base_url: &str, body: &[u8]) -> Response {
    match rewrite_manifest(state, body, base_url) {
        Ok(value) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::CONTENT_TYPE, "application/vnd.apple.mpegurl")
            .header("x-content-type-options", "nosniff")
            .body(Body::from(value))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        Err(error) => {
            tracing::warn!(
                target: "player.protected_hls",
                error = %error,
                "nested protected-HLS manifest could not be localized"
            );
            text_response(StatusCode::BAD_GATEWAY, "invalid manifest")
        }
    }
}

fn rewrite_manifest(
    state: &HlsServerState,
    bytes: &[u8],
    base_url: &str,
) -> Result<String, String> {
    let manifest =
        std::str::from_utf8(bytes).map_err(|_| "protected-HLS manifest is not UTF-8".to_owned())?;
    let base = reqwest::Url::parse(base_url)
        .map_err(|_| "protected-HLS manifest base URL is invalid".to_owned())?;
    let mut output = Vec::new();
    let mut pending_range: Option<(Option<u64>, usize)> = None;
    let mut last_uri = String::new();
    let mut next_implicit_offset = 0_u64;
    for raw_line in manifest.lines() {
        let line = raw_line.trim_end_matches('\r');
        if let Some(value) = line.strip_prefix("#EXT-X-BYTERANGE:") {
            let (length, offset) = value
                .split_once('@')
                .map_or((value, None), |(length, offset)| {
                    (length, offset.parse::<u64>().ok())
                });
            let length = length
                .parse::<usize>()
                .map_err(|_| "protected-HLS byte range length is invalid".to_owned())?;
            if length == 0 || length > MAX_MEDIA_RANGE_BYTES {
                return Err("protected-HLS byte range length is invalid".to_owned());
            }
            pending_range = Some((offset, length));
            output.push(line.to_owned());
            continue;
        }
        if line.starts_with("#EXT-X-MAP:") {
            let range = parse_attribute_range(line)?;
            output.push(replace_uri_attribute(state, &base, line, range)?);
            continue;
        }
        if line.starts_with('#') || line.trim().is_empty() {
            output.push(line.to_owned());
            continue;
        }
        let (offset, length) = pending_range
            .take()
            .map_or((None, None), |(offset, length)| (offset, Some(length)));
        let resolved = resolve_asset_url(&base, line.trim())?;
        let range = if let Some(length) = length {
            let offset = offset.unwrap_or_else(|| {
                if last_uri == resolved {
                    next_implicit_offset
                } else {
                    0
                }
            });
            next_implicit_offset = offset.saturating_add(length as u64);
            Some(ByteRange { offset, length })
        } else {
            next_implicit_offset = 0;
            None
        };
        last_uri = resolved.clone();
        let id = register_asset(state, resolved, range)?;
        output.push(format!("media/{id}"));
    }
    Ok(output.join("\n") + "\n")
}

fn replace_uri_attribute(
    state: &HlsServerState,
    base: &reqwest::Url,
    line: &str,
    range: Option<ByteRange>,
) -> Result<String, String> {
    let Some((before, rest)) = line.split_once("URI=\"") else {
        return Ok(line.to_owned());
    };
    let Some((uri, after)) = rest.split_once('"') else {
        return Err("protected-HLS URI attribute is malformed".to_owned());
    };
    if uri.starts_with("data:") || uri.starts_with("skd:") {
        return Ok(line.to_owned());
    }
    let resolved = resolve_asset_url(base, uri)?;
    let id = register_asset(state, resolved, range)?;
    Ok(format!("{before}URI=\"media/{id}\"{after}"))
}

fn parse_attribute_range(line: &str) -> Result<Option<ByteRange>, String> {
    let Some((_, rest)) = line.split_once("BYTERANGE=\"") else {
        return Ok(None);
    };
    let Some((value, _)) = rest.split_once('"') else {
        return Err("protected-HLS BYTERANGE attribute is malformed".to_owned());
    };
    let (length, offset) = value
        .split_once('@')
        .map_or((value, 0), |(length, offset)| {
            (length, offset.parse::<u64>().unwrap_or(0))
        });
    let length = length
        .parse::<usize>()
        .map_err(|_| "protected-HLS BYTERANGE attribute length is invalid".to_owned())?;
    if length == 0 || length > MAX_MEDIA_RANGE_BYTES {
        return Err("protected-HLS BYTERANGE attribute length is invalid".to_owned());
    }
    Ok(Some(ByteRange { offset, length }))
}

fn resolve_asset_url(base: &reqwest::Url, value: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(value)
        .or_else(|_| base.join(value))
        .map_err(|_| "protected-HLS media URL is invalid".to_owned())?;
    if !matches!(url.scheme(), "https" | "http") || url.host_str().is_none() {
        return Err("protected-HLS media URL scheme is unsupported".to_owned());
    }
    Ok(url.to_string())
}

fn register_asset(
    state: &HlsServerState,
    url: String,
    range: Option<ByteRange>,
) -> Result<u32, String> {
    let requested_range = range.map(|range| (range.offset, range.length));
    let mut assets = state
        .assets
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((id, _)) = assets.values.iter().find(|(_, asset)| {
        asset.url == url && asset.range.map(|range| (range.offset, range.length)) == requested_range
    }) {
        return Ok(*id);
    }
    if assets.values.len() >= MAX_REMOTE_ASSETS {
        return Err("protected-HLS manifest has too many assets".to_owned());
    }
    assets.next_id = assets
        .next_id
        .checked_add(1)
        .ok_or_else(|| "protected-HLS asset identifiers were exhausted".to_owned())?;
    let id = assets.next_id;
    assets.values.insert(id, RemoteAsset { url, range });
    Ok(id)
}

fn parse_requested_range(headers: &HeaderMap) -> Result<Option<(u64, usize)>, ()> {
    let Some(value) = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
    else {
        return Ok(None);
    };
    let value = value.strip_prefix("bytes=").ok_or(())?;
    let (start, end) = value.split_once('-').ok_or(())?;
    let start = start.parse::<u64>().map_err(|_| ())?;
    let end = end.parse::<u64>().map_err(|_| ())?;
    if end < start {
        return Err(());
    }
    let length_u64 = end
        .checked_sub(start)
        .and_then(|value| value.checked_add(1))
        .ok_or(())?;
    let length = usize::try_from(length_u64).map_err(|_| ())?;
    if length == 0 || length > MAX_MEDIA_RANGE_BYTES {
        return Err(());
    }
    Ok(Some((start, length)))
}

fn valid_content_range(value: &str) -> bool {
    value.starts_with("bytes ") && value.len() <= 128 && !value.chars().any(char::is_control)
}

fn media_content_type(value: Option<&str>) -> &'static str {
    match value
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
    {
        "audio/mp4" | "audio/m4a" | "audio/aac" => "audio/mp4",
        "video/mp4" => "video/mp4",
        "application/octet-stream" => "application/octet-stream",
        _ => "application/octet-stream",
    }
}

fn playback_error(stage: &'static str, error: PlaybackSourceError) -> Response {
    let status = match &error {
        PlaybackSourceError::AuthenticationExpired => StatusCode::UNAUTHORIZED,
        PlaybackSourceError::UrlExpired => StatusCode::GONE,
        PlaybackSourceError::Cancelled => StatusCode::GONE,
        PlaybackSourceError::RangeUnsupported => StatusCode::RANGE_NOT_SATISFIABLE,
        PlaybackSourceError::ResponseTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        PlaybackSourceError::ProviderUnavailable
        | PlaybackSourceError::ProviderFailure
        | PlaybackSourceError::Network => StatusCode::BAD_GATEWAY,
        _ => StatusCode::UNPROCESSABLE_ENTITY,
    };
    tracing::warn!(
        target: "player.protected_hls",
        stage,
        source_error = ?error,
        http_status = status.as_u16(),
        "protected-HLS upstream request failed"
    );
    text_response(status, "protected media request failed")
}

async fn license(
    State(state): State<HlsServerState>,
    Path(token): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(response) = validate_session(&state, &token, &headers) {
        return *response;
    }
    if let Err(response) = validate_post_origin(&state, &headers) {
        return *response;
    }
    if body.is_empty() || body.len() > MAX_LICENSE_BYTES {
        return text_response(StatusCode::BAD_REQUEST, "invalid license challenge");
    }
    let upstream = match state
        .source
        .request_license(body.to_vec(), state.cancellation.clone())
        .await
    {
        Ok(response) => response,
        Err(error) => return playback_error("license", error),
    };
    if upstream.status != 200 {
        tracing::warn!(
            target: "player.protected_hls",
            stage = "license-response",
            upstream_status = upstream.status,
            response_bytes = upstream.body.len(),
            "protected-HLS license request was rejected"
        );
        return text_response(
            StatusCode::from_u16(upstream.status).unwrap_or(StatusCode::BAD_GATEWAY),
            "protected media license request rejected",
        );
    }
    if upstream.body.is_empty() || upstream.body.len() > MAX_LICENSE_BYTES {
        return text_response(StatusCode::BAD_GATEWAY, "invalid license response");
    }
    Response::builder()
        .status(StatusCode::from_u16(upstream.status).unwrap_or(StatusCode::BAD_GATEWAY))
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_LENGTH, upstream.body.len())
        .header("x-content-type-options", "nosniff")
        .body(Body::from(upstream.body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn license_options(
    State(state): State<HlsServerState>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = validate_session(&state, &token, &headers) {
        return *response;
    }
    Response::builder()
        .status(StatusCode::NO_CONTENT)
        .header(
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            format!("http://{}", state.authority),
        )
        .header(header::ACCESS_CONTROL_ALLOW_METHODS, "POST")
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "content-type")
        .body(Body::empty())
        .unwrap_or_else(|_| StatusCode::NO_CONTENT.into_response())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserStateUpdate {
    kind: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    error_type: Option<String>,
    #[serde(default)]
    error_detail: Option<String>,
    #[serde(default)]
    http_status: Option<u16>,
    #[serde(default)]
    position_ms: u64,
    #[serde(default)]
    duration_ms: Option<u64>,
}

async fn browser_state(
    State(state): State<HlsServerState>,
    Path(token): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    if let Err(response) = validate_session(&state, &token, &headers) {
        return *response;
    }
    if let Err(response) = validate_post_origin(&state, &headers) {
        return *response;
    }
    let body = match to_bytes(body, MAX_STATE_BYTES).await {
        Ok(body) => body,
        Err(_) => return text_response(StatusCode::BAD_REQUEST, "invalid browser state"),
    };
    let update: BrowserStateUpdate = match serde_json::from_slice(&body) {
        Ok(update) => update,
        Err(_) => return text_response(StatusCode::BAD_REQUEST, "invalid browser state"),
    };
    match update.kind.as_str() {
        "ready" => tracing::info!(
            target: "player.protected_hls",
            stage = "player-page-ready",
            "protected audio browser page is ready"
        ),
        "manifest" => tracing::info!(
            target: "player.protected_hls",
            stage = "manifest-ready",
            "protected audio manifest was parsed"
        ),
        "diagnostic" => tracing::info!(
            target: "player.protected_hls",
            diagnostic_type = update.error_type.as_deref().and_then(sanitize_diagnostic_label),
            diagnostic_detail = update.error_detail.as_deref().and_then(sanitize_diagnostic_label),
            "protected audio playback diagnostic"
        ),
        "error" => tracing::warn!(
            target: "player.protected_hls",
            error_type = update.error_type.as_deref().and_then(sanitize_diagnostic_label),
            error_detail = update.error_detail.as_deref().and_then(sanitize_diagnostic_label),
            http_status = update.http_status.filter(|status| (100..=599).contains(status)),
            "protected audio browser reported a playback error"
        ),
        _ => {}
    }
    let message = sanitize_message(&update.message);
    let mut browser = state
        .browser
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    browser.loaded = true;
    browser.position_ms = update.position_ms;
    if let Some(duration) = update.duration_ms.filter(|value| *value > 0) {
        browser.duration_ms = Some(duration);
    }
    match update.kind.as_str() {
        "manifest" => {
            browser.ready = true;
            browser.buffering = false;
            browser.error = None;
            browser.error_kind = None;
        }
        "playing" => {
            browser.ready = true;
            browser.playing = true;
            browser.paused = false;
            browser.ended = false;
            browser.buffering = false;
            browser.error = None;
            browser.error_kind = None;
        }
        "paused" | "seeked" | "duration" => {
            browser.playing = false;
            browser.paused = !browser.ended;
            browser.buffering = false;
        }
        "buffering" => {
            browser.buffering = true;
            browser.paused = false;
        }
        "ended" => {
            browser.playing = false;
            browser.paused = false;
            browser.ended = true;
            browser.buffering = false;
        }
        "error" => {
            browser.playing = false;
            browser.paused = false;
            browser.buffering = false;
            browser.error_kind = Some("source".to_owned());
            browser.error = message.or_else(|| Some("protected playback failed".to_owned()));
        }
        "ready" => {}
        _ => {}
    }
    drop(browser);
    StatusCode::NO_CONTENT.into_response()
}

fn sanitize_message(message: &str) -> Option<String> {
    let value = message.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.chars().take(512).collect())
    }
}

fn sanitize_diagnostic_label(value: &str) -> Option<String> {
    let safe: String = value
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        })
        .take(64)
        .collect();
    (!safe.is_empty()).then_some(safe)
}

#[derive(Debug, Default, Deserialize)]
struct CommandQuery {
    #[serde(default)]
    after: u64,
}

#[derive(Serialize)]
struct CommandResponse {
    seq: u64,
    command: ProtectedHlsCommand,
}

async fn command(
    State(state): State<HlsServerState>,
    Path(token): Path<String>,
    Query(query): Query<CommandQuery>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = validate_session(&state, &token, &headers) {
        return *response;
    }
    loop {
        let notified = state.command_notify.notified();
        {
            let mut mailbox = state
                .commands
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            while mailbox
                .values
                .front()
                .is_some_and(|(sequence, _)| *sequence <= query.after)
            {
                mailbox.values.pop_front();
            }
            if let Some((sequence, command)) = mailbox.values.front().cloned() {
                return Json(CommandResponse {
                    seq: sequence,
                    command,
                })
                .into_response();
            }
        }
        tokio::select! {
            _ = notified => {}
            _ = state.cancellation.cancelled() => {
                return text_response(StatusCode::GONE, "session ended");
            }
            _ = tokio::time::sleep(COMMAND_WAIT) => {
                return StatusCode::NO_CONTENT.into_response();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use axum::http::HeaderValue;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[derive(Default)]
    struct FakeSource {
        manifest_requests: AtomicU64,
        media_requests: AtomicU64,
        license_requests: AtomicU64,
        certificate_requests: AtomicU64,
        license_status: u16,
        browser_player: Option<yaqmc_provider_api::ProtectedHlsBrowserPlayer>,
    }

    #[async_trait]
    impl ProtectedHlsSource for FakeSource {
        fn manifest_url(&self) -> &str {
            "https://spclient.example/private/audio.m3u8?token=secret"
        }

        fn browser_player(&self) -> Option<&yaqmc_provider_api::ProtectedHlsBrowserPlayer> {
            self.browser_player.as_ref()
        }

        fn requires_application_certificate(&self) -> bool {
            true
        }

        async fn fetch_manifest(
            &self,
            _cancellation: CancellationToken,
        ) -> Result<yaqmc_provider_api::ProtectedHlsResponse, PlaybackSourceError> {
            self.manifest_requests.fetch_add(1, Ordering::Relaxed);
            Ok(yaqmc_provider_api::ProtectedHlsResponse {
                status: 200,
                body: b"#EXTM3U\n#EXT-X-MAP:URI=\"https://cdn.example/init.mp4?sig=secret\",BYTERANGE=\"4@0\"\n#EXTINF:10,\n#EXT-X-BYTERANGE:4@0\nhttps://cdn.example/audio.mp4?sig=secret\n#EXT-X-ENDLIST\n".to_vec(),
                content_range: None,
                content_length: Some(244),
                content_type: Some("application/vnd.apple.mpegurl".to_owned()),
            })
        }

        async fn fetch_media_range(
            &self,
            _url: String,
            offset: u64,
            length: usize,
            _cancellation: CancellationToken,
        ) -> Result<yaqmc_provider_api::ProtectedHlsResponse, PlaybackSourceError> {
            self.media_requests.fetch_add(1, Ordering::Relaxed);
            assert_eq!(offset, 0);
            assert_eq!(length, 4);
            Ok(yaqmc_provider_api::ProtectedHlsResponse {
                status: 206,
                body: b"data".to_vec(),
                content_range: Some("bytes 0-3/100".to_owned()),
                content_length: Some(4),
                content_type: Some("audio/mp4".to_owned()),
            })
        }

        async fn request_license(
            &self,
            challenge: Vec<u8>,
            _cancellation: CancellationToken,
        ) -> Result<yaqmc_provider_api::ProtectedHlsResponse, PlaybackSourceError> {
            self.license_requests.fetch_add(1, Ordering::Relaxed);
            assert_eq!(challenge, b"challenge");
            if self.license_status >= 400 {
                return Ok(yaqmc_provider_api::ProtectedHlsResponse {
                    status: self.license_status,
                    body: Vec::new(),
                    content_range: None,
                    content_length: Some(0),
                    content_type: None,
                });
            }
            Ok(yaqmc_provider_api::ProtectedHlsResponse {
                status: 200,
                body: b"license".to_vec(),
                content_range: None,
                content_length: Some(7),
                content_type: Some("application/octet-stream".to_owned()),
            })
        }

        async fn fetch_application_certificate(
            &self,
            _cancellation: CancellationToken,
        ) -> Result<Option<yaqmc_provider_api::ProtectedHlsResponse>, PlaybackSourceError> {
            self.certificate_requests.fetch_add(1, Ordering::Relaxed);
            Ok(Some(yaqmc_provider_api::ProtectedHlsResponse {
                status: 200,
                body: b"certificate".to_vec(),
                content_range: None,
                content_length: Some(11),
                content_type: Some("application/octet-stream".to_owned()),
            }))
        }
    }

    impl std::fmt::Debug for FakeSource {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.debug_struct("FakeSource").finish_non_exhaustive()
        }
    }

    #[tokio::test]
    async fn player_policy_allows_local_media_blobs_but_not_external_fetches() {
        let session = ProtectedHlsSession::start(
            Arc::new(FakeSource::default()),
            tokio::runtime::Handle::current(),
        )
        .expect("start session");
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("client")
            .get(session.endpoints().page_url)
            .send()
            .await
            .expect("player request");
        assert_eq!(response.status(), StatusCode::OK);
        let policy = response.headers()[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .expect("player policy");
        let directives: Vec<_> = policy.split(';').map(str::trim).collect();
        assert!(directives.contains(&"media-src 'self' blob:"));
        assert!(directives.contains(&"connect-src 'self'"));
        assert!(directives.contains(&"script-src 'self' 'unsafe-inline'"));
        assert!(directives.contains(&"frame-ancestors 'none'"));
    }

    #[tokio::test]
    async fn localizes_manifest_media_and_license_without_exposing_signed_urls() {
        let source = Arc::new(FakeSource::default());
        let session = ProtectedHlsSession::start(source.clone(), tokio::runtime::Handle::current())
            .expect("start session");
        let endpoints = session.endpoints();
        let client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("client");
        let manifest = client
            .get(&endpoints.manifest_url)
            .send()
            .await
            .expect("manifest request")
            .text()
            .await
            .expect("manifest body");
        let config: serde_json::Value = client
            .get(endpoints.manifest_url.replace("m3u8", "config"))
            .send()
            .await
            .expect("config request")
            .json()
            .await
            .expect("config body");
        assert_eq!(config, serde_json::json!({ "serverCertificate": true }));
        let certificate = client
            .get(&endpoints.certificate_url)
            .send()
            .await
            .expect("certificate request");
        assert_eq!(certificate.status(), reqwest::StatusCode::OK);
        assert_eq!(
            certificate
                .bytes()
                .await
                .expect("certificate body")
                .as_ref(),
            b"certificate"
        );
        assert!(!manifest.contains("spclient.example"));
        assert!(!manifest.contains("cdn.example"));
        assert!(!manifest.contains("sig=secret"));
        let media_path = manifest
            .lines()
            .find(|line| line.starts_with("media/"))
            .expect("local media URL")
            .to_owned();
        let base = endpoints
            .manifest_url
            .strip_suffix("m3u8")
            .expect("manifest base");
        let media = client
            .get(format!("{base}{media_path}"))
            .send()
            .await
            .expect("media request");
        assert_eq!(media.status(), reqwest::StatusCode::PARTIAL_CONTENT);
        assert_eq!(media.bytes().await.expect("media body").as_ref(), b"data");
        let license = client
            .post(&endpoints.license_url)
            .body("challenge")
            .send()
            .await
            .expect("license request");
        assert_eq!(
            license.bytes().await.expect("license body").as_ref(),
            b"license"
        );
        assert_eq!(source.manifest_requests.load(Ordering::Relaxed), 1);
        assert_eq!(source.license_requests.load(Ordering::Relaxed), 1);
        assert_eq!(source.certificate_requests.load(Ordering::Relaxed), 1);
        assert!(source.media_requests.load(Ordering::Relaxed) >= 1);
    }

    #[tokio::test]
    async fn empty_license_rejections_keep_the_upstream_status() {
        // A 403 with no body became 502, causing HLS to retry a rejected license.
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        for status in [401, 403, 429, 500] {
            let source = Arc::new(FakeSource {
                license_status: status,
                ..FakeSource::default()
            });
            let session =
                ProtectedHlsSession::start(source.clone(), tokio::runtime::Handle::current())
                    .unwrap();
            let response = client
                .post(session.endpoints().license_url)
                .body("challenge")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), status);
            assert_eq!(source.license_requests.load(Ordering::Relaxed), 1);
        }
    }

    #[tokio::test]
    async fn plugin_player_serves_only_its_declared_assets_under_the_session_policy() {
        let source = Arc::new(FakeSource {
            browser_player: Some(yaqmc_provider_api::ProtectedHlsBrowserPlayer {
                html: Arc::from(b"<audio id=\"plugin-player\"></audio>".as_slice()),
                scripts: std::collections::BTreeMap::from([(
                    "assets/player.js".to_owned(),
                    Arc::from(b"window.pluginPlayer = true;".as_slice()),
                )]),
            }),
            ..FakeSource::default()
        });
        let session =
            ProtectedHlsSession::start(source, tokio::runtime::Handle::current()).unwrap();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let endpoint = session.endpoints().page_url;
        let response = client.get(&endpoint).send().await.unwrap();
        assert!(response.headers()[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap()
            .contains("connect-src 'self'"));
        assert_eq!(
            response.text().await.unwrap(),
            "<audio id=\"plugin-player\"></audio>"
        );
        let script_url = endpoint.replace("/player", "/assets/player.js");
        let script = client.get(&script_url).send().await.unwrap();
        assert_eq!(
            script.headers()[header::CONTENT_TYPE],
            "text/javascript; charset=utf-8"
        );
        assert_eq!(script.text().await.unwrap(), "window.pluginPlayer = true;");
        assert_eq!(
            client
                .get(script_url.replace("player.js", "missing.js"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        let origin = reqwest::Url::parse(&endpoint)
            .unwrap()
            .origin()
            .ascii_serialization();
        assert_eq!(
            client
                .get(format!("{origin}/invalid/assets/player.js"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn commands_are_delivered_in_order_and_wake_existing_waiters() {
        let session = ProtectedHlsSession::start(
            Arc::new(FakeSource::default()),
            tokio::runtime::Handle::current(),
        )
        .expect("start session");
        let endpoints = session.endpoints();
        let command_url = endpoints
            .manifest_url
            .strip_suffix("m3u8")
            .map(|base| format!("{base}command"))
            .expect("manifest base");
        let client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("client");

        session.play();
        session.pause();
        let first: serde_json::Value = client
            .get(format!("{command_url}?after=0"))
            .send()
            .await
            .expect("first command")
            .json()
            .await
            .expect("first command JSON");
        assert_eq!(
            first
                .pointer("/command/type")
                .and_then(serde_json::Value::as_str),
            Some("play")
        );
        let first_sequence = first
            .get("seq")
            .and_then(serde_json::Value::as_u64)
            .expect("first seq");
        let second = client
            .get(format!("{command_url}?after={first_sequence}"))
            .send()
            .await
            .expect("second command")
            .json::<serde_json::Value>()
            .await
            .expect("second command JSON");
        assert_eq!(
            second
                .pointer("/command/type")
                .and_then(serde_json::Value::as_str),
            Some("pause")
        );
        let second_sequence = second
            .get("seq")
            .and_then(serde_json::Value::as_u64)
            .expect("second seq");

        let pending = tokio::spawn({
            let client = client.clone();
            let command_url = command_url.clone();
            async move {
                client
                    .get(format!("{command_url}?after={second_sequence}"))
                    .send()
                    .await
                    .expect("pending command")
                    .json::<serde_json::Value>()
                    .await
                    .expect("pending command JSON")
            }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        session.seek(12_345);
        let next = tokio::time::timeout(Duration::from_secs(2), pending)
            .await
            .expect("command waiter was not notified")
            .expect("pending command task");
        assert_eq!(
            next.pointer("/command/type")
                .and_then(serde_json::Value::as_str),
            Some("seek")
        );
        assert_eq!(
            next.pointer("/command/positionMs")
                .and_then(serde_json::Value::as_u64),
            Some(12_345)
        );
    }
    #[test]
    fn commands_match_the_embedded_player_wire_contract() {
        let seek = serde_json::to_value(ProtectedHlsCommand::Seek {
            position_ms: 12_345,
        })
        .expect("seek serializes");
        assert_eq!(
            seek,
            serde_json::json!({"type": "seek", "positionMs": 12_345})
        );
        let volume = serde_json::to_value(ProtectedHlsCommand::Volume { millis: 625 })
            .expect("volume serializes");
        assert_eq!(
            volume,
            serde_json::json!({"type": "volume", "volumeMillis": 625})
        );
    }

    #[test]
    fn byte_range_parser_rejects_unbounded_requests() {
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, HeaderValue::from_static("bytes=0-10"));
        assert_eq!(parse_requested_range(&headers), Ok(Some((0, 11))));
        headers.insert(header::RANGE, HeaderValue::from_static("bytes=10-0"));
        assert!(parse_requested_range(&headers).is_err());
    }

    #[test]
    fn browser_diagnostic_labels_exclude_urls_and_free_form_data() {
        assert_eq!(
            sanitize_diagnostic_label("KEY_SYSTEM_ERROR"),
            Some("KEY_SYSTEM_ERROR".to_owned())
        );
        assert_eq!(
            sanitize_diagnostic_label("https://127.0.0.1/secret-token?x=1"),
            Some("https127.0.0.1secret-tokenx1".to_owned())
        );
        assert_eq!(sanitize_diagnostic_label(" : / "), None);
    }
}
