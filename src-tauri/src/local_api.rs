use crate::credentials::{CredentialError, CredentialStore};
use crate::player::{
    ApiEvent, CurrentLyricState, LyricDocument, PlayerError, PlayerService, PlayerSnapshot,
    QueueSnapshot, RepeatMode, Song,
};
use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response, Sse},
    routing::{get, post, put},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::{
    convert::Infallible,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use thiserror::Error;
use tokio::{
    net::TcpListener,
    sync::{oneshot, Mutex, RwLock},
    task::JoinHandle,
};
use tokio_stream::{wrappers::BroadcastStream, StreamExt};

pub const DEFAULT_LOCAL_API_PORT: u16 = 19_532;
const MAX_REQUEST_BODY_BYTES: usize = 16 * 1024;
const LOCAL_API_TOKEN_ACCOUNT: &str = "local-api-bearer-token";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalApiConfig {
    enabled: bool,
    port: u16,
    #[serde(default, rename = "token", skip_serializing)]
    legacy_token: String,
}

impl Default for LocalApiConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_LOCAL_API_PORT,
            legacy_token: String::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LocalApiRunState {
    Disabled,
    Starting,
    Running,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalApiStatus {
    pub enabled: bool,
    pub state: LocalApiRunState,
    pub host: &'static str,
    pub configured_port: u16,
    pub bound_port: Option<u16>,
    pub token_configured: bool,
    pub last_error: Option<String>,
}

struct ApiRuntime {
    shutdown: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<Result<(), std::io::Error>>>,
}

impl ApiRuntime {
    fn stopped() -> Self {
        Self {
            shutdown: None,
            task: None,
        }
    }
}

#[derive(Debug, Error)]
pub enum LocalApiError {
    #[error("local API configuration could not be read: {0}")]
    Configuration(#[from] serde_json::Error),
    #[error("local API I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("local API task failed: {0}")]
    Task(#[from] tokio::task::JoinError),
    #[error("local API secure token storage is unavailable")]
    Credentials(#[from] CredentialError),
}

pub struct LocalApiService {
    player: Arc<PlayerService>,
    config_path: PathBuf,
    config: RwLock<LocalApiConfig>,
    credentials: Arc<dyn CredentialStore>,
    token: RwLock<String>,
    status: RwLock<LocalApiStatus>,
    runtime: Mutex<ApiRuntime>,
}

impl LocalApiService {
    pub fn new(
        config_path: PathBuf,
        player: Arc<PlayerService>,
        credentials: Arc<dyn CredentialStore>,
    ) -> Result<Arc<Self>, LocalApiError> {
        let mut config = load_or_create_config(&config_path)?;
        let mut credential_error = None;
        let mut token = match credentials.load(LOCAL_API_TOKEN_ACCOUNT) {
            Ok(token) => token.unwrap_or_default(),
            Err(error) => {
                credential_error = Some(error.to_string());
                String::new()
            }
        };
        if !config.legacy_token.is_empty() {
            match credentials.save(LOCAL_API_TOKEN_ACCOUNT, &config.legacy_token) {
                Ok(()) => token.clone_from(&config.legacy_token),
                Err(error) => credential_error = Some(error.to_string()),
            }
            // Fail closed: a legacy plaintext token is removed even when the OS
            // credential store is unavailable. The user can retry enabling later.
            config.legacy_token.clear();
            persist_config(&config_path, &config)?;
        }
        let status = LocalApiStatus {
            enabled: config.enabled,
            state: LocalApiRunState::Disabled,
            host: "127.0.0.1",
            configured_port: config.port,
            bound_port: None,
            token_configured: !token.is_empty(),
            last_error: credential_error,
        };
        Ok(Arc::new(Self {
            player,
            config_path,
            config: RwLock::new(config),
            credentials,
            token: RwLock::new(token),
            status: RwLock::new(status),
            runtime: Mutex::new(ApiRuntime::stopped()),
        }))
    }

    pub async fn start_if_enabled(self: &Arc<Self>) -> Result<LocalApiStatus, LocalApiError> {
        if self.config.read().await.enabled {
            self.start().await
        } else {
            Ok(self.status().await)
        }
    }

    pub async fn status(&self) -> LocalApiStatus {
        self.status.read().await.clone()
    }

    pub async fn set_enabled(
        self: &Arc<Self>,
        enabled: bool,
    ) -> Result<LocalApiStatus, LocalApiError> {
        {
            let mut config = self.config.write().await;
            config.enabled = enabled;
            persist_config(&self.config_path, &config)?;
        }
        self.status.write().await.enabled = enabled;
        if enabled {
            self.start().await
        } else {
            self.stop().await
        }
    }

    pub async fn set_port(self: &Arc<Self>, port: u16) -> Result<LocalApiStatus, LocalApiError> {
        let should_restart = self.status.read().await.state == LocalApiRunState::Running;
        {
            let mut config = self.config.write().await;
            config.port = port;
            persist_config(&self.config_path, &config)?;
        }
        self.status.write().await.configured_port = port;
        if should_restart {
            self.stop().await?;
            self.start().await
        } else {
            Ok(self.status().await)
        }
    }

    pub async fn reveal_token(&self) -> String {
        self.token.read().await.clone()
    }

    pub async fn regenerate_token(self: &Arc<Self>) -> Result<LocalApiStatus, LocalApiError> {
        let should_restart = self.status.read().await.state == LocalApiRunState::Running;
        let token = generate_token();
        self.credentials.save(LOCAL_API_TOKEN_ACCOUNT, &token)?;
        *self.token.write().await = token;
        let mut status = self.status.write().await;
        status.token_configured = true;
        status.last_error = None;
        drop(status);
        if should_restart {
            self.stop().await?;
            self.start().await
        } else {
            Ok(self.status().await)
        }
    }

    pub async fn start(self: &Arc<Self>) -> Result<LocalApiStatus, LocalApiError> {
        let already_running = {
            let runtime = self.runtime.lock().await;
            runtime
                .task
                .as_ref()
                .is_some_and(|task| !task.is_finished())
        };
        if already_running {
            return Ok(self.status().await);
        }

        let config = self.config.read().await.clone();
        let token = match self.ensure_token().await {
            Ok(token) => token,
            Err(error) => {
                let mut status = self.status.write().await;
                status.state = LocalApiRunState::Error;
                status.last_error = Some(error.to_string());
                return Err(error);
            }
        };
        {
            let mut status = self.status.write().await;
            status.state = LocalApiRunState::Starting;
            status.last_error = None;
            status.bound_port = None;
        }

        let listener = match TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, config.port)).await {
            Ok(listener) => listener,
            Err(error) => {
                let mut status = self.status.write().await;
                status.state = LocalApiRunState::Error;
                status.last_error = Some(error.to_string());
                return Err(LocalApiError::Io(error));
            }
        };
        let bound_port = listener.local_addr()?.port();
        let router = build_router(Arc::clone(&self.player), token);
        let (shutdown, shutdown_receiver) = oneshot::channel();
        let task = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_receiver.await;
                })
                .await
        });

        {
            let mut runtime = self.runtime.lock().await;
            runtime.shutdown = Some(shutdown);
            runtime.task = Some(task);
        }
        {
            let mut status = self.status.write().await;
            status.state = LocalApiRunState::Running;
            status.bound_port = Some(bound_port);
            status.last_error = None;
        }
        Ok(self.status().await)
    }

    async fn ensure_token(&self) -> Result<String, LocalApiError> {
        let current = self.token.read().await.clone();
        if !current.is_empty() {
            return Ok(current);
        }
        if let Some(stored) = self.credentials.load(LOCAL_API_TOKEN_ACCOUNT)? {
            *self.token.write().await = stored.clone();
            self.status.write().await.token_configured = true;
            return Ok(stored);
        }
        let generated = generate_token();
        self.credentials.save(LOCAL_API_TOKEN_ACCOUNT, &generated)?;
        *self.token.write().await = generated.clone();
        self.status.write().await.token_configured = true;
        Ok(generated)
    }

    pub async fn stop(&self) -> Result<LocalApiStatus, LocalApiError> {
        let (shutdown, mut task) = {
            let mut runtime = self.runtime.lock().await;
            (runtime.shutdown.take(), runtime.task.take())
        };
        if let Some(shutdown) = shutdown {
            let _ = shutdown.send(());
        }
        if let Some(task) = task.as_mut() {
            if tokio::time::timeout(Duration::from_secs(2), &mut *task)
                .await
                .is_err()
            {
                task.abort();
            }
        }
        let config = self.config.read().await;
        let mut status = self.status.write().await;
        status.state = LocalApiRunState::Disabled;
        status.enabled = config.enabled;
        status.bound_port = None;
        status.last_error = None;
        Ok(status.clone())
    }
}

#[derive(Clone)]
struct ApiState {
    player: Arc<PlayerService>,
}

pub(crate) fn build_router(player: Arc<PlayerService>, token: String) -> Router {
    let state = ApiState { player };
    let protected = Router::new()
        .route("/player", get(get_player))
        .route("/player/track", get(get_track))
        .route("/player/queue", get(get_queue))
        .route("/player/play", post(play))
        .route("/player/pause", post(pause))
        .route("/player/toggle", post(toggle))
        .route("/player/next", post(next))
        .route("/player/previous", post(previous))
        .route("/player/seek", put(seek))
        .route("/player/volume", put(set_volume))
        .route("/player/shuffle", put(set_shuffle))
        .route("/player/repeat", put(set_repeat))
        .route("/lyrics", get(get_lyrics))
        .route("/lyrics/current", get(get_current_lyrics))
        .route("/events", get(events))
        .route_layer(middleware::from_fn_with_state(Arc::new(token), authorize))
        .layer(axum::extract::DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
        .with_state(state);

    Router::new()
        .route("/health", get(health))
        .nest("/v1", protected)
}

async fn authorize(State(expected): State<Arc<String>>, request: Request, next: Next) -> Response {
    let supplied = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    let authorized = supplied.is_some_and(|candidate| {
        candidate.len() == expected.len()
            && bool::from(candidate.as_bytes().ct_eq(expected.as_bytes()))
    });
    if !authorized {
        return ApiError::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "A valid bearer token is required.",
        )
        .into_response();
    }
    next.run(request).await
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    version: u8,
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        version: 1,
    })
}

async fn get_player(State(state): State<ApiState>) -> Json<PlayerSnapshot> {
    Json(state.player.snapshot().await)
}

async fn get_track(State(state): State<ApiState>) -> Json<Option<Song>> {
    Json(state.player.current_track().await)
}

async fn get_queue(State(state): State<ApiState>) -> Json<QueueSnapshot> {
    Json(state.player.queue_snapshot().await)
}

async fn get_lyrics(State(state): State<ApiState>) -> Json<Option<LyricDocument>> {
    Json(state.player.lyrics().await)
}

async fn get_current_lyrics(State(state): State<ApiState>) -> Json<CurrentLyricState> {
    Json(state.player.current_lyric_state().await)
}

async fn play(State(state): State<ApiState>) -> Result<Json<PlayerSnapshot>, ApiError> {
    Ok(Json(state.player.play().await.map_err(ApiError::player)?))
}

async fn pause(State(state): State<ApiState>) -> Result<Json<PlayerSnapshot>, ApiError> {
    Ok(Json(state.player.pause().await.map_err(ApiError::player)?))
}

async fn toggle(State(state): State<ApiState>) -> Result<Json<PlayerSnapshot>, ApiError> {
    Ok(Json(state.player.toggle().await.map_err(ApiError::player)?))
}

async fn next(State(state): State<ApiState>) -> Result<Json<PlayerSnapshot>, ApiError> {
    Ok(Json(state.player.next().await.map_err(ApiError::player)?))
}

async fn previous(State(state): State<ApiState>) -> Result<Json<PlayerSnapshot>, ApiError> {
    Ok(Json(
        state.player.previous().await.map_err(ApiError::player)?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SeekRequest {
    position_ms: u64,
}

async fn seek(
    State(state): State<ApiState>,
    Json(request): Json<SeekRequest>,
) -> Result<Json<PlayerSnapshot>, ApiError> {
    let track = state.player.current_track().await.ok_or_else(|| {
        ApiError::new(StatusCode::CONFLICT, "empty_queue", "No track is selected.")
    })?;
    if request.position_ms > track.duration_ms {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "position_out_of_range",
            "positionMs exceeds the current track duration.",
        ));
    }
    Ok(Json(
        state
            .player
            .seek(request.position_ms)
            .await
            .map_err(ApiError::player)?,
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VolumeRequest {
    volume: f64,
}

async fn set_volume(
    State(state): State<ApiState>,
    Json(request): Json<VolumeRequest>,
) -> Result<Json<PlayerSnapshot>, ApiError> {
    Ok(Json(
        state
            .player
            .set_volume(request.volume)
            .await
            .map_err(ApiError::player)?,
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ShuffleRequest {
    enabled: bool,
}

async fn set_shuffle(
    State(state): State<ApiState>,
    Json(request): Json<ShuffleRequest>,
) -> Json<PlayerSnapshot> {
    Json(state.player.set_shuffle(request.enabled).await)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RepeatRequest {
    mode: RepeatMode,
}

async fn set_repeat(
    State(state): State<ApiState>,
    Json(request): Json<RepeatRequest>,
) -> Json<PlayerSnapshot> {
    Json(state.player.set_repeat(request.mode).await)
}

async fn events(
    State(state): State<ApiState>,
) -> Sse<impl tokio_stream::Stream<Item = Result<axum::response::sse::Event, Infallible>>> {
    let initial_event = ApiEvent {
        version: 1,
        event_type: "player.snapshot".to_owned(),
        timestamp_ms: unix_timestamp_ms(),
        data: serde_json::to_value(state.player.snapshot().await).unwrap_or_default(),
    };
    let initial = tokio_stream::once(Ok(to_sse_event(initial_event)));
    let live = BroadcastStream::new(state.player.subscribe()).filter_map(|event| match event {
        Ok(event) => Some(Ok(to_sse_event(event))),
        Err(_) => None,
    });
    Sse::new(initial.chain(live)).keep_alive(
        axum::response::sse::KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    )
}

fn to_sse_event(event: ApiEvent) -> axum::response::sse::Event {
    axum::response::sse::Event::default()
        .event(event.event_type.clone())
        .json_data(event)
        .expect("ApiEvent is always JSON serializable")
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    fn player(error: PlayerError) -> Self {
        match error {
            PlayerError::EmptyQueue => {
                Self::new(StatusCode::CONFLICT, "empty_queue", error.to_string())
            }
            PlayerError::IndexOutOfRange(_)
            | PlayerError::QueueEntryNotFound(_)
            | PlayerError::InvalidVolume => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_parameter",
                error.to_string(),
            ),
            PlayerError::NoPlayableTracks => Self::new(
                StatusCode::CONFLICT,
                "no_playable_tracks",
                error.to_string(),
            ),
            PlayerError::Playback(_) => Self::new(
                StatusCode::BAD_GATEWAY,
                "playback_failed",
                error.to_string(),
            ),
        }
    }
}

#[derive(Serialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

#[derive(Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorEnvelope {
                error: ErrorBody {
                    code: self.code,
                    message: self.message,
                },
            }),
        )
            .into_response()
    }
}

fn generate_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn unix_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn load_or_create_config(path: &PathBuf) -> Result<LocalApiConfig, LocalApiError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if path.exists() {
        let bytes = std::fs::read(path)?;
        return Ok(serde_json::from_slice(&bytes)?);
    }
    let config = LocalApiConfig::default();
    persist_config(path, &config)?;
    Ok(config)
}

fn persist_config(path: &PathBuf, config: &LocalApiConfig) -> Result<(), LocalApiError> {
    let bytes = serde_json::to_vec_pretty(config)?;
    std::fs::write(path, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::MemoryCredentialStore;
    use crate::player::{
        AlbumSummary, ArtistSummary, Artwork, AudioQuality, LyricLine, LyricMetadata,
        LyricSyncMode, LyricWord, SongAvailability,
    };
    use axum::{
        body::Body,
        http::{HeaderValue, Request},
    };
    use http_body_util::BodyExt;
    use tempfile::tempdir;
    use tower::ServiceExt;

    async fn response_json(response: Response<Body>) -> serde_json::Value {
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("body reads")
            .to_bytes();
        serde_json::from_slice(&bytes).expect("body is JSON")
    }

    fn song(id: &str, duration_ms: u64) -> Song {
        Song {
            id: id.to_owned(),
            title: "Fixture track".to_owned(),
            artists: vec![ArtistSummary {
                id: "artist".to_owned(),
                name: "Fixture artist".to_owned(),
            }],
            album: AlbumSummary {
                id: "album".to_owned(),
                title: "Fixture album".to_owned(),
            },
            artwork: Artwork {
                src: "/cover.svg".to_owned(),
                alt: "Cover".to_owned(),
                dominant_color: "#123456".to_owned(),
                variants: Vec::new(),
            },
            duration_ms,
            track_number: 1,
            is_favorite: false,
            quality: AudioQuality::Lossless,
            availability: SongAvailability::Available,
            audio_formats: Vec::new(),
            playback_capability: None,
            provider: None,
        }
    }

    fn authorization(request: axum::http::request::Builder) -> axum::http::request::Builder {
        request.header(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer secret"),
        )
    }

    #[tokio::test]
    async fn health_is_public_but_v1_requires_a_bearer_token() {
        let router = build_router(Arc::new(PlayerService::new()), "secret".to_owned());

        let health = router
            .clone()
            .oneshot(Request::get("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);

        let denied = router
            .clone()
            .oneshot(Request::get("/v1/player").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(response_json(denied).await["error"]["code"], "unauthorized");

        let allowed = router
            .oneshot(
                Request::get("/v1/player")
                    .header(
                        header::AUTHORIZATION,
                        HeaderValue::from_static("Bearer secret"),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(allowed.status(), StatusCode::OK);
        assert!(allowed
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .is_none());
    }

    #[tokio::test]
    async fn malformed_and_unknown_control_fields_are_rejected() {
        let router = build_router(Arc::new(PlayerService::new()), "secret".to_owned());
        let response = router
            .oneshot(
                Request::put("/v1/player/volume")
                    .header(
                        header::AUTHORIZATION,
                        HeaderValue::from_static("Bearer secret"),
                    )
                    .header(
                        header::CONTENT_TYPE,
                        HeaderValue::from_static("application/json"),
                    )
                    .body(Body::from(r#"{"volume":0.5,"command":"anything"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn listener_is_disabled_by_default_and_binds_loopback_only() {
        let directory = tempdir().expect("temp directory");
        let config_path = directory.path().join("local-api.json");
        let service = LocalApiService::new(
            config_path.clone(),
            Arc::new(PlayerService::new()),
            Arc::new(MemoryCredentialStore::default()),
        )
        .expect("service loads");

        let initial = service.status().await;
        assert!(!initial.enabled);
        assert_eq!(initial.state, LocalApiRunState::Disabled);

        service.set_port(0).await.expect("ephemeral port accepted");
        let running = service.set_enabled(true).await.expect("listener starts");
        assert_eq!(running.host, "127.0.0.1");
        assert_eq!(running.state, LocalApiRunState::Running);
        assert!(running.bound_port.is_some_and(|port| port > 0));

        let stopped = service.set_enabled(false).await.expect("listener stops");
        assert_eq!(stopped.state, LocalApiRunState::Disabled);
        assert_eq!(stopped.bound_port, None);
        let persisted = std::fs::read_to_string(config_path).expect("config reads");
        assert!(!persisted.contains("token"));
    }

    #[tokio::test]
    async fn legacy_plaintext_token_is_migrated_to_the_secure_store() {
        let directory = tempdir().expect("temp directory");
        let config_path = directory.path().join("local-api.json");
        std::fs::write(
            &config_path,
            r#"{"enabled":false,"port":19532,"token":"legacy-secret"}"#,
        )
        .expect("legacy config writes");
        let credentials = Arc::new(MemoryCredentialStore::default());
        let service = LocalApiService::new(
            config_path.clone(),
            Arc::new(PlayerService::new()),
            credentials.clone(),
        )
        .expect("service loads");

        assert_eq!(service.reveal_token().await, "legacy-secret");
        assert_eq!(
            credentials
                .load(LOCAL_API_TOKEN_ACCOUNT)
                .expect("secure token loads"),
            Some("legacy-secret".to_owned())
        );
        let persisted = std::fs::read_to_string(config_path).expect("config reads");
        assert!(!persisted.contains("token"));
        assert!(!persisted.contains("legacy-secret"));
    }

    #[tokio::test]
    async fn playback_controls_and_validation_use_the_shared_player() {
        let player = Arc::new(PlayerService::new());
        player.hydrate_queue(vec![song("one", 10_000)]).await;
        let router = build_router(Arc::clone(&player), "secret".to_owned());

        let played = router
            .clone()
            .oneshot(
                authorization(Request::post("/v1/player/play"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(played.status(), StatusCode::OK);
        assert_eq!(response_json(played).await["isPlaying"], true);
        assert!(player.snapshot().await.is_playing);

        let invalid_seek = router
            .clone()
            .oneshot(
                authorization(Request::put("/v1/player/seek"))
                    .header(
                        header::CONTENT_TYPE,
                        HeaderValue::from_static("application/json"),
                    )
                    .body(Body::from(r#"{"positionMs":10001}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(invalid_seek.status(), StatusCode::UNPROCESSABLE_ENTITY);

        let invalid_volume = router
            .oneshot(
                authorization(Request::put("/v1/player/volume"))
                    .header(
                        header::CONTENT_TYPE,
                        HeaderValue::from_static("application/json"),
                    )
                    .body(Body::from(r#"{"volume":1.1}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(invalid_volume.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn queue_and_player_endpoints_expose_identity_order_and_reversible_shuffle() {
        let player = Arc::new(PlayerService::new());
        let initial = player
            .hydrate_queue(vec![
                song("one", 10_000),
                song("duplicate", 10_000),
                song("duplicate", 10_000),
                song("four", 10_000),
            ])
            .await;
        let moved = initial.queue_entries[2].id.clone();
        player
            .reorder_queue_entry(&moved, 1)
            .await
            .expect("queue reorder succeeds");
        let router = build_router(Arc::clone(&player), "secret".to_owned());

        let queue_response = router
            .clone()
            .oneshot(
                authorization(Request::get("/v1/player/queue"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let queue = response_json(queue_response).await;
        assert_eq!(queue["entries"][1]["id"], moved);
        assert_ne!(queue["entries"][1]["id"], queue["entries"][2]["id"]);
        assert_eq!(queue["playbackOrder"], "sequential");

        let shuffled = router
            .clone()
            .oneshot(
                authorization(Request::put("/v1/player/shuffle"))
                    .header(
                        header::CONTENT_TYPE,
                        HeaderValue::from_static("application/json"),
                    )
                    .body(Body::from(r#"{"enabled":true}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let shuffled = response_json(shuffled).await;
        assert_eq!(shuffled["playbackOrder"], "shuffle");
        assert_eq!(shuffled["shuffle"], true);
        assert_eq!(
            shuffled["shuffleTraversal"].as_array().map(Vec::len),
            Some(4)
        );

        let sequential = router
            .clone()
            .oneshot(
                authorization(Request::put("/v1/player/shuffle"))
                    .header(
                        header::CONTENT_TYPE,
                        HeaderValue::from_static("application/json"),
                    )
                    .body(Body::from(r#"{"enabled":false}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let sequential = response_json(sequential).await;
        assert_eq!(sequential["playbackOrder"], "sequential");
        assert_eq!(sequential["shuffle"], false);
        assert!(sequential["shuffleTraversal"]
            .as_array()
            .is_some_and(Vec::is_empty));
        assert_eq!(sequential["primaryPlaybackMode"], "sequential");

        let one = router
            .clone()
            .oneshot(
                authorization(Request::put("/v1/player/repeat"))
                    .header(
                        header::CONTENT_TYPE,
                        HeaderValue::from_static("application/json"),
                    )
                    .body(Body::from(r#"{"mode":"one"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let one = response_json(one).await;
        assert_eq!(one["repeat"], "one");
        assert_eq!(one["shuffle"], false);
        assert_eq!(one["playbackOrder"], "sequential");
        assert_eq!(one["primaryPlaybackMode"], "repeat-one");

        let shuffled_again = router
            .clone()
            .oneshot(
                authorization(Request::put("/v1/player/shuffle"))
                    .header(
                        header::CONTENT_TYPE,
                        HeaderValue::from_static("application/json"),
                    )
                    .body(Body::from(r#"{"enabled":true}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let shuffled_again = response_json(shuffled_again).await;
        assert_eq!(shuffled_again["shuffle"], true);
        assert_eq!(shuffled_again["repeat"], "one");
        assert_eq!(shuffled_again["primaryPlaybackMode"], "repeat-one");

        let off = router
            .oneshot(
                authorization(Request::put("/v1/player/repeat"))
                    .header(
                        header::CONTENT_TYPE,
                        HeaderValue::from_static("application/json"),
                    )
                    .body(Body::from(r#"{"mode":"off"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let off = response_json(off).await;
        assert_eq!(off["repeat"], "off");
        assert_eq!(off["shuffle"], true);
        assert_eq!(off["primaryPlaybackMode"], "shuffle");
    }

    #[tokio::test]
    async fn real_time_lyric_endpoint_returns_structured_line_and_word_state() {
        let player = Arc::new(PlayerService::new());
        player.hydrate_queue(vec![song("one", 10_000)]).await;
        player
            .set_lyrics(Some(LyricDocument {
                song_id: "one".to_owned(),
                sync_mode: LyricSyncMode::Word,
                metadata: LyricMetadata {
                    source_label: "test".to_owned(),
                    language: Some("en".to_owned()),
                    translated_language: Some("fr".to_owned()),
                    offset_ms: 0,
                },
                vocalists: vec![],
                lines: vec![LyricLine {
                    id: "line".to_owned(),
                    start_ms: Some(1_000),
                    end_ms: Some(3_000),
                    text: "soft light".to_owned(),
                    translation: Some("lumiere douce".to_owned()),
                    romanization: None,
                    vocalist_id: None,
                    words: vec![LyricWord {
                        start_ms: 1_000,
                        end_ms: 2_000,
                        text: "soft".to_owned(),
                    }],
                }],
            }))
            .await;
        player.seek(1_500).await.expect("seek succeeds");
        let router = build_router(player, "secret".to_owned());

        let response = router
            .oneshot(
                authorization(Request::get("/v1/lyrics/current"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = response_json(response).await;
        assert_eq!(body["lineIndex"], 0);
        assert_eq!(body["wordIndex"], 0);
        assert_eq!(body["line"]["translation"], "lumiere douce");
        assert_eq!(body["word"]["text"], "soft");
    }

    #[tokio::test]
    async fn port_conflicts_surface_as_runtime_errors() {
        let first_directory = tempdir().expect("first temp directory");
        let first = LocalApiService::new(
            first_directory.path().join("local-api.json"),
            Arc::new(PlayerService::new()),
            Arc::new(MemoryCredentialStore::default()),
        )
        .expect("first service loads");
        first.set_port(0).await.expect("ephemeral port accepted");
        let first_status = first
            .set_enabled(true)
            .await
            .expect("first listener starts");
        let occupied_port = first_status.bound_port.expect("listener has a port");

        let second_directory = tempdir().expect("second temp directory");
        let second = LocalApiService::new(
            second_directory.path().join("local-api.json"),
            Arc::new(PlayerService::new()),
            Arc::new(MemoryCredentialStore::default()),
        )
        .expect("second service loads");
        second
            .set_port(occupied_port)
            .await
            .expect("port is configured");
        assert!(second.set_enabled(true).await.is_err());
        assert_eq!(second.status().await.state, LocalApiRunState::Error);

        second
            .set_enabled(false)
            .await
            .expect("second service stops");
        first.set_enabled(false).await.expect("first service stops");
    }
}
