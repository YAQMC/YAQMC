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
            HttpBody::Json(value) => {
                if !headers.contains_key(header::CONTENT_TYPE) {
                    headers.insert(
                        header::CONTENT_TYPE,
                        HeaderValue::from_static("application/json"),
                    );
                }
                Some(serde_json::to_vec(&value)?)
            }
            HttpBody::Form(value) => {
                if !headers.contains_key(header::CONTENT_TYPE) {
                    headers.insert(
                        header::CONTENT_TYPE,
                        HeaderValue::from_static("application/x-www-form-urlencoded"),
                    );
                }
                Some(encode_form_body(&value)?)
            }
            HttpBody::Bytes(bytes) => Some(bytes),
        };
        let cancellation = request.cancellation.clone();
        let timeout = request.timeout;
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
        let response = match timeout {
            Some(timeout) => {
                tokio::select! {
                    biased;
                    () = cancellation.cancelled() => return Err(map_error(QQMusicError::Cancelled)),
                    response = tokio::time::timeout(timeout, operation) => match response {
                        Ok(response) => response.map_err(map_error)?,
                        Err(_) => return Err(map_error(QQMusicError::Timeout)),
                    },
                }
            }
            None => tokio::select! {
                biased;
                () = cancellation.cancelled() => return Err(map_error(QQMusicError::Cancelled)),
                response = operation => response.map_err(map_error)?,
            },
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

fn encode_form_body(value: &serde_json::Value) -> qqmusic_api::Result<Vec<u8>> {
    let mut encoded = Url::parse("https://form.invalid/")
        .map_err(|_| qqmusic_api::QmError::ValueError("form encoder base".into()))?;
    if let Some(object) = value.as_object() {
        let mut pairs = encoded.query_pairs_mut();
        for (key, value) in object {
            let value = match value {
                serde_json::Value::String(value) => value.clone(),
                serde_json::Value::Number(value) => value.to_string(),
                serde_json::Value::Bool(value) => value.to_string(),
                other => other.to_string(),
            };
            pairs.append_pair(key, &value);
        }
    }
    Ok(encoded.query().unwrap_or_default().as_bytes().to_vec())
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

#[cfg(test)]
mod tests {
    use super::*;
    use qqmusic_api::{ApiTransport, HttpBody, HttpMethod, NetworkErrorKind};
    use std::{collections::BTreeMap, sync::Mutex, time::Duration};

    struct ObservedRequest {
        headers: HeaderMap,
        body: Option<Vec<u8>>,
    }

    struct RecordingTransport {
        observed: Arc<Mutex<Option<ObservedRequest>>>,
        delay: Option<Duration>,
    }

    #[async_trait]
    impl QqTransport for RecordingTransport {
        async fn execute(
            &self,
            request: TransportRequest,
        ) -> Result<TransportResponse, QQMusicError> {
            *self.observed.lock().unwrap() = Some(ObservedRequest {
                headers: request.headers.clone(),
                body: request.body.clone(),
            });
            if let Some(delay) = self.delay {
                tokio::time::sleep(delay).await;
            }
            Ok(TransportResponse {
                status: StatusCode::OK,
                final_url: request.url,
                headers: HeaderMap::new(),
                body: b"{}".to_vec(),
            })
        }
    }

    fn host_transport(
        observed: Arc<Mutex<Option<ObservedRequest>>>,
        delay: Option<Duration>,
    ) -> HostTransport {
        HostTransport {
            inner: Arc::new(RecordingTransport { observed, delay }),
            operation: "test",
            response_shape: "test",
        }
    }

    fn request(body: HttpBody) -> qqmusic_api::TransportRequest {
        let mut request = qqmusic_api::TransportRequest::new(
            HttpMethod::Post,
            "https://u.y.qq.com/cgi-bin/musicu.fcg",
        );
        request.body = body;
        request
    }

    fn observed_body(observed: &Arc<Mutex<Option<ObservedRequest>>>) -> Vec<u8> {
        observed
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|request| request.body.clone())
            .expect("recorded request body")
    }

    #[tokio::test]
    async fn form_body_matches_default_encoding_and_content_type() {
        let observed = Arc::new(Mutex::new(None));
        let transport = host_transport(observed.clone(), None);
        transport
            .execute(request(HttpBody::Form(serde_json::json!({
                "a": null,
                "b": [1, 2],
                "c": {"nested": true},
                "d": "hello world",
            }))))
            .await
            .expect("form request");

        let observed_request = observed.lock().unwrap();
        let observed_request = observed_request.as_ref().expect("recorded request");
        assert_eq!(
            observed_request
                .headers
                .get(header::CONTENT_TYPE)
                .expect("content type")
                .to_str()
                .unwrap(),
            "application/x-www-form-urlencoded"
        );
        let body =
            std::str::from_utf8(observed_request.body.as_deref().expect("encoded form body"))
                .expect("UTF-8 form body");
        let mut parsed = Url::parse("https://form.invalid/").expect("constant form URL");
        parsed.set_query(Some(body));
        let fields = parsed
            .query_pairs()
            .into_owned()
            .collect::<BTreeMap<_, _>>();
        assert_eq!(fields.get("a").map(String::as_str), Some("null"));
        assert_eq!(fields.get("b").map(String::as_str), Some("[1,2]"));
        assert_eq!(
            fields.get("c").map(String::as_str),
            Some(r#"{"nested":true}"#)
        );
        assert_eq!(fields.get("d").map(String::as_str), Some("hello world"));
    }

    #[tokio::test]
    async fn non_object_form_body_is_empty() {
        let observed = Arc::new(Mutex::new(None));
        let transport = host_transport(observed.clone(), None);
        transport
            .execute(request(HttpBody::Form(serde_json::json!([1, 2, 3]))))
            .await
            .expect("form request");

        assert!(observed_body(&observed).is_empty());
    }

    #[tokio::test]
    async fn json_body_gets_default_content_type() {
        let observed = Arc::new(Mutex::new(None));
        let transport = host_transport(observed.clone(), None);
        transport
            .execute(request(HttpBody::Json(serde_json::json!({"ok": true}))))
            .await
            .expect("json request");

        let observed_request = observed.lock().unwrap();
        let observed_request = observed_request.as_ref().expect("recorded request");
        assert_eq!(
            observed_request
                .headers
                .get(header::CONTENT_TYPE)
                .expect("content type")
                .to_str()
                .unwrap(),
            "application/json"
        );
        assert_eq!(
            observed_request.body.as_deref(),
            Some(br#"{"ok":true}"#.as_slice())
        );
    }

    #[tokio::test]
    async fn explicit_content_type_is_preserved() {
        let observed = Arc::new(Mutex::new(None));
        let transport = host_transport(observed.clone(), None);
        let mut request = request(HttpBody::Json(serde_json::json!({"ok": true})));
        request
            .headers
            .push(("content-type".into(), "application/custom+json".into()));
        transport.execute(request).await.expect("json request");

        let observed_request = observed.lock().unwrap();
        assert_eq!(
            observed_request
                .as_ref()
                .unwrap()
                .headers
                .get(header::CONTENT_TYPE)
                .unwrap()
                .to_str()
                .unwrap(),
            "application/custom+json"
        );
    }

    #[tokio::test]
    async fn shorter_request_timeout_is_enforced() {
        let observed = Arc::new(Mutex::new(None));
        let transport = host_transport(observed, Some(Duration::from_millis(200)));
        let mut request = request(HttpBody::Empty);
        request.timeout = Some(Duration::from_millis(20));

        let error = tokio::time::timeout(Duration::from_millis(250), transport.execute(request))
            .await
            .expect("adapter must enforce the library timeout")
            .expect_err("request timeout");
        assert!(matches!(
            error,
            qqmusic_api::QmError::Network(error)
                if error.kind == NetworkErrorKind::Timeout
        ));
    }
}
