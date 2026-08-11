#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the authenticated request builders are introduced in later tasks"
    )
)]

use super::{
    clock::Clock,
    redaction::{redact_headers, redact_url, AUTH_SECRET_HEADERS},
    QQMusicError,
};
use async_trait::async_trait;
use reqwest::{
    header::{self, HeaderMap},
    Client, Method, StatusCode, Url,
};
use serde::Serialize;
#[cfg(test)]
use std::{
    collections::HashSet,
    net::{IpAddr, SocketAddr},
    sync::{Mutex as StdMutex, MutexGuard, OnceLock},
};
use std::{fmt, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

const ALLOWED_HOSTS: &[&str] = &[
    "u.y.qq.com",
    "c.y.qq.com",
    "c6.y.qq.com",
    "ssl.ptlogin2.qq.com",
    "ssl.ptlogin2.graph.qq.com",
    "xui.ptlogin2.qq.com",
    "graph.qq.com",
    "y.qq.com",
];
const MAX_REDIRECT_HOPS: usize = 3;

#[cfg(test)]
static PROXY_ENVIRONMENT_LOCK: OnceLock<StdMutex<()>> = OnceLock::new();

#[cfg(test)]
pub(crate) fn proxy_environment_lock() -> MutexGuard<'static, ()> {
    PROXY_ENVIRONMENT_LOCK
        .get_or_init(|| StdMutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RetryClass {
    SafeRead,
    AuthPoll,
    Write,
}

#[derive(Clone, Copy)]
pub(crate) struct TransportTimeouts {
    connect: Duration,
    total: Duration,
    retry_delay: Duration,
}

impl TransportTimeouts {
    fn production() -> Self {
        Self {
            connect: Duration::from_secs(5),
            total: Duration::from_secs(15),
            retry_delay: Duration::from_millis(250),
        }
    }
}

pub(crate) struct TransportRequest {
    pub(crate) operation: &'static str,
    pub(crate) method: Method,
    pub(crate) url: Url,
    pub(crate) headers: HeaderMap,
    pub(crate) body: Option<Vec<u8>>,
    pub(crate) retry: RetryClass,
    pub(crate) response_shape: &'static str,
    pub(crate) cancellation: CancellationToken,
}

impl fmt::Debug for TransportRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let redacted_headers = redact_headers(&self.headers);
        let header_names = redacted_headers.keys().collect::<Vec<_>>();
        formatter
            .debug_struct("TransportRequest")
            .field("operation", &self.operation)
            .field("method", &self.method)
            .field("url", &redact_url(&self.url))
            .field("header_names", &header_names)
            .field("body_len", &self.body.as_ref().map(Vec::len))
            .field("retry", &self.retry)
            .field("response_shape", &self.response_shape)
            .finish()
    }
}

pub(crate) struct TransportResponse {
    pub(crate) status: StatusCode,
    pub(crate) final_url: Url,
    pub(crate) headers: HeaderMap,
    pub(crate) body: Vec<u8>,
}

impl fmt::Debug for TransportResponse {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let redacted_headers = redact_headers(&self.headers);
        let header_names = redacted_headers.keys().collect::<Vec<_>>();
        formatter
            .debug_struct("TransportResponse")
            .field("status", &self.status)
            .field("final_url", &redact_url(&self.final_url))
            .field("header_names", &header_names)
            .field("body_len", &self.body.len())
            .finish()
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RequestDiagnostic {
    pub(crate) operation: &'static str,
    pub(crate) status: Option<u16>,
    pub(crate) duration_ms: u64,
    pub(crate) retry_count: u8,
    pub(crate) response_shape: &'static str,
}

#[async_trait]
pub(crate) trait QqTransport: Send + Sync {
    async fn execute(&self, request: TransportRequest) -> Result<TransportResponse, QQMusicError>;
}

#[derive(Clone, Default)]
pub(crate) struct ValidationPolicy {
    #[cfg(test)]
    allow_loopback_http: bool,
    #[cfg(test)]
    loopback_authorities: HashSet<String>,
}

impl ValidationPolicy {
    fn production() -> Self {
        Self::default()
    }

    #[cfg(test)]
    fn for_test(authorities: impl IntoIterator<Item = SocketAddr>) -> Self {
        Self {
            allow_loopback_http: true,
            loopback_authorities: authorities
                .into_iter()
                .map(|address| address.to_string())
                .collect(),
        }
    }
}

#[derive(Clone)]
pub(crate) struct ReqwestQqTransport {
    client: Client,
    clock: Arc<dyn Clock>,
    policy: ValidationPolicy,
    timeouts: TransportTimeouts,
}

impl ReqwestQqTransport {
    pub(crate) fn new(clock: Arc<dyn Clock>) -> Result<Self, QQMusicError> {
        let timeouts = TransportTimeouts::production();
        Ok(Self {
            client: build_direct_client(timeouts)?,
            clock,
            policy: ValidationPolicy::production(),
            timeouts,
        })
    }

    #[cfg(test)]
    fn new_with_policy(
        clock: Arc<dyn Clock>,
        policy: ValidationPolicy,
        timeouts: TransportTimeouts,
    ) -> Result<Self, QQMusicError> {
        Ok(Self {
            client: build_direct_client(timeouts)?,
            clock,
            policy,
            timeouts,
        })
    }

    async fn execute_attempt(
        &self,
        request: &TransportRequest,
    ) -> Result<TransportResponse, QQMusicError> {
        let mut current_url = request.url.clone();
        let mut method = request.method.clone();
        let mut headers = request.headers.clone();
        let mut body = request.body.clone();
        let mut hops = 0_usize;

        loop {
            self.validate_url(&current_url)?;
            let response = self
                .send(
                    method.clone(),
                    current_url.clone(),
                    headers.clone(),
                    body.clone(),
                    request.retry,
                    &request.cancellation,
                )
                .await?;
            let status = response.status();

            if is_redirect_status(status) {
                if let Some(location) = response.headers().get(header::LOCATION) {
                    if hops == MAX_REDIRECT_HOPS {
                        return Err(QQMusicError::Protocol);
                    }
                    let location = location.to_str().map_err(|_| QQMusicError::Protocol)?;
                    let next = current_url
                        .join(location)
                        .map_err(|_| QQMusicError::Protocol)?;
                    self.validate_url(&next)?;
                    let cross_origin = !same_origin(&current_url, &next);

                    if matches!(
                        status,
                        StatusCode::TEMPORARY_REDIRECT | StatusCode::PERMANENT_REDIRECT
                    ) && cross_origin
                        && (has_authentication(&headers) || body.is_some())
                    {
                        return Err(QQMusicError::Protocol);
                    }

                    if cross_origin {
                        strip_secret_headers(&mut headers);
                    }
                    if redirects_as_get(status, &method) {
                        method = Method::GET;
                        body = None;
                        strip_entity_headers(&mut headers);
                    }
                    current_url = next;
                    hops += 1;
                    continue;
                }
            }

            if status == StatusCode::TOO_MANY_REQUESTS {
                return Err(QQMusicError::RateLimited);
            }
            if status.is_server_error() {
                return Err(QQMusicError::Offline);
            }
            if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
                return Err(QQMusicError::AuthorizationRejected);
            }

            let response_headers = response.headers().clone();
            let response_body = self
                .collect_body(response, request.retry, &request.cancellation)
                .await?;
            return Ok(TransportResponse {
                status,
                final_url: current_url,
                headers: response_headers,
                body: response_body,
            });
        }
    }

    async fn send(
        &self,
        method: Method,
        url: Url,
        headers: HeaderMap,
        body: Option<Vec<u8>>,
        retry: RetryClass,
        cancellation: &CancellationToken,
    ) -> Result<reqwest::Response, QQMusicError> {
        if cancellation.is_cancelled() {
            return Err(QQMusicError::Cancelled);
        }
        let mut builder = self.client.request(method, url).headers(headers);
        if let Some(body) = body {
            builder = builder.body(body);
        }
        if retry == RetryClass::Write {
            return builder
                .send()
                .await
                .map_err(|_| QQMusicError::OutcomeUnknown);
        }
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(QQMusicError::Cancelled),
            response = builder.send() => response.map_err(map_read_error),
        }
    }

    async fn collect_body(
        &self,
        response: reqwest::Response,
        retry: RetryClass,
        cancellation: &CancellationToken,
    ) -> Result<Vec<u8>, QQMusicError> {
        if retry == RetryClass::Write {
            return response
                .bytes()
                .await
                .map(|body| body.to_vec())
                .map_err(|_| QQMusicError::OutcomeUnknown);
        }
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(QQMusicError::Cancelled),
            body = response.bytes() => body.map(|body| body.to_vec()).map_err(map_read_error),
        }
    }

    fn validate_url(&self, url: &Url) -> Result<(), QQMusicError> {
        if !url.username().is_empty() || url.password().is_some() {
            return Err(QQMusicError::Protocol);
        }
        if url.scheme() == "https"
            && url.port_or_known_default() == Some(443)
            && url
                .host_str()
                .is_some_and(|host| ALLOWED_HOSTS.contains(&host))
        {
            return Ok(());
        }

        let _policy = &self.policy;
        #[cfg(test)]
        if _policy.allow_loopback_http && url.scheme() == "http" {
            let host = url
                .host_str()
                .and_then(|host| host.parse::<IpAddr>().ok())
                .filter(IpAddr::is_loopback)
                .ok_or(QQMusicError::Protocol)?;
            let port = url.port().ok_or(QQMusicError::Protocol)?;
            let authority = SocketAddr::new(host, port).to_string();
            if _policy.loopback_authorities.contains(&authority) {
                return Ok(());
            }
        }

        Err(QQMusicError::Protocol)
    }

    async fn retry_delay(&self, cancellation: &CancellationToken) -> Result<(), QQMusicError> {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(QQMusicError::Cancelled),
            _ = tokio::time::sleep(self.timeouts.retry_delay) => Ok(()),
        }
    }

    fn emit_diagnostic(
        &self,
        request: &TransportRequest,
        started_ms: u64,
        status: Option<StatusCode>,
        retry_count: u8,
    ) {
        let diagnostic = RequestDiagnostic {
            operation: request.operation,
            status: status.map(|status| status.as_u16()),
            duration_ms: self.clock.now_ms().saturating_sub(started_ms),
            retry_count,
            response_shape: request.response_shape,
        };
        tracing::debug!(target: "qqmusic", diagnostic = ?diagnostic, "account transport request");
    }
}

#[async_trait]
impl QqTransport for ReqwestQqTransport {
    async fn execute(&self, request: TransportRequest) -> Result<TransportResponse, QQMusicError> {
        self.validate_url(&request.url)?;
        let started_ms = self.clock.now_ms();
        let mut retry_count = 0_u8;
        loop {
            match self.execute_attempt(&request).await {
                Ok(response) => {
                    self.emit_diagnostic(&request, started_ms, Some(response.status), retry_count);
                    return Ok(response);
                }
                Err(error)
                    if request.retry == RetryClass::SafeRead
                        && retry_count == 0
                        && is_safe_read_retryable(&error) =>
                {
                    retry_count = 1;
                    self.retry_delay(&request.cancellation).await?;
                }
                Err(error) => {
                    self.emit_diagnostic(&request, started_ms, None, retry_count);
                    return Err(error);
                }
            }
        }
    }
}

pub(crate) fn build_direct_client(timeouts: TransportTimeouts) -> Result<Client, QQMusicError> {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(timeouts.connect)
        .timeout(timeouts.total)
        .user_agent("YAQMC/0.1 authenticated transport")
        .build()
        .map_err(|_| QQMusicError::Offline)
}

fn map_read_error(error: reqwest::Error) -> QQMusicError {
    if error.is_timeout() {
        QQMusicError::Timeout
    } else {
        QQMusicError::Offline
    }
}

fn is_safe_read_retryable(error: &QQMusicError) -> bool {
    matches!(
        error,
        QQMusicError::Offline | QQMusicError::Timeout | QQMusicError::RateLimited
    )
}

fn is_redirect_status(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::MOVED_PERMANENTLY
            | StatusCode::FOUND
            | StatusCode::SEE_OTHER
            | StatusCode::TEMPORARY_REDIRECT
            | StatusCode::PERMANENT_REDIRECT
    )
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn has_authentication(headers: &HeaderMap) -> bool {
    AUTH_SECRET_HEADERS
        .iter()
        .any(|name| headers.contains_key(name))
}

fn strip_secret_headers(headers: &mut HeaderMap) {
    for name in AUTH_SECRET_HEADERS {
        headers.remove(name);
    }
}

fn strip_entity_headers(headers: &mut HeaderMap) {
    for name in [
        header::CONTENT_LENGTH,
        header::CONTENT_TYPE,
        header::TRANSFER_ENCODING,
    ] {
        headers.remove(name);
    }
}

fn redirects_as_get(status: StatusCode, method: &Method) -> bool {
    (status == StatusCode::SEE_OTHER && method != Method::HEAD)
        || (matches!(status, StatusCode::MOVED_PERMANENTLY | StatusCode::FOUND)
            && method == Method::POST)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::qqmusic::clock::{Clock, ManualClock};
    use axum::{
        body::{to_bytes, Body},
        extract::Request,
        http::{header, HeaderValue},
        response::{IntoResponse, Response},
        routing::any,
        Router,
    };
    use reqwest::{header::HeaderMap, Method, StatusCode, Url};
    use std::{
        collections::BTreeMap,
        net::SocketAddr,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Mutex as StdMutex,
        },
        time::Duration,
    };
    use tokio::{sync::Mutex, task::JoinHandle};
    use tokio_util::sync::CancellationToken;

    #[derive(Debug)]
    struct ObservedRequest {
        method: Method,
        cookie_present: bool,
        authorization_present: bool,
        proxy_authorization_present: bool,
        content_type_present: bool,
        body: Vec<u8>,
    }

    struct TestServer {
        address: SocketAddr,
        task: JoinHandle<()>,
    }

    impl TestServer {
        fn url(&self, path: &str) -> Url {
            Url::parse(&format!("http://{}{}", self.address, path)).expect("fixture URL")
        }
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn spawn_server(app: Router) -> TestServer {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("loopback listener");
        let address = listener.local_addr().expect("listener address");
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("fixture server");
        });
        TestServer { address, task }
    }

    async fn observe(request: Request) -> ObservedRequest {
        let (parts, body) = request.into_parts();
        let body = to_bytes(body, 1024 * 1024)
            .await
            .expect("fixture request body")
            .to_vec();
        ObservedRequest {
            method: parts.method,
            cookie_present: parts.headers.contains_key(header::COOKIE),
            authorization_present: parts.headers.contains_key(header::AUTHORIZATION),
            proxy_authorization_present: parts.headers.contains_key(header::PROXY_AUTHORIZATION),
            content_type_present: parts.headers.contains_key(header::CONTENT_TYPE),
            body,
        }
    }

    fn response_with_location(status: StatusCode, location: &str) -> Response {
        let mut response = (status, Body::empty()).into_response();
        response.headers_mut().insert(
            header::LOCATION,
            HeaderValue::from_str(location).expect("redirect location"),
        );
        response
    }

    fn short_timeouts() -> TransportTimeouts {
        TransportTimeouts {
            connect: Duration::from_millis(100),
            total: Duration::from_millis(80),
            retry_delay: Duration::from_millis(10),
        }
    }

    fn fixture_transport(
        authorities: impl IntoIterator<Item = SocketAddr>,
        timeouts: TransportTimeouts,
    ) -> ReqwestQqTransport {
        let clock: Arc<dyn Clock> = Arc::new(ManualClock::new(1_000));
        ReqwestQqTransport::new_with_policy(
            clock,
            ValidationPolicy::for_test(authorities),
            timeouts,
        )
        .expect("fixture transport")
    }

    fn request(url: Url, retry: RetryClass) -> TransportRequest {
        TransportRequest {
            operation: "fixture.operation",
            method: Method::GET,
            url,
            headers: HeaderMap::new(),
            body: None,
            retry,
            response_shape: "fixture-response",
            cancellation: CancellationToken::new(),
        }
    }

    fn authenticated_request(url: Url, retry: RetryClass) -> TransportRequest {
        let mut request = request(url, retry);
        request.headers.insert(
            header::COOKIE,
            HeaderValue::from_static("uin=1; qm_keyst=SECRET"),
        );
        request.headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer SECRET"),
        );
        request.headers.insert(
            header::PROXY_AUTHORIZATION,
            HeaderValue::from_static("Basic SECRET"),
        );
        request
    }

    async fn wait_for_calls(calls: &AtomicUsize, expected: usize) {
        tokio::time::timeout(Duration::from_secs(1), async {
            while calls.load(Ordering::Acquire) < expected {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("fixture request arrives");
    }

    #[tokio::test]
    async fn redirect_policy_revalidates_hops_and_strips_secrets_cross_host() {
        let observed = Arc::new(Mutex::new(Vec::<ObservedRequest>::new()));
        let target_observed = Arc::clone(&observed);
        let target = spawn_server(Router::new().route(
            "/target",
            any(move |request: Request| {
                let target_observed = Arc::clone(&target_observed);
                async move {
                    target_observed.lock().await.push(observe(request).await);
                    StatusCode::OK
                }
            }),
        ))
        .await;
        let redirect_target = target.url("/target").to_string();
        let source_observed = Arc::clone(&observed);
        let source = spawn_server(Router::new().route(
            "/cross-host",
            any(move |request: Request| {
                let source_observed = Arc::clone(&source_observed);
                let redirect_target = redirect_target.clone();
                async move {
                    source_observed.lock().await.push(observe(request).await);
                    response_with_location(StatusCode::FOUND, &redirect_target)
                }
            }),
        ))
        .await;
        let transport = fixture_transport([source.address, target.address], short_timeouts());

        let response = transport
            .execute(authenticated_request(
                source.url("/cross-host"),
                RetryClass::SafeRead,
            ))
            .await
            .expect("allowlisted redirect succeeds");

        assert_eq!(response.status, StatusCode::OK);
        let hops = observed.lock().await;
        assert_eq!(hops.len(), 2);
        assert!(hops[0].cookie_present);
        assert!(hops[0].authorization_present);
        assert!(hops[0].proxy_authorization_present);
        assert!(!hops[1].cookie_present);
        assert!(!hops[1].authorization_present);
        assert!(!hops[1].proxy_authorization_present);
    }

    #[tokio::test]
    async fn write_timeout_is_outcome_unknown_and_is_not_retried() {
        let calls = Arc::new(AtomicUsize::new(0));
        let server_calls = Arc::clone(&calls);
        let server = spawn_server(Router::new().fallback(any(move |request: Request| {
            let server_calls = Arc::clone(&server_calls);
            async move {
                server_calls.fetch_add(1, Ordering::AcqRel);
                let _ = observe(request).await;
                tokio::time::sleep(Duration::from_millis(200)).await;
                StatusCode::OK
            }
        })))
        .await;
        let transport = fixture_transport(
            [server.address],
            TransportTimeouts {
                total: Duration::from_millis(30),
                ..short_timeouts()
            },
        );
        let mut request = request(server.url("/write-timeout"), RetryClass::Write);
        request.method = Method::POST;
        request.body = Some(b"mutation".to_vec());

        let error = transport
            .execute(request)
            .await
            .expect_err("write must not report a definite failure");

        assert!(matches!(error, QQMusicError::OutcomeUnknown));
        assert_eq!(calls.load(Ordering::Acquire), 1);
    }

    async fn run_timeout_case(retry: RetryClass) -> usize {
        let calls = Arc::new(AtomicUsize::new(0));
        let server_calls = Arc::clone(&calls);
        let server = spawn_server(Router::new().fallback(any(move || {
            let server_calls = Arc::clone(&server_calls);
            async move {
                server_calls.fetch_add(1, Ordering::AcqRel);
                tokio::time::sleep(Duration::from_millis(120)).await;
                StatusCode::OK
            }
        })))
        .await;
        let transport = fixture_transport(
            [server.address],
            TransportTimeouts {
                total: Duration::from_millis(25),
                ..short_timeouts()
            },
        );

        let error = transport
            .execute(request(server.url("/read-timeout"), retry))
            .await
            .expect_err("fixture times out");
        assert!(matches!(error, QQMusicError::Timeout));
        calls.load(Ordering::Acquire)
    }

    #[tokio::test]
    async fn safe_read_retries_once_but_auth_poll_does_not() {
        assert_eq!(run_timeout_case(RetryClass::SafeRead).await, 2);
        assert_eq!(run_timeout_case(RetryClass::AuthPoll).await, 1);
    }

    #[tokio::test]
    async fn cancellation_stops_send_retry_delay_and_auth_poll() {
        let send_calls = Arc::new(AtomicUsize::new(0));
        let server_calls = Arc::clone(&send_calls);
        let send_server = spawn_server(Router::new().fallback(any(move || {
            let server_calls = Arc::clone(&server_calls);
            async move {
                server_calls.fetch_add(1, Ordering::AcqRel);
                tokio::time::sleep(Duration::from_secs(5)).await;
                StatusCode::OK
            }
        })))
        .await;
        let transport = Arc::new(fixture_transport([send_server.address], short_timeouts()));
        let read = request(send_server.url("/cancel-read"), RetryClass::SafeRead);
        let cancellation = read.cancellation.clone();
        let running_transport = Arc::clone(&transport);
        let running = tokio::spawn(async move { running_transport.execute(read).await });
        wait_for_calls(&send_calls, 1).await;
        cancellation.cancel();
        assert!(matches!(
            running.await.expect("read joins"),
            Err(QQMusicError::Cancelled)
        ));
        assert_eq!(send_calls.load(Ordering::Acquire), 1);

        let retry_calls = Arc::new(AtomicUsize::new(0));
        let server_calls = Arc::clone(&retry_calls);
        let retry_server = spawn_server(Router::new().fallback(any(move || {
            let server_calls = Arc::clone(&server_calls);
            async move {
                server_calls.fetch_add(1, Ordering::AcqRel);
                StatusCode::SERVICE_UNAVAILABLE
            }
        })))
        .await;
        let retry_transport = Arc::new(fixture_transport(
            [retry_server.address],
            TransportTimeouts {
                retry_delay: Duration::from_millis(500),
                ..short_timeouts()
            },
        ));
        let retry_request = request(retry_server.url("/cancel-delay"), RetryClass::SafeRead);
        let retry_cancellation = retry_request.cancellation.clone();
        let running_transport = Arc::clone(&retry_transport);
        let retrying = tokio::spawn(async move { running_transport.execute(retry_request).await });
        wait_for_calls(&retry_calls, 1).await;
        retry_cancellation.cancel();
        assert!(matches!(
            retrying.await.expect("retry joins"),
            Err(QQMusicError::Cancelled)
        ));
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(retry_calls.load(Ordering::Acquire), 1);

        let poll_calls = Arc::new(AtomicUsize::new(0));
        let server_calls = Arc::clone(&poll_calls);
        let poll_server = spawn_server(Router::new().fallback(any(move || {
            let server_calls = Arc::clone(&server_calls);
            async move {
                server_calls.fetch_add(1, Ordering::AcqRel);
                tokio::time::sleep(Duration::from_secs(5)).await;
                StatusCode::OK
            }
        })))
        .await;
        let poll_transport = Arc::new(fixture_transport([poll_server.address], short_timeouts()));
        let poll = request(poll_server.url("/cancel-poll"), RetryClass::AuthPoll);
        let poll_cancellation = poll.cancellation.clone();
        let running_transport = Arc::clone(&poll_transport);
        let polling = tokio::spawn(async move { running_transport.execute(poll).await });
        wait_for_calls(&poll_calls, 1).await;
        poll_cancellation.cancel();
        assert!(matches!(
            polling.await.expect("poll joins"),
            Err(QQMusicError::Cancelled)
        ));
        assert_eq!(poll_calls.load(Ordering::Acquire), 1);
    }

    #[tokio::test]
    async fn success_with_location_is_not_followed() {
        let target_calls = Arc::new(AtomicUsize::new(0));
        let server_calls = Arc::clone(&target_calls);
        let target = spawn_server(Router::new().fallback(any(move || {
            let server_calls = Arc::clone(&server_calls);
            async move {
                server_calls.fetch_add(1, Ordering::AcqRel);
                StatusCode::OK
            }
        })))
        .await;
        let location = target.url("/must-not-run").to_string();
        let source = spawn_server(Router::new().fallback(any(move || {
            let location = location.clone();
            async move { response_with_location(StatusCode::OK, &location) }
        })))
        .await;
        let transport = fixture_transport([source.address, target.address], short_timeouts());

        let response = transport
            .execute(request(source.url("/ordinary"), RetryClass::SafeRead))
            .await
            .expect("ordinary response");

        assert_eq!(response.status, StatusCode::OK);
        assert_eq!(target_calls.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn only_reviewed_redirect_statuses_are_followed() {
        for status in [301_u16, 302, 303, 307, 308] {
            let target_calls = Arc::new(AtomicUsize::new(0));
            let server_calls = Arc::clone(&target_calls);
            let target = spawn_server(Router::new().fallback(any(move || {
                let server_calls = Arc::clone(&server_calls);
                async move {
                    server_calls.fetch_add(1, Ordering::AcqRel);
                    StatusCode::OK
                }
            })))
            .await;
            let location = target.url("/target").to_string();
            let source = spawn_server(Router::new().fallback(any(move || {
                let location = location.clone();
                async move {
                    response_with_location(
                        StatusCode::from_u16(status).expect("redirect status"),
                        &location,
                    )
                }
            })))
            .await;
            let transport = fixture_transport([source.address, target.address], short_timeouts());

            transport
                .execute(request(source.url("/redirect"), RetryClass::SafeRead))
                .await
                .expect("reviewed redirect succeeds");
            assert_eq!(target_calls.load(Ordering::Acquire), 1, "status {status}");
        }

        for status in [300_u16, 304, 305, 306] {
            let target_calls = Arc::new(AtomicUsize::new(0));
            let server_calls = Arc::clone(&target_calls);
            let target = spawn_server(Router::new().fallback(any(move || {
                let server_calls = Arc::clone(&server_calls);
                async move {
                    server_calls.fetch_add(1, Ordering::AcqRel);
                    StatusCode::OK
                }
            })))
            .await;
            let location = target.url("/target").to_string();
            let source = spawn_server(Router::new().fallback(any(move || {
                let location = location.clone();
                async move {
                    response_with_location(
                        StatusCode::from_u16(status).expect("ordinary status"),
                        &location,
                    )
                }
            })))
            .await;
            let transport = fixture_transport([source.address, target.address], short_timeouts());

            let response = transport
                .execute(request(source.url("/ordinary"), RetryClass::AuthPoll))
                .await
                .expect("ordinary response");
            assert_eq!(response.status.as_u16(), status);
            assert_eq!(target_calls.load(Ordering::Acquire), 0, "status {status}");
        }
    }

    #[tokio::test]
    async fn cross_origin_authenticated_body_preserving_redirect_is_rejected() {
        for status in [
            StatusCode::TEMPORARY_REDIRECT,
            StatusCode::PERMANENT_REDIRECT,
        ] {
            let target_calls = Arc::new(AtomicUsize::new(0));
            let server_calls = Arc::clone(&target_calls);
            let target = spawn_server(Router::new().fallback(any(move || {
                let server_calls = Arc::clone(&server_calls);
                async move {
                    server_calls.fetch_add(1, Ordering::AcqRel);
                    StatusCode::OK
                }
            })))
            .await;
            let location = target.url("/target").to_string();
            let source = spawn_server(Router::new().fallback(any(move || {
                let location = location.clone();
                async move { response_with_location(status, &location) }
            })))
            .await;
            let transport = fixture_transport([source.address, target.address], short_timeouts());
            let mut mutation = authenticated_request(source.url("/mutation"), RetryClass::Write);
            mutation.method = Method::POST;
            mutation.body = Some(b"secret mutation".to_vec());

            let error = transport
                .execute(mutation)
                .await
                .expect_err("cross-origin body preservation must be rejected");

            assert!(matches!(error, QQMusicError::Protocol));
            assert_eq!(target_calls.load(Ordering::Acquire), 0);
        }
    }

    #[tokio::test]
    async fn cross_origin_post_redirect_becomes_secret_free_get() {
        let observed = Arc::new(Mutex::new(Vec::<ObservedRequest>::new()));
        let target_observed = Arc::clone(&observed);
        let target = spawn_server(Router::new().fallback(any(move |request: Request| {
            let target_observed = Arc::clone(&target_observed);
            async move {
                target_observed.lock().await.push(observe(request).await);
                StatusCode::OK
            }
        })))
        .await;
        let location = target.url("/target").to_string();
        let source = spawn_server(Router::new().fallback(any(move || {
            let location = location.clone();
            async move { response_with_location(StatusCode::FOUND, &location) }
        })))
        .await;
        let transport = fixture_transport([source.address, target.address], short_timeouts());
        let mut mutation = authenticated_request(source.url("/source"), RetryClass::Write);
        mutation.method = Method::POST;
        mutation.body = Some(b"secret mutation".to_vec());
        mutation.headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );

        transport
            .execute(mutation)
            .await
            .expect("302 redirect safely converts to GET");

        let target_request = observed.lock().await.pop().expect("target request");
        assert_eq!(target_request.method, Method::GET);
        assert!(target_request.body.is_empty());
        assert!(!target_request.cookie_present);
        assert!(!target_request.authorization_present);
        assert!(!target_request.proxy_authorization_present);
        assert!(!target_request.content_type_present);
    }

    #[tokio::test]
    async fn same_origin_307_preserves_method_body_and_authentication() {
        let observed = Arc::new(Mutex::new(Vec::<ObservedRequest>::new()));
        let target_observed = Arc::clone(&observed);
        let server_url = Arc::new(StdMutex::new(None::<String>));
        let redirect_url = Arc::clone(&server_url);
        let app = Router::new()
            .route(
                "/source",
                any(move || {
                    let redirect_url = Arc::clone(&redirect_url);
                    async move {
                        let location = redirect_url
                            .lock()
                            .expect("server URL lock")
                            .clone()
                            .expect("server URL initialized");
                        response_with_location(StatusCode::TEMPORARY_REDIRECT, &location)
                    }
                }),
            )
            .route(
                "/target",
                any(move |request: Request| {
                    let target_observed = Arc::clone(&target_observed);
                    async move {
                        target_observed.lock().await.push(observe(request).await);
                        StatusCode::OK
                    }
                }),
            );
        let server = spawn_server(app).await;
        *server_url.lock().expect("server URL lock") = Some(server.url("/target").to_string());
        let transport = fixture_transport([server.address], short_timeouts());
        let mut mutation = authenticated_request(server.url("/source"), RetryClass::Write);
        mutation.method = Method::POST;
        mutation.body = Some(b"same-origin body".to_vec());

        transport
            .execute(mutation)
            .await
            .expect("same-origin 307 succeeds");

        let target_request = observed.lock().await.pop().expect("target request");
        assert_eq!(target_request.method, Method::POST);
        assert_eq!(target_request.body, b"same-origin body");
        assert!(target_request.cookie_present);
        assert!(target_request.authorization_present);
        assert!(target_request.proxy_authorization_present);
    }

    #[tokio::test]
    async fn redirect_hops_are_revalidated_and_capped() {
        let rejected_target_calls = Arc::new(AtomicUsize::new(0));
        let target_calls = Arc::clone(&rejected_target_calls);
        let rejected_target = spawn_server(Router::new().fallback(any(move || {
            let target_calls = Arc::clone(&target_calls);
            async move {
                target_calls.fetch_add(1, Ordering::AcqRel);
                StatusCode::OK
            }
        })))
        .await;
        let rejected_location = rejected_target.url("/target").to_string();
        let source = spawn_server(Router::new().fallback(any(move || {
            let rejected_location = rejected_location.clone();
            async move { response_with_location(StatusCode::FOUND, &rejected_location) }
        })))
        .await;
        let transport = fixture_transport([source.address], short_timeouts());

        assert!(matches!(
            transport
                .execute(request(source.url("/source"), RetryClass::AuthPoll))
                .await,
            Err(QQMusicError::Protocol)
        ));
        assert_eq!(rejected_target_calls.load(Ordering::Acquire), 0);

        let hop_calls = Arc::new(AtomicUsize::new(0));
        let observed_hops = Arc::clone(&hop_calls);
        let address_slot = Arc::new(StdMutex::new(None::<SocketAddr>));
        let handler_slot = Arc::clone(&address_slot);
        let loop_server = spawn_server(Router::new().fallback(any(move |request: Request| {
            let observed_hops = Arc::clone(&observed_hops);
            let handler_slot = Arc::clone(&handler_slot);
            async move {
                observed_hops.fetch_add(1, Ordering::AcqRel);
                let index = request
                    .uri()
                    .path()
                    .trim_start_matches('/')
                    .parse::<usize>()
                    .expect("hop index");
                let address = handler_slot
                    .lock()
                    .expect("address lock")
                    .expect("address initialized");
                response_with_location(
                    StatusCode::FOUND,
                    &format!("http://{address}/{}", index + 1),
                )
            }
        })))
        .await;
        *address_slot.lock().expect("address lock") = Some(loop_server.address);
        let transport = fixture_transport([loop_server.address], short_timeouts());

        assert!(matches!(
            transport
                .execute(request(loop_server.url("/0"), RetryClass::AuthPoll))
                .await,
            Err(QQMusicError::Protocol)
        ));
        assert_eq!(hop_calls.load(Ordering::Acquire), 4);
    }

    #[tokio::test]
    async fn cancellation_interrupts_response_body_collection() {
        use futures_util::{stream, StreamExt};
        use std::convert::Infallible;

        let calls = Arc::new(AtomicUsize::new(0));
        let server_calls = Arc::clone(&calls);
        let server = spawn_server(Router::new().fallback(any(move || {
            let server_calls = Arc::clone(&server_calls);
            async move {
                server_calls.fetch_add(1, Ordering::AcqRel);
                let first = stream::once(async {
                    Ok::<_, Infallible>(axum::body::Bytes::from_static(b"partial"))
                });
                let pending = stream::pending::<Result<axum::body::Bytes, Infallible>>();
                Response::new(Body::from_stream(first.chain(pending)))
            }
        })))
        .await;
        let transport = Arc::new(fixture_transport(
            [server.address],
            TransportTimeouts {
                total: Duration::from_secs(2),
                ..short_timeouts()
            },
        ));
        let pending = request(server.url("/stream"), RetryClass::AuthPoll);
        let cancellation = pending.cancellation.clone();
        let running_transport = Arc::clone(&transport);
        let running = tokio::spawn(async move { running_transport.execute(pending).await });
        wait_for_calls(&calls, 1).await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        cancellation.cancel();

        assert!(matches!(
            running.await.expect("body collection joins"),
            Err(QQMusicError::Cancelled)
        ));
        assert_eq!(calls.load(Ordering::Acquire), 1);
    }

    #[test]
    fn production_validation_is_exact_https_origin_only() {
        let clock: Arc<dyn Clock> = Arc::new(ManualClock::new(0));
        let transport = ReqwestQqTransport::new(clock).expect("production transport");
        for url in [
            "https://u.y.qq.com/path",
            "https://ssl.ptlogin2.graph.qq.com/path",
            "https://y.qq.com:443/path",
        ] {
            assert!(
                transport
                    .validate_url(&Url::parse(url).expect("allowed URL"))
                    .is_ok(),
                "expected allowed URL: {url}"
            );
        }
        for url in [
            "http://u.y.qq.com/path",
            "https://u.y.qq.com:444/path",
            "https://sub.u.y.qq.com/path",
            "https://user:secret@u.y.qq.com/path",
            "https://music.tc.qq.com/path",
            "https://example.com/path",
        ] {
            assert!(
                transport
                    .validate_url(&Url::parse(url).expect("rejected URL"))
                    .is_err(),
                "expected rejected URL: {url}"
            );
        }
    }

    struct ProxyEnvironment {
        prior: BTreeMap<&'static str, Option<std::ffi::OsString>>,
    }

    impl ProxyEnvironment {
        fn point_to(proxy: &str) -> Self {
            let names = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"];
            let prior = names
                .into_iter()
                .map(|name| (name, std::env::var_os(name)))
                .collect();
            for name in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] {
                std::env::set_var(name, proxy);
            }
            std::env::remove_var("NO_PROXY");
            Self { prior }
        }
    }

    impl Drop for ProxyEnvironment {
        fn drop(&mut self) {
            for (name, value) in &self.prior {
                match value {
                    Some(value) => std::env::set_var(name, value),
                    None => std::env::remove_var(name),
                }
            }
        }
    }

    #[tokio::test]
    async fn direct_client_ignores_process_proxy_configuration() {
        let proxy_calls = Arc::new(AtomicUsize::new(0));
        let observed_proxy_calls = Arc::clone(&proxy_calls);
        let proxy = spawn_server(Router::new().fallback(any(move || {
            let observed_proxy_calls = Arc::clone(&observed_proxy_calls);
            async move {
                observed_proxy_calls.fetch_add(1, Ordering::AcqRel);
                StatusCode::BAD_GATEWAY
            }
        })))
        .await;
        let target_calls = Arc::new(AtomicUsize::new(0));
        let observed_target_calls = Arc::clone(&target_calls);
        let target = spawn_server(Router::new().fallback(any(move || {
            let observed_target_calls = Arc::clone(&observed_target_calls);
            async move {
                observed_target_calls.fetch_add(1, Ordering::AcqRel);
                StatusCode::OK
            }
        })))
        .await;
        let transport = {
            let _lock = proxy_environment_lock();
            let _environment = ProxyEnvironment::point_to(&format!("http://{}", proxy.address));
            fixture_transport([target.address], short_timeouts())
        };

        transport
            .execute(request(target.url("/direct"), RetryClass::AuthPoll))
            .await
            .expect("direct request succeeds");

        assert_eq!(proxy_calls.load(Ordering::Acquire), 0);
        assert_eq!(target_calls.load(Ordering::Acquire), 1);
    }

    #[test]
    fn debug_and_diagnostic_output_never_contains_request_secrets() {
        let mut request = authenticated_request(
            Url::parse("https://u.y.qq.com/path?vkey=SECRET&guid=123").expect("URL"),
            RetryClass::Write,
        );
        request.body = Some(br#"{"qm_keyst":"SECRET"}"#.to_vec());
        let debug = format!("{request:?}");
        assert!(!debug.contains("SECRET"));
        assert!(!debug.contains("qm_keyst"));
        assert!(debug.contains("fixture.operation"));

        let mut response_headers = HeaderMap::new();
        response_headers.insert(
            header::SET_COOKIE,
            HeaderValue::from_static("qm_keyst=SECRET"),
        );
        let response = TransportResponse {
            status: StatusCode::OK,
            final_url: Url::parse("https://u.y.qq.com/path?vkey=SECRET").expect("URL"),
            headers: response_headers,
            body: b"SECRET response".to_vec(),
        };
        let response_debug = format!("{response:?}");
        assert!(!response_debug.contains("SECRET"));
        assert!(response_debug.contains("body_len"));

        let diagnostic = RequestDiagnostic {
            operation: "fixture.operation",
            status: Some(200),
            duration_ms: 25,
            retry_count: 0,
            response_shape: "fixture-response",
        };
        let serialized = serde_json::to_string(&diagnostic).expect("diagnostic serializes");
        assert!(!serialized.contains("http"));
        assert!(!serialized.contains("SECRET"));
    }
}
