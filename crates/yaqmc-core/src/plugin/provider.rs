use std::{
    collections::{BTreeSet, HashMap},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;
use tokio_util::sync::CancellationToken;
use yaqmc_provider_api::{
    AccountCapabilities, AccountLoginFlow, AccountLoginMethodDescriptor, AccountPlaylistDetail,
    AccountPlaylistSummary, AccountProvider, AccountSnapshot, AccountState, Album, AreaFeed,
    Artist, ArtistCatalogKind, ArtistCatalogPage, AudioQualityPreference, CacheStats,
    CatalogProvider, CatalogProviderCapabilities, CatalogSearchKind, CollectPlaylistRequest,
    CreatePlaylistRequest, DeletePlaylistRequest, DiscoverFeed, FavoriteMutationRequest,
    FavoriteMutationResult, HomeFeed, LibrarySnapshot, LyricDocument, LyricsProvider,
    OAuthCallbackMatcher, OAuthLoginProvider, OAuthPrepareResult, OpaquePlaybackSource, Page,
    PlaybackEpoch, PlaybackEpochClock, PlaybackEpochGuard, PlaybackLocation, PlaybackSourceError,
    PlaybackSourceProvider, PlaybackSourceResolver, PlaybackSourceSelection, Playlist,
    PlaylistMutationResult, PlaylistTrackMutationRequest, ProviderAccount, ProviderCapabilities,
    ProviderCommandError, ProviderResult, ProviderStatus, RecommendationBatch,
    RecommendationProvider, RecommendationRequest, RemotePlayHistoryItem, RenamePlaylistRequest,
    ResolvedPlaybackSource, SearchResult, Song,
};

use crate::plugin::{
    component::{component_credential_headers, ComponentRuntimeError, ProviderComponent},
    component_host::ComponentHostContext,
    manifest::{PluginManifest, ProviderCapability, ProviderWorld},
    network::{component_request_origin, proxy_component_media_range},
};

const MAX_CATALOG_VALUE_DEPTH: usize = 64;
const MAX_CATALOG_VALUE_NODES: usize = 100_000;
const MAX_CATALOG_STRING_BYTES: usize = 1024 * 1024;
const COMPONENT_OAUTH_ATTEMPT_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ComponentProviderError {
    #[error("the plugin manifest does not declare a provider component")]
    MissingProvider,
    #[error("the provider component could not be loaded")]
    Runtime(#[from] ComponentRuntimeError),
}

/// Capability adapter between the frozen Plugin API v3 envelope and Core's
/// provider-neutral contracts. The component never receives Core trait objects.
pub struct ComponentProviderAdapter {
    provider_id: String,
    display_name: String,
    component: ProviderComponent,
    host: Option<ComponentHostContext>,
    declared: BTreeSet<ProviderCapability>,
    account_generation: AtomicU64,
    snapshot_revision: AtomicU64,
    epoch_clock: Arc<PlaybackEpochClock>,
    account_cancellation: Mutex<CancellationToken>,
    oauth_attempts: Mutex<HashMap<String, ComponentOAuthAttempt>>,
    last_account_snapshot: Mutex<AccountSnapshot>,
}

impl ComponentProviderAdapter {
    pub fn from_manifest(
        manifest: &PluginManifest,
        component_bytes: &[u8],
    ) -> Result<Arc<Self>, ComponentProviderError> {
        Self::from_manifest_with_host(manifest, component_bytes, None)
    }

    pub fn from_manifest_with_host(
        manifest: &PluginManifest,
        component_bytes: &[u8],
        host: Option<ComponentHostContext>,
    ) -> Result<Arc<Self>, ComponentProviderError> {
        let provider = manifest
            .provider
            .as_ref()
            .ok_or(ComponentProviderError::MissingProvider)?;
        let declared = provider
            .capabilities
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();
        let world =
            ProviderWorld::parse(&provider.world).ok_or(ComponentProviderError::MissingProvider)?;
        let component = ProviderComponent::load_with_host(
            component_bytes,
            declared.iter().copied(),
            world,
            host.clone(),
        )?;
        let provider_id = provider.id.clone();
        let has_account = declared.contains(&ProviderCapability::Account);
        let generation = u64::from(has_account);
        let epoch_clock = Arc::new(PlaybackEpochClock::default());
        if has_account {
            epoch_clock.replace(Some(component_playback_epoch(&provider_id, generation)));
        }
        Ok(Arc::new(Self {
            provider_id,
            display_name: provider
                .name
                .clone()
                .unwrap_or_else(|| manifest.name.clone()),
            component,
            host,
            declared,
            account_generation: AtomicU64::new(generation),
            snapshot_revision: AtomicU64::new(0),
            epoch_clock,
            account_cancellation: Mutex::new(CancellationToken::new()),
            oauth_attempts: Mutex::new(HashMap::new()),
            last_account_snapshot: Mutex::new(guest_component_snapshot()),
        }))
    }

    pub fn provider_id(&self) -> &str {
        &self.provider_id
    }

    pub fn component(&self) -> &ProviderComponent {
        &self.component
    }

    pub fn registry_capabilities(self: &Arc<Self>) -> ProviderCapabilities {
        ProviderCapabilities {
            display_name: Some(self.display_name.clone()),
            catalog: self
                .declared
                .contains(&ProviderCapability::Catalog)
                .then(|| Arc::clone(self) as Arc<dyn CatalogProvider>),
            recommendations: self
                .declared
                .contains(&ProviderCapability::Recommendation)
                .then(|| Arc::clone(self) as Arc<dyn RecommendationProvider>),
            lyrics: self
                .declared
                .contains(&ProviderCapability::Lyrics)
                .then(|| Arc::clone(self) as Arc<dyn LyricsProvider>),
            playback: self
                .declared
                .contains(&ProviderCapability::Playback)
                .then(|| Arc::clone(self) as Arc<dyn PlaybackSourceProvider>),
            account: self
                .declared
                .contains(&ProviderCapability::Account)
                .then(|| Arc::clone(self) as Arc<dyn AccountProvider>),
            ..ProviderCapabilities::default()
        }
    }

    async fn call<Req, Response>(
        &self,
        capability: ProviderCapability,
        operation: &str,
        request: &Req,
    ) -> ProviderResult<Response>
    where
        Req: Serialize + ?Sized,
        Response: DeserializeOwned,
    {
        let payload = serde_json::to_string(request)
            .map_err(|_| ProviderCommandError::invalid_request("provider request is invalid"))?;
        let response = self
            .component
            .invoke(capability, operation, &payload)
            .await
            .map_err(map_runtime_error)?;
        let mut value: Value =
            serde_json::from_str(&response).map_err(|_| ProviderCommandError {
                code: "invalid-provider-response".to_owned(),
                message: "the provider returned malformed JSON".to_owned(),
                retryable: false,
            })?;
        let mut nodes = 0;
        validate_value(&value, 0, &mut nodes)?;
        enforce_provider_scope(&mut value, &self.provider_id);
        serde_json::from_value(value).map_err(|_| ProviderCommandError {
            code: "invalid-provider-response".to_owned(),
            message: "the provider response does not match the requested operation".to_owned(),
            retryable: false,
        })
    }

    async fn call_account_scoped<Req, Response>(
        &self,
        capability: ProviderCapability,
        operation: &str,
        request: &Req,
    ) -> ProviderResult<Response>
    where
        Req: Serialize + ?Sized,
        Response: DeserializeOwned,
    {
        let generation = self.account_generation.load(Ordering::Acquire);
        let response = self.call(capability, operation, request).await?;
        if self.declared.contains(&ProviderCapability::Account)
            && self.account_generation.load(Ordering::Acquire) != generation
        {
            return Err(ProviderCommandError {
                code: "cancelled".to_owned(),
                message: "the provider account changed during the operation".to_owned(),
                retryable: false,
            });
        }
        Ok(response)
    }

    fn advance_account_generation(&self) -> u64 {
        let mut cancellation = self
            .account_cancellation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        cancellation.cancel();
        *cancellation = CancellationToken::new();
        let generation = self.account_generation.fetch_add(1, Ordering::AcqRel) + 1;
        self.epoch_clock.replace(Some(component_playback_epoch(
            &self.provider_id,
            generation,
        )));
        generation
    }

    fn current_playback_guard(&self) -> PlaybackEpochGuard {
        if !self.declared.contains(&ProviderCapability::Account) {
            return PlaybackEpochGuard::unrestricted();
        }
        let cancellation = self
            .account_cancellation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let generation = self.account_generation.load(Ordering::Acquire);
        PlaybackEpochGuard::account_bound(
            component_playback_epoch(&self.provider_id, generation),
            cancellation,
            Arc::clone(&self.epoch_clock),
        )
    }

    fn sanitize_snapshot(&self, mut snapshot: AccountSnapshot) -> AccountSnapshot {
        snapshot.revision = self.snapshot_revision.fetch_add(1, Ordering::AcqRel) + 1;
        *self
            .last_account_snapshot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = snapshot.clone();
        snapshot
    }

    fn sanitize_page<T>(&self, mut page: Page<T>) -> Page<T> {
        page.auth_revision = self.account_generation.load(Ordering::Acquire);
        page
    }

    fn sanitize_playlist_mutation(
        &self,
        mut result: PlaylistMutationResult,
    ) -> PlaylistMutationResult {
        result.auth_revision = self.account_generation.load(Ordering::Acquire);
        result
    }

    fn sanitize_favorite_mutation(
        &self,
        mut result: FavoriteMutationResult,
    ) -> FavoriteMutationResult {
        result.auth_revision = self.account_generation.load(Ordering::Acquire);
        result
    }

    async fn prepare_component_oauth_login(
        &self,
        method_id: &str,
    ) -> ProviderResult<OAuthPrepareResult> {
        if !valid_account_login_method_id(method_id) {
            return Err(ProviderCommandError::invalid_request(
                "account login method is invalid",
            ));
        }
        let host = self.host.as_ref().ok_or_else(|| {
            ProviderCommandError::adapter("provider authorization host is unavailable")
        })?;
        let attempt_id = component_random_token(host, "oauth_")?;
        let state = component_random_token(host, "state_")?;
        self.advance_account_generation();
        let prepared: ComponentOAuthPrepare = self
            .call_account_scoped(
                ProviderCapability::Account,
                "account.auth.prepare-oauth",
                &json!({
                    "loginProvider": method_id,
                    "attemptId": attempt_id,
                    "state": state
                }),
            )
            .await?;
        if prepared.navigation_allowlist.is_empty() || prepared.navigation_allowlist.len() > 16 {
            return Err(ProviderCommandError::invalid_request(
                "provider authorization navigation allowlist is invalid",
            ));
        }
        let authorize_url = validate_component_oauth_url(host, &prepared.url)?;
        if !oauth_state_matches(&authorize_url, &state) {
            return Err(ProviderCommandError::invalid_request(
                "provider authorization state is invalid",
            ));
        }
        for allowed in &prepared.navigation_allowlist {
            validate_component_oauth_url(host, allowed)?;
        }
        if !prepared
            .navigation_allowlist
            .iter()
            .any(|allowed| prepared.url.starts_with(allowed))
        {
            return Err(ProviderCommandError::invalid_request(
                "provider authorization URL is outside its navigation allowlist",
            ));
        }
        validate_component_oauth_url(host, &prepared.callback_matcher.url_prefix)?;
        self.oauth_attempts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                attempt_id.clone(),
                ComponentOAuthAttempt {
                    state,
                    callback_prefix: prepared.callback_matcher.url_prefix.clone(),
                    created_at_ms: component_now_ms(),
                },
            );
        Ok(OAuthPrepareResult {
            attempt_id,
            url: prepared.url,
            mobile_url: None,
            navigation_allowlist: prepared.navigation_allowlist,
            external_navigation_rules: Vec::new(),
            callback_matcher: OAuthCallbackMatcher {
                url_prefix: prepared.callback_matcher.url_prefix,
            },
            snapshot: self.account_snapshot().await,
        })
    }

    fn catalog_capability_projection(&self) -> CatalogProviderCapabilities {
        CatalogProviderCapabilities {
            search: true,
            album: true,
            artist: true,
            playlist: true,
            lyrics: self.declared.contains(&ProviderCapability::Lyrics),
            word_timed_lyrics: self.declared.contains(&ProviderCapability::Lyrics),
            streaming: self.declared.contains(&ProviderCapability::Playback),
            quality_selection: self.declared.contains(&ProviderCapability::Playback),
        }
    }

    async fn resolve_playback(
        &self,
        operation: &str,
        request: &Value,
    ) -> Result<ResolvedPlaybackSource, PlaybackSourceError> {
        let resolution: ComponentPlaybackResolution = self
            .call_account_scoped(ProviderCapability::Playback, operation, request)
            .await
            .map_err(map_playback_command_error)?;
        resolution.into_source(self, self.current_playback_guard())
    }
}

struct ComponentOAuthAttempt {
    state: String,
    callback_prefix: String,
    created_at_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComponentOAuthPrepare {
    url: String,
    navigation_allowlist: Vec<String>,
    callback_matcher: ComponentOAuthCallbackMatcher,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComponentOAuthCallbackMatcher {
    url_prefix: String,
}

fn component_playback_epoch(provider_id: &str, generation: u64) -> PlaybackEpoch {
    PlaybackEpoch::new(generation, format!("component:{provider_id}:{generation}"))
}

fn component_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn guest_component_snapshot() -> AccountSnapshot {
    AccountSnapshot {
        account: AccountState::Guest {
            profile: (),
            entitlement: (),
        },
        revision: 0,
        capabilities: AccountCapabilities {
            qr_login: false,
            favorite_read: false,
            favorite_write: false,
            playlist_read: false,
            playlist_write: false,
            recent_history_read: false,
        },
    }
}

fn component_random_token(host: &ComponentHostContext, prefix: &str) -> ProviderResult<String> {
    let bytes = host.random_bytes(32).map_err(|_| {
        ProviderCommandError::adapter("provider authorization state is unavailable")
    })?;
    let mut token = String::with_capacity(prefix.len() + bytes.len() * 2);
    token.push_str(prefix);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut token, "{byte:02x}").map_err(|_| {
            ProviderCommandError::adapter("provider authorization state is unavailable")
        })?;
    }
    Ok(token)
}

fn validate_component_oauth_url(
    host: &ComponentHostContext,
    value: &str,
) -> ProviderResult<reqwest::Url> {
    if value.len() > 4_096 {
        return Err(ProviderCommandError::invalid_request(
            "provider authorization URL is invalid",
        ));
    }
    let url = reqwest::Url::parse(value).map_err(|_| {
        ProviderCommandError::invalid_request("provider authorization URL is invalid")
    })?;
    let origin = component_request_origin(&json!({ "url": value })).map_err(|_| {
        ProviderCommandError::invalid_request("provider authorization URL is invalid")
    })?;
    if !host.allowed_origins().contains(&origin) {
        return Err(ProviderCommandError::invalid_request(
            "provider authorization origin is not granted",
        ));
    }
    Ok(url)
}

fn oauth_state_matches(url: &reqwest::Url, expected: &str) -> bool {
    let mut values = url
        .query_pairs()
        .filter(|(name, _)| name == "state")
        .map(|(_, value)| value.into_owned());
    values.next().as_deref() == Some(expected) && values.next().is_none()
}

fn prune_oauth_attempts(attempts: &mut HashMap<String, ComponentOAuthAttempt>) {
    let now = component_now_ms();
    let ttl = COMPONENT_OAUTH_ATTEMPT_TTL.as_millis() as u64;
    attempts.retain(|_, attempt| now.saturating_sub(attempt.created_at_ms) <= ttl);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComponentPlaybackResolution {
    source: ComponentPlaybackRecipe,
    cache_key: String,
    format: String,
    #[serde(default)]
    mime_type: Option<String>,
    quality_label: String,
    #[serde(default)]
    bitrate_kbps: Option<u32>,
    #[serde(default)]
    sample_rate_hz: Option<u32>,
    #[serde(default)]
    bit_depth: Option<u16>,
    content_length: u64,
    #[serde(default)]
    expires_at_ms: Option<u64>,
    #[serde(default)]
    timeline_offset_ms: u64,
    #[serde(default)]
    timeline_end_ms: Option<u64>,
    #[serde(default)]
    is_preview: bool,
    selection: PlaybackSourceSelection,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum ComponentPlaybackRecipe {
    Cache { key: String },
    Https { request: Value },
}

impl ComponentPlaybackResolution {
    fn into_source(
        self,
        adapter: &ComponentProviderAdapter,
        epoch_guard: PlaybackEpochGuard,
    ) -> Result<ResolvedPlaybackSource, PlaybackSourceError> {
        validate_playback_text(&self.cache_key, 256)?;
        validate_playback_text(&self.quality_label, 128)?;
        if self
            .mime_type
            .as_deref()
            .is_some_and(|value| validate_playback_text(value, 128).is_err())
        {
            return Err(PlaybackSourceError::TrackUnavailable);
        }
        let format = match self.format.as_str() {
            "mp3" => yaqmc_provider_api::AudioFormat::Mp3,
            "aac" => yaqmc_provider_api::AudioFormat::Aac,
            "flac" => yaqmc_provider_api::AudioFormat::Flac,
            "wav" => yaqmc_provider_api::AudioFormat::Wav,
            _ => return Err(PlaybackSourceError::DecoderUnsupported),
        };
        let opaque: Arc<dyn OpaquePlaybackSource> = match self.source {
            ComponentPlaybackRecipe::Cache { key } => {
                validate_playback_text(&key, 240)?;
                let host = adapter
                    .host
                    .as_ref()
                    .ok_or(PlaybackSourceError::TrackUnavailable)?;
                let bytes = host
                    .cache_get(&key)
                    .map_err(|_| PlaybackSourceError::TrackUnavailable)?
                    .ok_or(PlaybackSourceError::TrackUnavailable)?;
                if bytes.len() as u64 != self.content_length {
                    return Err(PlaybackSourceError::RangeUnsupported);
                }
                Arc::new(ComponentCachePlaybackSource {
                    bytes: Arc::from(bytes),
                    host: host.clone(),
                })
            }
            ComponentPlaybackRecipe::Https { request } => {
                let host = adapter
                    .host
                    .as_ref()
                    .ok_or(PlaybackSourceError::TrackUnavailable)?;
                let origin = component_request_origin(&request)
                    .map_err(|_| PlaybackSourceError::TrackUnavailable)?;
                if !host.allowed_origins().contains(&origin) {
                    return Err(PlaybackSourceError::TrackUnavailable);
                }
                Arc::new(ComponentHttpsPlaybackSource {
                    request,
                    content_length: self.content_length,
                    host: host.clone(),
                    allow_credentials: adapter.declared.contains(&ProviderCapability::Account),
                })
            }
        };
        Ok(ResolvedPlaybackSource {
            cache_key: format!("component:{}:{}", adapter.provider_id, self.cache_key),
            location: PlaybackLocation::Opaque(opaque),
            format,
            mime_type: self.mime_type,
            quality_label: self.quality_label,
            bitrate_kbps: self.bitrate_kbps,
            sample_rate_hz: self.sample_rate_hz,
            bit_depth: self.bit_depth,
            content_length: Some(self.content_length),
            supports_range: true,
            expires_at_ms: self.expires_at_ms,
            timeline_offset_ms: self.timeline_offset_ms,
            timeline_end_ms: self.timeline_end_ms,
            is_preview: self.is_preview,
            selection: self.selection,
            epoch_guard,
        })
    }
}

struct ComponentCachePlaybackSource {
    bytes: Arc<[u8]>,
    host: ComponentHostContext,
}

impl std::fmt::Debug for ComponentCachePlaybackSource {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ComponentCachePlaybackSource")
            .field("content_length", &self.bytes.len())
            .finish()
    }
}

#[async_trait]
impl OpaquePlaybackSource for ComponentCachePlaybackSource {
    fn content_length(&self) -> u64 {
        self.bytes.len() as u64
    }

    async fn read_range(
        &self,
        offset: u64,
        length: usize,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> Result<Vec<u8>, PlaybackSourceError> {
        if cancellation.is_cancelled() {
            return Err(PlaybackSourceError::Cancelled);
        }
        self.host
            .ensure_active()
            .map_err(|_| PlaybackSourceError::Cancelled)?;
        let start = usize::try_from(offset).map_err(|_| PlaybackSourceError::RangeUnsupported)?;
        let end = start
            .checked_add(length)
            .filter(|end| *end <= self.bytes.len())
            .ok_or(PlaybackSourceError::RangeUnsupported)?;
        Ok(self.bytes[start..end].to_vec())
    }
}

struct ComponentHttpsPlaybackSource {
    request: Value,
    content_length: u64,
    host: ComponentHostContext,
    allow_credentials: bool,
}

impl std::fmt::Debug for ComponentHttpsPlaybackSource {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ComponentHttpsPlaybackSource")
            .field("content_length", &self.content_length)
            .finish_non_exhaustive()
    }
}

#[async_trait]
impl OpaquePlaybackSource for ComponentHttpsPlaybackSource {
    fn content_length(&self) -> u64 {
        self.content_length
    }

    async fn read_range(
        &self,
        offset: u64,
        length: usize,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> Result<Vec<u8>, PlaybackSourceError> {
        self.host
            .ensure_active()
            .map_err(|_| PlaybackSourceError::Cancelled)?;
        if cancellation.is_cancelled() {
            return Err(PlaybackSourceError::Cancelled);
        }
        let requested_end = offset
            .checked_add(length as u64)
            .and_then(|value| value.checked_sub(1))
            .filter(|end| *end < self.content_length)
            .ok_or(PlaybackSourceError::RangeUnsupported)?;
        let credentials =
            component_credential_headers(&self.host, self.allow_credentials, &self.request)
                .map_err(|_| PlaybackSourceError::AuthenticationExpired)?;
        let response = tokio::select! {
            _ = cancellation.cancelled() => Err(PlaybackSourceError::Cancelled),
            result = proxy_component_media_range(
                self.host.allowed_origins(),
                &self.request,
                &credentials,
                offset,
                length,
            ) => result.map_err(|_| PlaybackSourceError::Network),
        }?;
        self.host
            .ensure_active()
            .map_err(|_| PlaybackSourceError::Cancelled)?;
        match response.status {
            200 if offset == 0 && length as u64 == self.content_length => {}
            206 => {
                let (start, end, total) = response
                    .content_range
                    .as_deref()
                    .and_then(parse_component_content_range)
                    .ok_or(PlaybackSourceError::RangeUnsupported)?;
                if start != offset || end != requested_end || total != self.content_length {
                    return Err(PlaybackSourceError::RangeUnsupported);
                }
            }
            401 | 403 => return Err(PlaybackSourceError::AuthenticationExpired),
            404 | 410 => return Err(PlaybackSourceError::UrlExpired),
            416 => return Err(PlaybackSourceError::RangeUnsupported),
            _ => return Err(PlaybackSourceError::Network),
        }
        if response.body.len() != length
            || response
                .content_length
                .is_some_and(|value| value != response.body.len() as u64)
            || response.mime_type.as_deref().is_some_and(|mime| {
                !(mime.starts_with("audio/")
                    || mime.eq_ignore_ascii_case("application/octet-stream"))
            })
        {
            return Err(PlaybackSourceError::RangeUnsupported);
        }
        Ok(response.body)
    }
}

fn parse_component_content_range(value: &str) -> Option<(u64, u64, u64)> {
    let value = value.strip_prefix("bytes ")?;
    let (range, total) = value.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    Some((start.parse().ok()?, end.parse().ok()?, total.parse().ok()?))
}

fn validate_playback_text(value: &str, max_bytes: usize) -> Result<(), PlaybackSourceError> {
    if value.is_empty()
        || value.len() > max_bytes
        || value.chars().any(|character| character.is_control())
    {
        Err(PlaybackSourceError::TrackUnavailable)
    } else {
        Ok(())
    }
}

#[async_trait]
impl CatalogProvider for ComponentProviderAdapter {
    fn catalog_capabilities(&self) -> CatalogProviderCapabilities {
        self.catalog_capability_projection()
    }

    async fn catalog_status(&self) -> ProviderStatus {
        ProviderStatus {
            provider_id: self.provider_id.clone(),
            display_name: self.display_name.clone(),
            connection: if self.component.circuit_open() {
                "circuit-open".to_owned()
            } else if self.component.enabled() {
                "ready".to_owned()
            } else {
                "disabled".to_owned()
            },
            message: String::new(),
            preferred_quality: AudioQualityPreference::Automatic,
            capabilities: self.catalog_capability_projection(),
        }
    }

    async fn catalog_search(
        &self,
        query: String,
        kind: CatalogSearchKind,
        page: u32,
        limit: u32,
    ) -> ProviderResult<SearchResult> {
        self.call(
            ProviderCapability::Catalog,
            "catalog.search",
            &json!({ "query": query, "kind": kind, "page": page, "limit": limit }),
        )
        .await
    }

    async fn catalog_song(&self, id: String) -> ProviderResult<Song> {
        self.call(
            ProviderCapability::Catalog,
            "catalog.song",
            &json!({ "id": id }),
        )
        .await
    }

    async fn catalog_album(&self, id: String) -> ProviderResult<Album> {
        self.call(
            ProviderCapability::Catalog,
            "catalog.album",
            &json!({ "id": id }),
        )
        .await
    }

    async fn catalog_artist(&self, id: String) -> ProviderResult<Artist> {
        self.call(
            ProviderCapability::Catalog,
            "catalog.artist",
            &json!({ "id": id }),
        )
        .await
    }

    async fn catalog_artist_page(
        &self,
        id: String,
        kind: ArtistCatalogKind,
        page: u32,
        limit: u32,
    ) -> ProviderResult<ArtistCatalogPage> {
        self.call(
            ProviderCapability::Catalog,
            "catalog.artist-page",
            &json!({ "id": id, "kind": kind, "page": page, "limit": limit }),
        )
        .await
    }

    async fn catalog_playlist(&self, id: String) -> ProviderResult<Playlist> {
        self.call(
            ProviderCapability::Catalog,
            "catalog.playlist",
            &json!({ "id": id }),
        )
        .await
    }

    async fn catalog_home(&self, refresh: bool) -> ProviderResult<HomeFeed> {
        self.call(
            ProviderCapability::Catalog,
            "catalog.home",
            &json!({ "refresh": refresh }),
        )
        .await
    }

    async fn catalog_discover(&self, refresh: bool) -> ProviderResult<DiscoverFeed> {
        self.call(
            ProviderCapability::Catalog,
            "catalog.discover",
            &json!({ "refresh": refresh }),
        )
        .await
    }

    async fn catalog_area(&self, enc_area: String) -> ProviderResult<AreaFeed> {
        self.call(
            ProviderCapability::Catalog,
            "catalog.area",
            &json!({ "encArea": enc_area }),
        )
        .await
    }

    fn catalog_library(&self) -> LibrarySnapshot {
        LibrarySnapshot::default()
    }

    async fn catalog_artwork_data_uri(&self, url: String) -> ProviderResult<String> {
        self.call(
            ProviderCapability::Catalog,
            "catalog.artwork-data-uri",
            &json!({ "url": url }),
        )
        .await
    }

    fn catalog_cache_stats(&self) -> ProviderResult<CacheStats> {
        Err(unsupported("component cache statistics"))
    }

    fn catalog_clear_cache(&self) -> ProviderResult<CacheStats> {
        Err(unsupported("component cache clearing"))
    }

    async fn catalog_remember_songs(&self, _songs: &[Song]) {}
}

#[async_trait]
impl RecommendationProvider for ComponentProviderAdapter {
    async fn recommendation_next(
        &self,
        request: RecommendationRequest,
    ) -> ProviderResult<RecommendationBatch> {
        self.call_account_scoped(
            ProviderCapability::Recommendation,
            "recommendation.next",
            &request,
        )
        .await
    }
}

#[async_trait]
impl LyricsProvider for ComponentProviderAdapter {
    async fn lyrics_for_song(&self, song_id: String) -> ProviderResult<Option<LyricDocument>> {
        self.call_account_scoped(
            ProviderCapability::Lyrics,
            "lyrics.get",
            &json!({ "songId": song_id }),
        )
        .await
    }
}

#[async_trait]
impl PlaybackSourceResolver for ComponentProviderAdapter {
    async fn resolve(&self, song: &Song) -> Result<ResolvedPlaybackSource, PlaybackSourceError> {
        self.resolve_playback("playback.resolve", &json!({ "song": song }))
            .await
    }

    async fn resolve_client_fallback(
        &self,
        song: &Song,
        failed: &PlaybackSourceSelection,
    ) -> Result<ResolvedPlaybackSource, PlaybackSourceError> {
        self.resolve_playback(
            "playback.resolve-client-fallback",
            &json!({ "song": song, "failed": failed }),
        )
        .await
    }
}

#[async_trait]
impl PlaybackSourceProvider for ComponentProviderAdapter {
    fn playback_media_http_client(&self) -> reqwest::Client {
        // Component media is always consumed through PlaybackLocation::Opaque.
        // This compatibility method must never carry component authority.
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("a TLS-only reqwest client can be constructed")
    }

    async fn playback_set_preferred_quality(
        &self,
        quality: AudioQualityPreference,
    ) -> ProviderResult<ProviderStatus> {
        let mut status: ProviderStatus = self
            .call(
                ProviderCapability::Playback,
                "playback.set-preferred-quality",
                &json!({ "quality": quality }),
            )
            .await?;
        status.provider_id = self.provider_id.clone();
        status.display_name = self.display_name.clone();
        status.capabilities = self.catalog_capability_projection();
        Ok(status)
    }

    async fn playback_set_current_quality(
        &self,
        track_id: String,
        quality: AudioQualityPreference,
    ) -> ProviderResult<()> {
        self.call(
            ProviderCapability::Playback,
            "playback.set-current-quality",
            &json!({ "trackId": track_id, "quality": quality }),
        )
        .await
    }
}

#[async_trait]
impl AccountProvider for ComponentProviderAdapter {
    fn provider_account(&self) -> &dyn ProviderAccount {
        self
    }

    async fn account_login_methods(&self) -> ProviderResult<Vec<AccountLoginMethodDescriptor>> {
        let methods: Vec<AccountLoginMethodDescriptor> = self
            .call_account_scoped(
                ProviderCapability::Account,
                "account.auth.login-methods",
                &json!({}),
            )
            .await?;
        validate_account_login_methods(methods)
    }

    async fn account_prepare_login(&self, method_id: &str) -> ProviderResult<OAuthPrepareResult> {
        let methods = self.account_login_methods().await?;
        if !methods.iter().any(|method| method.id == method_id) {
            return Err(ProviderCommandError::invalid_request(
                "account login method is unavailable",
            ));
        }
        self.prepare_component_oauth_login(method_id).await
    }
}

#[async_trait]
impl ProviderAccount for ComponentProviderAdapter {
    fn account_generation(&self) -> u64 {
        self.account_generation.load(Ordering::Acquire)
    }

    async fn account_snapshot(&self) -> AccountSnapshot {
        let snapshot = self
            .call_account_scoped(ProviderCapability::Account, "account.snapshot", &json!({}))
            .await
            .unwrap_or_else(|_| {
                self.last_account_snapshot
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone()
            });
        self.sanitize_snapshot(snapshot)
    }

    async fn favorite_songs(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> ProviderResult<Page<Song>> {
        let page = self
            .call_account_scoped(
                ProviderCapability::Account,
                "account.favorite-songs",
                &json!({ "cursor": cursor, "limit": limit }),
            )
            .await?;
        Ok(self.sanitize_page(page))
    }

    async fn account_playlists(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> ProviderResult<Page<AccountPlaylistSummary>> {
        let page = self
            .call_account_scoped(
                ProviderCapability::Account,
                "account.playlists",
                &json!({ "cursor": cursor, "limit": limit }),
            )
            .await?;
        Ok(self.sanitize_page(page))
    }

    async fn account_playlist_tracks(
        &self,
        playlist: AccountPlaylistSummary,
        cursor: Option<String>,
        limit: u32,
    ) -> ProviderResult<AccountPlaylistDetail> {
        let mut detail: AccountPlaylistDetail = self
            .call_account_scoped(
                ProviderCapability::Account,
                "account.playlist-tracks",
                &json!({ "playlist": playlist, "cursor": cursor, "limit": limit }),
            )
            .await?;
        detail.tracks.auth_revision = self.account_generation();
        Ok(detail)
    }

    async fn account_recently_played(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> ProviderResult<Page<RemotePlayHistoryItem>> {
        let page = self
            .call_account_scoped(
                ProviderCapability::Account,
                "account.recently-played",
                &json!({ "cursor": cursor, "limit": limit }),
            )
            .await?;
        Ok(self.sanitize_page(page))
    }

    async fn set_favorite(
        &self,
        request: FavoriteMutationRequest,
    ) -> ProviderResult<FavoriteMutationResult> {
        let result = self
            .call_account_scoped(
                ProviderCapability::Account,
                "account.set-favorite",
                &json!({ "request": request }),
            )
            .await?;
        Ok(self.sanitize_favorite_mutation(result))
    }

    async fn create_playlist(
        &self,
        request: CreatePlaylistRequest,
    ) -> ProviderResult<PlaylistMutationResult> {
        let result = self
            .call_account_scoped(
                ProviderCapability::Account,
                "account.create-playlist",
                &json!({ "request": request }),
            )
            .await?;
        Ok(self.sanitize_playlist_mutation(result))
    }

    async fn rename_playlist(
        &self,
        request: RenamePlaylistRequest,
    ) -> ProviderResult<PlaylistMutationResult> {
        let result = self
            .call_account_scoped(
                ProviderCapability::Account,
                "account.rename-playlist",
                &json!({ "request": request }),
            )
            .await?;
        Ok(self.sanitize_playlist_mutation(result))
    }

    async fn add_playlist_track(
        &self,
        request: PlaylistTrackMutationRequest,
    ) -> ProviderResult<PlaylistMutationResult> {
        let result = self
            .call_account_scoped(
                ProviderCapability::Account,
                "account.add-playlist-track",
                &json!({ "request": request }),
            )
            .await?;
        Ok(self.sanitize_playlist_mutation(result))
    }

    async fn remove_playlist_track(
        &self,
        request: PlaylistTrackMutationRequest,
    ) -> ProviderResult<PlaylistMutationResult> {
        let result = self
            .call_account_scoped(
                ProviderCapability::Account,
                "account.remove-playlist-track",
                &json!({ "request": request }),
            )
            .await?;
        Ok(self.sanitize_playlist_mutation(result))
    }

    async fn delete_playlist(
        &self,
        request: DeletePlaylistRequest,
    ) -> ProviderResult<PlaylistMutationResult> {
        let result = self
            .call_account_scoped(
                ProviderCapability::Account,
                "account.delete-playlist",
                &json!({ "request": request }),
            )
            .await?;
        Ok(self.sanitize_playlist_mutation(result))
    }

    async fn set_playlist_collected(
        &self,
        request: CollectPlaylistRequest,
    ) -> ProviderResult<PlaylistMutationResult> {
        let result = self
            .call_account_scoped(
                ProviderCapability::Account,
                "account.set-playlist-collected",
                &json!({ "request": request }),
            )
            .await?;
        Ok(self.sanitize_playlist_mutation(result))
    }

    async fn start_qr_login(&self) -> ProviderResult<AccountSnapshot> {
        self.advance_account_generation();
        let snapshot = self
            .call_account_scoped(
                ProviderCapability::Account,
                "account.auth.start-qr",
                &json!({}),
            )
            .await?;
        Ok(self.sanitize_snapshot(snapshot))
    }

    async fn prepare_oauth_login(
        &self,
        provider: OAuthLoginProvider,
    ) -> ProviderResult<OAuthPrepareResult> {
        self.prepare_component_oauth_login(provider.as_str()).await
    }

    async fn complete_oauth_login(
        &self,
        attempt_id: &str,
        callback_url: reqwest::Url,
    ) -> ProviderResult<AccountSnapshot> {
        let attempt = {
            let mut attempts = self
                .oauth_attempts
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            prune_oauth_attempts(&mut attempts);
            attempts.remove(attempt_id)
        }
        .ok_or_else(|| ProviderCommandError::invalid_request("authorization attempt is invalid"))?;
        let host = self.host.as_ref().ok_or_else(|| {
            ProviderCommandError::adapter("provider authorization host is unavailable")
        })?;
        validate_component_oauth_url(host, callback_url.as_str())?;
        if !callback_url.as_str().starts_with(&attempt.callback_prefix)
            || !oauth_state_matches(&callback_url, &attempt.state)
        {
            return Err(ProviderCommandError::invalid_request(
                "provider authorization callback is invalid",
            ));
        }
        self.advance_account_generation();
        let snapshot = self
            .call_account_scoped(
                ProviderCapability::Account,
                "account.auth.complete-oauth",
                &json!({ "attemptId": attempt_id, "callbackUrl": callback_url.as_str() }),
            )
            .await?;
        Ok(self.sanitize_snapshot(snapshot))
    }

    async fn cancel_oauth_login(&self, attempt_id: &str) -> ProviderResult<AccountSnapshot> {
        self.oauth_attempts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(attempt_id);
        self.advance_account_generation();
        let snapshot = self
            .call_account_scoped(
                ProviderCapability::Account,
                "account.auth.cancel-oauth",
                &json!({ "attemptId": attempt_id }),
            )
            .await?;
        Ok(self.sanitize_snapshot(snapshot))
    }

    async fn heartbeat_qr_login(
        &self,
        attempt_id: String,
        owner_lease_id: String,
    ) -> ProviderResult<AccountSnapshot> {
        let snapshot = self
            .call_account_scoped(
                ProviderCapability::Account,
                "account.auth.heartbeat-qr",
                &json!({ "attemptId": attempt_id, "ownerLeaseId": owner_lease_id }),
            )
            .await?;
        Ok(self.sanitize_snapshot(snapshot))
    }

    async fn is_oauth_login(&self, attempt_id: &str) -> bool {
        let mut attempts = self
            .oauth_attempts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        prune_oauth_attempts(&mut attempts);
        attempts.contains_key(attempt_id)
    }

    async fn cancel_qr_login(&self, attempt_id: String) -> ProviderResult<AccountSnapshot> {
        self.advance_account_generation();
        let snapshot = self
            .call_account_scoped(
                ProviderCapability::Account,
                "account.auth.cancel-qr",
                &json!({ "attemptId": attempt_id }),
            )
            .await?;
        Ok(self.sanitize_snapshot(snapshot))
    }

    async fn refresh_qr_login(
        &self,
        attempt_id: Option<String>,
    ) -> ProviderResult<AccountSnapshot> {
        self.advance_account_generation();
        let snapshot = self
            .call_account_scoped(
                ProviderCapability::Account,
                "account.auth.refresh-qr",
                &json!({ "attemptId": attempt_id }),
            )
            .await?;
        Ok(self.sanitize_snapshot(snapshot))
    }

    async fn restore_session(&self) {
        self.advance_account_generation();
        let _ = self
            .call_account_scoped::<_, ()>(
                ProviderCapability::Account,
                "account.restore-session",
                &json!({}),
            )
            .await;
    }

    async fn sign_out(&self) -> ProviderResult<AccountSnapshot> {
        self.advance_account_generation();
        let snapshot = self
            .call_account_scoped(ProviderCapability::Account, "account.sign-out", &json!({}))
            .await?;
        Ok(self.sanitize_snapshot(snapshot))
    }
}

fn unsupported(operation: &str) -> ProviderCommandError {
    ProviderCommandError {
        code: "unsupported-operation".to_owned(),
        message: format!("this provider does not support {operation}"),
        retryable: false,
    }
}

fn valid_account_login_method_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_' | b'.')
        })
}

fn validate_account_login_methods(
    methods: Vec<AccountLoginMethodDescriptor>,
) -> ProviderResult<Vec<AccountLoginMethodDescriptor>> {
    if methods.len() > 16 {
        return Err(invalid_response(
            "the provider returned too many account login methods",
        ));
    }
    let mut seen = BTreeSet::new();
    for method in &methods {
        if !valid_account_login_method_id(&method.id)
            || method.label.trim().is_empty()
            || method.label.len() > 80
            || method.flow != AccountLoginFlow::OAuth
            || !seen.insert(method.id.as_str())
        {
            return Err(invalid_response(
                "the provider returned an invalid account login method",
            ));
        }
    }
    Ok(methods)
}

fn map_runtime_error(error: ComponentRuntimeError) -> ProviderCommandError {
    match error {
        ComponentRuntimeError::Guest(message) => sanitize_guest_error(&message),
        ComponentRuntimeError::Deadline => ProviderCommandError {
            code: "provider-timeout".to_owned(),
            message: "the provider operation timed out".to_owned(),
            retryable: true,
        },
        ComponentRuntimeError::CircuitOpen => ProviderCommandError {
            code: "provider-circuit-open".to_owned(),
            message: "the provider was disabled after repeated sandbox faults".to_owned(),
            retryable: false,
        },
        ComponentRuntimeError::Cancelled => ProviderCommandError {
            code: "provider-cancelled".to_owned(),
            message: "the provider operation was cancelled".to_owned(),
            retryable: false,
        },
        ComponentRuntimeError::Disabled | ComponentRuntimeError::HostUnavailable => {
            ProviderCommandError {
                code: "provider-unavailable".to_owned(),
                message: "the provider is disabled".to_owned(),
                retryable: false,
            }
        }
        ComponentRuntimeError::CapabilityDenied => ProviderCommandError {
            code: "unsupported-operation".to_owned(),
            message: "the provider capability was not granted".to_owned(),
            retryable: false,
        },
        ComponentRuntimeError::InvalidComponent
        | ComponentRuntimeError::OversizedResponse
        | ComponentRuntimeError::SandboxFault => ProviderCommandError {
            code: "provider-sandbox-fault".to_owned(),
            message: "the provider sandbox rejected the operation".to_owned(),
            retryable: false,
        },
    }
}

fn sanitize_guest_error(raw: &str) -> ProviderCommandError {
    let code = serde_json::from_str::<ProviderCommandError>(raw)
        .ok()
        .map(|error| error.code)
        .unwrap_or_default();
    let (code, message, retryable) = match code.as_str() {
        "offline" | "network" => ("offline", "the provider is offline", true),
        "timeout" | "provider-timeout" => {
            ("provider-timeout", "the provider operation timed out", true)
        }
        "rate-limited" => ("rate-limited", "the provider rate limit was reached", true),
        "authentication-expired" => (
            "authentication-expired",
            "the provider authorization expired",
            false,
        ),
        "authorization-rejected" => (
            "authorization-rejected",
            "the provider rejected authorization",
            false,
        ),
        "entitlement-unavailable" | "entitlement-insufficient" => (
            "entitlement-insufficient",
            "the account cannot access this media",
            false,
        ),
        "entitlement-unknown" => (
            "entitlement-unknown",
            "the provider could not determine media access",
            false,
        ),
        "client-unsupported" => (
            "client-unsupported",
            "the media format is unsupported",
            false,
        ),
        "song-unavailable" | "unavailable" | "not-found" => (
            "song-unavailable",
            "the requested provider item is unavailable",
            false,
        ),
        "url-expired" => ("url-expired", "the media source expired", true),
        "range-unsupported" => (
            "range-unsupported",
            "the media source does not support bounded reads",
            false,
        ),
        "response-too-large" => (
            "response-too-large",
            "the provider response exceeded its limit",
            false,
        ),
        "cancelled" | "provider-cancelled" => (
            "provider-cancelled",
            "the provider operation was cancelled",
            false,
        ),
        "invalid-request" => ("invalid-request", "the provider request was invalid", false),
        "unsupported-operation" => (
            "unsupported-operation",
            "the provider does not support this operation",
            false,
        ),
        "mutation-in-progress" => (
            "mutation-in-progress",
            "a provider mutation is already in progress",
            true,
        ),
        "storage-failure" => (
            "storage-failure",
            "the provider could not access its private storage",
            false,
        ),
        _ => (
            "provider-operation-failed",
            "the provider rejected the operation",
            false,
        ),
    };
    ProviderCommandError {
        code: code.to_owned(),
        message: message.to_owned(),
        retryable,
    }
}

fn map_playback_command_error(error: ProviderCommandError) -> PlaybackSourceError {
    match error.code.as_str() {
        "provider-cancelled" | "cancelled" => PlaybackSourceError::Cancelled,
        "authentication-expired" => PlaybackSourceError::AuthenticationExpired,
        "entitlement-unavailable" | "entitlement-insufficient" => {
            PlaybackSourceError::EntitlementInsufficient
        }
        "entitlement-unknown" => PlaybackSourceError::EntitlementUnknown,
        "client-unsupported" => PlaybackSourceError::DecoderUnsupported,
        "url-expired" => PlaybackSourceError::UrlExpired,
        "range-unsupported" => PlaybackSourceError::RangeUnsupported,
        "response-too-large" => PlaybackSourceError::ResponseTooLarge,
        "offline" | "rate-limited" | "provider-timeout" | "network" => PlaybackSourceError::Network,
        "provider-unavailable"
        | "provider-circuit-open"
        | "song-unavailable"
        | "not-found"
        | "unavailable" => PlaybackSourceError::TrackUnavailable,
        _ => PlaybackSourceError::TrackUnavailable,
    }
}

fn validate_value(value: &Value, depth: usize, nodes: &mut usize) -> ProviderResult<()> {
    *nodes = nodes.saturating_add(1);
    if depth > MAX_CATALOG_VALUE_DEPTH || *nodes > MAX_CATALOG_VALUE_NODES {
        return Err(invalid_response("the provider response is too complex"));
    }
    match value {
        Value::String(value) if value.len() > MAX_CATALOG_STRING_BYTES => Err(invalid_response(
            "the provider response contains an oversized string",
        )),
        Value::Array(values) => {
            for value in values {
                validate_value(value, depth + 1, nodes)?;
            }
            Ok(())
        }
        Value::Object(values) => {
            for value in values.values() {
                validate_value(value, depth + 1, nodes)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn invalid_response(message: &str) -> ProviderCommandError {
    ProviderCommandError {
        code: "invalid-provider-response".to_owned(),
        message: message.to_owned(),
        retryable: false,
    }
}

fn enforce_provider_scope(value: &mut Value, provider_id: &str) {
    match value {
        Value::Array(values) => {
            for value in values {
                enforce_provider_scope(value, provider_id);
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                enforce_provider_scope(value, provider_id);
            }
            if looks_like_song(values) {
                let track_id = values
                    .get("provider")
                    .and_then(Value::as_object)
                    .and_then(|provider| provider.get("trackId"))
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .or_else(|| values.get("id").and_then(Value::as_str))
                    .unwrap_or_default()
                    .to_owned();
                let provider = values
                    .entry("provider".to_owned())
                    .or_insert_with(|| json!({}));
                if let Some(provider) = provider.as_object_mut() {
                    provider.insert("providerId".to_owned(), json!(provider_id));
                    provider.insert("trackId".to_owned(), json!(track_id));
                }
            }
            if values.contains_key("entityKind") && values.contains_key("entityId") {
                values.insert("providerId".to_owned(), json!(provider_id));
            }
        }
        _ => {}
    }
}

fn looks_like_song(values: &serde_json::Map<String, Value>) -> bool {
    [
        "id",
        "title",
        "artists",
        "album",
        "artwork",
        "durationMs",
        "quality",
        "availability",
    ]
    .iter()
    .all(|key| values.contains_key(*key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        credentials::MemoryCredentialStore,
        plugin::{
            component::static_test_component, component_host::ComponentHostServices,
            manifest::PluginManifest,
        },
    };

    #[test]
    fn guest_errors_never_echo_component_secrets_or_urls() {
        let raw = serde_json::json!({
            "code": "authentication-expired",
            "message": "Authorization: Bearer secret https://signed.invalid/media?token=secret",
            "retryable": true
        })
        .to_string();
        let error = sanitize_guest_error(&raw);
        let wire = serde_json::to_string(&error).expect("error serializes");
        assert_eq!(error.code, "authentication-expired");
        assert!(!error.retryable);
        assert!(!wire.contains("secret"));
        assert!(!wire.contains("https://"));
        assert!(!wire.contains("Authorization"));
    }

    fn manifest() -> PluginManifest {
        PluginManifest::parse(
            br#"{
                "manifestVersion": 2,
                "id": "dev.example.catalog",
                "name": "Example Catalog",
                "version": "1.0.0",
                "apiVersion": 3,
                "entrypoints": { "component": "component/provider.wasm" },
                "provider": {
                    "id": "dev.example.catalog",
                    "witVersion": "0.1.0",
                    "world": "provider",
                    "capabilities": ["provider.catalog"]
                },
                "permissions": ["provider.catalog"]
            }"#,
        )
        .expect("manifest")
    }

    fn adapter(response: Value) -> Arc<ComponentProviderAdapter> {
        let source = static_test_component(&serde_json::to_string(&response).expect("response"));
        ComponentProviderAdapter::from_manifest(&manifest(), source.as_bytes()).expect("adapter")
    }

    fn capability_adapter(
        capability: ProviderCapability,
        response: Value,
    ) -> Arc<ComponentProviderAdapter> {
        let capability = capability.as_str();
        let manifest = PluginManifest::parse(
            serde_json::to_vec(&json!({
                "manifestVersion": 2,
                "id": "dev.example.capability",
                "name": "Example capability",
                "version": "1.0.0",
                "apiVersion": 3,
                "entrypoints": { "component": "component/provider.wasm" },
                "provider": {
                    "id": "dev.example.capability",
                    "witVersion": "0.1.0",
                    "world": "provider",
                    "capabilities": [capability]
                },
                "permissions": [capability]
            }))
            .expect("manifest JSON")
            .as_slice(),
        )
        .expect("capability manifest");
        let source = static_test_component(&serde_json::to_string(&response).expect("response"));
        ComponentProviderAdapter::from_manifest(&manifest, source.as_bytes()).expect("adapter")
    }

    fn playback_manifest() -> PluginManifest {
        PluginManifest::parse(
            serde_json::to_vec(&json!({
                "manifestVersion": 2,
                "id": "dev.example.playback",
                "name": "Example playback",
                "version": "1.0.0",
                "apiVersion": 3,
                "entrypoints": { "component": "component/provider.wasm" },
                "provider": {
                    "id": "dev.example.playback",
                    "witVersion": "0.1.0",
                    "world": "provider-storage",
                    "capabilities": ["provider.playback"]
                },
                "permissions": ["provider.playback", "plugin.storage"]
            }))
            .expect("manifest JSON")
            .as_slice(),
        )
        .expect("playback manifest")
    }

    fn network_playback_manifest() -> PluginManifest {
        PluginManifest::parse(
            serde_json::to_vec(&json!({
                "manifestVersion": 2,
                "id": "dev.example.network-playback",
                "name": "Example network playback",
                "version": "1.0.0",
                "apiVersion": 3,
                "entrypoints": { "component": "component/provider.wasm" },
                "provider": {
                    "id": "dev.example.network-playback",
                    "witVersion": "0.1.0",
                    "world": "provider-network",
                    "capabilities": ["provider.playback"]
                },
                "permissions": [
                    "provider.playback",
                    "network:https://media.example.com"
                ]
            }))
            .expect("manifest JSON")
            .as_slice(),
        )
        .expect("network playback manifest")
    }

    fn account_manifest() -> PluginManifest {
        PluginManifest::parse(
            serde_json::to_vec(&json!({
                "manifestVersion": 2,
                "id": "dev.example.account",
                "name": "Example account",
                "version": "1.0.0",
                "apiVersion": 3,
                "entrypoints": { "component": "component/provider.wasm" },
                "provider": {
                    "id": "dev.example.account",
                    "witVersion": "0.1.0",
                    "world": "provider-account",
                    "capabilities": ["provider.playback", "provider.account"]
                },
                "permissions": [
                    "provider.playback",
                    "provider.account",
                    "plugin.storage",
                    "network:https://accounts.example.com"
                ]
            }))
            .expect("manifest JSON")
            .as_slice(),
        )
        .expect("account manifest")
    }

    fn account_adapter(response: Value) -> Arc<ComponentProviderAdapter> {
        let root = tempfile::tempdir().expect("temp root");
        let services = ComponentHostServices::open(
            root.path().join("data"),
            root.path().join("cache"),
            Arc::new(MemoryCredentialStore::default()),
            tokio::runtime::Handle::current(),
        )
        .expect("host services");
        let host = services.for_plugin(
            "dev.example.account",
            "dev.example.account",
            std::collections::HashSet::from(["https://accounts.example.com".to_owned()]),
        );
        let source = static_test_component(&serde_json::to_string(&response).expect("response"));
        ComponentProviderAdapter::from_manifest_with_host(
            &account_manifest(),
            source.as_bytes(),
            Some(host),
        )
        .expect("account adapter")
    }

    fn guest_snapshot(revision: u64) -> Value {
        json!({
            "state": "guest",
            "profile": null,
            "entitlement": null,
            "revision": revision,
            "capabilities": {
                "qrLogin": true,
                "favoriteRead": true,
                "favoriteWrite": true,
                "playlistRead": true,
                "playlistWrite": true,
                "recentHistoryRead": true
            }
        })
    }

    fn song() -> Value {
        json!({
            "id": "song-1",
            "title": "Fixture Song",
            "artists": [{ "id": "artist-1", "name": "Fixture Artist" }],
            "album": { "id": "album-1", "title": "Fixture Album" },
            "artwork": { "src": "", "alt": "Fixture", "dominantColor": "#000000" },
            "durationMs": 180000,
            "trackNumber": 1,
            "isFavorite": false,
            "quality": "standard",
            "availability": { "status": "available" },
            "provider": { "providerId": "spoofed", "trackId": "song-1" }
        })
    }

    #[tokio::test]
    async fn read_only_catalog_component_searches_and_opens_entities() {
        let search = adapter(json!({
            "kind": "song",
            "query": "fixture",
            "page": 1,
            "hasMore": false,
            "items": [song()]
        }));
        let result = search
            .catalog_search("fixture".to_owned(), CatalogSearchKind::Song, 1, 20)
            .await
            .expect("search");
        let SearchResult::Song { items, .. } = result else {
            panic!("song result")
        };
        assert_eq!(
            items[0].provider.as_ref().expect("provider").provider_id,
            "dev.example.catalog"
        );

        let opened_song = adapter(song())
            .catalog_song("song-1".to_owned())
            .await
            .expect("song");
        assert_eq!(opened_song.title, "Fixture Song");

        let album = adapter(json!({
            "id": "album-1",
            "title": "Fixture Album",
            "artist": { "id": "artist-1", "name": "Fixture Artist" },
            "artwork": { "src": "", "alt": "Fixture", "dominantColor": "#000000" },
            "releaseYear": 2026,
            "genre": "",
            "description": "",
            "tracks": [song()]
        }))
        .catalog_album("album-1".to_owned())
        .await
        .expect("album");
        assert_eq!(album.tracks.len(), 1);

        let artist = adapter(json!({
            "id": "artist-1",
            "name": "Fixture Artist",
            "artwork": { "src": "", "alt": "Fixture", "dominantColor": "#000000" },
            "description": "",
            "topSongs": [song()],
            "albums": []
        }))
        .catalog_artist("artist-1".to_owned())
        .await
        .expect("artist");
        assert_eq!(artist.top_songs[0].title, "Fixture Song");
    }

    #[tokio::test]
    async fn registry_projection_exposes_only_declared_component_capabilities() {
        let adapter = adapter(json!({}));
        let capabilities = adapter.registry_capabilities();
        assert!(capabilities.catalog.is_some());
        assert!(capabilities.playback.is_none());
        assert!(capabilities.account.is_none());
        adapter.component().disable();
        assert_eq!(
            adapter.catalog_status().await.connection,
            "disabled".to_owned()
        );
    }

    #[tokio::test]
    async fn recommendation_and_lyrics_capabilities_use_the_frozen_operations() {
        let recommendations = capability_adapter(
            ProviderCapability::Recommendation,
            json!({ "songs": [], "nextCursor": "next", "ended": false }),
        );
        let batch = recommendations
            .recommendation_next(RecommendationRequest {
                kind: yaqmc_provider_api::RecommendationKind::Guess,
                limit: 5,
                cursor: None,
                seeds: Vec::new(),
            })
            .await
            .expect("recommendation batch");
        assert_eq!(batch.next_cursor.as_deref(), Some("next"));
        let capabilities = recommendations.registry_capabilities();
        assert!(capabilities.recommendations.is_some());
        assert!(capabilities.catalog.is_none());

        let lyrics = capability_adapter(ProviderCapability::Lyrics, Value::Null);
        assert!(lyrics
            .lyrics_for_song("song-1".to_owned())
            .await
            .expect("lyrics response")
            .is_none());
        let capabilities = lyrics.registry_capabilities();
        assert!(capabilities.lyrics.is_some());
        assert!(capabilities.recommendations.is_none());
    }

    #[tokio::test]
    async fn playback_cache_recipe_stays_opaque_and_is_revoked_on_disable() {
        let root = tempfile::tempdir().expect("temp root");
        let services = ComponentHostServices::open(
            root.path().join("data"),
            root.path().join("cache"),
            Arc::new(MemoryCredentialStore::default()),
            tokio::runtime::Handle::current(),
        )
        .expect("host services");
        let host = services.for_plugin(
            "dev.example.playback",
            "dev.example.playback",
            std::collections::HashSet::new(),
        );
        host.cache_put("fixture-audio", b"RIFF").expect("cache put");
        let response = json!({
            "source": { "kind": "cache", "key": "fixture-audio" },
            "cacheKey": "song-1:standard",
            "format": "wav",
            "mimeType": "audio/wav",
            "qualityLabel": "standard",
            "contentLength": 4,
            "selection": {
                "requestedQuality": "automatic",
                "resolvedQuality": "standard",
                "preview": false,
                "qualityCapabilities": []
            }
        });
        let source = static_test_component(&serde_json::to_string(&response).expect("response"));
        let adapter = ComponentProviderAdapter::from_manifest_with_host(
            &playback_manifest(),
            source.as_bytes(),
            Some(host),
        )
        .expect("playback adapter");
        let song: Song = serde_json::from_value(song()).expect("song");
        let resolved = adapter.resolve(&song).await.expect("resolved source");
        assert_eq!(
            resolved.cache_key,
            "component:dev.example.playback:song-1:standard"
        );
        let PlaybackLocation::Opaque(opaque) = resolved.location else {
            panic!("component playback must remain opaque")
        };
        assert_eq!(
            opaque
                .read_range(0, 4, tokio_util::sync::CancellationToken::new())
                .await
                .expect("opaque read"),
            b"RIFF"
        );
        assert!(!format!("{opaque:?}").contains("fixture-audio"));
        assert!(adapter.registry_capabilities().playback.is_some());

        adapter.component().disable();
        assert_eq!(
            opaque
                .read_range(0, 4, tokio_util::sync::CancellationToken::new())
                .await,
            Err(PlaybackSourceError::Cancelled)
        );
    }

    #[tokio::test]
    async fn playback_https_recipe_is_origin_scoped_and_debug_redacted() {
        let root = tempfile::tempdir().expect("temp root");
        let services = ComponentHostServices::open(
            root.path().join("data"),
            root.path().join("cache"),
            Arc::new(MemoryCredentialStore::default()),
            tokio::runtime::Handle::current(),
        )
        .expect("host services");
        let host = services.for_plugin(
            "dev.example.network-playback",
            "dev.example.network-playback",
            std::collections::HashSet::from(["https://media.example.com".to_owned()]),
        );
        let response = json!({
            "source": {
                "kind": "https",
                "request": {
                    "url": "https://media.example.com/song?opaque=sensitive",
                    "headers": { "accept": "audio/*" }
                }
            },
            "cacheKey": "song-1:standard",
            "format": "mp3",
            "mimeType": "audio/mpeg",
            "qualityLabel": "standard",
            "contentLength": 9,
            "selection": {
                "requestedQuality": "automatic",
                "resolvedQuality": "standard",
                "preview": false,
                "qualityCapabilities": []
            }
        });
        let source = static_test_component(&serde_json::to_string(&response).expect("response"));
        let adapter = ComponentProviderAdapter::from_manifest_with_host(
            &network_playback_manifest(),
            source.as_bytes(),
            Some(host),
        )
        .expect("network adapter");
        let song: Song = serde_json::from_value(song()).expect("song");
        let resolved = adapter.resolve(&song).await.expect("resolved source");
        let PlaybackLocation::Opaque(opaque) = resolved.location else {
            panic!("network recipe must remain opaque")
        };
        let debug = format!("{opaque:?}");
        assert!(!debug.contains("media.example.com"));
        assert!(!debug.contains("sensitive"));
    }

    #[tokio::test]
    async fn account_generation_is_host_owned_and_cancels_old_playback_authority() {
        let adapter = account_adapter(guest_snapshot(9_999));
        let capabilities = adapter.registry_capabilities();
        assert!(capabilities.account.is_some());
        assert!(capabilities.playback.is_some());
        assert_eq!(adapter.account_generation(), 1);

        let old_guard = adapter.current_playback_guard();
        let snapshot = adapter.account_snapshot().await;
        assert_eq!(snapshot.revision, 1);
        let snapshot = adapter.start_qr_login().await.expect("start QR login");
        assert_eq!(snapshot.revision, 2);
        assert_eq!(adapter.account_generation(), 2);
        assert_eq!(old_guard.validate(), Err(PlaybackSourceError::Cancelled));
    }

    #[tokio::test]
    async fn account_pages_ignore_guest_supplied_auth_revision() {
        let adapter = account_adapter(json!({
            "items": [],
            "nextCursor": null,
            "total": 0,
            "fetchedAtMs": 1,
            "stale": false,
            "authRevision": 9_999
        }));
        let page = adapter
            .favorite_songs(None, 20)
            .await
            .expect("favorite page");
        assert_eq!(page.auth_revision, adapter.account_generation());
    }

    #[test]
    fn oauth_state_requires_one_exact_callback_value() {
        let exact = reqwest::Url::parse("https://accounts.example.com/cb?state=state_abc")
            .expect("callback");
        assert!(oauth_state_matches(&exact, "state_abc"));
        let duplicate =
            reqwest::Url::parse("https://accounts.example.com/cb?state=state_abc&state=state_abc")
                .expect("callback");
        assert!(!oauth_state_matches(&duplicate, "state_abc"));
        let wrong = reqwest::Url::parse("https://accounts.example.com/cb?state=state_other")
            .expect("callback");
        assert!(!oauth_state_matches(&wrong, "state_abc"));
    }
}
