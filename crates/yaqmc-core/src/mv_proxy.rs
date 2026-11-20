use std::{
    collections::HashMap,
    net::Ipv4Addr,
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use tokio::{net::TcpListener, sync::RwLock, task::JoinHandle};
use yaqmc_provider_api::{MusicVideo, MvPlaybackSource};

const SOURCE_TTL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum MvProxyError {
    #[error("the MV proxy could not bind to loopback")]
    Bind,
}

#[derive(Clone)]
struct ProxySource {
    upstream_url: String,
    headers: HeaderMap,
    mime_type: String,
    content_length: u64,
    created_at: Instant,
    client: reqwest::Client,
}

#[derive(Clone)]
struct ProxyState {
    sources: Arc<RwLock<HashMap<String, ProxySource>>>,
}

struct ProxyRuntime {
    port: u16,
    task: JoinHandle<()>,
}

pub struct MvStreamProxy {
    state: ProxyState,
    runtime: RwLock<Option<ProxyRuntime>>,
}

impl Default for MvStreamProxy {
    fn default() -> Self {
        Self::new()
    }
}

impl MvStreamProxy {
    pub fn new() -> Self {
        Self {
            state: ProxyState {
                sources: Arc::new(RwLock::new(HashMap::new())),
            },
            runtime: RwLock::new(None),
        }
    }

    pub async fn publish(
        &self,
        playback: MvPlaybackSource,
        client: reqwest::Client,
    ) -> Result<MusicVideo, MvProxyError> {
        let port = self.ensure_started().await?;
        let mut token_bytes = [0_u8; 32];
        rand::rng().fill_bytes(&mut token_bytes);
        let token = URL_SAFE_NO_PAD.encode(token_bytes);
        let mut headers = HeaderMap::new();
        for (name, value) in playback.headers {
            let (Ok(name), Ok(value)) = (
                HeaderName::from_bytes(name.as_bytes()),
                HeaderValue::from_str(&value),
            ) else {
                continue;
            };
            headers.append(name, value);
        }
        let now = Instant::now();
        let mut sources = self.state.sources.write().await;
        sources.retain(|_, source| now.duration_since(source.created_at) < SOURCE_TTL);
        sources.insert(
            token.clone(),
            ProxySource {
                upstream_url: playback.upstream_url,
                headers,
                mime_type: playback.mime_type,
                content_length: playback.content_length,
                created_at: now,
                client,
            },
        );
        drop(sources);

        let mut video = playback.video;
        video.stream_url = format!("http://127.0.0.1:{port}/mv/{token}");
        Ok(video)
    }

    async fn ensure_started(&self) -> Result<u16, MvProxyError> {
        if let Some(runtime) = self.runtime.read().await.as_ref() {
            return Ok(runtime.port);
        }
        let mut runtime = self.runtime.write().await;
        if let Some(runtime) = runtime.as_ref() {
            return Ok(runtime.port);
        }
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|_| MvProxyError::Bind)?;
        let port = listener
            .local_addr()
            .map_err(|_| MvProxyError::Bind)?
            .port();
        let state = self.state.clone();
        let task = tokio::spawn(async move {
            let router = Router::new()
                .route("/mv/{token}", get(serve_media))
                .with_state(state);
            let _ = axum::serve(listener, router).await;
        });
        *runtime = Some(ProxyRuntime { port, task });
        Ok(port)
    }
}

impl Drop for MvStreamProxy {
    fn drop(&mut self) {
        let runtime = self.runtime.get_mut();
        if let Some(runtime) = runtime.take() {
            runtime.task.abort();
        }
    }
}

async fn serve_media(
    State(state): State<ProxyState>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> Response {
    let source = state.sources.read().await.get(&token).cloned();
    let Some(source) = source else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if source.created_at.elapsed() >= SOURCE_TTL {
        state.sources.write().await.remove(&token);
        return StatusCode::GONE.into_response();
    }

    let mut request = source
        .client
        .get(&source.upstream_url)
        .headers(source.headers.clone());
    if let Some(range) = headers.get(header::RANGE) {
        request = request.header(header::RANGE, range);
    }
    let upstream = match request.send().await {
        Ok(response) => response,
        Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
    };
    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let upstream_headers = upstream.headers().clone();
    let stream = upstream.bytes_stream();
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = status;
    let output = response.headers_mut();
    copy_header(&upstream_headers, output, header::CONTENT_TYPE);
    copy_header(&upstream_headers, output, header::CONTENT_LENGTH);
    copy_header(&upstream_headers, output, header::CONTENT_RANGE);
    copy_header(&upstream_headers, output, header::ACCEPT_RANGES);
    copy_header(&upstream_headers, output, header::ETAG);
    copy_header(&upstream_headers, output, header::LAST_MODIFIED);
    copy_header(&upstream_headers, output, header::CACHE_CONTROL);
    if !output.contains_key(header::CONTENT_TYPE) {
        output.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_str(&source.mime_type)
                .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
        );
    }
    if !output.contains_key(header::CONTENT_LENGTH) && source.content_length > 0 {
        if let Ok(value) = HeaderValue::from_str(&source.content_length.to_string()) {
            output.insert(header::CONTENT_LENGTH, value);
        }
    }
    output.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    response
}

fn copy_header(source: &HeaderMap, target: &mut HeaderMap, name: HeaderName) {
    if let Some(value) = source.get(&name) {
        target.insert(name, value.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use yaqmc_provider_api::Artwork;

    #[tokio::test]
    async fn proxy_exposes_an_opaque_url_and_forwards_ranges_with_upstream_headers() {
        let received = Arc::new(RwLock::new(HeaderMap::new()));
        let upstream_state = Arc::clone(&received);
        let upstream = Router::new()
            .route(
                "/media",
                get(move |headers: HeaderMap| {
                    let state = Arc::clone(&upstream_state);
                    async move {
                        *state.write().await = headers;
                        Response::builder()
                            .status(StatusCode::PARTIAL_CONTENT)
                            .header(header::CONTENT_TYPE, "video/mp4")
                            .header(header::CONTENT_RANGE, "bytes 2-5/10")
                            .header(header::CONTENT_LENGTH, "4")
                            .header(header::ACCEPT_RANGES, "bytes")
                            .body(Body::from("2345"))
                            .expect("valid upstream response")
                    }
                }),
            )
            .with_state(());
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("bind upstream");
        let upstream_address = listener.local_addr().expect("upstream address");
        let upstream_task = tokio::spawn(async move {
            axum::serve(listener, upstream)
                .await
                .expect("serve upstream");
        });

        let proxy = MvStreamProxy::new();
        let playback = MvPlaybackSource {
            video: MusicVideo {
                id: "qqmusic:mv:fixture".to_owned(),
                title: "Fixture MV".to_owned(),
                artist: "Fixture Artist".to_owned(),
                artwork: Artwork {
                    src: String::new(),
                    alt: "Fixture MV".to_owned(),
                    dominant_color: "#000000".to_owned(),
                    variants: Vec::new(),
                },
                duration_ms: 1_000,
                description: String::new(),
                play_count: 0,
                stream_url: String::new(),
            },
            upstream_url: format!("http://{upstream_address}/media"),
            headers: vec![
                ("Cookie".to_owned(), "qm_keyst=secret".to_owned()),
                ("Referer".to_owned(), "https://y.qq.com/".to_owned()),
            ],
            mime_type: "video/mp4".to_owned(),
            content_length: 10,
        };
        let published = proxy
            .publish(playback, reqwest::Client::new())
            .await
            .expect("publish proxy source");
        assert!(published.stream_url.starts_with("http://127.0.0.1:"));
        assert!(!published.stream_url.contains("secret"));
        assert!(!published.stream_url.contains("/media"));

        let response = reqwest::Client::new()
            .get(&published.stream_url)
            .header("Range", "bytes=2-5")
            .send()
            .await
            .expect("request proxied media");
        assert_eq!(response.status(), reqwest::StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            response
                .headers()
                .get("content-range")
                .and_then(|value| value.to_str().ok()),
            Some("bytes 2-5/10")
        );
        assert_eq!(
            response.bytes().await.expect("proxy body").as_ref(),
            b"2345"
        );

        let forwarded = received.read().await;
        assert_eq!(
            forwarded.get(header::RANGE),
            Some(&HeaderValue::from_static("bytes=2-5"))
        );
        assert_eq!(
            forwarded.get(header::COOKIE),
            Some(&HeaderValue::from_static("qm_keyst=secret"))
        );
        assert_eq!(
            forwarded.get(header::REFERER),
            Some(&HeaderValue::from_static("https://y.qq.com/"))
        );

        drop(proxy);
        upstream_task.abort();
    }
}
