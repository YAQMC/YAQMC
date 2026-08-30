use crate::plugin::permissions::is_blocked_ip;
use async_trait::async_trait;
use reqwest::redirect::Policy;
use serde_json::{json, Value};
use std::{collections::HashSet, net::SocketAddr, time::Duration};

const MAX_REQUEST_BODY: usize = 256 * 1024;
const LEGACY_MAX_RESPONSE_BODY: usize = 1024 * 1024;
pub const COMPONENT_MAX_RESPONSE_BODY: usize = 4 * 1024 * 1024;
const MAX_REDIRECTS: usize = 3;
const MAX_URL_BYTES: usize = 4096;
const REQUEST_TIMEOUT_SECS: u64 = 10;

const ALLOWED_REQUEST_HEADERS: &[&str] = &["accept", "content-type", "user-agent"];

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
    body: String,
    response_limit: usize,
}

struct TransportResponse {
    status: u16,
    location: Option<String>,
    body: Vec<u8>,
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
            .resolve_to_addrs(&request.host, &request.addresses)
            .build()
            .map_err(|_| "plugin network client could not be created".to_owned())?;
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
        if status.is_redirection() {
            return Ok(TransportResponse {
                status: status.as_u16(),
                location,
                body: Vec::new(),
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
        })
    }
}

pub async fn proxy_request(
    allowed_origins: &HashSet<String>,
    payload: &Value,
) -> Result<Value, String> {
    proxy_request_with_limit(allowed_origins, payload, LEGACY_MAX_RESPONSE_BODY).await
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
    let body = payload.get("body").and_then(Value::as_str).unwrap_or("");
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
        if !allowed_origins.contains(&origin) {
            return Err("plugin network origin is not granted".into());
        }
        let host = parsed
            .host_str()
            .ok_or_else(|| "network host is required".to_owned())?
            .to_ascii_lowercase();
        let port = parsed.port_or_known_default().unwrap_or(443);
        let addresses = resolver.resolve(&host, port).await?;
        validate_resolved_addresses(&addresses)?;
        let mut hop_headers = headers.clone();
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
                    String::new()
                } else {
                    body.to_owned()
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
        return Ok(json!({
            "ok": (200..300).contains(&response.status),
            "status": response.status,
            "body": String::from_utf8_lossy(&response.body),
        }));
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
        validated.push((header, text.to_owned()));
    }
    Ok(validated)
}

fn origin_of(url: &reqwest::Url) -> Result<String, String> {
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
    if url.scheme() != "https" {
        return Err("plugin network requests must use https".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("plugin network urls cannot include credentials".into());
    }
    if url.fragment().is_some() {
        return Err("plugin network urls cannot include fragments".into());
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

fn validate_resolved_addresses(addresses: &[SocketAddr]) -> Result<(), String> {
    if addresses.is_empty() {
        return Err("plugin network host could not be resolved".into());
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
}
