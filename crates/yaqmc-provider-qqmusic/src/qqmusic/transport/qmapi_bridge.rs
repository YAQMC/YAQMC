//! Inject the existing host transport under qm-api-rs during account migration.
//! No CGI module, method, endpoint or credential is selected by this adapter.
use super::*;
use reqwest::header::{HeaderName, HeaderValue};

pub(crate) struct AccountTransport {
    pub inner: Arc<dyn QqTransport>,
    pub operation: &'static str,
    pub response_shape: &'static str,
    pub retry: RetryClass,
}

/// Pass-through bridge for library flows that own their own wire contract.
///
/// Unlike [`AccountTransport`] this adapter does not constrain the method,
/// query or body: `qm-api-rs` is the only author of the request. It only
/// translates types, rejects bodies it cannot encode, and keeps the host
/// transport's allowlist, redirect validation and cancellation behaviour.
pub(crate) struct HostTransport {
    pub inner: Arc<dyn QqTransport>,
    pub operation: &'static str,
    pub response_shape: &'static str,
}

#[async_trait]
impl qqmusic_api::ApiTransport for HostTransport {
    async fn execute(
        &self,
        request: qqmusic_api::TransportRequest,
    ) -> qqmusic_api::Result<qqmusic_api::TransportResponse> {
        use qqmusic_api::{HttpBody, HttpMethod, QmError};
        let method = match request.method {
            HttpMethod::Get => Method::GET,
            HttpMethod::Post => Method::POST,
            HttpMethod::Put => Method::PUT,
            HttpMethod::Head => Method::HEAD,
            HttpMethod::Delete => Method::DELETE,
            HttpMethod::Patch => Method::PATCH,
        };
        let mut url = Url::parse(&request.url)
            .map_err(|_| QmError::ValueError("invalid request URL".into()))?;
        if !request.query.is_empty() {
            let mut pairs = url.query_pairs_mut();
            for (key, value) in &request.query {
                pairs.append_pair(key, value);
            }
        }
        let mut headers = HeaderMap::new();
        for (name, value) in &request.headers {
            headers.append(
                HeaderName::from_bytes(name.as_bytes())
                    .map_err(|_| QmError::ValueError("invalid header name".into()))?,
                HeaderValue::from_str(value)
                    .map_err(|_| QmError::ValueError("invalid header value".into()))?,
            );
        }
        let body = match request.body {
            HttpBody::Empty => None,
            HttpBody::Json(value) => Some(serde_json::to_vec(&value)?),
            HttpBody::Form(value) => {
                let object = value
                    .as_object()
                    .ok_or_else(|| QmError::ValueError("form body must be an object".into()))?;
                let mut encoded = Url::parse("https://form.invalid/")
                    .map_err(|_| QmError::ValueError("form encoder base".into()))?;
                {
                    let mut pairs = encoded.query_pairs_mut();
                    for (key, value) in object {
                        pairs.append_pair(key, value.as_str().unwrap_or_default());
                    }
                }
                Some(encoded.query().unwrap_or_default().as_bytes().to_vec())
            }
            HttpBody::Bytes(bytes) => Some(bytes),
        };
        let cancellation = request.cancellation.clone();
        let limit = request.max_response_bytes;
        let operation = self.inner.execute(TransportRequest {
            max_response_bytes: limit,
            operation: self.operation,
            method,
            url,
            headers,
            body,
            retry: match request.retry {
                qqmusic_api::RetryClass::SafeRead => RetryClass::SafeRead,
                qqmusic_api::RetryClass::AuthPoll => RetryClass::AuthPoll,
                qqmusic_api::RetryClass::Write => RetryClass::Write,
            },
            redirects: match request.redirects {
                qqmusic_api::RedirectMode::FollowValidated => RedirectMode::FollowValidated,
                qqmusic_api::RedirectMode::None => RedirectMode::ReturnResponse,
            },
            response_shape: self.response_shape,
            cancellation: request.cancellation,
        });
        let response = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(map_error(QQMusicError::Cancelled)),
            response = operation => response.map_err(map_error)?,
        };
        if limit.is_some_and(|limit| response.body.len() > limit) {
            return Err(QmError::Protocol {
                stage: "response-limit",
                message: "host response exceeds requested bound".into(),
            });
        }
        Ok(qqmusic_api::TransportResponse {
            status: response.status.as_u16(),
            final_url: response.final_url.to_string(),
            headers: response
                .headers
                .iter()
                .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str().into(), v.into())))
                .collect(),
            body: response.body,
        })
    }
}

#[async_trait]
impl qqmusic_api::ApiTransport for AccountTransport {
    async fn execute(
        &self,
        request: qqmusic_api::TransportRequest,
    ) -> qqmusic_api::Result<qqmusic_api::TransportResponse> {
        use qqmusic_api::{HttpBody, HttpMethod, QmError};
        if request.method != HttpMethod::Post || !request.query.is_empty() {
            return Err(QmError::ValueError(
                "unsupported account transport request".into(),
            ));
        }
        let body = match request.body {
            HttpBody::Json(value) => serde_json::to_vec(&value)?,
            _ => return Err(QmError::ValueError("unsupported account body".into())),
        };
        let mut headers = HeaderMap::new();
        for (name, value) in request.headers {
            headers.append(
                HeaderName::from_bytes(name.as_bytes())
                    .map_err(|_| QmError::ValueError("invalid header name".into()))?,
                HeaderValue::from_str(&value)
                    .map_err(|_| QmError::ValueError("invalid header value".into()))?,
            );
        }
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json; charset=utf-8"),
        );
        let cancellation = request.cancellation.clone();
        let limit = request.max_response_bytes;
        let operation = self.inner.execute(TransportRequest {
            max_response_bytes: limit,
            operation: self.operation,
            method: Method::POST,
            url: Url::parse(&request.url)
                .map_err(|_| QmError::ValueError("invalid request URL".into()))?,
            headers,
            body: Some(body),
            retry: self.retry,
            redirects: match request.redirects {
                qqmusic_api::RedirectMode::FollowValidated => RedirectMode::FollowValidated,
                qqmusic_api::RedirectMode::None => RedirectMode::ReturnResponse,
            },
            response_shape: self.response_shape,
            cancellation: request.cancellation,
        });
        let response = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(map_error(QQMusicError::Cancelled)),
            response = operation => response.map_err(map_error)?,
        };
        if limit.is_some_and(|limit| response.body.len() > limit) {
            return Err(QmError::Protocol {
                stage: "response-limit",
                message: "host response exceeds requested bound".into(),
            });
        }
        Ok(qqmusic_api::TransportResponse {
            status: response.status.as_u16(),
            final_url: response.final_url.to_string(),
            headers: response
                .headers
                .iter()
                .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str().into(), v.into())))
                .collect(),
            body: response.body,
        })
    }
}

fn map_error(error: QQMusicError) -> qqmusic_api::QmError {
    use qqmusic_api::{NetworkError, NetworkErrorKind, QmError};
    let kind = match error {
        QQMusicError::Timeout => NetworkErrorKind::Timeout,
        QQMusicError::Cancelled => NetworkErrorKind::Cancelled,
        QQMusicError::AuthenticationExpired | QQMusicError::AuthorizationRejected => {
            return QmError::CredentialExpired("host rejected account".into())
        }
        QQMusicError::RateLimited => return QmError::RateLimited,
        QQMusicError::SchemaChanged | QQMusicError::MalformedResponse => {
            return QmError::ApiData("invalid host response".into())
        }
        QQMusicError::Protocol => {
            return QmError::Protocol {
                stage: "account-transport",
                message: "host protocol failure".into(),
            }
        }
        _ => NetworkErrorKind::Other,
    };
    QmError::Network(NetworkError {
        kind,
        message: "account transport failure".into(),
    })
}
