//! `ApiTransport` backed by YAQMC's reqwest **0.13.4**.
//!
//! Mirrors qm-api-rs `ReqwestApiTransport` controls (timeout, host allowlist,
//! cancellation, retry class, validated redirects) without using the library's
//! private reqwest 0.12 client.

use std::{sync::Mutex, time::Duration};

use qqmusic_api::{
    ApiTransport, CancellationToken, HttpBody, HttpMethod, NetworkError, NetworkErrorKind, QmError,
    RedirectMode, RetryClass, TransportConfig, TransportRequest, TransportResponse,
};
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue},
    Client, Url,
};

const PRODUCTION_HOSTS: &[&str] = &[
    "u.y.qq.com",
    "c.y.qq.com",
    "c6.y.qq.com",
    "api.tencentmusic.com",
    "ssl.ptlogin2.qq.com",
    "ssl.ptlogin2.graph.qq.com",
    "xui.ptlogin2.qq.com",
    "graph.qq.com",
    "y.qq.com",
    "open.weixin.qq.com",
    "lp.open.weixin.qq.com",
];

pub(crate) struct YaqmcReqwestTransport {
    client: Client,
    config: TransportConfig,
    extra_origins: Mutex<Vec<String>>,
}

impl std::fmt::Debug for YaqmcReqwestTransport {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("YaqmcReqwestTransport")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

impl YaqmcReqwestTransport {
    pub(crate) fn new(config: TransportConfig) -> Result<Self, QmError> {
        let mut builder = Client::builder()
            .gzip(true)
            .brotli(true)
            .cookie_store(true)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(config.connect_timeout)
            .timeout(config.total_timeout);
        if let Some(proxy) = &config.proxy {
            let proxy = reqwest::Proxy::all(proxy).map_err(map_reqwest_error)?;
            builder = builder.proxy(proxy);
        }
        let client = builder.build().map_err(map_reqwest_error)?;
        Ok(Self {
            client,
            config,
            extra_origins: Mutex::new(Vec::new()),
        })
    }

    fn extras(&self) -> Vec<String> {
        self.extra_origins
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn validate(&self, url: &Url) -> Result<(), QmError> {
        validate_url(url, &self.extras())
    }

    async fn execute_attempt(
        &self,
        request: &TransportRequest,
        start_url: &Url,
    ) -> Result<TransportResponse, QmError> {
        let mut current_url = start_url.clone();
        let mut method = request.method;
        let mut headers = request.headers.clone();
        ensure_yqq_cgi_headers(start_url, &mut headers);
        let mut body = request.body.clone();
        let mut hops = 0_usize;

        loop {
            self.validate(&current_url)?;
            let response = self
                .send(
                    method,
                    current_url.clone(),
                    &headers,
                    &body,
                    request.timeout,
                    &request.cancellation,
                )
                .await?;
            let status = response.status().as_u16();

            if request.redirects == RedirectMode::FollowValidated && is_redirect_status(status) {
                if let Some(location) = header_value(response.headers(), "location") {
                    if hops >= self.config.max_redirects {
                        return Err(network_kind(
                            NetworkErrorKind::Redirect,
                            "too many redirects",
                        ));
                    }
                    let next = current_url.join(&location).map_err(|error| {
                        QmError::ValueError(format!("invalid redirect: {error}"))
                    })?;
                    self.validate(&next)?;
                    if !same_origin(&current_url, &next) {
                        strip_secret_headers(&mut headers);
                    }
                    if redirects_as_get(status, method) {
                        method = HttpMethod::Get;
                        body = HttpBody::Empty;
                        strip_entity_headers(&mut headers);
                    }
                    strip_hop_headers(&mut headers);
                    current_url = next;
                    hops += 1;
                    continue;
                }
            }

            let response_headers = headers_from_reqwest(response.headers());
            let body_bytes = collect_body(response, &request.cancellation).await?;
            return Ok(TransportResponse {
                status,
                final_url: current_url.to_string(),
                headers: response_headers,
                body: body_bytes,
            });
        }
    }

    async fn send(
        &self,
        method: HttpMethod,
        url: Url,
        headers: &[(String, String)],
        body: &HttpBody,
        timeout: Option<Duration>,
        cancellation: &CancellationToken,
    ) -> Result<reqwest::Response, QmError> {
        if cancellation.is_cancelled() {
            return Err(cancelled());
        }
        let mut builder = self
            .client
            .request(to_reqwest_method(method), url)
            .headers(to_header_map(headers));
        builder = apply_body(builder, body);
        builder = builder.timeout(timeout.unwrap_or(self.config.total_timeout));

        tokio::select! {
            biased;
            () = cancellation.cancelled() => Err(cancelled()),
            response = builder.send() => response.map_err(map_reqwest_error),
        }
    }
}

#[async_trait::async_trait]
impl ApiTransport for YaqmcReqwestTransport {
    async fn execute(&self, request: TransportRequest) -> qqmusic_api::Result<TransportResponse> {
        let mut url = Url::parse(&request.url)
            .map_err(|error| QmError::ValueError(format!("invalid url: {error}")))?;
        if !request.query.is_empty() {
            let mut pairs = url.query_pairs_mut();
            for (key, value) in &request.query {
                pairs.append_pair(key, value);
            }
        }
        self.validate(&url)?;

        let max_extra = match request.retry {
            RetryClass::SafeRead => self.config.retry_max,
            RetryClass::AuthPoll | RetryClass::Write => 0,
        };
        let mut extra_used = 0_u32;
        loop {
            match self.execute_attempt(&request, &url).await {
                Ok(response)
                    if extra_used < max_extra
                        && request.retry == RetryClass::SafeRead
                        && is_retryable_status(response.status) =>
                {
                    extra_used += 1;
                    sleep_or_cancel(&request, self.config.retry_delay).await?;
                }
                Ok(response) => return Ok(response),
                Err(error)
                    if extra_used < max_extra
                        && request.retry == RetryClass::SafeRead
                        && error.is_retryable() =>
                {
                    extra_used += 1;
                    sleep_or_cancel(&request, self.config.retry_delay).await?;
                }
                Err(error) => return Err(error),
            }
        }
    }

    fn allow_origin(&self, origin: &str) {
        let Some(origin) = parse_origin_input(origin) else {
            return;
        };
        let mut extras = self
            .extra_origins
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !extras.contains(&origin) {
            extras.push(origin);
        }
    }
}

pub(crate) fn qmapi_transport(
    config: TransportConfig,
) -> Result<std::sync::Arc<dyn ApiTransport>, QmError> {
    Ok(std::sync::Arc::new(YaqmcReqwestTransport::new(config)?))
}

fn origin_of(url: &Url) -> String {
    let host = match url.host_str() {
        Some(host) if host.contains(':') => format!("[{host}]"),
        Some(host) => host.to_string(),
        None => String::new(),
    };
    match url.port() {
        Some(port) => format!("{}://{}:{port}", url.scheme(), host),
        None => format!("{}://{}", url.scheme(), host),
    }
}

fn parse_origin_input(value: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    url.host_str()?;
    Some(origin_of(&url))
}

fn is_allowed_host(host: &str) -> bool {
    if PRODUCTION_HOSTS.contains(&host) {
        return true;
    }
    host.ends_with(".stream.qqmusic.qq.com")
        || host.ends_with(".music.tc.qq.com")
        || host.ends_with(".gtimg.cn")
        || (host.ends_with(".myqcloud.com") && host.contains(".cos."))
}

fn validate_url(url: &Url, extra_origins: &[String]) -> Result<(), QmError> {
    if !url.username().is_empty() || url.password().is_some() {
        return Err(allowlist_denied("<userinfo>"));
    }
    let host = url.host_str().unwrap_or("");
    if host.is_empty() {
        return Err(allowlist_denied("<missing-host>"));
    }
    if url.scheme() == "https" && is_allowed_host(host) {
        return Ok(());
    }
    let origin = origin_of(url);
    if extra_origins.iter().any(|extra| extra == &origin) {
        return Ok(());
    }
    Err(allowlist_denied(host))
}

fn form_pairs(value: &serde_json::Value) -> Vec<(String, String)> {
    match value {
        serde_json::Value::Object(map) => map
            .iter()
            .map(|(key, value)| {
                let flattened = match value {
                    serde_json::Value::String(text) => text.clone(),
                    serde_json::Value::Number(number) => number.to_string(),
                    serde_json::Value::Bool(flag) => flag.to_string(),
                    other => other.to_string(),
                };
                (key.clone(), flattened)
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn is_redirect_status(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

fn redirects_as_get(status: u16, method: HttpMethod) -> bool {
    matches!(status, 301..=303) && !matches!(method, HttpMethod::Get | HttpMethod::Head)
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host() == right.host()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn is_retryable_status(status: u16) -> bool {
    status == 429 || status >= 500
}

async fn sleep_or_cancel(request: &TransportRequest, delay: Duration) -> Result<(), QmError> {
    tokio::select! {
        biased;
        () = request.cancellation.cancelled() => Err(cancelled()),
        () = tokio::time::sleep(delay) => Ok(()),
    }
}

async fn collect_body(
    response: reqwest::Response,
    cancellation: &CancellationToken,
) -> Result<Vec<u8>, QmError> {
    tokio::select! {
        biased;
        () = cancellation.cancelled() => Err(cancelled()),
        body = response.bytes() => body
            .map(|bytes| bytes.to_vec())
            .map_err(map_reqwest_error),
    }
}

fn to_reqwest_method(method: HttpMethod) -> reqwest::Method {
    match method {
        HttpMethod::Get => reqwest::Method::GET,
        HttpMethod::Post => reqwest::Method::POST,
        HttpMethod::Put => reqwest::Method::PUT,
        HttpMethod::Head => reqwest::Method::HEAD,
        HttpMethod::Delete => reqwest::Method::DELETE,
        HttpMethod::Patch => reqwest::Method::PATCH,
    }
}

fn to_header_map(headers: &[(String, String)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (key, value) in headers {
        let Ok(name) = HeaderName::from_bytes(key.as_bytes()) else {
            continue;
        };
        let Ok(header_value) = HeaderValue::from_str(value) else {
            continue;
        };
        map.append(name, header_value);
    }
    map
}

fn headers_from_reqwest(map: &HeaderMap) -> Vec<(String, String)> {
    map.iter()
        .map(|(key, value)| {
            (
                key.as_str().to_string(),
                String::from_utf8_lossy(value.as_bytes()).into_owned(),
            )
        })
        .collect()
}

fn header_value(map: &HeaderMap, name: &str) -> Option<String> {
    map.get(name)
        .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned())
}

fn apply_body(builder: reqwest::RequestBuilder, body: &HttpBody) -> reqwest::RequestBuilder {
    match body {
        HttpBody::Empty => builder,
        HttpBody::Json(value) => builder.json(value),
        HttpBody::Form(value) => {
            let encoded = form_pairs(value)
                .into_iter()
                .map(|(key, value)| {
                    format!(
                        "{}={}",
                        form_urlencoded_component(&key),
                        form_urlencoded_component(&value)
                    )
                })
                .collect::<Vec<_>>()
                .join("&");
            builder
                .header(
                    reqwest::header::CONTENT_TYPE,
                    "application/x-www-form-urlencoded",
                )
                .body(encoded)
        }
        HttpBody::Bytes(bytes) => builder.body(bytes.clone()),
    }
}

fn form_urlencoded_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(byte as char);
            }
            b' ' => encoded.push('+'),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn strip_hop_headers(headers: &mut Vec<(String, String)>) {
    headers.retain(|(key, _)| {
        !key.eq_ignore_ascii_case("host")
            && !key.eq_ignore_ascii_case("content-length")
            && !key.eq_ignore_ascii_case("transfer-encoding")
    });
}

fn strip_entity_headers(headers: &mut Vec<(String, String)>) {
    headers.retain(|(key, _)| {
        !key.eq_ignore_ascii_case("content-type")
            && !key.eq_ignore_ascii_case("content-length")
            && !key.eq_ignore_ascii_case("content-encoding")
    });
}

fn has_header(headers: &[(String, String)], name: &str) -> bool {
    headers
        .iter()
        .any(|(key, _)| key.eq_ignore_ascii_case(name))
}

/// In-tree QQ Music CGI always sends these. Pin `dcddabc` also writes them on
/// library `request_cgi`. Fill only when missing so ptlogin Referer is kept and
/// older pins still work. Without Referer, `GetPlayLyricInfo` returned CGI 24001.
fn ensure_yqq_cgi_headers(url: &Url, headers: &mut Vec<(String, String)>) {
    let host = url.host_str().unwrap_or("");
    if !matches!(host, "u.y.qq.com" | "c.y.qq.com" | "c6.y.qq.com") {
        return;
    }
    if !has_header(headers, "referer") {
        headers.push(("Referer".into(), "https://y.qq.com/".into()));
    }
    if !has_header(headers, "origin") {
        headers.push(("Origin".into(), "https://y.qq.com".into()));
    }
}

fn strip_secret_headers(headers: &mut Vec<(String, String)>) {
    headers.retain(|(key, _)| {
        !key.eq_ignore_ascii_case("cookie")
            && !key.eq_ignore_ascii_case("authorization")
            && !key.eq_ignore_ascii_case("x-cos-security-token")
    });
}

fn map_reqwest_error(error: reqwest::Error) -> QmError {
    let kind = if error.is_timeout() {
        NetworkErrorKind::Timeout
    } else if error.is_connect() {
        NetworkErrorKind::Connect
    } else if error.is_builder() {
        NetworkErrorKind::Builder
    } else if error.is_redirect() {
        NetworkErrorKind::Redirect
    } else if error.is_body() || error.is_decode() {
        NetworkErrorKind::Body
    } else {
        NetworkErrorKind::Other
    };
    network_kind(kind, error.to_string())
}

fn network_kind(kind: NetworkErrorKind, message: impl Into<String>) -> QmError {
    QmError::Network(NetworkError {
        kind,
        message: message.into(),
    })
}

fn cancelled() -> QmError {
    network_kind(NetworkErrorKind::Cancelled, "request cancelled")
}

fn allowlist_denied(host: &str) -> QmError {
    QmError::Protocol {
        stage: "allowlist",
        message: format!("host not allowed: {host}"),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicU32, Ordering},
        Arc,
    };

    use axum::{
        http::{header::LOCATION, StatusCode},
        response::IntoResponse,
        routing::get,
        Router,
    };
    use qqmusic_api::TransportRequest;

    use super::*;

    async fn spawn_router(app: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock transport listener");
        let addr = listener.local_addr().expect("listener address");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve mock");
        });
        format!("http://{addr}")
    }

    fn transport_for(base: &str, config: TransportConfig) -> YaqmcReqwestTransport {
        let transport = YaqmcReqwestTransport::new(config).expect("reqwest 0.13 transport");
        transport.allow_origin(base);
        transport
    }

    #[test]
    fn u_y_qq_cgi_gets_referer_and_origin_when_missing() {
        let url = Url::parse("https://u.y.qq.com/cgi-bin/musicu.fcg").expect("url");
        let mut headers = vec![("User-Agent".into(), "x".into())];
        ensure_yqq_cgi_headers(&url, &mut headers);
        assert!(headers.iter().any(
            |(key, value)| key.eq_ignore_ascii_case("referer") && value == "https://y.qq.com/"
        ));
        assert!(headers
            .iter()
            .any(|(key, value)| key.eq_ignore_ascii_case("origin") && value == "https://y.qq.com"));
    }

    #[test]
    fn existing_ptlogin_referer_is_not_replaced() {
        let url = Url::parse("https://u.y.qq.com/cgi-bin/musicu.fcg").expect("url");
        let mut headers = vec![("Referer".into(), "https://xui.ptlogin2.qq.com/".into())];
        ensure_yqq_cgi_headers(&url, &mut headers);
        assert_eq!(
            headers
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case("referer"))
                .map(|(_, value)| value.as_str()),
            Some("https://xui.ptlogin2.qq.com/")
        );
    }

    #[tokio::test]
    async fn mock_base_url_is_allowed() {
        let base = spawn_router(Router::new().route("/ok", get(|| async { "hi" }))).await;
        let transport = transport_for(&base, TransportConfig::default());
        let response = transport
            .execute(TransportRequest::new(HttpMethod::Get, format!("{base}/ok")))
            .await
            .expect("allowed mock origin");
        assert_eq!(response.status, 200);
        assert_eq!(response.text(), "hi");
    }

    #[tokio::test]
    async fn unknown_host_is_rejected() {
        let transport = YaqmcReqwestTransport::new(TransportConfig::default()).expect("transport");
        let error = transport
            .execute(TransportRequest::new(
                HttpMethod::Get,
                "https://evil.example/nope",
            ))
            .await
            .expect_err("blocked host");
        match error {
            QmError::Protocol { stage, message } => {
                assert_eq!(stage, "allowlist");
                assert!(message.contains("evil.example"));
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[tokio::test]
    async fn timeout_is_enforced() {
        let base = spawn_router(Router::new().route(
            "/slow",
            get(|| async {
                tokio::time::sleep(Duration::from_secs(2)).await;
                "late"
            }),
        ))
        .await;
        let config = TransportConfig {
            total_timeout: Duration::from_millis(200),
            connect_timeout: Duration::from_millis(200),
            ..TransportConfig::default()
        };
        let transport = transport_for(&base, config);
        let error = transport
            .execute(TransportRequest::new(
                HttpMethod::Get,
                format!("{base}/slow"),
            ))
            .await
            .expect_err("timeout");
        match error {
            QmError::Network(network) => assert_eq!(network.kind, NetworkErrorKind::Timeout),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[tokio::test]
    async fn redirect_none_returns_30x() {
        let base = spawn_router(
            Router::new()
                .route(
                    "/from",
                    get(|| async { (StatusCode::FOUND, [(LOCATION, "/to")]).into_response() }),
                )
                .route("/to", get(|| async { "landed" })),
        )
        .await;
        let transport = transport_for(&base, TransportConfig::default());
        let mut request = TransportRequest::new(HttpMethod::Get, format!("{base}/from"));
        request.redirects = RedirectMode::None;
        let response = transport.execute(request).await.expect("30x");
        assert_eq!(response.status, 302);
        assert_ne!(response.text(), "landed");
    }

    #[tokio::test]
    async fn write_requests_are_not_retried() {
        async fn hits_for(retry: RetryClass) -> u32 {
            let hits = Arc::new(AtomicU32::new(0));
            let hits_for_handler = Arc::clone(&hits);
            let base = spawn_router(Router::new().route(
                "/flaky",
                get(move || {
                    let hits_for_handler = Arc::clone(&hits_for_handler);
                    async move {
                        hits_for_handler.fetch_add(1, Ordering::SeqCst);
                        StatusCode::INTERNAL_SERVER_ERROR
                    }
                }),
            ))
            .await;
            let transport = transport_for(&base, TransportConfig::default());
            let mut request = TransportRequest::new(HttpMethod::Get, format!("{base}/flaky"));
            request.retry = retry;
            let _ = transport.execute(request).await;
            hits.load(Ordering::SeqCst)
        }
        assert_eq!(hits_for(RetryClass::SafeRead).await, 2);
        assert_eq!(hits_for(RetryClass::Write).await, 1);
        assert_eq!(hits_for(RetryClass::AuthPoll).await, 1);
    }

    #[test]
    fn qmapi_transport_factory_uses_reqwest_0_13() {
        let transport = qmapi_transport(TransportConfig::default()).expect("factory");
        transport.allow_origin("http://127.0.0.1:9");
    }

    #[test]
    fn production_hosts_are_listed() {
        assert!(is_allowed_host("u.y.qq.com"));
        assert!(is_allowed_host("api.tencentmusic.com"));
        assert!(is_allowed_host("lp.open.weixin.qq.com"));
        assert!(is_allowed_host("isure.stream.qqmusic.qq.com"));
        assert!(is_allowed_host("bucket.cos.ap-guangzhou.myqcloud.com"));
        assert!(!is_allowed_host("evil.example"));
    }
}
