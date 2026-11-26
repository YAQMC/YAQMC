use crate::plugin::permissions::{is_blocked_ip, LOCAL_BACKEND_ORIGIN};
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use reqwest::redirect::Policy;
use serde_json::{json, Value};
use std::{collections::HashSet, net::SocketAddr, time::Duration};

const MAX_REQUEST_BODY: usize = 256 * 1024;
const LEGACY_MAX_RESPONSE_BODY: usize = 1024 * 1024;
pub const COMPONENT_MAX_RESPONSE_BODY: usize = 4 * 1024 * 1024;
const MAX_REDIRECTS: usize = 3;
const MAX_URL_BYTES: usize = 4096;
const REQUEST_TIMEOUT_SECS: u64 = 10;
const MAX_COMPONENT_IMAGE_BYTES: usize = 256 * 1024;

const ALLOWED_REQUEST_HEADERS: &[&str] = &[
    "accept",
    "app-platform",
    "clienttime",
    "content-type",
    "dfid",
    "kg-rec",
    "kg-rf",
    "kg-rc",
    "kg-thash",
    "kg-tid",
    "mid",
    "origin",
    "referer",
    "user-agent",
    "x-router",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ComponentCredentialHeader {
    pub origin: String,
    pub name: String,
    pub value: String,
}

#[derive(Clone)]
struct PinnedRequest {
    method: reqwest::Method,
    url: reqwest::Url,
    host: String,
    addresses: Vec<SocketAddr>,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    response_limit: usize,
}

struct TransportResponse {
    status: u16,
    location: Option<String>,
    body: Vec<u8>,
    set_cookies: Vec<String>,
    content_range: Option<String>,
    content_length: Option<u64>,
    mime_type: Option<String>,
}

pub(crate) struct ComponentMediaChunk {
    pub status: u16,
    pub body: Vec<u8>,
    pub content_range: Option<String>,
    pub content_length: Option<u64>,
    pub mime_type: Option<String>,
}

pub(crate) struct ComponentBinaryResponse {
    pub status: u16,
    pub body: Vec<u8>,
    pub content_range: Option<String>,
    pub content_length: Option<u64>,
    pub mime_type: Option<String>,
}

#[async_trait]
trait AddressResolver: Send + Sync {
    async fn resolve(&self, host: &str, port: u16) -> Result<Vec<SocketAddr>, String>;
}

struct SystemResolver;

#[async_trait]
impl AddressResolver for SystemResolver {
    async fn resolve(&self, host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
        tokio::net::lookup_host((host, port))
            .await
            .map(|addresses| addresses.collect())
            .map_err(|_| "plugin network host could not be resolved".to_owned())
    }
}

#[async_trait]
trait NetworkTransport: Send + Sync {
    async fn send(&self, request: PinnedRequest) -> Result<TransportResponse, String>;
}

struct ReqwestTransport;

#[async_trait]
impl NetworkTransport for ReqwestTransport {
    async fn send(&self, request: PinnedRequest) -> Result<TransportResponse, String> {
        // A fresh client per hop prevents connection pooling or a second DNS
        // lookup from escaping the addresses validated for this exact URL.
        let client = reqwest::Client::builder()
            .redirect(Policy::none())
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .connect_timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .resolve_to_addrs(&request.host, &request.addresses);
        let client = if is_local_backend_url(&request.url) {
            client.no_proxy()
        } else {
            client
        };
        let client = client
            .build()
            .map_err(|_| "plugin network client could not be created".to_owned())?;
        let is_head = request.method == reqwest::Method::HEAD;
        let mut builder = client.request(request.method, request.url);
        for (name, value) in request.headers {
            builder = builder.header(name, value);
        }
        if !request.body.is_empty() {
            builder = builder.body(request.body);
        }
        let mut response = builder.send().await.map_err(classify_reqwest)?;
        let status = response.status();
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let content_range = response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let content_length =
            transport_content_length(is_head, response.headers(), response.content_length());
        let mime_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let set_cookies = response
            .headers()
            .get_all(reqwest::header::SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if status.is_redirection() {
            return Ok(TransportResponse {
                status: status.as_u16(),
                location,
                body: Vec::new(),
                set_cookies,
                content_range,
                content_length,
                mime_type,
            });
        }
        if response
            .content_length()
            .is_some_and(|length| length > request.response_limit as u64)
        {
            return Err("plugin network response is too large".to_owned());
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(classify_reqwest)? {
            if body.len().saturating_add(chunk.len()) > request.response_limit {
                return Err("plugin network response is too large".to_owned());
            }
            body.extend_from_slice(&chunk);
        }
        Ok(TransportResponse {
            status: status.as_u16(),
            location,
            body,
            set_cookies,
            content_range,
            content_length,
            mime_type,
        })
    }
}

pub async fn proxy_request(
    allowed_origins: &HashSet<String>,
    payload: &Value,
) -> Result<Value, String> {
    proxy_request_with_limit(allowed_origins, payload, LEGACY_MAX_RESPONSE_BODY).await
}

fn transport_content_length(
    is_head: bool,
    headers: &reqwest::header::HeaderMap,
    body_length: Option<u64>,
) -> Option<u64> {
    if is_head {
        // HEAD has no body; its Content-Length describes the requested media.
        headers
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok()?.parse().ok())
    } else {
        body_length
    }
}

pub(crate) async fn proxy_component_request(
    allowed_origins: &HashSet<String>,
    payload: &Value,
    credential_headers: &[ComponentCredentialHeader],
) -> Result<Value, String> {
    proxy_request_with(
        allowed_origins,
        payload,
        COMPONENT_MAX_RESPONSE_BODY,
        credential_headers,
        &SystemResolver,
        &ReqwestTransport,
    )
    .await
}

pub(crate) async fn proxy_component_media_range(
    allowed_origins: &HashSet<String>,
    payload: &Value,
    credential_headers: &[ComponentCredentialHeader],
    offset: u64,
    length: usize,
) -> Result<ComponentMediaChunk, String> {
    if length == 0 || length > COMPONENT_MAX_RESPONSE_BODY {
        return Err("component media range is invalid".to_owned());
    }
    if payload
        .get("method")
        .and_then(Value::as_str)
        .is_some_and(|method| !method.eq_ignore_ascii_case("GET"))
        || payload
            .get("body")
            .and_then(Value::as_str)
            .is_some_and(|body| !body.is_empty())
    {
        return Err("component media requests must use GET without a body".to_owned());
    }
    let end = offset
        .checked_add(length as u64)
        .and_then(|value| value.checked_sub(1))
        .ok_or_else(|| "component media range is invalid".to_owned())?;
    let internal_headers = [
        ("accept-encoding".to_owned(), "identity".to_owned()),
        ("range".to_owned(), format!("bytes={offset}-{end}")),
    ];
    let response = proxy_raw_request_with(
        allowed_origins,
        payload,
        length,
        credential_headers,
        &internal_headers,
        &SystemResolver,
        &ReqwestTransport,
    )
    .await?;
    Ok(ComponentMediaChunk {
        status: response.status,
        body: response.body,
        content_range: response.content_range,
        content_length: response.content_length,
        mime_type: response.mime_type,
    })
}

pub(crate) async fn proxy_component_binary_request(
    allowed_origins: &HashSet<String>,
    payload: &Value,
    credential_headers: &[ComponentCredentialHeader],
    body: Vec<u8>,
) -> Result<ComponentBinaryResponse, String> {
    if body.len() > MAX_REQUEST_BODY {
        return Err("plugin network request body is too large".into());
    }
    let response = proxy_raw_request_with_body(
        allowed_origins,
        payload,
        COMPONENT_MAX_RESPONSE_BODY,
        credential_headers,
        &[],
        body,
        &SystemResolver,
        &ReqwestTransport,
    )
    .await?;
    Ok(ComponentBinaryResponse {
        status: response.status,
        body: response.body,
        content_range: response.content_range,
        content_length: response.content_length,
        mime_type: response.mime_type,
    })
}

async fn proxy_request_with_limit(
    allowed_origins: &HashSet<String>,
    payload: &Value,
    response_limit: usize,
) -> Result<Value, String> {
    proxy_request_with(
        allowed_origins,
        payload,
        response_limit,
        &[],
        &SystemResolver,
        &ReqwestTransport,
    )
    .await
}

async fn proxy_request_with(
    allowed_origins: &HashSet<String>,
    payload: &Value,
    response_limit: usize,
    credential_headers: &[ComponentCredentialHeader],
    resolver: &dyn AddressResolver,
    transport: &dyn NetworkTransport,
) -> Result<Value, String> {
    let response_fields = component_response_json_fields(payload)?;
    let response_limit = if payload.get("responseFormat").and_then(Value::as_str) == Some("image") {
        response_limit.min(MAX_COMPONENT_IMAGE_BYTES)
    } else {
        response_limit
    };
    let response = proxy_raw_request_with(
        allowed_origins,
        payload,
        response_limit,
        credential_headers,
        &[],
        resolver,
        transport,
    )
    .await?;
    let body = if (200..300).contains(&response.status)
        && payload.get("responseFormat").and_then(Value::as_str) == Some("image")
    {
        component_image_data_uri(&response.body, response.mime_type.as_deref())?
    } else {
        String::from_utf8_lossy(&response.body).into_owned()
    };
    let mut output = json!({
        "ok": (200..300).contains(&response.status),
        "status": response.status,
        "body": body,
        "setCookies": response.set_cookies,
        "contentLength": response.content_length,
        "mimeType": response.mime_type,
    });
    if (200..300).contains(&response.status)
        && payload.get("responseFormat").and_then(Value::as_str) == Some("json")
    {
        if let Ok(mut body) = serde_json::from_slice::<Value>(&response.body) {
            if let Some(fields) = &response_fields {
                retain_component_json_fields(&mut body, fields, 0)?;
            }
            output["bodyJson"] = body;
            if let Some(fields) = output.as_object_mut() {
                fields.remove("body");
            }
        }
    }
    Ok(output)
}

fn component_response_json_fields(payload: &Value) -> Result<Option<HashSet<String>>, String> {
    let Some(value) = payload.get("responseJsonFields") else {
        return Ok(None);
    };
    let invalid = || "component JSON response fields are invalid".to_owned();
    if payload.get("responseFormat").and_then(Value::as_str) != Some("json") {
        return Err(invalid());
    }
    let values = value
        .as_array()
        .filter(|values| !values.is_empty() && values.len() <= 128)
        .ok_or_else(invalid)?;
    let mut fields = HashSet::new();
    for value in values {
        let name = value
            .as_str()
            .filter(|name| {
                !name.is_empty() && name.len() <= 64 && !name.chars().any(char::is_control)
            })
            .ok_or_else(invalid)?;
        if !fields.insert(name.to_owned()) {
            return Err(invalid());
        }
    }
    Ok(Some(fields))
}

fn retain_component_json_fields(
    value: &mut Value,
    fields: &HashSet<String>,
    depth: usize,
) -> Result<(), String> {
    if depth > 64 {
        return Err("component JSON response is too deeply nested".to_owned());
    }
    match value {
        Value::Object(object) => {
            object.retain(|key, _| fields.contains(key));
            for value in object.values_mut() {
                retain_component_json_fields(value, fields, depth + 1)?;
            }
        }
        Value::Array(items) => {
            for value in items {
                retain_component_json_fields(value, fields, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn component_image_data_uri(bytes: &[u8], content_type: Option<&str>) -> Result<String, String> {
    if bytes.len() > MAX_COMPONENT_IMAGE_BYTES {
        return Err("component artwork response is too large".to_owned());
    }
    let content_type = content_type
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !matches!(
        content_type.as_str(),
        "image/png" | "image/jpeg" | "image/jpg" | "image/gif" | "image/webp"
    ) {
        return Err("component artwork response is not a supported raster image".to_owned());
    }
    // NetEase avatar CDNs can label PNG bytes as image/jpg. Keep accepting only
    // bounded raster responses, but derive the data URI type from the bytes.
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else {
        return Err("component artwork response is not a supported raster image".to_owned());
    };
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

async fn proxy_raw_request_with(
    allowed_origins: &HashSet<String>,
    payload: &Value,
    response_limit: usize,
    credential_headers: &[ComponentCredentialHeader],
    internal_headers: &[(String, String)],
    resolver: &dyn AddressResolver,
    transport: &dyn NetworkTransport,
) -> Result<TransportResponse, String> {
    let body = payload
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or("")
        .as_bytes()
        .to_vec();
    proxy_raw_request_with_body(
        allowed_origins,
        payload,
        response_limit,
        credential_headers,
        internal_headers,
        body,
        resolver,
        transport,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn proxy_raw_request_with_body(
    allowed_origins: &HashSet<String>,
    payload: &Value,
    response_limit: usize,
    credential_headers: &[ComponentCredentialHeader],
    internal_headers: &[(String, String)],
    body: Vec<u8>,
    resolver: &dyn AddressResolver,
    transport: &dyn NetworkTransport,
) -> Result<TransportResponse, String> {
    let method = payload
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("GET")
        .to_ascii_uppercase();
    match method.as_str() {
        "GET" | "POST" | "HEAD" => {}
        _ => return Err("plugin network method is not allowed".into()),
    }
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| "network method is invalid".to_owned())?;
    let url = payload
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| "network url is required".to_owned())?;
    if url.len() > MAX_URL_BYTES {
        return Err("plugin network url is too long".into());
    }
    if body.len() > MAX_REQUEST_BODY {
        return Err("plugin network request body is too large".into());
    }
    let headers = validate_headers(payload.get("headers"))?;
    let mut current = url.to_owned();
    let mut hops = 0_usize;
    loop {
        let parsed =
            reqwest::Url::parse(&current).map_err(|_| "network url is invalid".to_owned())?;
        deny_url(&parsed)?;
        let origin = origin_of(&parsed)?;
        if !origin_allowed(allowed_origins, &origin) {
            return Err("plugin network origin is not granted".into());
        }
        let host = parsed
            .host_str()
            .ok_or_else(|| "network host is required".to_owned())?
            .to_ascii_lowercase();
        let port = parsed.port_or_known_default().unwrap_or(443);
        let addresses = resolver.resolve(&host, port).await?;
        validate_resolved_addresses(&addresses, is_local_backend_url(&parsed))?;
        let mut hop_headers = headers.clone();
        hop_headers.extend_from_slice(internal_headers);
        for credential in credential_headers {
            if credential.origin != origin {
                return Err("component credential cannot follow a cross-origin redirect".into());
            }
            hop_headers.push((credential.name.clone(), credential.value.clone()));
        }
        let response = transport
            .send(PinnedRequest {
                method: method.clone(),
                url: parsed.clone(),
                host,
                addresses,
                headers: hop_headers,
                body: if method == reqwest::Method::GET || method == reqwest::Method::HEAD {
                    Vec::new()
                } else {
                    body.clone()
                },
                response_limit,
            })
            .await?;
        if (300..400).contains(&response.status) {
            hops += 1;
            if hops > MAX_REDIRECTS {
                return Err("plugin network redirected too many times".into());
            }
            let location = response
                .location
                .ok_or_else(|| "plugin network redirect is missing a location".to_owned())?;
            current = parsed
                .join(&location)
                .map_err(|_| "plugin network redirect is invalid".to_owned())?
                .to_string();
            if current.len() > MAX_URL_BYTES {
                return Err("plugin network url is too long".into());
            }
            continue;
        }
        if response.body.len() > response_limit {
            return Err("plugin network response is too large".into());
        }
        return Ok(response);
    }
}

pub(crate) fn component_request_origin(payload: &Value) -> Result<String, String> {
    let url = payload
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| "network url is required".to_owned())?;
    if url.len() > MAX_URL_BYTES {
        return Err("plugin network url is too long".into());
    }
    let parsed = reqwest::Url::parse(url).map_err(|_| "network url is invalid".to_owned())?;
    deny_url(&parsed)?;
    origin_of(&parsed)
}

pub(crate) fn origin_allowed(allowed_origins: &HashSet<String>, origin: &str) -> bool {
    if allowed_origins.contains(origin) {
        return true;
    }
    if !allowed_origins.contains("https://music.126.net") {
        return false;
    }
    let Some(host) = origin.strip_prefix("https://") else {
        return false;
    };
    host.ends_with(".music.126.net") && host.len() > "music.126.net".len() + 1
}

fn validate_headers(value: Option<&Value>) -> Result<Vec<(String, String)>, String> {
    let headers = value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut validated = Vec::with_capacity(headers.len());
    for (name, value) in headers {
        let header = name.to_ascii_lowercase();
        if !ALLOWED_REQUEST_HEADERS.contains(&header.as_str()) {
            return Err(format!("plugin network header {name} is not allowed"));
        }
        let text = value
            .as_str()
            .ok_or_else(|| "plugin network headers must be strings".to_owned())?;
        if text.len() > 240 || text.contains('\n') || text.contains('\r') {
            return Err("plugin network header is invalid".into());
        }
        if header == "kg-tid"
            && (!text.bytes().all(|byte| byte.is_ascii_digit())
                || !text.parse::<u16>().is_ok_and(|value| value > 0))
        {
            return Err("plugin protocol header is invalid".into());
        }
        validated.push((header, text.to_owned()));
    }
    Ok(validated)
}

fn origin_of(url: &reqwest::Url) -> Result<String, String> {
    if is_local_backend_url(url) {
        return Ok(LOCAL_BACKEND_ORIGIN.to_owned());
    }
    if url.scheme() != "https" {
        return Err("plugin network requests must use https".into());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "network host is required".to_owned())?;
    Ok(match url.port() {
        None | Some(443) => format!("https://{}", host.to_ascii_lowercase()),
        Some(port) => format!("https://{}:{port}", host.to_ascii_lowercase()),
    })
}

fn deny_url(url: &reqwest::Url) -> Result<(), String> {
    if !url.username().is_empty() || url.password().is_some() {
        return Err("plugin network urls cannot include credentials".into());
    }
    if url.fragment().is_some() {
        return Err("plugin network urls cannot include fragments".into());
    }
    if is_local_backend_url(url) {
        return Ok(());
    }
    if url.scheme() != "https" {
        return Err("plugin network requests must use https".into());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "network host is required".to_owned())?;
    if host.eq_ignore_ascii_case("localhost")
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.eq_ignore_ascii_case("metadata.google.internal")
    {
        return Err("plugin network host is not allowed".into());
    }
    if host.parse::<std::net::IpAddr>().is_ok() {
        return Err("plugin network IP literals are not allowed".into());
    }
    Ok(())
}

fn is_local_backend_url(url: &reqwest::Url) -> bool {
    url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(43821)
}

fn validate_resolved_addresses(
    addresses: &[SocketAddr],
    allow_local_backend: bool,
) -> Result<(), String> {
    if addresses.is_empty() {
        return Err("plugin network host could not be resolved".into());
    }
    if allow_local_backend {
        if addresses
            .iter()
            .all(|address| address.ip().to_string() == "127.0.0.1" && address.port() == 43821)
        {
            return Ok(());
        }
        return Err("plugin network resolved to an unexpected loopback address".into());
    }
    if addresses.iter().any(|address| is_blocked_ip(address.ip())) {
        return Err("plugin network resolved to a private or local address".into());
    }
    Ok(())
}

fn classify_reqwest(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "plugin network request timed out".into()
    } else if error.is_connect() {
        "plugin network connection failed".into()
    } else {
        "plugin network request failed".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::VecDeque, sync::Mutex};

    struct FakeResolver {
        answers: Mutex<VecDeque<Vec<SocketAddr>>>,
    }

    #[async_trait]
    impl AddressResolver for FakeResolver {
        async fn resolve(&self, _host: &str, _port: u16) -> Result<Vec<SocketAddr>, String> {
            self.answers
                .lock()
                .expect("resolver")
                .pop_front()
                .ok_or_else(|| "no resolver answer".to_owned())
        }
    }

    struct FakeTransport {
        responses: Mutex<VecDeque<TransportResponse>>,
        pinned: Mutex<Vec<Vec<SocketAddr>>>,
        headers: Mutex<Vec<Vec<(String, String)>>>,
    }

    #[async_trait]
    impl NetworkTransport for FakeTransport {
        async fn send(&self, request: PinnedRequest) -> Result<TransportResponse, String> {
            self.pinned.lock().expect("pinned").push(request.addresses);
            self.headers.lock().expect("headers").push(request.headers);
            self.responses
                .lock()
                .expect("responses")
                .pop_front()
                .ok_or_else(|| "no transport response".to_owned())
        }
    }

    fn public_address() -> SocketAddr {
        "1.1.1.1:443".parse().expect("public address")
    }

    #[test]
    fn head_metadata_reports_media_length_instead_of_the_empty_body() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(reqwest::header::CONTENT_LENGTH, "360492".parse().unwrap());
        assert_eq!(
            transport_content_length(true, &headers, Some(0)),
            Some(360492)
        );
        // GET uses the decoded body length, which can differ from the wire header.
        assert_eq!(
            transport_content_length(false, &headers, Some(1024)),
            Some(1024)
        );
        headers.clear();
        assert_eq!(transport_content_length(true, &headers, Some(0)), None);
        headers.insert(reqwest::header::CONTENT_LENGTH, "0".parse().unwrap());
        assert_eq!(transport_content_length(true, &headers, Some(0)), Some(0));
    }

    fn allowed(origins: &[&str]) -> HashSet<String> {
        origins.iter().map(|origin| (*origin).to_owned()).collect()
    }

    #[test]
    fn origin_normalization_strips_path() {
        let url = reqwest::Url::parse("https://API.Example.com/v1").unwrap();
        assert_eq!(origin_of(&url).unwrap(), "https://api.example.com");
        assert!(deny_url(&reqwest::Url::parse("http://api.example.com").unwrap()).is_err());
        assert!(deny_url(&reqwest::Url::parse("https://localhost").unwrap()).is_err());
        assert!(deny_url(&reqwest::Url::parse("https://169.254.169.254").unwrap()).is_err());
        assert!(deny_url(&reqwest::Url::parse("file:///etc/passwd").unwrap()).is_err());
        assert!(
            deny_url(&reqwest::Url::parse("https://user:pass@api.example.com").unwrap()).is_err()
        );
        assert!(
            deny_url(&reqwest::Url::parse("https://api.example.com/#secret").unwrap()).is_err()
        );
    }

    #[test]
    fn official_media_root_allows_only_its_subdomains() {
        let allowed = allowed(&["https://music.126.net"]);
        assert!(origin_allowed(&allowed, "https://m10.music.126.net"));
        assert!(origin_allowed(&allowed, "https://m801.music.126.net"));
        assert!(!origin_allowed(
            &allowed,
            "https://music.126.net.evil.example"
        ));
        assert!(!origin_allowed(&allowed, "https://example.com"));
    }

    #[test]
    fn loopback_backend_is_the_only_http_exception() {
        let local = reqwest::Url::parse("http://127.0.0.1:43821/v1").unwrap();
        assert_eq!(origin_of(&local).unwrap(), LOCAL_BACKEND_ORIGIN);
        assert!(deny_url(&local).is_ok());
        assert!(deny_url(&reqwest::Url::parse("http://127.0.0.1:43822").unwrap()).is_err());
        assert!(deny_url(&reqwest::Url::parse("http://localhost:43821").unwrap()).is_err());
        assert!(deny_url(&reqwest::Url::parse("http://10.0.0.1:43821").unwrap()).is_err());
        assert!(
            deny_url(&reqwest::Url::parse("http://127.0.0.1:43821@evil.example").unwrap()).is_err()
        );
        assert!(validate_resolved_addresses(&["127.0.0.1:43821".parse().unwrap()], true).is_ok());
        assert!(validate_resolved_addresses(&["127.0.0.2:43821".parse().unwrap()], true).is_err());
        assert!(validate_resolved_addresses(&["127.0.0.1:43822".parse().unwrap()], true).is_err());
    }

    #[tokio::test]
    async fn validated_dns_addresses_are_the_addresses_given_to_transport() {
        let resolver = FakeResolver {
            answers: Mutex::new(VecDeque::from([vec![public_address()]])),
        };
        let transport = FakeTransport {
            responses: Mutex::new(VecDeque::from([TransportResponse {
                status: 200,
                location: None,
                body: b"ok".to_vec(),
                set_cookies: Vec::new(),
                content_range: None,
                content_length: Some(2),
                mime_type: None,
            }])),
            pinned: Mutex::new(Vec::new()),
            headers: Mutex::new(Vec::new()),
        };
        let result = proxy_request_with(
            &allowed(&["https://api.example.com"]),
            &json!({ "url": "https://api.example.com/v1" }),
            1024,
            &[],
            &resolver,
            &transport,
        )
        .await
        .expect("request");
        assert_eq!(result["body"], "ok");
        assert_eq!(
            transport.pinned.lock().expect("pinned").as_slice(),
            &[vec![public_address()]]
        );
    }

    #[tokio::test]
    async fn every_redirect_rechecks_origin_and_dns_before_transport() {
        let resolver = FakeResolver {
            answers: Mutex::new(VecDeque::from([
                vec![public_address()],
                vec!["127.0.0.1:443".parse().expect("local")],
            ])),
        };
        let transport = FakeTransport {
            responses: Mutex::new(VecDeque::from([TransportResponse {
                status: 302,
                location: Some("https://cdn.example.com/private".to_owned()),
                body: Vec::new(),
                set_cookies: Vec::new(),
                content_range: None,
                content_length: Some(0),
                mime_type: None,
            }])),
            pinned: Mutex::new(Vec::new()),
            headers: Mutex::new(Vec::new()),
        };
        let error = proxy_request_with(
            &allowed(&["https://api.example.com", "https://cdn.example.com"]),
            &json!({ "url": "https://api.example.com/start" }),
            1024,
            &[],
            &resolver,
            &transport,
        )
        .await
        .unwrap_err();
        assert!(error.contains("private or local"));
        assert_eq!(transport.pinned.lock().expect("pinned").len(), 1);
    }

    #[tokio::test]
    async fn ungranted_redirect_and_oversized_body_fail_closed() {
        let resolver = FakeResolver {
            answers: Mutex::new(VecDeque::from([vec![public_address()]])),
        };
        let transport = FakeTransport {
            responses: Mutex::new(VecDeque::from([TransportResponse {
                status: 302,
                location: Some("https://other.example.com/path".to_owned()),
                body: Vec::new(),
                set_cookies: Vec::new(),
                content_range: None,
                content_length: Some(0),
                mime_type: None,
            }])),
            pinned: Mutex::new(Vec::new()),
            headers: Mutex::new(Vec::new()),
        };
        let error = proxy_request_with(
            &allowed(&["https://api.example.com"]),
            &json!({ "url": "https://api.example.com/start" }),
            4,
            &[],
            &resolver,
            &transport,
        )
        .await
        .unwrap_err();
        assert!(error.contains("not granted"));

        let resolver = FakeResolver {
            answers: Mutex::new(VecDeque::from([vec![public_address()]])),
        };
        let transport = FakeTransport {
            responses: Mutex::new(VecDeque::from([TransportResponse {
                status: 200,
                location: None,
                body: b"oversized".to_vec(),
                set_cookies: Vec::new(),
                content_range: None,
                content_length: Some(9),
                mime_type: None,
            }])),
            pinned: Mutex::new(Vec::new()),
            headers: Mutex::new(Vec::new()),
        };
        let error = proxy_request_with(
            &allowed(&["https://api.example.com"]),
            &json!({ "url": "https://api.example.com/start" }),
            4,
            &[],
            &resolver,
            &transport,
        )
        .await
        .unwrap_err();
        assert!(error.contains("too large"));
    }

    #[tokio::test]
    async fn credential_headers_are_bound_to_the_exact_request_origin() {
        let resolver = FakeResolver {
            answers: Mutex::new(VecDeque::from([vec![public_address()]])),
        };
        let transport = FakeTransport {
            responses: Mutex::new(VecDeque::from([TransportResponse {
                status: 200,
                location: None,
                body: b"ok".to_vec(),
                set_cookies: Vec::new(),
                content_range: None,
                content_length: Some(2),
                mime_type: None,
            }])),
            pinned: Mutex::new(Vec::new()),
            headers: Mutex::new(Vec::new()),
        };
        let credential = ComponentCredentialHeader {
            origin: "https://api.example.com".to_owned(),
            name: "authorization".to_owned(),
            value: "Bearer synthetic".to_owned(),
        };
        proxy_request_with(
            &allowed(&["https://api.example.com"]),
            &json!({ "url": "https://api.example.com/v1" }),
            1024,
            std::slice::from_ref(&credential),
            &resolver,
            &transport,
        )
        .await
        .expect("same-origin credential request");
        assert_eq!(
            transport.headers.lock().expect("headers").as_slice(),
            &[vec![(
                "authorization".to_owned(),
                "Bearer synthetic".to_owned()
            )]]
        );

        let resolver = FakeResolver {
            answers: Mutex::new(VecDeque::from([vec![public_address()]])),
        };
        let transport = FakeTransport {
            responses: Mutex::new(VecDeque::new()),
            pinned: Mutex::new(Vec::new()),
            headers: Mutex::new(Vec::new()),
        };
        let error = proxy_request_with(
            &allowed(&["https://cdn.example.com"]),
            &json!({ "url": "https://cdn.example.com/v1" }),
            1024,
            &[credential],
            &resolver,
            &transport,
        )
        .await
        .unwrap_err();
        assert!(error.contains("cross-origin"));
        assert!(transport.headers.lock().expect("headers").is_empty());
    }

    #[tokio::test]
    async fn json_response_format_preserves_metadata_and_legacy_error_bodies() {
        for (status, body, structured) in [
            (200, r#"{"title":"屋顶","items":[1,2]}"#, true),
            (200, "not json", false),
            (403, r#"{"error":"access_denied"}"#, false),
        ] {
            let resolver = FakeResolver {
                answers: Mutex::new(VecDeque::from([vec![public_address()]])),
            };
            let transport = FakeTransport {
                responses: Mutex::new(VecDeque::from([TransportResponse {
                    status,
                    location: None,
                    body: body.as_bytes().to_vec(),
                    set_cookies: vec!["session=synthetic".to_owned()],
                    content_range: None,
                    content_length: Some(body.len() as u64),
                    mime_type: Some("application/json".to_owned()),
                }])),
                pinned: Mutex::new(Vec::new()),
                headers: Mutex::new(Vec::new()),
            };
            let response = proxy_request_with(
                &allowed(&["https://api.example.com"]),
                &json!({"url": "https://api.example.com/search", "responseFormat": "json"}),
                1024,
                &[],
                &resolver,
                &transport,
            )
            .await
            .unwrap();
            assert_eq!(response["status"], status);
            assert_eq!(response["contentLength"], body.len() as u64);
            assert_eq!(response["setCookies"], json!(["session=synthetic"]));
            if structured {
                assert_eq!(response["bodyJson"]["title"], "屋顶");
                assert!(response.get("body").is_none());
            } else {
                assert_eq!(response["body"], body);
                assert!(response.get("bodyJson").is_none());
            }
        }
    }

    #[test]
    fn json_response_field_selection_preserves_arrays_and_rejects_invalid_selectors() {
        let payload =
            json!({"responseFormat":"json", "responseJsonFields":["data","songs","name","ot"]});
        let fields = component_response_json_fields(&payload).unwrap().unwrap();
        let mut value = json!({"data":{"songs":[{"name":"Song","ot":42,"tracking":{"name":"discard"}}]},"tracking":"discard"});
        retain_component_json_fields(&mut value, &fields, 0).unwrap();
        assert_eq!(value, json!({"data":{"songs":[{"name":"Song","ot":42}]}}));
        for selector in [
            json!([]),
            json!(["name", "name"]),
            json!([3]),
            json!(["x".repeat(65)]),
            json!(["field\n"]),
        ] {
            assert!(component_response_json_fields(
                &json!({"responseFormat":"json","responseJsonFields":selector})
            )
            .is_err());
        }
        assert!(component_response_json_fields(&json!({"responseJsonFields":["data"]})).is_err());
        assert!(component_response_json_fields(&json!({}))
            .unwrap()
            .is_none());
        assert!(retain_component_json_fields(&mut value, &fields, 65).is_err());
    }

    #[test]
    fn component_images_require_bounded_raster_bytes_and_supported_declared_types() {
        let png = b"\x89PNG\r\n\x1a\nsynthetic";
        let encoded = component_image_data_uri(png, Some("image/png; charset=binary")).unwrap();
        assert_eq!(
            encoded,
            format!("data:image/png;base64,{}", STANDARD.encode(png))
        );
        assert!(component_image_data_uri(png, Some("image/svg+xml")).is_err());
        assert!(component_image_data_uri(png, Some("text/html")).is_err());
        assert!(component_image_data_uri(b"<svg/>", Some("image/svg+xml")).is_err());
        assert!(component_image_data_uri(b"<html/>", Some("image/png")).is_err());
        assert!(component_image_data_uri(png, None).is_err());
        assert!(
            component_image_data_uri(&[0xff, 0xd8, 0xff, 0], Some("IMAGE/JPG"))
                .unwrap()
                .starts_with("data:image/jpeg;base64,")
        );
        let mut oversized = png.to_vec();
        oversized.resize(MAX_COMPONENT_IMAGE_BYTES + 1, 0);
        assert!(component_image_data_uri(&oversized, Some("image/png")).is_err());
    }

    #[test]
    fn component_images_use_actual_raster_format_when_cdn_mime_is_wrong() {
        let png = b"\x89PNG\r\n\x1a\nsynthetic";
        for declared in ["image/jpg", "image/jpeg", "IMAGE/JPG; charset=binary"] {
            assert_eq!(
                component_image_data_uri(png, Some(declared)).unwrap(),
                format!("data:image/png;base64,{}", STANDARD.encode(png))
            );
        }
        let jpeg = &[0xff, 0xd8, 0xff, 0];
        assert_eq!(
            component_image_data_uri(jpeg, Some("image/png")).unwrap(),
            format!("data:image/jpeg;base64,{}", STANDARD.encode(jpeg))
        );
        assert!(component_image_data_uri(b"<svg/>", Some("image/jpg")).is_err());
        assert!(component_image_data_uri(b"<html/>", Some("image/jpeg")).is_err());
    }

    #[tokio::test]
    async fn image_response_format_keeps_binary_bytes_and_origin_fences() {
        let png = b"\x89PNG\r\n\x1a\nsynthetic";
        let resolver = FakeResolver {
            answers: Mutex::new(VecDeque::from([vec![public_address()]])),
        };
        let transport = FakeTransport {
            responses: Mutex::new(VecDeque::from([TransportResponse {
                status: 200,
                location: None,
                body: png.to_vec(),
                set_cookies: Vec::new(),
                content_range: None,
                content_length: Some(png.len() as u64),
                mime_type: Some("image/jpg".to_owned()),
            }])),
            pinned: Mutex::new(Vec::new()),
            headers: Mutex::new(Vec::new()),
        };
        let request = json!({"url": "https://images.example.com/cover", "responseFormat": "image"});
        assert!(
            proxy_request_with(&allowed(&[]), &request, 1024, &[], &resolver, &transport)
                .await
                .is_err()
        );
        let response = proxy_request_with(
            &allowed(&["https://images.example.com"]),
            &request,
            1024,
            &[],
            &resolver,
            &transport,
        )
        .await
        .unwrap();
        assert_eq!(
            response["body"],
            format!("data:image/png;base64,{}", STANDARD.encode(png))
        );
        assert_eq!(response["contentLength"], png.len());
        assert!(response.get("bodyJson").is_none());
    }

    #[tokio::test]
    async fn media_ranges_remain_binary_and_use_only_host_injected_range_headers() {
        let resolver = FakeResolver {
            answers: Mutex::new(VecDeque::from([vec![public_address()]])),
        };
        let transport = FakeTransport {
            responses: Mutex::new(VecDeque::from([TransportResponse {
                status: 206,
                location: None,
                body: vec![0xff, 0x00, 0x7f],
                set_cookies: Vec::new(),
                content_range: Some("bytes 3-5/9".to_owned()),
                content_length: Some(3),
                mime_type: Some("audio/mpeg".to_owned()),
            }])),
            pinned: Mutex::new(Vec::new()),
            headers: Mutex::new(Vec::new()),
        };
        let internal = [
            ("accept-encoding".to_owned(), "identity".to_owned()),
            ("range".to_owned(), "bytes=3-5".to_owned()),
        ];
        let response = proxy_raw_request_with(
            &allowed(&["https://media.example.com"]),
            &json!({ "url": "https://media.example.com/song" }),
            3,
            &[],
            &internal,
            &resolver,
            &transport,
        )
        .await
        .expect("media range");
        assert_eq!(response.body, vec![0xff, 0x00, 0x7f]);
        assert_eq!(response.content_range.as_deref(), Some("bytes 3-5/9"));
        assert_eq!(response.mime_type.as_deref(), Some("audio/mpeg"));
        assert_eq!(
            transport.headers.lock().expect("headers").as_slice(),
            &[internal.to_vec()]
        );
    }

    #[test]
    fn kugou_protocol_header_is_numeric_and_does_not_allow_ambient_credentials() {
        assert!(validate_headers(Some(&serde_json::json!({"kg-tid":"255"}))).is_ok());
        for headers in [
            serde_json::json!({"kg-tid":"0"}),
            serde_json::json!({"kg-tid":"65536"}),
            serde_json::json!({"kg-tid":"255\r\nCookie:x"}),
            serde_json::json!({"cookie":"x"}),
            serde_json::json!({"authorization":"x"}),
        ] {
            assert!(validate_headers(Some(&headers)).is_err());
        }
    }

    #[tokio::test]
    async fn spotify_web_protocol_headers_reach_transport_with_bound_credentials() {
        for (url, header, credential_name) in [
            (
                "https://open.spotify.com/api/token",
                ("referer", "https://open.spotify.com/"),
                "cookie",
            ),
            (
                "https://api-partner.spotify.com/pathfinder/v2/query",
                ("app-platform", "WebPlayer"),
                "client-token",
            ),
            (
                "https://guc3-spclient.spotify.com/widevine-license/v1/audio/license",
                ("origin", "https://open.spotify.com"),
                "client-token",
            ),
        ] {
            let origin = component_request_origin(&json!({"url": url})).unwrap();
            let resolver = FakeResolver {
                answers: Mutex::new(VecDeque::from([vec![public_address()]])),
            };
            let transport = FakeTransport {
                responses: Mutex::new(VecDeque::from([TransportResponse {
                    status: 200,
                    location: None,
                    body: b"{}".to_vec(),
                    set_cookies: Vec::new(),
                    content_range: None,
                    content_length: Some(2),
                    mime_type: Some("application/json".to_owned()),
                }])),
                pinned: Mutex::new(Vec::new()),
                headers: Mutex::new(Vec::new()),
            };
            let credential = ComponentCredentialHeader {
                origin: origin.clone(),
                name: credential_name.to_owned(),
                value: "synthetic".to_owned(),
            };
            proxy_request_with(
                &allowed(&[&origin]),
                &json!({"url": url, "headers": {header.0: header.1}}),
                1024,
                &[credential],
                &resolver,
                &transport,
            )
            .await
            .expect("Spotify protocol headers must reach the network transport");
            let sent = transport.headers.lock().expect("headers");
            assert!(sent[0].contains(&(header.0.to_owned(), header.1.to_owned())));
            assert!(sent[0].contains(&(credential_name.to_owned(), "synthetic".to_owned())));
            assert!(validate_headers(Some(&json!({credential_name: "synthetic"}))).is_err());
        }
    }
}
