use std::{
    collections::{BTreeSet, HashMap},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
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
    ProviderCommandError, ProviderResult, ProviderScopedOutput, ProviderStatus,
    RecommendationBatch, RecommendationProvider, RecommendationRequest, RemotePlayHistoryItem,
    RenamePlaylistRequest, ResolvedPlaybackSource, SearchResult, Song, DEFAULT_PROFILE_ID,
};
use yaqmc_provider_api::{CommentsProvider, SongCommentsPage, SongCommentsRequest};

#[cfg(test)]
use yaqmc_provider_api::ShareTarget;

use crate::plugin::{
    component::{component_credential_headers, ComponentRuntimeError, ProviderComponent},
    component_host::ComponentHostContext,
    manifest::{PluginManifest, ProviderCapability, ProviderWorld},
    network::{component_request_origin, origin_allowed, proxy_component_media_range},
};

const MAX_CATALOG_VALUE_DEPTH: usize = 64;

#[async_trait]
impl CommentsProvider for ComponentProviderAdapter {
    async fn song_comments(
        &self,
        request: SongCommentsRequest,
    ) -> ProviderResult<SongCommentsPage> {
        request.validate()?;
        let page: SongCommentsPage = self
            .call_account_scoped(ProviderCapability::Comments, "comments.list", &request)
            .await?;
        page.bounded()
    }
}
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
    platform: Option<String>,
    display_name: String,
    component: ProviderComponent,
    host: Option<ComponentHostContext>,
    declared: BTreeSet<ProviderCapability>,
    account_generation: AtomicU64,
    epoch_clock: Arc<PlaybackEpochClock>,
    account_cancellation: Mutex<CancellationToken>,
    oauth_attempts: Mutex<HashMap<String, ComponentOAuthAttempt>>,
    last_account_snapshot: Mutex<AccountSnapshot>,
    update_admission: Arc<tokio::sync::RwLock<()>>,
    last_activity: Mutex<Option<Instant>>,
}

struct ProviderCallGuard<'a> {
    _admission: tokio::sync::RwLockReadGuard<'a, ()>,
    last_activity: &'a Mutex<Option<Instant>>,
}

impl Drop for ProviderCallGuard<'_> {
    fn drop(&mut self) {
        *self.last_activity.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
    }
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
            .provider_declarations()
            .into_iter()
            .next()
            .ok_or(ComponentProviderError::MissingProvider)?;
        Self::from_manifest_with_provider(manifest, provider, component_bytes, host)
    }

    pub fn from_manifest_with_provider(
        manifest: &PluginManifest,
        provider: &crate::plugin::manifest::ProviderPluginManifest,
        component_bytes: &[u8],
        host: Option<ComponentHostContext>,
    ) -> Result<Arc<Self>, ComponentProviderError> {
        Self::from_precompiled(
            manifest,
            provider,
            ProviderComponent::compile(component_bytes)?,
            host,
        )
    }

    pub(crate) fn from_precompiled(
        manifest: &PluginManifest,
        provider: &crate::plugin::manifest::ProviderPluginManifest,
        compiled: crate::plugin::component::CompiledComponent,
        host: Option<ComponentHostContext>,
    ) -> Result<Arc<Self>, ComponentProviderError> {
        let declared = provider
            .capabilities
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();
        let world =
            ProviderWorld::parse(&provider.world).ok_or(ComponentProviderError::MissingProvider)?;
        let component = ProviderComponent::from_compiled(
            compiled,
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
            provider_id: provider_id.clone(),
            platform: provider.platform.clone(),
            display_name: provider
                .name
                .clone()
                .unwrap_or_else(|| manifest.name.clone()),
            component,
            host,
            declared,
            account_generation: AtomicU64::new(generation),
            epoch_clock,
            account_cancellation: Mutex::new(CancellationToken::new()),
            oauth_attempts: Mutex::new(HashMap::new()),
            last_account_snapshot: Mutex::new(guest_component_snapshot(&provider_id)),
            update_admission: Arc::new(tokio::sync::RwLock::new(())),
            last_activity: Mutex::new(None),
        }))
    }

    pub fn provider_id(&self) -> &str {
        &self.provider_id
    }

    pub fn component(&self) -> &ProviderComponent {
        &self.component
    }

    pub(crate) fn update_busy(&self) -> bool {
        self.update_admission.try_write().is_err() || self.update_session_busy()
    }

    pub(crate) fn update_session_busy(&self) -> bool {
        let mut attempts = self
            .oauth_attempts
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        prune_oauth_attempts(&mut attempts);
        self.component.busy()
            || !attempts.is_empty()
            || matches!(
                self.last_account_snapshot
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .state_name(),
                "starting-login"
                    | "waiting-for-scan"
                    | "waiting-for-confirmation"
                    | "restoring-session"
            )
    }

    pub(crate) fn try_admit_update(&self) -> Option<tokio::sync::OwnedRwLockWriteGuard<()>> {
        self.update_admission.clone().try_write_owned().ok()
    }

    pub(crate) fn update_last_activity(&self) -> Option<Instant> {
        *self.last_activity.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn enter_call(&self) -> ProviderResult<ProviderCallGuard<'_>> {
        let admission = self
            .update_admission
            .try_read()
            .map_err(|_| ProviderCommandError {
                code: "provider-updating".into(),
                message: "the provider is being updated; retry after it restarts".into(),
                retryable: true,
            })?;
        Ok(ProviderCallGuard {
            _admission: admission,
            last_activity: &self.last_activity,
        })
    }

    pub(crate) fn stop_for_update(&self) {
        self.oauth_attempts
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
        self.account_cancellation
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .cancel();
        self.component.disable();
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
            comments: self
                .declared
                .contains(&ProviderCapability::Comments)
                .then(|| Arc::clone(self) as Arc<dyn CommentsProvider>),
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
        let _active = self.enter_call()?;
        let mut request = serde_json::to_value(request)
            .map_err(|_| ProviderCommandError::invalid_request("provider request is invalid"))?;
        if let Some(platform) = &self.platform {
            if let Some(object) = request.as_object_mut() {
                object.insert("platform".to_owned(), Value::String(platform.clone()));
            }
        }
        let payload = serde_json::to_string(&request)
            .map_err(|_| ProviderCommandError::invalid_request("provider request is invalid"))?;
        let response = self
            .component
            .invoke(capability, operation, &payload)
            .await
            .map_err(map_runtime_error)?;
        let value: Value = serde_json::from_str(&response).map_err(|_| ProviderCommandError {
            code: "invalid-provider-response".to_owned(),
            message: "the provider returned malformed JSON".to_owned(),
            retryable: false,
        })?;
        let mut nodes = 0;
        validate_value(&value, 0, &mut nodes)?;
        serde_json::from_value(value).map_err(|_| ProviderCommandError {
            code: "invalid-provider-response".to_owned(),
            message: "the provider response does not match the requested operation".to_owned(),
            retryable: false,
        })
    }

    async fn call_scoped<Req, Response>(
        &self,
        capability: ProviderCapability,
        operation: &str,
        request: &Req,
    ) -> ProviderResult<Response>
    where
        Req: Serialize + ?Sized,
        Response: DeserializeOwned + ProviderScopedOutput,
    {
        let response: Response = self.call(capability, operation, request).await?;
        response.validate_scope(&self.provider_id)
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

    fn sanitize_snapshot(&self, mut snapshot: AccountSnapshot) -> ProviderResult<AccountSnapshot> {
        snapshot = snapshot.validate_scope(&self.provider_id)?;
        let mut previous = self
            .last_account_snapshot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let generation = self.account_generation.load(Ordering::Acquire);
        // Snapshots and library pages share one authority revision. Polling an
        // unchanged account must not invalidate an in-flight library request.
        let changed = previous.account != snapshot.account
            || previous.profile_id != snapshot.profile_id
            || previous.capabilities != snapshot.capabilities;
        snapshot.revision = if changed && previous.revision == generation {
            self.advance_account_generation()
        } else {
            generation
        };
        *previous = snapshot.clone();
        Ok(snapshot)
    }

    fn sanitize_page<T: ProviderScopedOutput>(&self, mut page: Page<T>) -> ProviderResult<Page<T>> {
        page = page.validate_scope(&self.provider_id)?;
        page.auth_revision = self.account_generation.load(Ordering::Acquire);
        Ok(page)
    }

    fn sanitize_playlist_mutation(
        &self,
        mut result: PlaylistMutationResult,
    ) -> ProviderResult<PlaylistMutationResult> {
        result = result.validate_scope(&self.provider_id)?;
        result.auth_revision = self.account_generation.load(Ordering::Acquire);
        Ok(result)
    }

    fn sanitize_favorite_mutation(
        &self,
        mut result: FavoriteMutationResult,
    ) -> ProviderResult<FavoriteMutationResult> {
        result.auth_revision = self.account_generation.load(Ordering::Acquire);
        Ok(result)
    }

    async fn prepare_component_oauth_login(
        &self,
        method_id: &str,
    ) -> ProviderResult<OAuthPrepareResult> {
        let _active = self.enter_call()?;
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
        let mut prepared: ComponentOAuthPrepare = self
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
        if prepared.browser_session.is_none() && !oauth_state_matches(&authorize_url, &state) {
            return Err(ProviderCommandError::invalid_request(
                "provider authorization state is invalid",
            ));
        }
        if let Some(policy) = &prepared.browser_session {
            super::browser_session::validate_policy(host, policy)?;
        }
        for allowed in &mut prepared.navigation_allowlist {
            let url = validate_component_oauth_url(host, allowed)?;
            // Legacy components used a trailing-slash origin as an origin grant.
            // Return the explicit glob so Core and desktop enforce the same rule.
            if allowed.ends_with('/')
                && url.path() == "/"
                && url.query().is_none()
                && url.fragment().is_none()
            {
                allowed.push_str("**");
            }
        }
        if !component_oauth_navigation_matches(&authorize_url, &prepared.navigation_allowlist) {
            return Err(ProviderCommandError::invalid_request(
                "provider authorization URL is outside its navigation allowlist",
            ));
        }
        validate_component_oauth_callback_url(host, &prepared.callback_matcher.url_prefix)?;
        self.oauth_attempts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                attempt_id.clone(),
                ComponentOAuthAttempt {
                    state,
                    callback_prefix: prepared.callback_matcher.url_prefix.clone(),
                    created_at_ms: component_now_ms(),
                    browser_session: prepared.browser_session.clone(),
                },
            );
        Ok(OAuthPrepareResult {
            browser_session: prepared.browser_session,
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
        let catalog = self.declared.contains(&ProviderCapability::Catalog);
        CatalogProviderCapabilities {
            search: catalog,
            album: catalog,
            artist: catalog,
            playlist: catalog,
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
        let _active = self.enter_call().map_err(map_playback_command_error)?;
        let resolution: ComponentPlaybackResolution = self
            .call_account_scoped(ProviderCapability::Playback, operation, request)
            .await
            .map_err(map_playback_command_error)?;
        resolution.into_source(self, self.current_playback_guard())
    }
}

fn bounded_catalog_capabilities(
    reported: CatalogProviderCapabilities,
    granted: CatalogProviderCapabilities,
) -> CatalogProviderCapabilities {
    CatalogProviderCapabilities {
        search: reported.search && granted.search,
        album: reported.album && granted.album,
        artist: reported.artist && granted.artist,
        playlist: reported.playlist && granted.playlist,
        lyrics: reported.lyrics && granted.lyrics,
        word_timed_lyrics: reported.word_timed_lyrics && granted.word_timed_lyrics,
        streaming: reported.streaming && granted.streaming,
        quality_selection: reported.quality_selection && granted.quality_selection,
    }
}

struct ComponentOAuthAttempt {
    state: String,
    callback_prefix: String,
    created_at_ms: u64,
    browser_session: Option<yaqmc_provider_api::BrowserSessionPolicy>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComponentOAuthPrepare {
    url: String,
    navigation_allowlist: Vec<String>,
    callback_matcher: ComponentOAuthCallbackMatcher,
    #[serde(default)]
    browser_session: Option<yaqmc_provider_api::BrowserSessionPolicy>,
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

fn guest_component_snapshot(provider_id: &str) -> AccountSnapshot {
    AccountSnapshot {
        provider_id: provider_id.to_owned(),
        profile_id: DEFAULT_PROFILE_ID.to_owned(),
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

fn validate_component_oauth_callback_url(
    host: &ComponentHostContext,
    value: &str,
) -> ProviderResult<reqwest::Url> {
    if value.len() > 4_096 {
        return Err(ProviderCommandError::invalid_request(
            "provider authorization callback URL is invalid",
        ));
    }
    let url = reqwest::Url::parse(value).map_err(|_| {
        ProviderCommandError::invalid_request("provider authorization callback URL is invalid")
    })?;
    let origin = component_request_origin(&json!({ "url": value })).map_err(|_| {
        ProviderCommandError::invalid_request("provider authorization callback URL is invalid")
    })?;
    let host_allowed = host.allowed_origins().contains(&origin);
    let yaqmc_callback = origin == "http://127.0.0.1:43821"
        && url.path().starts_with("/oauth/")
        && url.fragment().is_none();
    if !host_allowed && !yaqmc_callback {
        return Err(ProviderCommandError::invalid_request(
            "provider authorization callback origin is not granted",
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

// Match the desktop OAuth window policy: /** grants an origin, ** grants
// a URL prefix within the same path, and an unmarked URL is exact.
fn component_oauth_navigation_matches(url: &reqwest::Url, allowlist: &[String]) -> bool {
    allowlist.iter().any(|allowed| {
        if let Some(prefix) = allowed.strip_suffix("/**") {
            return reqwest::Url::parse(prefix).is_ok_and(|base| url.origin() == base.origin());
        }
        if let Some(prefix) = allowed.strip_suffix("**") {
            return reqwest::Url::parse(prefix).is_ok_and(|base| {
                url.origin() == base.origin()
                    && if prefix.ends_with('/') {
                        url.path().starts_with(base.path())
                    } else {
                        url.path() == base.path()
                    }
                    && url.as_str().starts_with(prefix)
            });
        }
        url.as_str() == allowed
    })
}

fn component_oauth_callback_matches(url: &reqwest::Url, prefix: &str) -> bool {
    let Ok(expected) = reqwest::Url::parse(prefix) else {
        return false;
    };
    url.origin() == expected.origin()
        && url.path() == expected.path()
        && expected
            .fragment()
            .is_none_or(|fragment| url.fragment() == Some(fragment))
        && expected.query_pairs().all(|(name, _)| {
            url.query_pairs()
                .filter(|(key, _)| key == &name)
                .eq(expected.query_pairs().filter(|(key, _)| key == &name))
        })
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
            return Err(PlaybackSourceError::ProviderFailure);
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
                    .ok_or(PlaybackSourceError::ProviderUnavailable)?;
                let bytes = host
                    .cache_get(&key)
                    .map_err(|_| PlaybackSourceError::CacheFailure)?
                    .ok_or(PlaybackSourceError::CacheFailure)?;
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
                    .ok_or(PlaybackSourceError::ProviderUnavailable)?;
                let origin = component_request_origin(&request)
                    .map_err(|_| PlaybackSourceError::ProviderFailure)?;
                if !origin_allowed(host.allowed_origins(), &origin) {
                    return Err(PlaybackSourceError::ProviderFailure);
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
        Err(PlaybackSourceError::ProviderFailure)
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
        let mut status = ProviderStatus {
            provider_id: self.provider_id.clone(),
            profile_id: DEFAULT_PROFILE_ID.to_owned(),
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
        };
        if self.component.enabled()
            && !self.component.circuit_open()
            && self.declared.contains(&ProviderCapability::Catalog)
        {
            if let Ok(reported) = self
                .call_scoped::<_, ProviderStatus>(
                    ProviderCapability::Catalog,
                    "catalog.status",
                    &json!({}),
                )
                .await
            {
                status.preferred_quality = reported.preferred_quality;
                status.capabilities =
                    bounded_catalog_capabilities(reported.capabilities, status.capabilities);
            }
        }
        status
    }

    async fn catalog_search(
        &self,
        query: String,
        kind: CatalogSearchKind,
        page: u32,
        limit: u32,
    ) -> ProviderResult<SearchResult> {
        self.call_scoped(
            ProviderCapability::Catalog,
            "catalog.search",
            &json!({ "query": query, "kind": kind, "page": page, "limit": limit }),
        )
        .await
    }

    async fn catalog_song(&self, id: String) -> ProviderResult<Song> {
        self.call_scoped(
            ProviderCapability::Catalog,
            "catalog.song",
            &json!({ "id": id }),
        )
        .await
    }

    async fn catalog_album(&self, id: String) -> ProviderResult<Album> {
        self.call_scoped(
            ProviderCapability::Catalog,
            "catalog.album",
            &json!({ "id": id }),
        )
        .await
    }

    async fn catalog_artist(&self, id: String) -> ProviderResult<Artist> {
        self.call_scoped(
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
        self.call_scoped(
            ProviderCapability::Catalog,
            "catalog.artist-page",
            &json!({ "id": id, "kind": kind, "page": page, "limit": limit }),
        )
        .await
    }

    async fn catalog_playlist(&self, id: String) -> ProviderResult<Playlist> {
        // Components can page large playlists without spending a whole Wasm
        // invocation's fuel on metadata the UI does not need in that page.
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct PlaylistPage {
            #[serde(flatten)]
            playlist: Playlist,
            #[serde(default)]
            next_cursor: Option<String>,
        }
        let mut cursor: Option<String> = None;
        let mut combined: Option<Playlist> = None;
        let mut seen = std::collections::HashSet::new();
        for _ in 0..250 {
            let page: PlaylistPage = self
                .call(
                    ProviderCapability::Catalog,
                    "catalog.playlist",
                    &json!({"id": id, "cursor": cursor}),
                )
                .await?;
            let playlist = page.playlist.validate_scope(&self.provider_id)?;
            if playlist.id != id {
                return Err(ProviderCommandError::invalid_request(
                    "provider playlist identity changed",
                ));
            }
            if let Some(combined) = combined.as_mut() {
                combined.tracks.extend(playlist.tracks);
            } else {
                combined = Some(playlist);
            }
            match page.next_cursor {
                None => return Ok(combined.expect("first page was assigned")),
                Some(next)
                    if !next.is_empty() && next.len() <= 128 && seen.insert(next.clone()) =>
                {
                    cursor = Some(next)
                }
                _ => {
                    return Err(ProviderCommandError::invalid_request(
                        "provider playlist pagination made no progress",
                    ))
                }
            }
        }
        Err(ProviderCommandError::invalid_request(
            "provider playlist exceeds the supported page count",
        ))
    }

    async fn catalog_home(&self, refresh: bool) -> ProviderResult<HomeFeed> {
        self.call_scoped(
            ProviderCapability::Catalog,
            "catalog.home",
            &json!({ "refresh": refresh }),
        )
        .await
    }

    async fn catalog_discover(&self, refresh: bool) -> ProviderResult<DiscoverFeed> {
        self.call_scoped(
            ProviderCapability::Catalog,
            "catalog.discover",
            &json!({ "refresh": refresh }),
        )
        .await
    }

    async fn catalog_area(&self, enc_area: String) -> ProviderResult<AreaFeed> {
        self.call_scoped(
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
        let batch: RecommendationBatch = self
            .call_account_scoped(
                ProviderCapability::Recommendation,
                "recommendation.next",
                &request,
            )
            .await?;
        batch.validate_scope(&self.provider_id)
    }
}

#[async_trait]
impl LyricsProvider for ComponentProviderAdapter {
    async fn lyrics_for_song(&self, song_id: String) -> ProviderResult<Option<LyricDocument>> {
        let document: Option<LyricDocument> = self
            .call_account_scoped(
                ProviderCapability::Lyrics,
                "lyrics.get",
                &json!({ "songId": song_id }),
            )
            .await?;
        Ok(document.map(|mut document| {
            document.comments.truncate(15);
            for comment in &mut document.comments {
                comment.sanitize();
                comment.content = comment.content.chars().take(160).collect();
                comment.author = comment.author.chars().take(60).collect();
            }
            document
        }))
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
            .call::<_, ProviderStatus>(
                ProviderCapability::Playback,
                "playback.set-preferred-quality",
                &json!({ "quality": quality }),
            )
            .await?
            .validate_scope(&self.provider_id)?;
        status.provider_id = self.provider_id.clone();
        status.display_name = self.display_name.clone();
        status.capabilities =
            bounded_catalog_capabilities(status.capabilities, self.catalog_capability_projection());
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
        let _active = self.enter_call()?;
        let methods = self.account_login_methods().await?;
        let Some(method) = methods.iter().find(|method| method.id == method_id) else {
            return Err(ProviderCommandError::invalid_request(
                "account login method is unavailable",
            ));
        };
        if method.flow != AccountLoginFlow::OAuth {
            return Err(ProviderCommandError::invalid_request(
                "account login method does not use OAuth",
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
        let Ok(_active) = self.enter_call() else {
            return self
                .last_account_snapshot
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone();
        };
        let snapshot = self
            .call_account_scoped(ProviderCapability::Account, "account.snapshot", &json!({}))
            .await
            .unwrap_or_else(|_| {
                self.last_account_snapshot
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone()
            });
        self.sanitize_snapshot(snapshot).unwrap_or_else(|_| {
            self.last_account_snapshot
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
        })
    }

    async fn refresh_account(&self) -> ProviderResult<AccountSnapshot> {
        let _active = self.enter_call()?;
        let snapshot = self
            .call_account_scoped(ProviderCapability::Account, "account.snapshot", &json!({}))
            .await?;
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
        self.sanitize_page(page)
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
        self.sanitize_page(page)
    }

    async fn account_playlist_tracks(
        &self,
        playlist: AccountPlaylistSummary,
        cursor: Option<String>,
        limit: u32,
    ) -> ProviderResult<AccountPlaylistDetail> {
        let playlist = playlist.validate_scope(&self.provider_id)?;
        let mut detail: AccountPlaylistDetail = self
            .call_account_scoped(
                ProviderCapability::Account,
                "account.playlist-tracks",
                &json!({ "playlist": playlist, "cursor": cursor, "limit": limit }),
            )
            .await?;
        detail = detail.validate_scope(&self.provider_id)?;
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
        self.sanitize_page(page)
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
        self.sanitize_favorite_mutation(result)
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
        self.sanitize_playlist_mutation(result)
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
        self.sanitize_playlist_mutation(result)
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
        self.sanitize_playlist_mutation(result)
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
        self.sanitize_playlist_mutation(result)
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
        self.sanitize_playlist_mutation(result)
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
        self.sanitize_playlist_mutation(result)
    }

    async fn start_qr_login(&self) -> ProviderResult<AccountSnapshot> {
        let _active = self.enter_call()?;
        self.advance_account_generation();
        let snapshot = self
            .call_account_scoped(
                ProviderCapability::Account,
                "account.auth.start-qr",
                &json!({}),
            )
            .await?;
        self.sanitize_snapshot(snapshot)
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
        let _active = self.enter_call()?;
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
        validate_component_oauth_callback_url(host, callback_url.as_str())?;
        if attempt.browser_session.is_some()
            || !component_oauth_callback_matches(&callback_url, &attempt.callback_prefix)
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
        self.sanitize_snapshot(snapshot)
    }

    async fn complete_browser_session_login(
        &self,
        attempt_id: &str,
        callback_url: reqwest::Url,
        cookies: Vec<yaqmc_provider_api::BrowserSessionCookie>,
    ) -> ProviderResult<AccountSnapshot> {
        let _active = self.enter_call()?;
        let attempt = {
            let mut attempts = self
                .oauth_attempts
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            prune_oauth_attempts(&mut attempts);
            attempts.remove(attempt_id)
        }
        .ok_or_else(|| ProviderCommandError::invalid_request("authorization attempt is invalid"))?;
        let policy = attempt.browser_session.ok_or_else(|| {
            ProviderCommandError::invalid_request("browser session login was not requested")
        })?;
        if callback_url.as_str() != policy.url {
            return Err(ProviderCommandError::invalid_request(
                "provider browser session origin is invalid",
            ));
        }
        let host = self.host.as_ref().ok_or_else(|| {
            ProviderCommandError::adapter("provider authorization host is unavailable")
        })?;
        let handles = super::browser_session::import_session(host, &policy, cookies)?;
        self.advance_account_generation();
        let result = self.call_account_scoped(
            ProviderCapability::Account,
            "account.auth.complete-oauth",
            &json!({ "attemptId": attempt_id, "browserCredentials": handles.iter().map(|(origin, handle)| json!({"origin": origin, "handle": handle})).collect::<Vec<_>>() }),
        ).await.and_then(|snapshot: AccountSnapshot| {
            if matches!(snapshot.account, AccountState::Authenticated { .. }) {
                self.sanitize_snapshot(snapshot)
            } else {
                Err(ProviderCommandError::invalid_request("provider browser session was not authenticated"))
            }
        });
        if result.is_err() {
            for (_, handle) in &handles {
                let _ = host.credential_delete(handle);
            }
        }
        result
    }

    async fn cancel_oauth_login(&self, attempt_id: &str) -> ProviderResult<AccountSnapshot> {
        let _active = self.enter_call()?;
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
        self.sanitize_snapshot(snapshot)
    }

    async fn heartbeat_qr_login(
        &self,
        attempt_id: String,
        owner_lease_id: String,
    ) -> ProviderResult<AccountSnapshot> {
        let _active = self.enter_call()?;
        let snapshot = self
            .call_account_scoped(
                ProviderCapability::Account,
                "account.auth.heartbeat-qr",
                &json!({ "attemptId": attempt_id, "ownerLeaseId": owner_lease_id }),
            )
            .await?;
        self.sanitize_snapshot(snapshot)
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
        let _active = self.enter_call()?;
        self.advance_account_generation();
        let snapshot = self
            .call_account_scoped(
                ProviderCapability::Account,
                "account.auth.cancel-qr",
                &json!({ "attemptId": attempt_id }),
            )
            .await?;
        self.sanitize_snapshot(snapshot)
    }

    async fn refresh_qr_login(
        &self,
        attempt_id: Option<String>,
    ) -> ProviderResult<AccountSnapshot> {
        let _active = self.enter_call()?;
        self.advance_account_generation();
        let snapshot = self
            .call_account_scoped(
                ProviderCapability::Account,
                "account.auth.refresh-qr",
                &json!({ "attemptId": attempt_id }),
            )
            .await?;
        self.sanitize_snapshot(snapshot)
    }

    async fn restore_session(&self) {
        let Ok(_active) = self.enter_call() else {
            return;
        };
        self.advance_account_generation();
        let _ = self
            .call_account_scoped::<_, ()>(
                ProviderCapability::Account,
                "account.restore-session",
                &json!({}),
            )
            .await;
        let _ = self.account_snapshot().await;
    }

    async fn sign_out(&self) -> ProviderResult<AccountSnapshot> {
        let _active = self.enter_call()?;
        self.advance_account_generation();
        let snapshot = self
            .call_account_scoped(ProviderCapability::Account, "account.sign-out", &json!({}))
            .await?;
        self.sanitize_snapshot(snapshot)
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
            || !matches!(method.flow, AccountLoginFlow::OAuth | AccountLoginFlow::Qr)
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
        "provider-backend-unavailable" => (
            "provider-backend-unavailable",
            "the local provider service is unavailable",
            true,
        ),
        "provider-unavailable" | "provider-circuit-open" => (
            "provider-unavailable",
            "the music plugin is unavailable",
            false,
        ),
        "provider-not-configured" | "provider-configuration" => (
            "provider-not-configured",
            "the provider configuration is incomplete",
            false,
        ),
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
        "membership-required" => (
            "membership-required",
            "the account needs a music membership for this track",
            false,
        ),
        "purchase-required" => (
            "purchase-required",
            "the account needs to purchase this track",
            false,
        ),
        "copyright-restricted" => (
            "copyright-restricted",
            "the platform restricts playback under its licensing",
            false,
        ),
        "full-playback-unavailable" => (
            "full-playback-unavailable",
            "the platform returned no playable source; the reason is unconfirmed",
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
        "comments-limit-exceeded" => (
            "comments-limit-exceeded",
            "the complete reply thread exceeds the supported sorting limit",
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

pub(super) fn map_playback_command_error(error: ProviderCommandError) -> PlaybackSourceError {
    match error.code.as_str() {
        "provider-cancelled" | "cancelled" => PlaybackSourceError::Cancelled,
        "authentication-expired" => PlaybackSourceError::AuthenticationExpired,
        "entitlement-unavailable" | "entitlement-insufficient" => {
            PlaybackSourceError::EntitlementInsufficient
        }
        "entitlement-unknown" => PlaybackSourceError::EntitlementUnknown,
        "membership-required" => PlaybackSourceError::MembershipRequired,
        "purchase-required" => PlaybackSourceError::PurchaseRequired,
        "copyright-restricted" => PlaybackSourceError::CopyrightRestricted,
        "full-playback-unavailable" => PlaybackSourceError::UrlUnavailable,
        "unsupported-operation" => PlaybackSourceError::ProviderUnsupported,
        "provider-unavailable" | "provider-not-configured" | "provider-backend-unavailable" => {
            PlaybackSourceError::ProviderUnavailable
        }
        "client-unsupported" => PlaybackSourceError::DecoderUnsupported,
        "url-expired" => PlaybackSourceError::UrlExpired,
        "range-unsupported" => PlaybackSourceError::RangeUnsupported,
        "response-too-large" => PlaybackSourceError::ResponseTooLarge,
        "offline" | "rate-limited" | "provider-timeout" | "network" => PlaybackSourceError::Network,
        "provider-circuit-open" => PlaybackSourceError::ProviderUnavailable,
        "song-unavailable" | "not-found" | "unavailable" => PlaybackSourceError::TrackUnavailable,
        _ => PlaybackSourceError::ProviderFailure,
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

    #[test]
    fn playback_restrictions_survive_guest_sanitization_without_secrets() {
        for (code, expected) in [
            (
                "membership-required",
                PlaybackSourceError::MembershipRequired,
            ),
            ("purchase-required", PlaybackSourceError::PurchaseRequired),
            (
                "copyright-restricted",
                PlaybackSourceError::CopyrightRestricted,
            ),
            (
                "unsupported-operation",
                PlaybackSourceError::ProviderUnsupported,
            ),
            (
                "provider-unavailable",
                PlaybackSourceError::ProviderUnavailable,
            ),
            (
                "full-playback-unavailable",
                PlaybackSourceError::UrlUnavailable,
            ),
            ("malformed-response", PlaybackSourceError::ProviderFailure),
            ("unknown-error", PlaybackSourceError::ProviderFailure),
        ] {
            let safe = sanitize_guest_error(
                &json!({
                    "code": code,
                    "message": "secret https://signed.invalid/song?token=secret",
                    "retryable": true,
                })
                .to_string(),
            );
            assert!(!safe.message.contains("secret"));
            assert_eq!(map_playback_command_error(safe), expected, "{code}");
        }
        let fault = map_runtime_error(ComponentRuntimeError::SandboxFault);
        assert_eq!(
            map_playback_command_error(fault),
            PlaybackSourceError::ProviderFailure
        );
    }

    #[test]
    fn local_service_errors_keep_actionable_codes_without_guest_messages() {
        for code in [
            "provider-backend-unavailable",
            "provider-not-configured",
            "comments-limit-exceeded",
        ] {
            let error = sanitize_guest_error(
                &serde_json::json!({
                    "code": code, "message": "secret", "retryable": false,
                })
                .to_string(),
            );
            assert_eq!(error.code, code);
            assert!(!error.message.contains("secret"));
        }
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
            "providerId": "dev.example.account",
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
            "provider": { "providerId": "dev.example.catalog", "trackId": "song-1" }
        })
    }

    fn playlist_summary(profile_id: Option<&str>) -> Value {
        let mut value = json!({
            "providerId": "dev.example.account",
            "id": "playlist-1",
            "reference": { "kind": "owned", "tid": "tid-1" },
            "title": "Fixture Playlist",
            "description": "",
            "owner": { "id": "owner-1", "displayName": "Owner" },
            "artwork": { "src": "", "alt": "", "dominantColor": "#000000" },
            "ownership": "owned",
            "capabilities": {
                "canAddTracks": true,
                "canRemoveTracks": true,
                "canRename": true,
                "canDelete": true,
                "canReorder": true
            },
            "trackCount": 1,
            "updatedAtMs": null
        });
        if let Some(profile_id) = profile_id {
            value["profileId"] = json!(profile_id);
        }
        value
    }

    #[test]
    fn typed_scope_defaults_legacy_profiles_and_rejects_forged_values() {
        let legacy_song: Song = serde_json::from_value(song()).expect("song");
        assert_eq!(
            legacy_song.provider.as_ref().expect("provider").profile_id,
            DEFAULT_PROFILE_ID
        );
        assert!(legacy_song
            .clone()
            .validate_scope("dev.example.catalog")
            .is_ok());

        let mut forged_song = song();
        forged_song["provider"]["profileId"] = json!("secondary");
        let forged_song: Song = serde_json::from_value(forged_song).expect("forged song shape");
        assert_eq!(
            forged_song
                .validate_scope("dev.example.catalog")
                .expect_err("non-default song profile must fail closed")
                .code,
            "invalid-provider-response"
        );

        let mut forged_provider = song();
        forged_provider["provider"]["providerId"] = json!("other.provider");
        let forged_provider: Song =
            serde_json::from_value(forged_provider).expect("forged provider shape");
        assert!(forged_provider
            .validate_scope("dev.example.catalog")
            .is_err());
    }

    #[tokio::test]
    async fn scoped_snapshot_status_share_playlist_and_mutation_outputs_are_fail_closed() {
        let account = account_adapter(guest_snapshot(1));
        let snapshot = account.account_snapshot().await;
        assert_eq!(snapshot.profile_id, DEFAULT_PROFILE_ID);
        let mut forged_snapshot = snapshot.clone();
        forged_snapshot.profile_id = "secondary".to_owned();
        assert!(forged_snapshot
            .validate_scope("dev.example.account")
            .is_err());

        let catalog = adapter(json!({}));
        let status = catalog.catalog_status().await;
        assert_eq!(status.profile_id, DEFAULT_PROFILE_ID);
        let mut forged_status = status.clone();
        forged_status.profile_id = "secondary".to_owned();
        assert!(forged_status.validate_scope("dev.example.catalog").is_err());

        let share: ShareTarget = serde_json::from_value(json!({
            "providerId": "dev.example.catalog",
            "entityKind": "song",
            "entityId": "song-1",
            "title": "Fixture Song",
            "artists": []
        }))
        .expect("legacy share target");
        assert_eq!(share.profile_id, DEFAULT_PROFILE_ID);
        assert!(share.clone().validate_scope("dev.example.catalog").is_ok());
        let mut forged_share = share;
        forged_share.profile_id = "secondary".to_owned();
        assert!(forged_share.validate_scope("dev.example.catalog").is_err());

        let playlist: AccountPlaylistSummary =
            serde_json::from_value(playlist_summary(None)).expect("legacy playlist");
        assert_eq!(playlist.profile_id, DEFAULT_PROFILE_ID);
        assert!(playlist
            .clone()
            .validate_scope("dev.example.account")
            .is_ok());
        let mut forged_playlist = playlist;
        forged_playlist.profile_id = "secondary".to_owned();
        assert!(forged_playlist
            .validate_scope("dev.example.account")
            .is_err());

        let mut mutation_value = json!({
            "clientOperationId": "op-1",
            "status": "applied",
            "playlist": null,
            "errorCode": null,
            "authRevision": 0
        });
        mutation_value["playlist"] = playlist_summary(Some("secondary"));
        let mutation: PlaylistMutationResult =
            serde_json::from_value(mutation_value).expect("playlist mutation");
        assert!(mutation.validate_scope("dev.example.account").is_err());
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
    async fn component_status_reads_quality_without_expanding_authority_or_scope() {
        let reported = json!({
            "providerId": "dev.example.catalog", "profileId": "default",
            "displayName": "Untrusted name", "connection": "Untrusted connection",
            "message": "Untrusted message", "preferredQuality": "lossless",
            "capabilities": {
                "search": true, "album": false, "artist": false, "playlist": false,
                "lyrics": true, "wordTimedLyrics": true, "streaming": true,
                "qualitySelection": true
            }
        });
        let status = adapter(reported.clone()).catalog_status().await;
        assert_eq!(status.preferred_quality, AudioQualityPreference::Lossless);
        assert_eq!(status.provider_id, "dev.example.catalog");
        assert_eq!(status.display_name, "Example Catalog");
        assert_eq!(status.connection, "ready");
        assert!(status.message.is_empty());
        assert!(status.capabilities.search);
        assert!(!status.capabilities.album);
        assert!(!status.capabilities.lyrics);
        assert!(!status.capabilities.streaming);
        assert!(!status.capabilities.quality_selection);
        let mut forged = reported;
        forged["profileId"] = json!("secondary");
        let status = adapter(forged).catalog_status().await;
        assert_eq!(status.preferred_quality, AudioQualityPreference::Automatic);
        assert_eq!(status.profile_id, DEFAULT_PROFILE_ID);
        let legacy = adapter(json!({})).catalog_status().await;
        assert_eq!(legacy.connection, "ready");
        assert_eq!(legacy.preferred_quality, AudioQualityPreference::Automatic);
    }

    #[tokio::test]
    async fn registry_projection_exposes_only_declared_component_capabilities() {
        let adapter = adapter(json!({}));
        let capabilities = adapter.registry_capabilities();
        assert!(capabilities.catalog.is_some());
        assert!(capabilities.playback.is_none());
        assert!(capabilities.account.is_none());
        assert!(capabilities.comments.is_none());
        adapter.component().disable();
        assert_eq!(
            adapter.catalog_status().await.connection,
            "disabled".to_owned()
        );
    }

    #[tokio::test]
    async fn comments_component_capability_is_optional_bounded_and_revocable() {
        let adapter = capability_adapter(
            ProviderCapability::Comments,
            json!({
                "items":(0..21).map(|i| json!({"id":i.to_string(), "content":"hello",
                    "author":"listener", "likedCount":u64::MAX})).collect::<Vec<_>>(),
                "nextCursor":"after-21", "total":1000, "supportedSorts":["hot","new"], "repliesSupported":false
            }),
        );
        assert!(adapter.registry_capabilities().comments.is_some());
        let request = SongCommentsRequest {
            song_id: "track1".to_owned(),
            sort: yaqmc_provider_api::CommentSort::Hot,
            limit: 20,
            cursor: None,
            parent_id: None,
        };
        let page = adapter.song_comments(request.clone()).await.unwrap();
        assert_eq!(page.items.len(), 21);
        assert_eq!(page.items[0].liked_count, 9_007_199_254_740_991);
        assert_eq!(page.next_cursor.as_deref(), Some("after-21"));
        adapter.component().disable();
        assert!(adapter.song_comments(request).await.is_err());
    }

    #[tokio::test]
    async fn legacy_lyric_comments_sanitize_optional_fields_before_reaching_the_renderer() {
        let adapter = capability_adapter(
            ProviderCapability::Lyrics,
            json!({
                "songId":"song-1", "syncMode":"line",
                "metadata":{"sourceLabel":"legacy", "offsetMs":0}, "lines":[], "vocalists":[],
                "comments":[{
                    "id":"1", "content":"文".repeat(200), "author":"名".repeat(80),
                    "likedCount":u64::MAX, "timeMs":u64::MAX,
                    "replyCount":u64::MAX, "avatarUrl":"javascript:invalid",
                    "replyTo":{"author":"名".repeat(120), "content":"quote"}
                }]
            }),
        );
        let document = adapter
            .lyrics_for_song("song-1".into())
            .await
            .unwrap()
            .unwrap();
        let comment = &document.comments[0];
        assert!(comment.time_ms.is_none());
        assert!(comment.avatar_url.is_none());
        assert_eq!(comment.liked_count, 9_007_199_254_740_991);
        assert_eq!(comment.reply_count, Some(9_007_199_254_740_991));
        assert_eq!(comment.content.chars().count(), 160);
        assert_eq!(comment.author.chars().count(), 60);
        assert_eq!(
            comment.reply_to.as_ref().unwrap().author.chars().count(),
            100
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
    async fn update_admission_preserves_inflight_calls_and_rejects_new_login_without_cancelling_it()
    {
        let adapter = account_adapter(guest_snapshot(9_999));
        let old_playback = adapter.current_playback_guard();
        let admitted = adapter.enter_call().expect("admitted call");
        assert!(adapter.update_busy());
        assert!(adapter.try_admit_update().is_none());
        assert!(old_playback.validate().is_ok());
        drop(admitted);

        let update = adapter.try_admit_update().expect("idle update admission");
        let generation = adapter.account_generation();
        assert_eq!(
            adapter
                .start_qr_login()
                .await
                .err()
                .expect("blocked login")
                .code,
            "provider-updating"
        );
        assert_eq!(adapter.account_generation(), generation);
        assert!(old_playback.validate().is_ok());
        assert!(adapter.component.enabled());
        drop(update);
        assert!(adapter.start_qr_login().await.is_ok());
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
    async fn restoring_a_session_publishes_the_authoritative_account_snapshot() {
        let mut response = guest_snapshot(9_999);
        response["state"] = json!("session-expired");
        let adapter = account_adapter(response);
        assert_eq!(
            adapter
                .last_account_snapshot
                .lock()
                .expect("snapshot lock")
                .state_name(),
            "guest"
        );
        adapter.restore_session().await;
        let restored = adapter.last_account_snapshot.lock().expect("snapshot lock");
        assert_eq!(restored.state_name(), "session-expired");
        assert_eq!(restored.provider_id, "dev.example.account");
        assert!(restored.revision > 0);
        assert_ne!(restored.revision, 9_999);
    }

    #[tokio::test]
    async fn repeated_snapshot_reads_share_library_authority_until_account_changes() {
        let adapter = account_adapter(guest_snapshot(9_999));
        let first = adapter.account_snapshot().await;
        let guard = adapter.current_playback_guard();
        let second = adapter.account_snapshot().await;
        assert_eq!(first.revision, second.revision);
        let page: Page<Song> = adapter
            .sanitize_page(
                serde_json::from_value(json!({
                    "items": [], "nextCursor": null, "total": 0, "fetchedAtMs": 1,
                    "stale": false, "authRevision": 9_999
                }))
                .unwrap(),
            )
            .unwrap();
        assert_eq!(page.auth_revision, second.revision);
        assert!(guard.validate().is_ok());

        let mut changed = second;
        changed.account = AccountState::SessionExpired {
            profile: None,
            entitlement: None,
        };
        let changed = adapter.sanitize_snapshot(changed).unwrap();
        assert!(changed.revision > first.revision);
        assert_eq!(changed.revision, adapter.account_generation());
        assert_eq!(guard.validate(), Err(PlaybackSourceError::Cancelled));
    }

    #[tokio::test]
    async fn explicit_account_refresh_propagates_invalid_responses() {
        let adapter = account_adapter(json!({"unexpected":"not an account snapshot"}));
        assert_eq!(adapter.account_snapshot().await.state_name(), "guest");
        assert!(adapter.refresh_account().await.is_err());
        assert_eq!(
            adapter.last_account_snapshot.lock().unwrap().state_name(),
            "guest"
        );
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
    fn oauth_navigation_globs_match_desktop_rules() {
        for (url, rule, expected) in [
            (
                "https://accounts.spotify.com/authorize?state=x",
                "https://accounts.spotify.com/**",
                true,
            ),
            (
                "https://accounts.spotify.com/login",
                "https://accounts.spotify.com",
                false,
            ),
            (
                "https://accounts.spotify.com/authorize?state=x",
                "https://accounts.spotify.com/authorize**",
                true,
            ),
            (
                "https://accounts.spotify.com/authorize-other?state=x",
                "https://accounts.spotify.com/authorize**",
                false,
            ),
            (
                "https://accounts.spotify.com/authorize?state=x",
                "https://accounts.spotify.com/authorize",
                false,
            ),
            (
                "https://accounts.spotify.com/login",
                "https://accounts.spotify.com/login",
                true,
            ),
            (
                "https://accounts.spotify.com.evil.test/login",
                "https://accounts.spotify.com/**",
                false,
            ),
            (
                "https://accounts.spotify.com:444/login",
                "https://accounts.spotify.com/**",
                false,
            ),
            (
                "http://accounts.spotify.com/login",
                "https://accounts.spotify.com/**",
                false,
            ),
        ] {
            assert_eq!(
                component_oauth_navigation_matches(
                    &reqwest::Url::parse(url).unwrap(),
                    &[rule.to_owned()]
                ),
                expected,
                "{url} against {rule}",
            );
        }
    }

    #[tokio::test]
    async fn browser_session_completion_is_single_use_and_rolls_back_rejected_credentials() {
        use crate::credentials::{CredentialError, CredentialStore};
        use std::sync::atomic::AtomicUsize;
        #[derive(Default)]
        struct Counter(AtomicUsize);
        impl CredentialStore for Counter {
            fn load(&self, _: &str) -> Result<Option<String>, CredentialError> {
                Ok(None)
            }
            fn save(&self, _: &str, _: &str) -> Result<(), CredentialError> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
            fn delete(&self, _: &str) -> Result<(), CredentialError> {
                self.0.fetch_sub(1, Ordering::SeqCst);
                Ok(())
            }
        }
        let mut authenticated = guest_snapshot(1);
        authenticated["state"] = json!("authenticated");
        authenticated["profile"] =
            json!({"nickname": "Fixture", "maskedIdentity": "authenticated", "avatarUrl": null});
        authenticated["entitlement"] = json!({"tier":"unknown", "membership":"unknown", "permittedQualities":[], "restrictions":[]});
        for (response, accepted) in [
            (authenticated, true),
            (guest_snapshot(1), false),
            (json!({}), false),
        ] {
            let root = tempfile::tempdir().unwrap();
            let store = Arc::new(Counter::default());
            let services = ComponentHostServices::open(
                root.path().join("data"),
                root.path().join("cache"),
                store.clone(),
                tokio::runtime::Handle::current(),
            )
            .unwrap();
            let host = services.for_plugin(
                "dev.example.account",
                "dev.example.account",
                std::collections::HashSet::from(["https://accounts.example.com".to_owned()]),
            );
            let source = static_test_component(&response.to_string());
            let adapter = ComponentProviderAdapter::from_manifest_with_host(
                &account_manifest(),
                source.as_bytes(),
                Some(host),
            )
            .unwrap();
            adapter.oauth_attempts.lock().unwrap().insert(
                "web".to_owned(),
                ComponentOAuthAttempt {
                    state: "host-state".to_owned(),
                    callback_prefix: "https://accounts.example.com/callback".to_owned(),
                    created_at_ms: component_now_ms(),
                    browser_session: Some(yaqmc_provider_api::BrowserSessionPolicy {
                        url: "https://accounts.example.com/".to_owned(),
                        cookie_names: vec!["session".to_owned()],
                        required_cookie_names: vec!["session".to_owned()],
                        credential_origins: vec!["https://accounts.example.com".to_owned()],
                        format: yaqmc_provider_api::BrowserSessionFormat::Cookie,
                    }),
                },
            );
            let callback = reqwest::Url::parse("https://accounts.example.com/").unwrap();
            let result = adapter
                .complete_browser_session_login(
                    "web",
                    callback.clone(),
                    vec![yaqmc_provider_api::BrowserSessionCookie {
                        name: "session".to_owned(),
                        value: "synthetic".to_owned(),
                    }],
                )
                .await;
            assert_eq!(result.is_ok(), accepted);
            assert_eq!(store.0.load(Ordering::SeqCst), usize::from(accepted));
            assert!(adapter
                .complete_browser_session_login("web", callback, Vec::new())
                .await
                .is_err());
            assert_eq!(store.0.load(Ordering::SeqCst), usize::from(accepted));
        }
    }

    #[test]
    fn oauth_callback_compares_path_and_fixed_query_parameters() {
        let prefix = "http://127.0.0.1:43821/oauth/spotify/callback?client=fixture";
        for (url, expected) in [
            ("http://127.0.0.1:43821/oauth/spotify/callback?state=x&client=fixture&code=test", true),
            ("http://127.0.0.1:43821/oauth/spotify/callback-other?client=fixture&state=x", false),
            ("http://127.0.0.1:43821/oauth/spotify/callback/extra?client=fixture&state=x", false),
            ("http://127.0.0.1:43822/oauth/spotify/callback?client=fixture&state=x", false),
            ("http://127.0.0.1:43821/oauth/spotify/callback?client=fixture-extra&state=x", false),
            ("http://127.0.0.1:43821/oauth/spotify/callback?client=fixture&client=fixture&state=x", false),
            ("http://127.0.0.1:43821/oauth/spotify/callback?state=x", false),
        ] {
            assert_eq!(component_oauth_callback_matches(&reqwest::Url::parse(url).unwrap(), prefix), expected, "{url}");
        }
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
