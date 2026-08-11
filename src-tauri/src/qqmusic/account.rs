#![expect(
    dead_code,
    reason = "account services consume these shared contracts in later tasks"
)]

use super::{
    auth::{AuthenticatedAccountContext, QQMusicAuthService, SessionRecord},
    cache::{
        AccountCache, AccountEpoch, AccountLibraryProjection, CachedAccountPage,
        CompletedResultCache, OpaqueCursorRegistry, ProviderTrackRegistry, ACCOUNT_CACHE_KIND,
    },
    clock::Clock,
    color_for, is_allowed_artwork_url, normalize_old_song, playlist_id, stable_component,
    transport::{QqTransport, RedirectMode, RetryClass, TransportRequest, TransportResponse},
    upgrade_https, OldSongDto, PlaylistOwner, QQMusicError, QQ_MUSICU_URL,
};
use crate::player::{Artwork, AudioQuality, Song};
use crate::storage::{ProviderCacheMutation, StorageService};
use reqwest::{
    header::{self, HeaderMap, HeaderValue},
    Method, StatusCode, Url,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(test)]
use std::sync::Mutex as StdMutex;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
use tokio::sync::Mutex;
#[cfg(test)]
use tokio::sync::Notify;

const FAVORITES_TTL_MS: u64 = 2 * 60 * 1_000;
const ACCOUNT_COLLECTION_TTL_MS: u64 = 5 * 60 * 1_000;

#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
enum ReadBoundary {
    Response,
    BeforeRetry,
    BeforeCacheCommit,
}

#[cfg(test)]
struct ReadBarrier {
    boundary: ReadBoundary,
    entered: Notify,
    release: Notify,
}

#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
enum WriteBoundary {
    WriteClassified,
    ReconciliationRead,
    BeforeCacheCommit,
    AfterCacheCommit,
}

#[cfg(test)]
struct WriteBarrier {
    boundary: WriteBoundary,
    entered: Notify,
    release: Notify,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
    pub total: Option<u64>,
    pub fetched_at_ms: u64,
    pub stale: bool,
    pub auth_revision: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistCapabilities {
    pub can_add_tracks: bool,
    pub can_remove_tracks: bool,
    pub can_rename: bool,
    pub can_delete: bool,
    pub can_reorder: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlaylistOwnership {
    Owned,
    Collected,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountPlaylistSummary {
    pub id: String,
    pub title: String,
    pub description: String,
    pub owner: PlaylistOwner,
    pub artwork: Artwork,
    pub ownership: PlaylistOwnership,
    pub capabilities: PlaylistCapabilities,
    pub track_count: u64,
    pub updated_at_ms: Option<u64>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountPlaylistDetail {
    pub summary: AccountPlaylistSummary,
    pub tracks: Page<Song>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemotePlayHistorySource {
    QqmusicAccount,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePlayHistoryItem {
    pub song: Song,
    pub played_at_ms: Option<u64>,
    pub source: RemotePlayHistorySource,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EntitlementTier {
    Free,
    MusicVip,
    SuperVip,
    Unknown,
}

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MembershipState {
    Active,
    Expired,
    Inactive,
    Unknown,
}

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EntitlementFeature {
    Playback,
    FavoriteWrite,
    PlaylistWrite,
    Quality,
}

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EntitlementRestrictionReason {
    MembershipRequired,
    RegionRestricted,
    UpstreamRestricted,
    Unknown,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntitlementRestriction {
    pub feature: EntitlementFeature,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality: Option<AudioQuality>,
    pub reason: EntitlementRestrictionReason,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountEntitlement {
    pub tier: EntitlementTier,
    pub membership: MembershipState,
    pub expires_at_ms: Option<u64>,
    pub permitted_qualities: Vec<AudioQuality>,
    pub observed_maximum_quality: Option<AudioQuality>,
    pub restrictions: Vec<EntitlementRestriction>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountProfile {
    pub avatar_url: Option<String>,
    pub nickname: String,
    pub masked_identity: String,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountCapabilities {
    pub qr_login: bool,
    pub favorite_read: bool,
    pub favorite_write: bool,
    pub playlist_read: bool,
    pub playlist_write: bool,
    pub recent_history_read: bool,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum AccountState {
    Guest {
        profile: (),
        entitlement: (),
    },
    RestoringSession {
        profile: (),
        entitlement: (),
    },
    StartingLogin {
        #[serde(rename = "attemptId")]
        attempt_id: String,
        #[serde(rename = "ownerLeaseId")]
        owner_lease_id: String,
        #[serde(rename = "pollAfterMs")]
        poll_after_ms: u64,
        profile: (),
        entitlement: (),
    },
    WaitingForScan {
        #[serde(rename = "attemptId")]
        attempt_id: String,
        #[serde(rename = "ownerLeaseId")]
        owner_lease_id: String,
        #[serde(rename = "qrImageDataUri")]
        qr_image_data_uri: String,
        #[serde(rename = "expiresAtMs")]
        expires_at_ms: u64,
        #[serde(rename = "pollAfterMs")]
        poll_after_ms: u64,
        profile: (),
        entitlement: (),
    },
    WaitingForConfirmation {
        #[serde(rename = "attemptId")]
        attempt_id: String,
        #[serde(rename = "ownerLeaseId")]
        owner_lease_id: String,
        #[serde(rename = "expiresAtMs")]
        expires_at_ms: u64,
        #[serde(rename = "pollAfterMs")]
        poll_after_ms: u64,
        profile: (),
        entitlement: (),
    },
    Authenticated {
        profile: AccountProfile,
        entitlement: AccountEntitlement,
    },
    SessionExpired {
        profile: Option<AccountProfile>,
        entitlement: Option<AccountEntitlement>,
    },
    ReauthenticationRequired {
        profile: Option<AccountProfile>,
        entitlement: Option<AccountEntitlement>,
    },
    SecureStoreUnavailable {
        profile: Option<AccountProfile>,
        entitlement: Option<AccountEntitlement>,
    },
    Cancelled {
        #[serde(rename = "attemptId")]
        attempt_id: Option<String>,
        profile: (),
        entitlement: (),
    },
    Expired {
        #[serde(rename = "attemptId")]
        attempt_id: Option<String>,
        profile: (),
        entitlement: (),
    },
    Rejected {
        #[serde(rename = "attemptId")]
        attempt_id: Option<String>,
        profile: (),
        entitlement: (),
    },
    NetworkError {
        #[serde(rename = "attemptId")]
        attempt_id: Option<String>,
        profile: (),
        entitlement: (),
    },
    ProtocolError {
        #[serde(rename = "attemptId")]
        attempt_id: Option<String>,
        profile: (),
        entitlement: (),
    },
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSnapshot {
    #[serde(flatten)]
    pub account: AccountState,
    pub revision: u64,
    pub capabilities: AccountCapabilities,
}

impl AccountSnapshot {
    pub(crate) fn state_name(&self) -> &'static str {
        match &self.account {
            AccountState::Guest { .. } => "guest",
            AccountState::RestoringSession { .. } => "restoring-session",
            AccountState::StartingLogin { .. } => "starting-login",
            AccountState::WaitingForScan { .. } => "waiting-for-scan",
            AccountState::WaitingForConfirmation { .. } => "waiting-for-confirmation",
            AccountState::Authenticated { .. } => "authenticated",
            AccountState::SessionExpired { .. } => "session-expired",
            AccountState::ReauthenticationRequired { .. } => "reauthentication-required",
            AccountState::SecureStoreUnavailable { .. } => "secure-store-unavailable",
            AccountState::Cancelled { .. } => "cancelled",
            AccountState::Expired { .. } => "expired",
            AccountState::Rejected { .. } => "rejected",
            AccountState::NetworkError { .. } => "network-error",
            AccountState::ProtocolError { .. } => "protocol-error",
        }
    }

    pub(crate) fn attempt_id(&self) -> Option<&str> {
        match &self.account {
            AccountState::StartingLogin { attempt_id, .. }
            | AccountState::WaitingForScan { attempt_id, .. }
            | AccountState::WaitingForConfirmation { attempt_id, .. } => Some(attempt_id),
            AccountState::Cancelled { attempt_id, .. }
            | AccountState::Expired { attempt_id, .. }
            | AccountState::Rejected { attempt_id, .. }
            | AccountState::NetworkError { attempt_id, .. }
            | AccountState::ProtocolError { attempt_id, .. } => attempt_id.as_deref(),
            _ => None,
        }
    }

    pub(crate) fn owner_lease_id(&self) -> Option<&str> {
        match &self.account {
            AccountState::StartingLogin { owner_lease_id, .. }
            | AccountState::WaitingForScan { owner_lease_id, .. }
            | AccountState::WaitingForConfirmation { owner_lease_id, .. } => Some(owner_lease_id),
            _ => None,
        }
    }

    pub(crate) fn qr_image_data_uri(&self) -> Option<&str> {
        match &self.account {
            AccountState::WaitingForScan {
                qr_image_data_uri, ..
            } => Some(qr_image_data_uri),
            _ => None,
        }
    }
}

impl PlaylistCapabilities {
    pub(crate) fn read_only() -> Self {
        Self {
            can_add_tracks: false,
            can_remove_tracks: false,
            can_rename: false,
            can_delete: false,
            can_reorder: false,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderErrorCode {
    Offline,
    Timeout,
    AuthenticationExpired,
    AuthorizationRejected,
    EntitlementUnavailable,
    RateLimited,
    SchemaChanged,
    SongUnavailable,
    MalformedResponse,
    ProviderFailure,
    Cancelled,
    NotFound,
    InvalidRequest,
    UnsupportedOperation,
    MutationInProgress,
    StorageFailure,
}

impl ProviderErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Offline => "offline",
            Self::Timeout => "timeout",
            Self::AuthenticationExpired => "authentication-expired",
            Self::AuthorizationRejected => "authorization-rejected",
            Self::EntitlementUnavailable => "entitlement-unavailable",
            Self::RateLimited => "rate-limited",
            Self::SchemaChanged => "schema-changed",
            Self::SongUnavailable => "song-unavailable",
            Self::MalformedResponse => "malformed-response",
            Self::ProviderFailure => "provider-failure",
            Self::Cancelled => "cancelled",
            Self::NotFound => "not-found",
            Self::InvalidRequest => "invalid-request",
            Self::UnsupportedOperation => "unsupported-operation",
            Self::MutationInProgress => "mutation-in-progress",
            Self::StorageFailure => "storage-failure",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MutationStatus {
    Applied,
    Rejected,
    Reconciled,
    OutcomeUnknown,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteMutationRequest {
    pub track_id: String,
    pub favorite: bool,
    pub client_operation_id: String,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteMutationResult {
    pub client_operation_id: String,
    pub status: MutationStatus,
    pub track_id: String,
    pub favorite: bool,
    pub error_code: Option<ProviderErrorCode>,
    pub auth_revision: u64,
}

#[derive(Default)]
struct MutationState {
    epoch: Option<AccountEpoch>,
    favorite_in_flight: HashMap<String, String>,
    favorite_completed: CompletedResultCache<CompletedFavoriteMutation>,
}

#[derive(Clone)]
struct CompletedFavoriteMutation {
    requested_track_id: String,
    requested_favorite: bool,
    result: FavoriteMutationResult,
}

impl MutationState {
    fn ensure_epoch(&mut self, epoch: &AccountEpoch) {
        if self.epoch.as_ref() != Some(epoch) {
            self.clear();
            self.epoch = Some(epoch.clone());
        }
    }

    fn clear(&mut self) {
        self.epoch = None;
        self.favorite_in_flight.clear();
        self.favorite_completed.clear();
    }
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePlaylistRequest {
    pub title: String,
    pub client_operation_id: String,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenamePlaylistRequest {
    pub playlist_id: String,
    pub title: String,
    pub client_operation_id: String,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistTrackMutationRequest {
    pub playlist_id: String,
    pub track_id: String,
    pub client_operation_id: String,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletePlaylistRequest {
    pub playlist_id: String,
    pub client_operation_id: String,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistMutationResult {
    pub client_operation_id: String,
    pub status: MutationStatus,
    pub playlist: Option<AccountPlaylistSummary>,
    pub error_code: Option<ProviderErrorCode>,
    pub auth_revision: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedPlaylistDetailPage {
    summary: AccountPlaylistSummary,
    items: Vec<Song>,
    total: Option<u64>,
    fetched_at_ms: u64,
    expires_at_ms: u64,
    terminal: bool,
}

struct FavoriteRefresh {
    epoch: AccountEpoch,
    expected_cursor: Option<String>,
    items: Vec<Song>,
    seen: HashSet<String>,
    page_writes: Vec<ProviderCacheMutation>,
}

struct PlaylistRefresh {
    epoch: AccountEpoch,
    expected_cursor: Option<String>,
    items: Vec<AccountPlaylistSummary>,
    seen: HashSet<String>,
    page_writes: Vec<ProviderCacheMutation>,
}

#[derive(Default)]
struct RefreshState {
    epoch: Option<AccountEpoch>,
    favorites: Option<FavoriteRefresh>,
    playlists: Option<PlaylistRefresh>,
}

impl RefreshState {
    fn ensure_epoch(&mut self, epoch: &AccountEpoch) {
        if self.epoch.as_ref() != Some(epoch) {
            self.epoch = Some(epoch.clone());
            self.favorites = None;
            self.playlists = None;
        }
    }

    fn clear(&mut self) {
        self.epoch = None;
        self.favorites = None;
        self.playlists = None;
    }
}

pub(crate) struct QQMusicAccountService {
    transport: Arc<dyn QqTransport>,
    clock: Arc<dyn Clock>,
    storage: Arc<StorageService>,
    auth: Arc<QQMusicAuthService>,
    cursors: Mutex<OpaqueCursorRegistry>,
    refreshes: Mutex<RefreshState>,
    mutations: Mutex<MutationState>,
    projection_commit: Mutex<()>,
    track_references: Mutex<ProviderTrackRegistry>,
    #[cfg(test)]
    read_barrier: StdMutex<Option<Arc<ReadBarrier>>>,
    #[cfg(test)]
    write_barrier: StdMutex<Option<Arc<WriteBarrier>>>,
}

impl QQMusicAccountService {
    pub(crate) fn new(
        transport: Arc<dyn QqTransport>,
        clock: Arc<dyn Clock>,
        storage: Arc<StorageService>,
        auth: Arc<QQMusicAuthService>,
    ) -> Self {
        Self {
            transport,
            clock,
            storage,
            auth,
            cursors: Mutex::new(OpaqueCursorRegistry::default()),
            refreshes: Mutex::new(RefreshState::default()),
            mutations: Mutex::new(MutationState::default()),
            projection_commit: Mutex::new(()),
            track_references: Mutex::new(ProviderTrackRegistry::default()),
            #[cfg(test)]
            read_barrier: StdMutex::new(None),
            #[cfg(test)]
            write_barrier: StdMutex::new(None),
        }
    }

    pub(crate) async fn clear_runtime_state(&self) {
        self.cursors.lock().await.clear();
        self.refreshes.lock().await.clear();
        self.mutations.lock().await.clear();
    }

    pub(crate) async fn remember_songs<'a>(&self, songs: impl IntoIterator<Item = &'a Song>) {
        let references = songs
            .into_iter()
            .filter_map(|song| {
                song.provider.as_ref().and_then(|provider| {
                    provider
                        .numeric_id
                        .map(|numeric_id| (song.id.clone(), numeric_id))
                })
            })
            .collect::<Vec<_>>();
        if references.is_empty() {
            return;
        }
        let mut registry = self.track_references.lock().await;
        for (stable_id, numeric_id) in references {
            registry.remember(stable_id, numeric_id);
        }
    }

    #[cfg(test)]
    fn set_read_barrier(&self, boundary: ReadBoundary) -> Arc<ReadBarrier> {
        let barrier = Arc::new(ReadBarrier {
            boundary,
            entered: Notify::new(),
            release: Notify::new(),
        });
        *self
            .read_barrier
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::clone(&barrier));
        barrier
    }

    #[cfg(test)]
    fn set_write_barrier(&self, boundary: WriteBoundary) -> Arc<WriteBarrier> {
        let barrier = Arc::new(WriteBarrier {
            boundary,
            entered: Notify::new(),
            release: Notify::new(),
        });
        *self
            .write_barrier
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::clone(&barrier));
        barrier
    }

    pub(crate) async fn set_favorite(
        &self,
        request: FavoriteMutationRequest,
    ) -> Result<FavoriteMutationResult, QQMusicError> {
        validate_favorite_request(&request)?;
        let context = self.auth.capture_account_context().await?;
        let mutation_key = format!("favorite:{}", request.track_id);
        let cached = {
            let mut state = self.mutations.lock().await;
            state.ensure_epoch(&context.epoch);
            if let Some(completed) = state
                .favorite_completed
                .get(&context.epoch, &request.client_operation_id)
            {
                if completed.requested_track_id != request.track_id
                    || completed.requested_favorite != request.favorite
                {
                    return Err(QQMusicError::InvalidRequest);
                }
                Some(completed.result)
            } else {
                if state.favorite_in_flight.contains_key(&mutation_key) {
                    return Err(QQMusicError::MutationInProgress);
                }
                state
                    .favorite_in_flight
                    .insert(mutation_key.clone(), request.client_operation_id.clone());
                None
            }
        };
        if let Some(cached) = cached {
            self.auth.ensure_current(&context.epoch).await?;
            return Ok(cached);
        }

        let result = match self.set_favorite_owned(&context, &request).await {
            Ok(result) => result,
            Err(error) => {
                self.release_favorite_mutation(
                    &context.epoch,
                    &mutation_key,
                    &request.client_operation_id,
                )
                .await;
                return Err(error);
            }
        };
        if let Err(error) = self.auth.ensure_current(&context.epoch).await {
            self.release_favorite_mutation(
                &context.epoch,
                &mutation_key,
                &request.client_operation_id,
            )
            .await;
            return Err(error);
        }
        let mut state = self.mutations.lock().await;
        if state.epoch.as_ref() != Some(&context.epoch)
            || state.favorite_in_flight.get(&mutation_key) != Some(&request.client_operation_id)
        {
            return Err(QQMusicError::Cancelled);
        }
        state.favorite_completed.insert_if_current(
            &context.epoch,
            request.client_operation_id.clone(),
            CompletedFavoriteMutation {
                requested_track_id: request.track_id.clone(),
                requested_favorite: request.favorite,
                result: result.clone(),
            },
        );
        state.favorite_in_flight.remove(&mutation_key);
        drop(state);
        self.auth.ensure_current(&context.epoch).await?;
        Ok(result)
    }

    async fn set_favorite_owned(
        &self,
        context: &AuthenticatedAccountContext,
        request: &FavoriteMutationRequest,
    ) -> Result<FavoriteMutationResult, QQMusicError> {
        let write = self.execute_favorite_write(context, request).await;
        #[cfg(test)]
        self.hit_write_boundary(WriteBoundary::WriteClassified)
            .await;
        self.auth.ensure_current(&context.epoch).await?;

        let (status, favorite, error_code) = match write {
            Ok(true) => (MutationStatus::Applied, request.favorite, None),
            Ok(false) => (
                MutationStatus::Rejected,
                !request.favorite,
                Some(ProviderErrorCode::ProviderFailure),
            ),
            Err(QQMusicError::OutcomeUnknown) => self.reconcile_favorite(context, request).await?,
            Err(QQMusicError::AuthenticationExpired | QQMusicError::AuthorizationRejected) => {
                return self.expire_mutation_session(context).await;
            }
            Err(error) => return Err(error),
        };

        if matches!(status, MutationStatus::Applied | MutationStatus::Reconciled) {
            self.commit_favorite_projection(context, &request.track_id, favorite)
                .await?;
        }
        Ok(FavoriteMutationResult {
            client_operation_id: request.client_operation_id.clone(),
            status,
            track_id: request.track_id.clone(),
            favorite,
            error_code,
            auth_revision: context.auth_revision,
        })
    }

    async fn execute_favorite_write(
        &self,
        context: &AuthenticatedAccountContext,
        request: &FavoriteMutationRequest,
    ) -> Result<bool, QQMusicError> {
        self.auth.ensure_current(&context.epoch).await?;
        let provider_track_id = self
            .track_references
            .lock()
            .await
            .numeric_id(&request.track_id)
            .ok_or(QQMusicError::InvalidRequest)?;
        let method = if request.favorite {
            "AddSonglist"
        } else {
            "DelSonglist"
        };
        let payload = musicu_request(
            &context.session,
            "music.musicasset.PlaylistDetailWrite",
            method,
            json!({
                "dirId": 201,
                "tid": 0,
                "bFmtUtf8": true,
                "v_songInfo": [{ "songId": provider_track_id, "songType": 13 }]
            }),
        );
        let response = self
            .transport
            .execute(TransportRequest {
                operation: "account.favorite.write",
                method: Method::POST,
                url: Url::parse(QQ_MUSICU_URL).map_err(|_| QQMusicError::Protocol)?,
                headers: account_headers(&context.session)?,
                body: Some(serde_json::to_vec(&payload).map_err(|_| QQMusicError::Protocol)?),
                retry: RetryClass::Write,
                redirects: RedirectMode::FollowValidated,
                response_shape: "favorite-mutation",
                cancellation: context.cancellation.clone(),
            })
            .await?;
        self.auth.ensure_current(&context.epoch).await?;
        if !response.status.is_success() {
            return Ok(false);
        }
        favorite_write_accepted(&response.body)
    }

    async fn reconcile_favorite(
        &self,
        context: &AuthenticatedAccountContext,
        request: &FavoriteMutationRequest,
    ) -> Result<(MutationStatus, bool, Option<ProviderErrorCode>), QQMusicError> {
        let mut observed_opposite = false;
        for delay_ms in [300_u64, 700, 1_500] {
            self.auth.ensure_current(&context.epoch).await?;
            tokio::select! {
                biased;
                _ = context.cancellation.cancelled() => return Err(QQMusicError::Cancelled),
                _ = tokio::time::sleep(std::time::Duration::from_millis(delay_ms)) => {}
            }
            self.auth.ensure_current(&context.epoch).await?;
            let observed = match self.read_favorite_state(context, &request.track_id).await {
                Ok(observed) => observed,
                Err(QQMusicError::AuthenticationExpired | QQMusicError::AuthorizationRejected) => {
                    return self.expire_mutation_session(context).await;
                }
                Err(QQMusicError::Cancelled) => return Err(QQMusicError::Cancelled),
                Err(_) => None,
            };
            #[cfg(test)]
            self.hit_write_boundary(WriteBoundary::ReconciliationRead)
                .await;
            self.auth.ensure_current(&context.epoch).await?;
            if observed == Some(request.favorite) {
                return Ok((MutationStatus::Reconciled, request.favorite, None));
            }
            if observed == Some(!request.favorite) {
                observed_opposite = true;
            }
        }
        if observed_opposite {
            Ok((
                MutationStatus::Rejected,
                !request.favorite,
                Some(ProviderErrorCode::ProviderFailure),
            ))
        } else {
            Ok((
                MutationStatus::OutcomeUnknown,
                request.favorite,
                Some(ProviderErrorCode::ProviderFailure),
            ))
        }
    }

    async fn read_favorite_state(
        &self,
        context: &AuthenticatedAccountContext,
        track_id: &str,
    ) -> Result<Option<bool>, QQMusicError> {
        let payload = musicu_request(
            &context.session,
            "music.srfDissInfo.DissInfo",
            "CgiGetDiss",
            json!({ "dirid": 201, "song_begin": 0, "song_num": 100 }),
        );
        let response = self
            .transport
            .execute(TransportRequest {
                operation: "account.favorite.reconcile",
                method: Method::POST,
                url: Url::parse(QQ_MUSICU_URL).map_err(|_| QQMusicError::Protocol)?,
                headers: account_headers(&context.session)?,
                body: Some(serde_json::to_vec(&payload).map_err(|_| QQMusicError::Protocol)?),
                retry: RetryClass::ReconciliationRead,
                redirects: RedirectMode::FollowValidated,
                response_shape: "favorite-reconciliation-page",
                cancellation: context.cancellation.clone(),
            })
            .await
            .map_err(|error| match error {
                QQMusicError::AuthorizationRejected => QQMusicError::AuthenticationExpired,
                other => other,
            })?;
        self.auth.ensure_current(&context.epoch).await?;
        if !response.status.is_success() {
            return Err(QQMusicError::Protocol);
        }
        let page = normalize_favorite_response(&response.body, 0)?;
        if page.items.iter().any(|song| song.id == track_id) {
            Ok(Some(true))
        } else if page.next_provider_cursor.is_none() {
            Ok(Some(false))
        } else {
            Ok(None)
        }
    }

    async fn commit_favorite_projection(
        &self,
        context: &AuthenticatedAccountContext,
        track_id: &str,
        favorite: bool,
    ) -> Result<(), QQMusicError> {
        let _commit = self.projection_commit.lock().await;
        self.auth.ensure_current(&context.epoch).await?;
        let mut projection = self.projection_for(context)?;
        if favorite {
            if !projection.favorite_ids.iter().any(|id| id == track_id) {
                projection.favorite_ids.push(track_id.to_owned());
            }
        } else {
            projection.favorite_ids.retain(|id| id != track_id);
        }
        projection.fetched_at_ms = self.clock.now_ms();
        let operations = [
            ProviderCacheMutation::DeleteKindPrefix {
                kind: ACCOUNT_CACHE_KIND.to_owned(),
                prefix: AccountCache::scope_prefix(&context.epoch.scope),
            },
            cache_put(
                &AccountCache::projection_key(&context.epoch.scope),
                &projection,
                u64::MAX,
            )?,
        ];
        #[cfg(test)]
        self.hit_write_boundary(WriteBoundary::BeforeCacheCommit)
            .await;
        self.commit_cache(context, &operations).await?;
        #[cfg(test)]
        self.hit_write_boundary(WriteBoundary::AfterCacheCommit)
            .await;
        self.auth.ensure_current(&context.epoch).await?;
        self.cursors.lock().await.clear();
        self.refreshes.lock().await.clear();
        Ok(())
    }

    async fn expire_mutation_session<T>(
        &self,
        context: &AuthenticatedAccountContext,
    ) -> Result<T, QQMusicError> {
        match self
            .auth
            .require_reauthentication_if_current(&context.epoch)
            .await
        {
            Ok(()) => Err(QQMusicError::AuthenticationExpired),
            Err(QQMusicError::Cancelled) => Err(QQMusicError::Cancelled),
            Err(error) => Err(error),
        }
    }

    async fn release_favorite_mutation(
        &self,
        epoch: &AccountEpoch,
        mutation_key: &str,
        operation_id: &str,
    ) {
        let mut state = self.mutations.lock().await;
        if state.epoch.as_ref() == Some(epoch)
            && state
                .favorite_in_flight
                .get(mutation_key)
                .is_some_and(|owner| owner == operation_id)
        {
            state.favorite_in_flight.remove(mutation_key);
        }
    }

    pub(crate) async fn favorite_songs(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> Result<Page<Song>, QQMusicError> {
        let context = self.auth.capture_account_context().await?;
        let resource = "favorites";
        let provider_cursor = self
            .resolve_provider_cursor(&context, resource, cursor.as_deref())
            .await?;
        let offset = provider_offset(&provider_cursor)?;
        let key = AccountCache::favorites_key(&context.epoch.scope, cursor.as_deref());
        let cached = self.cached_page::<Song>(&key)?;
        if let Some(cached) = cached
            .as_ref()
            .filter(|page| page.terminal && page.expires_at_ms > self.clock.now_ms())
        {
            self.auth.ensure_current(&context.epoch).await?;
            return Ok(page_from_cached(
                cached.clone(),
                context.auth_revision,
                false,
            ));
        }

        let limit = limit.clamp(1, 100);
        let payload = musicu_request(
            &context.session,
            "music.srfDissInfo.DissInfo",
            "CgiGetDiss",
            json!({ "dirid": 201, "song_begin": offset, "song_num": limit }),
        );
        let response = match self
            .execute_read(&context, "account.favorites", "favorite-page", payload)
            .await
        {
            Ok(response) => response,
            Err(error) => {
                return self.stale_page_or_error(&context, cached, error).await;
            }
        };
        let normalized = normalize_favorite_response(&response.body, offset)?;
        validate_next_provider_cursor(offset, normalized.next_provider_cursor.as_deref())?;
        self.auth.ensure_current(&context.epoch).await?;
        let now = self.clock.now_ms();
        let next_cursor = self
            .issue_next_cursor(&context, resource, normalized.next_provider_cursor.clone())
            .await?;
        let page = Page {
            items: normalized.items,
            next_cursor,
            total: normalized.total,
            fetched_at_ms: now,
            stale: false,
            auth_revision: context.auth_revision,
        };
        let cached_page = CachedAccountPage {
            items: page.items.clone(),
            total: page.total,
            fetched_at_ms: now,
            expires_at_ms: now.saturating_add(FAVORITES_TTL_MS),
            terminal: page.next_cursor.is_none(),
        };
        let write = cache_put(&key, &cached_page, cached_page.expires_at_ms)?;
        let terminal = page.next_cursor.is_none();
        let completed = {
            let mut state = self.refreshes.lock().await;
            state.ensure_epoch(&context.epoch);
            if cursor.is_none() {
                state.favorites = Some(FavoriteRefresh {
                    epoch: context.epoch.clone(),
                    expected_cursor: None,
                    items: Vec::new(),
                    seen: HashSet::new(),
                    page_writes: Vec::new(),
                });
            }
            let refresh = state
                .favorites
                .as_mut()
                .filter(|refresh| refresh.epoch == context.epoch)
                .ok_or(QQMusicError::InvalidRequest)?;
            if cursor.is_some() && refresh.expected_cursor.as_deref() != cursor.as_deref() {
                return Err(QQMusicError::InvalidRequest);
            }
            for song in &page.items {
                if refresh.seen.insert(song.id.clone()) {
                    refresh.items.push(song.clone());
                }
            }
            refresh.expected_cursor = page.next_cursor.clone();
            refresh.page_writes.push(write);
            terminal.then(|| state.favorites.take().expect("favorite refresh exists"))
        };
        if let Some(refresh) = completed {
            let mut projection = self.projection_for(&context)?;
            projection.favorite_ids = refresh.items.iter().map(|song| song.id.clone()).collect();
            projection.profile = context.profile.clone();
            projection.entitlement = context.entitlement.clone();
            projection.fetched_at_ms = now;
            let mut operations = vec![ProviderCacheMutation::DeleteKindPrefix {
                kind: ACCOUNT_CACHE_KIND.to_owned(),
                prefix: AccountCache::favorites_prefix(&context.epoch.scope),
            }];
            operations.extend(refresh.page_writes);
            operations.push(cache_put(
                &AccountCache::projection_key(&context.epoch.scope),
                &projection,
                u64::MAX,
            )?);
            self.commit_cache(&context, &operations).await?;
        } else {
            self.auth.ensure_current(&context.epoch).await?;
        }
        Ok(page)
    }

    pub(crate) async fn playlists(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> Result<Page<AccountPlaylistSummary>, QQMusicError> {
        let context = self.auth.capture_account_context().await?;
        let resource = "playlists";
        let provider_cursor = self
            .resolve_provider_cursor(&context, resource, cursor.as_deref())
            .await?;
        let offset = provider_offset(&provider_cursor)?;
        let key = AccountCache::playlists_key(&context.epoch.scope, cursor.as_deref());
        let cached = self.cached_page::<AccountPlaylistSummary>(&key)?;
        if let Some(cached) = cached
            .as_ref()
            .filter(|page| page.terminal && page.expires_at_ms > self.clock.now_ms())
        {
            self.auth.ensure_current(&context.epoch).await?;
            return Ok(page_from_cached(
                cached.clone(),
                context.auth_revision,
                false,
            ));
        }

        let limit = limit.clamp(1, 100);
        let payload = musicu_request(
            &context.session,
            "music.musicasset.PlaylistBaseRead",
            "GetPlaylistByUin",
            json!({
                "uin": context.session.uin,
                "sin": offset,
                "ein": offset.saturating_add(limit as u64).saturating_sub(1)
            }),
        );
        let response = match self
            .execute_read(&context, "account.playlists", "playlist-page", payload)
            .await
        {
            Ok(response) => response,
            Err(error) => {
                return self.stale_page_or_error(&context, cached, error).await;
            }
        };
        let normalized = normalize_playlist_page_response(&response.body, offset)?;
        validate_next_provider_cursor(offset, normalized.next_provider_cursor.as_deref())?;
        self.auth.ensure_current(&context.epoch).await?;
        let now = self.clock.now_ms();
        let next_cursor = self
            .issue_next_cursor(&context, resource, normalized.next_provider_cursor.clone())
            .await?;
        let page = Page {
            items: normalized.items,
            next_cursor,
            total: normalized.total,
            fetched_at_ms: now,
            stale: false,
            auth_revision: context.auth_revision,
        };
        let cached_page = CachedAccountPage {
            items: page.items.clone(),
            total: page.total,
            fetched_at_ms: now,
            expires_at_ms: now.saturating_add(ACCOUNT_COLLECTION_TTL_MS),
            terminal: page.next_cursor.is_none(),
        };
        let write = cache_put(&key, &cached_page, cached_page.expires_at_ms)?;
        let terminal = page.next_cursor.is_none();
        let completed = {
            let mut state = self.refreshes.lock().await;
            state.ensure_epoch(&context.epoch);
            if cursor.is_none() {
                state.playlists = Some(PlaylistRefresh {
                    epoch: context.epoch.clone(),
                    expected_cursor: None,
                    items: Vec::new(),
                    seen: HashSet::new(),
                    page_writes: Vec::new(),
                });
            }
            let refresh = state
                .playlists
                .as_mut()
                .filter(|refresh| refresh.epoch == context.epoch)
                .ok_or(QQMusicError::InvalidRequest)?;
            if cursor.is_some() && refresh.expected_cursor.as_deref() != cursor.as_deref() {
                return Err(QQMusicError::InvalidRequest);
            }
            for playlist in &page.items {
                if refresh.seen.insert(playlist.id.clone()) {
                    refresh.items.push(playlist.clone());
                }
            }
            refresh.expected_cursor = page.next_cursor.clone();
            refresh.page_writes.push(write);
            terminal.then(|| state.playlists.take().expect("playlist refresh exists"))
        };
        if let Some(refresh) = completed {
            let mut projection = self.projection_for(&context)?;
            projection.playlists = refresh.items;
            projection.profile = context.profile.clone();
            projection.entitlement = context.entitlement.clone();
            projection.fetched_at_ms = now;
            let mut operations = vec![ProviderCacheMutation::DeleteKindPrefix {
                kind: ACCOUNT_CACHE_KIND.to_owned(),
                prefix: AccountCache::playlists_prefix(&context.epoch.scope),
            }];
            operations.extend(refresh.page_writes);
            operations.push(cache_put(
                &AccountCache::projection_key(&context.epoch.scope),
                &projection,
                u64::MAX,
            )?);
            self.commit_cache(&context, &operations).await?;
        } else {
            self.auth.ensure_current(&context.epoch).await?;
        }
        Ok(page)
    }

    pub(crate) async fn playlist_tracks(
        &self,
        playlist_id: String,
        cursor: Option<String>,
        limit: u32,
    ) -> Result<AccountPlaylistDetail, QQMusicError> {
        let provider_playlist_id = provider_playlist_id(&playlist_id)?.to_owned();
        let context = self.auth.capture_account_context().await?;
        let resource = format!("playlist-tracks:{playlist_id}");
        let provider_cursor = self
            .resolve_provider_cursor(&context, &resource, cursor.as_deref())
            .await?;
        let offset = provider_offset(&provider_cursor)?;
        let key = AccountCache::playlist_tracks_key(
            &context.epoch.scope,
            &playlist_id,
            cursor.as_deref(),
        );
        let cached = self.cached_detail_page(&key)?;
        if let Some(cached) = cached
            .as_ref()
            .filter(|page| page.terminal && page.expires_at_ms > self.clock.now_ms())
        {
            self.auth.ensure_current(&context.epoch).await?;
            return Ok(detail_from_cached(
                cached.clone(),
                context.auth_revision,
                false,
            ));
        }

        let limit = limit.clamp(1, 100);
        let payload = musicu_request(
            &context.session,
            "music.srfDissInfo.DissInfo",
            "CgiGetDiss",
            json!({
                "disstid": provider_playlist_id,
                "song_begin": offset,
                "song_num": limit
            }),
        );
        let response = match self
            .execute_read(
                &context,
                "account.playlist-tracks",
                "playlist-detail-page",
                payload,
            )
            .await
        {
            Ok(response) => response,
            Err(error) => {
                self.auth.ensure_current(&context.epoch).await?;
                if stale_eligible(&error) {
                    if let Some(cached) = cached {
                        return Ok(detail_from_cached(cached, context.auth_revision, true));
                    }
                }
                return Err(error);
            }
        };
        let (summary, mut normalized) = normalize_playlist_detail_response(&response.body, offset)?;
        validate_next_provider_cursor(offset, normalized.next_provider_cursor.as_deref())?;
        self.overlay_favorites(&context, &mut normalized.items)?;
        self.auth.ensure_current(&context.epoch).await?;
        let now = self.clock.now_ms();
        let next_cursor = self
            .issue_next_cursor(&context, &resource, normalized.next_provider_cursor.clone())
            .await?;
        let detail = AccountPlaylistDetail {
            summary: summary.clone(),
            tracks: Page {
                items: normalized.items,
                next_cursor,
                total: normalized.total,
                fetched_at_ms: now,
                stale: false,
                auth_revision: context.auth_revision,
            },
        };
        let cached = CachedPlaylistDetailPage {
            summary,
            items: detail.tracks.items.clone(),
            total: detail.tracks.total,
            fetched_at_ms: now,
            expires_at_ms: now.saturating_add(ACCOUNT_COLLECTION_TTL_MS),
            terminal: detail.tracks.next_cursor.is_none(),
        };
        self.commit_cache(&context, &[cache_put(&key, &cached, cached.expires_at_ms)?])
            .await?;
        Ok(detail)
    }

    pub(crate) async fn recently_played(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> Result<Page<RemotePlayHistoryItem>, QQMusicError> {
        let context = self.auth.capture_account_context().await?;
        let resource = "recent";
        let provider_cursor = self
            .resolve_provider_cursor(&context, resource, cursor.as_deref())
            .await?;
        let offset = provider_offset(&provider_cursor)?;
        let key = AccountCache::recent_key(&context.epoch.scope, cursor.as_deref());
        let cached = self.cached_page::<RemotePlayHistoryItem>(&key)?;
        if let Some(cached) = cached
            .as_ref()
            .filter(|page| page.terminal && page.expires_at_ms > self.clock.now_ms())
        {
            self.auth.ensure_current(&context.epoch).await?;
            return Ok(page_from_cached(
                cached.clone(),
                context.auth_revision,
                false,
            ));
        }

        let limit = limit.clamp(1, 100);
        let payload = musicu_request(
            &context.session,
            "music.musichallSong.RecentPlayList",
            "GetRecentPlayList",
            json!({ "uin": context.session.uin, "begin": offset, "num": limit }),
        );
        let response = match self
            .execute_read(&context, "account.recent", "recent-history-page", payload)
            .await
        {
            Ok(response) => response,
            Err(error) => {
                return self.stale_page_or_error(&context, cached, error).await;
            }
        };
        let mut normalized = normalize_recent_response(&response.body, offset)?;
        validate_next_provider_cursor(offset, normalized.next_provider_cursor.as_deref())?;
        let mut songs = normalized
            .items
            .iter()
            .map(|item| item.song.clone())
            .collect::<Vec<_>>();
        self.overlay_favorites(&context, &mut songs)?;
        for (item, song) in normalized.items.iter_mut().zip(songs) {
            item.song = song;
        }
        self.auth.ensure_current(&context.epoch).await?;
        let now = self.clock.now_ms();
        let next_cursor = self
            .issue_next_cursor(&context, resource, normalized.next_provider_cursor.clone())
            .await?;
        let page = Page {
            items: normalized.items,
            next_cursor,
            total: normalized.total,
            fetched_at_ms: now,
            stale: false,
            auth_revision: context.auth_revision,
        };
        let cached = CachedAccountPage {
            items: page.items.clone(),
            total: page.total,
            fetched_at_ms: now,
            expires_at_ms: now.saturating_add(ACCOUNT_COLLECTION_TTL_MS),
            terminal: page.next_cursor.is_none(),
        };
        self.commit_cache(&context, &[cache_put(&key, &cached, cached.expires_at_ms)?])
            .await?;
        Ok(page)
    }

    fn cached_page<T: for<'de> Deserialize<'de>>(
        &self,
        key: &str,
    ) -> Result<Option<CachedAccountPage<T>>, QQMusicError> {
        self.storage
            .get_json(key, true)
            .map_err(|_| QQMusicError::Storage)
    }

    fn cached_detail_page(
        &self,
        key: &str,
    ) -> Result<Option<CachedPlaylistDetailPage>, QQMusicError> {
        self.storage
            .get_json(key, true)
            .map_err(|_| QQMusicError::Storage)
    }

    fn projection_for(
        &self,
        context: &AuthenticatedAccountContext,
    ) -> Result<AccountLibraryProjection, QQMusicError> {
        Ok(self
            .storage
            .get_json(&AccountCache::projection_key(&context.epoch.scope), true)
            .map_err(|_| QQMusicError::Storage)?
            .unwrap_or_else(|| AccountLibraryProjection {
                favorite_ids: Vec::new(),
                playlists: Vec::new(),
                profile: context.profile.clone(),
                entitlement: context.entitlement.clone(),
                fetched_at_ms: self.clock.now_ms(),
            }))
    }

    fn overlay_favorites(
        &self,
        context: &AuthenticatedAccountContext,
        songs: &mut [Song],
    ) -> Result<(), QQMusicError> {
        let projection = self.projection_for(context)?;
        let favorite_ids = projection.favorite_ids.into_iter().collect::<HashSet<_>>();
        for song in songs {
            song.is_favorite = favorite_ids.contains(&song.id);
        }
        Ok(())
    }

    async fn resolve_provider_cursor(
        &self,
        context: &AuthenticatedAccountContext,
        resource: &str,
        outward_cursor: Option<&str>,
    ) -> Result<String, QQMusicError> {
        self.auth.ensure_current(&context.epoch).await?;
        match outward_cursor {
            None => Ok("0".to_owned()),
            Some(cursor) => self
                .cursors
                .lock()
                .await
                .resolve(&context.epoch, resource, cursor)
                .ok_or(QQMusicError::InvalidRequest),
        }
    }

    async fn issue_next_cursor(
        &self,
        context: &AuthenticatedAccountContext,
        resource: &str,
        provider_cursor: Option<String>,
    ) -> Result<Option<String>, QQMusicError> {
        self.auth.ensure_current(&context.epoch).await?;
        let Some(provider_cursor) = provider_cursor else {
            return Ok(None);
        };
        Ok(Some(self.cursors.lock().await.issue(
            &context.epoch,
            resource,
            provider_cursor,
        )))
    }

    async fn execute_read(
        &self,
        context: &AuthenticatedAccountContext,
        operation: &'static str,
        response_shape: &'static str,
        payload: Value,
    ) -> Result<TransportResponse, QQMusicError> {
        self.auth.ensure_current(&context.epoch).await?;
        let body = serde_json::to_vec(&payload).map_err(|_| QQMusicError::Protocol)?;
        let result = self
            .transport
            .execute(TransportRequest {
                operation,
                method: Method::POST,
                url: Url::parse(QQ_MUSICU_URL).map_err(|_| QQMusicError::Protocol)?,
                headers: account_headers(&context.session)?,
                body: Some(body),
                retry: RetryClass::SafeRead,
                redirects: RedirectMode::FollowValidated,
                response_shape,
                cancellation: context.cancellation.clone(),
            })
            .await;
        #[cfg(test)]
        if result.is_ok() {
            self.hit_read_boundary(ReadBoundary::Response).await;
        } else if result.as_ref().err().is_some_and(stale_eligible) {
            self.hit_read_boundary(ReadBoundary::BeforeRetry).await;
        }
        let response = result.map_err(|error| match error {
            QQMusicError::AuthorizationRejected => QQMusicError::AuthenticationExpired,
            other => other,
        })?;
        self.auth.ensure_current(&context.epoch).await?;
        if !response.status.is_success() {
            return Err(match response.status {
                StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                    QQMusicError::AuthenticationExpired
                }
                StatusCode::TOO_MANY_REQUESTS => QQMusicError::RateLimited,
                status if status.is_server_error() => QQMusicError::Offline,
                _ => QQMusicError::Protocol,
            });
        }
        Ok(response)
    }

    async fn stale_page_or_error<T: for<'de> Deserialize<'de>>(
        &self,
        context: &AuthenticatedAccountContext,
        cached: Option<CachedAccountPage<T>>,
        error: QQMusicError,
    ) -> Result<Page<T>, QQMusicError> {
        self.auth.ensure_current(&context.epoch).await?;
        if stale_eligible(&error) {
            if let Some(cached) = cached {
                return Ok(page_from_cached(cached, context.auth_revision, true));
            }
        }
        Err(error)
    }

    async fn commit_cache(
        &self,
        context: &AuthenticatedAccountContext,
        operations: &[ProviderCacheMutation],
    ) -> Result<(), QQMusicError> {
        #[cfg(test)]
        self.hit_read_boundary(ReadBoundary::BeforeCacheCommit)
            .await;
        self.auth
            .commit_account_cache_if_current(&context.epoch, || {
                self.storage.apply_provider_cache_batch(operations)
            })
            .await
    }

    #[cfg(test)]
    async fn hit_read_boundary(&self, boundary: ReadBoundary) {
        let barrier = self
            .read_barrier
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .filter(|barrier| barrier.boundary == boundary)
            .cloned();
        if let Some(barrier) = barrier {
            barrier.entered.notify_one();
            barrier.release.notified().await;
        }
    }

    #[cfg(test)]
    async fn hit_write_boundary(&self, boundary: WriteBoundary) {
        let barrier = self
            .write_barrier
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .filter(|barrier| barrier.boundary == boundary)
            .cloned();
        if let Some(barrier) = barrier {
            barrier.entered.notify_one();
            barrier.release.notified().await;
        }
    }
}

fn musicu_request(
    session: &SessionRecord,
    module: &'static str,
    method: &'static str,
    param: Value,
) -> Value {
    json!({
        "comm": {
            "ct": 24,
            "cv": 0,
            "format": "json",
            "uin": session.uin,
        },
        "req": {
            "module": module,
            "method": method,
            "param": param,
        },
    })
}

fn account_headers(session: &SessionRecord) -> Result<HeaderMap, QQMusicError> {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    headers.insert(header::ORIGIN, HeaderValue::from_static("https://y.qq.com"));
    headers.insert(
        header::REFERER,
        HeaderValue::from_static("https://y.qq.com/"),
    );
    headers.insert(
        header::COOKIE,
        HeaderValue::from_str(&session.cookie_header).map_err(|_| QQMusicError::Protocol)?,
    );
    Ok(headers)
}

fn provider_offset(cursor: &str) -> Result<u64, QQMusicError> {
    cursor
        .parse::<u64>()
        .map_err(|_| QQMusicError::InvalidRequest)
}

fn validate_next_provider_cursor(
    current_offset: u64,
    next_cursor: Option<&str>,
) -> Result<(), QQMusicError> {
    if let Some(next) = next_cursor {
        let next = provider_offset(next).map_err(|_| QQMusicError::SchemaChanged)?;
        if next <= current_offset {
            return Err(QQMusicError::SchemaChanged);
        }
    }
    Ok(())
}

fn provider_playlist_id(value: &str) -> Result<&str, QQMusicError> {
    let value = value.strip_prefix("qqmusic:playlist:").unwrap_or(value);
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(QQMusicError::InvalidRequest);
    }
    Ok(value)
}

fn provider_track_id(value: &str) -> Result<&str, QQMusicError> {
    let value = value.strip_prefix("qqmusic:track:").unwrap_or(value);
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(QQMusicError::InvalidRequest);
    }
    Ok(value)
}

fn validate_favorite_request(request: &FavoriteMutationRequest) -> Result<(), QQMusicError> {
    provider_track_id(&request.track_id)?;
    if !(8..=128).contains(&request.client_operation_id.len())
        || !request
            .client_operation_id
            .bytes()
            .all(|byte| byte.is_ascii_graphic())
    {
        return Err(QQMusicError::InvalidRequest);
    }
    Ok(())
}

fn favorite_write_accepted(body: &[u8]) -> Result<bool, QQMusicError> {
    let value: Value = serde_json::from_slice(body).map_err(|_| QQMusicError::MalformedResponse)?;
    ensure_cgi_response_success(&value)?;
    let return_code = value
        .pointer("/req/data/retCode")
        .or_else(|| value.pointer("/data/retCode"))
        .and_then(Value::as_i64)
        .ok_or(QQMusicError::SchemaChanged)?;
    Ok(return_code == 0)
}

fn ensure_cgi_response_success(value: &Value) -> Result<(), QQMusicError> {
    for code in [
        value.get("code").and_then(Value::as_i64),
        value.pointer("/req/code").and_then(Value::as_i64),
    ]
    .into_iter()
    .flatten()
    {
        match code {
            0 => {}
            1000 | 104_400 | 104_401 => return Err(QQMusicError::AuthenticationExpired),
            2001 => return Err(QQMusicError::RateLimited),
            _ => return Err(QQMusicError::Protocol),
        }
    }
    Ok(())
}

fn cache_put<T: Serialize>(
    key: &str,
    value: &T,
    expires_at_ms: u64,
) -> Result<ProviderCacheMutation, QQMusicError> {
    let value_json = serde_json::to_string(value).map_err(|_| QQMusicError::Storage)?;
    Ok(ProviderCacheMutation::Put {
        key: key.to_owned(),
        kind: ACCOUNT_CACHE_KIND.to_owned(),
        value_json,
        expires_at_ms,
    })
}

fn page_from_cached<T>(cached: CachedAccountPage<T>, auth_revision: u64, stale: bool) -> Page<T> {
    Page {
        items: cached.items,
        next_cursor: None,
        total: cached.total,
        fetched_at_ms: cached.fetched_at_ms,
        stale,
        auth_revision,
    }
}

fn detail_from_cached(
    cached: CachedPlaylistDetailPage,
    auth_revision: u64,
    stale: bool,
) -> AccountPlaylistDetail {
    AccountPlaylistDetail {
        summary: cached.summary,
        tracks: Page {
            items: cached.items,
            next_cursor: None,
            total: cached.total,
            fetched_at_ms: cached.fetched_at_ms,
            stale,
            auth_revision,
        },
    }
}

fn stale_eligible(error: &QQMusicError) -> bool {
    matches!(
        error,
        QQMusicError::Offline | QQMusicError::Timeout | QQMusicError::RateLimited
    )
}

pub(crate) struct NormalizedProviderPage<T> {
    pub(crate) items: Vec<T>,
    pub(crate) next_provider_cursor: Option<String>,
    pub(crate) total: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PlaylistEditSafetyError {
    SchemaChanged,
    TaggedRenameUnverified,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawOwnedPlaylistEditFields {
    #[serde(default, rename = "dirId")]
    provider_dir_id: Option<u64>,
    #[serde(default, rename = "dirName")]
    original_title: Option<String>,
    #[serde(default, rename = "desc")]
    description: Option<String>,
    #[serde(default, rename = "picUrl")]
    picture_url: Option<String>,
    #[serde(default, rename = "tagNameList")]
    tag_names: Option<Vec<String>>,
}

pub(crate) struct ProviderOwnedPlaylistEditSnapshot {
    pub(crate) provider_dir_id: u64,
    pub(crate) original_title: String,
    pub(crate) description: String,
    pub(crate) picture_url: String,
    pub(crate) tag_names: Vec<String>,
}

pub(crate) fn parse_owned_playlist_edit_snapshot(
    raw: &str,
) -> Result<ProviderOwnedPlaylistEditSnapshot, PlaylistEditSafetyError> {
    let value: Value =
        serde_json::from_str(raw).map_err(|_| PlaylistEditSafetyError::SchemaChanged)?;
    let value = playlist_value(&value).ok_or(PlaylistEditSafetyError::SchemaChanged)?;
    parse_owned_playlist_edit_value(value)
}

fn parse_owned_playlist_edit_value(
    value: &Value,
) -> Result<ProviderOwnedPlaylistEditSnapshot, PlaylistEditSafetyError> {
    let fields: RawOwnedPlaylistEditFields = serde_json::from_value(value.clone())
        .map_err(|_| PlaylistEditSafetyError::SchemaChanged)?;
    let snapshot = ProviderOwnedPlaylistEditSnapshot {
        provider_dir_id: fields
            .provider_dir_id
            .ok_or(PlaylistEditSafetyError::SchemaChanged)?,
        original_title: fields
            .original_title
            .ok_or(PlaylistEditSafetyError::SchemaChanged)?,
        description: fields
            .description
            .ok_or(PlaylistEditSafetyError::SchemaChanged)?,
        picture_url: fields
            .picture_url
            .ok_or(PlaylistEditSafetyError::SchemaChanged)?,
        tag_names: fields
            .tag_names
            .ok_or(PlaylistEditSafetyError::SchemaChanged)?,
    };
    if snapshot.tag_names.is_empty() {
        Ok(snapshot)
    } else {
        Err(PlaylistEditSafetyError::TaggedRenameUnverified)
    }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPlaylistCreator {
    #[serde(default, alias = "nickname")]
    nick: String,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPlaylistCapabilities {
    #[serde(default)]
    can_add: bool,
    #[serde(default)]
    can_remove: bool,
    #[serde(default)]
    can_rename: bool,
    #[serde(default)]
    can_delete: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAccountPlaylist {
    #[serde(default, rename = "tid", alias = "disstid", alias = "id")]
    id: Option<Value>,
    #[serde(default, rename = "dirName", alias = "dissname", alias = "title")]
    title: Option<String>,
    #[serde(default, rename = "desc", alias = "description")]
    description: Option<String>,
    #[serde(default, rename = "picUrl", alias = "logo")]
    picture_url: Option<String>,
    #[serde(
        default,
        rename = "trackCount",
        alias = "songnum",
        alias = "song_count"
    )]
    track_count: u64,
    #[serde(default, rename = "updateTime", alias = "mtime")]
    updated_at_ms: Option<u64>,
    #[serde(default)]
    ownership: Option<String>,
    #[serde(default, rename = "isOwner")]
    is_owner: Option<bool>,
    #[serde(default)]
    creator: RawPlaylistCreator,
    #[serde(default)]
    capabilities: RawPlaylistCapabilities,
}

fn normalize_playlist_value(value: &Value) -> Result<AccountPlaylistSummary, QQMusicError> {
    let raw: RawAccountPlaylist =
        serde_json::from_value(value.clone()).map_err(|_| QQMusicError::SchemaChanged)?;
    let provider_id = raw
        .id
        .as_ref()
        .and_then(value_string)
        .filter(|id| !id.trim().is_empty())
        .ok_or(QQMusicError::SchemaChanged)?;
    let title = raw
        .title
        .filter(|title| !title.trim().is_empty())
        .ok_or(QQMusicError::SchemaChanged)?;
    let ownership = if raw
        .ownership
        .as_deref()
        .is_some_and(|ownership| ownership.eq_ignore_ascii_case("owned"))
        || raw.is_owner == Some(true)
    {
        PlaylistOwnership::Owned
    } else {
        PlaylistOwnership::Collected
    };
    let capabilities = if ownership == PlaylistOwnership::Owned {
        PlaylistCapabilities {
            can_add_tracks: raw.capabilities.can_add,
            can_remove_tracks: raw.capabilities.can_remove,
            can_rename: raw.capabilities.can_rename
                && parse_owned_playlist_edit_value(value).is_ok(),
            can_delete: raw.capabilities.can_delete,
            can_reorder: false,
        }
    } else {
        PlaylistCapabilities::read_only()
    };
    let artwork_src = raw
        .picture_url
        .as_deref()
        .map(upgrade_https)
        .filter(|url| is_allowed_artwork_url(url))
        .unwrap_or_default();
    let stable_id = playlist_id(&provider_id);
    Ok(AccountPlaylistSummary {
        id: stable_id.clone(),
        title: title.clone(),
        description: raw.description.unwrap_or_default(),
        owner: PlaylistOwner {
            id: format!("qqmusic:owner:{}", stable_component(&stable_id)),
            display_name: if raw.creator.nick.trim().is_empty() {
                "QQ Music".to_owned()
            } else {
                raw.creator.nick.trim().to_owned()
            },
        },
        artwork: Artwork {
            src: artwork_src,
            alt: format!("{title} cover"),
            dominant_color: color_for(&stable_id),
        },
        ownership,
        capabilities,
        track_count: raw.track_count,
        updated_at_ms: raw.updated_at_ms,
    })
}

fn value_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn response_data(value: &Value) -> Result<&Value, QQMusicError> {
    ensure_cgi_response_success(value)?;
    value
        .pointer("/req/data")
        .or_else(|| value.get("data"))
        .ok_or(QQMusicError::SchemaChanged)
}

fn playlist_value(value: &Value) -> Option<&Value> {
    if value.get("dirId").is_some() || value.get("tid").is_some() {
        return Some(value);
    }
    let data = response_data(value).ok()?;
    data.get("dirinfo")
        .or_else(|| data.pointer("/v_playlist/0"))
        .or_else(|| data.pointer("/playlist/0"))
}

fn page_numbers(data: &Value, fallback_offset: u64) -> (u64, Option<u64>) {
    let offset = ["song_begin", "begin", "sin", "offset"]
        .into_iter()
        .find_map(|key| data.get(key).and_then(Value::as_u64))
        .unwrap_or(fallback_offset);
    let total = ["total_song_num", "total", "totalnum", "totalNum"]
        .into_iter()
        .find_map(|key| data.get(key).and_then(Value::as_u64));
    (offset, total)
}

fn next_provider_cursor(offset: u64, count: usize, total: Option<u64>) -> Option<String> {
    let next = offset.saturating_add(count as u64);
    match total {
        Some(total) if next < total => Some(next.to_string()),
        None if count > 0 => Some(next.to_string()),
        _ => None,
    }
}

pub(crate) fn normalize_favorite_response(
    body: &[u8],
    fallback_offset: u64,
) -> Result<NormalizedProviderPage<Song>, QQMusicError> {
    let value: Value = serde_json::from_slice(body).map_err(|_| QQMusicError::MalformedResponse)?;
    let data = response_data(&value)?;
    let songs = data
        .get("songlist")
        .or_else(|| data.pointer("/cdlist/0/songlist"))
        .or_else(|| data.get("tracks"))
        .cloned()
        .ok_or(QQMusicError::SchemaChanged)?;
    let songs: Vec<OldSongDto> =
        serde_json::from_value(songs).map_err(|_| QQMusicError::SchemaChanged)?;
    let mut items = songs
        .into_iter()
        .enumerate()
        .filter_map(|(index, song)| normalize_old_song(song, index as u32 + 1))
        .collect::<Vec<_>>();
    for song in &mut items {
        song.is_favorite = true;
    }
    let (offset, total) = page_numbers(data, fallback_offset);
    Ok(NormalizedProviderPage {
        next_provider_cursor: next_provider_cursor(offset, items.len(), total),
        items,
        total,
    })
}

pub(crate) fn normalize_playlist_page_response(
    body: &[u8],
    fallback_offset: u64,
) -> Result<NormalizedProviderPage<AccountPlaylistSummary>, QQMusicError> {
    let value: Value = serde_json::from_slice(body).map_err(|_| QQMusicError::MalformedResponse)?;
    let data = response_data(&value)?;
    let list = data
        .get("v_playlist")
        .or_else(|| data.get("playlist"))
        .and_then(Value::as_array)
        .ok_or(QQMusicError::SchemaChanged)?;
    let items = list
        .iter()
        .map(normalize_playlist_value)
        .collect::<Result<Vec<_>, _>>()?;
    let (offset, total) = page_numbers(data, fallback_offset);
    Ok(NormalizedProviderPage {
        next_provider_cursor: next_provider_cursor(offset, items.len(), total),
        items,
        total,
    })
}

pub(crate) fn normalize_playlist_detail_response(
    body: &[u8],
    fallback_offset: u64,
) -> Result<(AccountPlaylistSummary, NormalizedProviderPage<Song>), QQMusicError> {
    let value: Value = serde_json::from_slice(body).map_err(|_| QQMusicError::MalformedResponse)?;
    let data = response_data(&value)?;
    let summary = data
        .get("dirinfo")
        .or_else(|| data.pointer("/cdlist/0"))
        .map(normalize_playlist_value)
        .transpose()?
        .ok_or(QQMusicError::SchemaChanged)?;
    let songs = data
        .get("songlist")
        .or_else(|| data.pointer("/cdlist/0/songlist"))
        .cloned()
        .ok_or(QQMusicError::SchemaChanged)?;
    let songs: Vec<OldSongDto> =
        serde_json::from_value(songs).map_err(|_| QQMusicError::SchemaChanged)?;
    let items = songs
        .into_iter()
        .enumerate()
        .filter_map(|(index, song)| normalize_old_song(song, index as u32 + 1))
        .collect::<Vec<_>>();
    let (offset, total) = page_numbers(data, fallback_offset);
    Ok((
        summary,
        NormalizedProviderPage {
            next_provider_cursor: next_provider_cursor(offset, items.len(), total),
            items,
            total,
        },
    ))
}

pub(crate) fn normalize_recent_response(
    body: &[u8],
    fallback_offset: u64,
) -> Result<NormalizedProviderPage<RemotePlayHistoryItem>, QQMusicError> {
    let value: Value = serde_json::from_slice(body).map_err(|_| QQMusicError::MalformedResponse)?;
    let data = response_data(&value)?;
    let list = data
        .get("songlist")
        .or_else(|| data.get("tracks"))
        .and_then(Value::as_array)
        .ok_or(QQMusicError::SchemaChanged)?;
    let mut items = Vec::with_capacity(list.len());
    for (index, item) in list.iter().enumerate() {
        let song_value = item.get("song").unwrap_or(item).clone();
        let song: OldSongDto =
            serde_json::from_value(song_value).map_err(|_| QQMusicError::SchemaChanged)?;
        if let Some(song) = normalize_old_song(song, index as u32 + 1) {
            items.push(RemotePlayHistoryItem {
                song,
                played_at_ms: item
                    .get("playedAtMs")
                    .or_else(|| item.get("playtime"))
                    .and_then(Value::as_u64),
                source: RemotePlayHistorySource::QqmusicAccount,
            });
        }
    }
    let (offset, total) = page_numbers(data, fallback_offset);
    Ok(NormalizedProviderPage {
        next_provider_cursor: next_provider_cursor(offset, items.len(), total),
        items,
        total,
    })
}

#[cfg(test)]
fn normalize_favorite_fixture(raw: &str) -> Result<Page<Song>, QQMusicError> {
    let page = normalize_favorite_response(raw.as_bytes(), 0)?;
    Ok(Page {
        items: page.items,
        next_cursor: page
            .next_provider_cursor
            .map(|cursor| format!("cursor:{cursor}")),
        total: page.total,
        fetched_at_ms: 0,
        stale: false,
        auth_revision: 0,
    })
}

#[cfg(test)]
fn normalize_playlist_fixture(raw: &str) -> Result<AccountPlaylistSummary, QQMusicError> {
    let value: Value = serde_json::from_str(raw).map_err(|_| QQMusicError::MalformedResponse)?;
    normalize_playlist_value(playlist_value(&value).ok_or(QQMusicError::SchemaChanged)?)
}

#[cfg(test)]
fn normalize_recent_fixture(raw: &str) -> Result<Page<RemotePlayHistoryItem>, QQMusicError> {
    let page = normalize_recent_response(raw.as_bytes(), 0)?;
    Ok(Page {
        items: page.items,
        next_cursor: page
            .next_provider_cursor
            .map(|cursor| format!("cursor:{cursor}")),
        total: page.total,
        fetched_at_ms: 0,
        stale: false,
        auth_revision: 0,
    })
}

#[cfg(test)]
fn owned_playlist_fixture_missing_tag_field() -> String {
    serde_json::json!({
        "tid": "SANITIZED_PLAYLIST_MISSING_TAG",
        "dirId": 3101,
        "dirName": "Synthetic Missing Tag Metadata",
        "desc": "",
        "picUrl": "",
        "ownership": "owned",
        "creator": { "nick": "Synthetic Listener" },
        "capabilities": { "canAdd": true, "canRemove": true, "canRename": true, "canDelete": true }
    })
    .to_string()
}

#[cfg(test)]
fn owned_playlist_fixture_with_tags() -> String {
    serde_json::json!({
        "tid": "SANITIZED_PLAYLIST_TAGGED",
        "dirId": 3102,
        "dirName": "Synthetic Tagged Playlist",
        "desc": "",
        "picUrl": "",
        "tagNameList": ["Synthetic Tag"],
        "ownership": "owned",
        "creator": { "nick": "Synthetic Listener" },
        "capabilities": { "canAdd": true, "canRemove": true, "canRename": true, "canDelete": true }
    })
    .to_string()
}

#[cfg(test)]
fn owned_playlist_fixture_with_present_empty_tag_names() -> String {
    serde_json::json!({
        "tid": "SANITIZED_PLAYLIST_UNTAGGED",
        "dirId": 3103,
        "dirName": "Synthetic Untagged Playlist",
        "desc": "",
        "picUrl": "",
        "tagNameList": [],
        "ownership": "owned",
        "creator": { "nick": "Synthetic Listener" },
        "capabilities": { "canAdd": true, "canRemove": true, "canRename": true, "canDelete": true }
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::super::{
        auth::{AuthChallenge, AuthPollResult, QQMusicAuthProtocol, ValidatedAccount},
        cache::OpaqueAccountScope,
        clock::ManualClock,
    };
    use super::*;
    use crate::credentials::{
        CredentialStore, MemoryCredentialStore, SpawnBlockingCredentialStore,
    };
    use async_trait::async_trait;
    use std::{
        collections::VecDeque,
        sync::atomic::{AtomicUsize, Ordering},
    };
    use tokio_util::sync::CancellationToken;

    struct StaticAuthProtocol;

    #[async_trait]
    impl QQMusicAuthProtocol for StaticAuthProtocol {
        async fn create_challenge(
            &self,
            _cancellation: CancellationToken,
        ) -> Result<AuthChallenge, QQMusicError> {
            Err(QQMusicError::Protocol)
        }

        async fn poll_challenge(
            &self,
            _challenge: &AuthChallenge,
            _cancellation: CancellationToken,
        ) -> Result<AuthPollResult, QQMusicError> {
            Err(QQMusicError::Protocol)
        }

        async fn validate_session(
            &self,
            _session: &SessionRecord,
            _cancellation: CancellationToken,
        ) -> Result<ValidatedAccount, QQMusicError> {
            Ok(validated_account())
        }
    }

    enum TestReply {
        Body(Vec<u8>),
        Error(QQMusicError),
    }

    struct QueueTransport {
        replies: Mutex<VecDeque<TestReply>>,
        calls: AtomicUsize,
        operations: Mutex<Vec<&'static str>>,
        requests: Mutex<Vec<(&'static str, Vec<u8>)>>,
    }

    impl QueueTransport {
        fn new(replies: impl IntoIterator<Item = TestReply>) -> Self {
            Self {
                replies: Mutex::new(replies.into_iter().collect()),
                calls: AtomicUsize::new(0),
                operations: Mutex::new(Vec::new()),
                requests: Mutex::new(Vec::new()),
            }
        }

        async fn push(&self, reply: TestReply) {
            self.replies.lock().await.push_back(reply);
        }

        fn call_count(&self) -> usize {
            self.calls.load(Ordering::Acquire)
        }

        async fn operation_count(&self, operation: &str) -> usize {
            self.operations
                .lock()
                .await
                .iter()
                .filter(|candidate| **candidate == operation)
                .count()
        }

        async fn request_body(&self, operation: &str) -> Option<Vec<u8>> {
            self.requests
                .lock()
                .await
                .iter()
                .find(|(candidate, _)| *candidate == operation)
                .map(|(_, body)| body.clone())
        }
    }

    #[async_trait]
    impl QqTransport for QueueTransport {
        async fn execute(
            &self,
            request: TransportRequest,
        ) -> Result<TransportResponse, QQMusicError> {
            self.calls.fetch_add(1, Ordering::AcqRel);
            self.operations.lock().await.push(request.operation);
            if let Some(body) = request.body.as_ref() {
                self.requests
                    .lock()
                    .await
                    .push((request.operation, body.clone()));
            }
            match self
                .replies
                .lock()
                .await
                .pop_front()
                .unwrap_or(TestReply::Error(QQMusicError::Protocol))
            {
                TestReply::Body(body) => Ok(TransportResponse {
                    status: StatusCode::OK,
                    final_url: Url::parse(QQ_MUSICU_URL).expect("fixture URL"),
                    headers: HeaderMap::new(),
                    body,
                }),
                TestReply::Error(error) => Err(error),
            }
        }
    }

    struct AccountServiceFixture {
        service: Arc<QQMusicAccountService>,
        auth: Arc<QQMusicAuthService>,
        transport: Arc<QueueTransport>,
        storage: Arc<StorageService>,
        clock: Arc<ManualClock>,
        credentials: Arc<MemoryCredentialStore>,
        session: SessionRecord,
    }

    impl AccountServiceFixture {
        async fn authenticated(replies: impl IntoIterator<Item = TestReply>) -> Self {
            let storage = Arc::new(StorageService::temporary());
            let clock = Arc::new(ManualClock::new(10_000));
            let credentials = Arc::new(MemoryCredentialStore::default());
            let session = synthetic_session('a');
            let auth = build_auth(
                Arc::clone(&storage),
                Arc::clone(&clock),
                Arc::clone(&credentials),
            );
            auth.complete_confirmation(session.clone())
                .await
                .expect("authenticate fixture");
            let transport = Arc::new(QueueTransport::new(replies));
            let service = Arc::new(QQMusicAccountService::new(
                Arc::clone(&transport) as Arc<dyn QqTransport>,
                Arc::clone(&clock) as Arc<dyn Clock>,
                Arc::clone(&storage),
                Arc::clone(&auth),
            ));
            {
                let mut references = service.track_references.lock().await;
                references.remember("qqmusic:track:SANITIZED_TRACK_A".to_owned(), 1001);
                references.remember("qqmusic:track:SANITIZED_TRACK_B".to_owned(), 1002);
                references.remember("qqmusic:track:SANITIZED_TRACK_C".to_owned(), 1003);
            }
            Self {
                service,
                auth,
                transport,
                storage,
                clock,
                credentials,
                session,
            }
        }

        async fn restarted(&self, replies: impl IntoIterator<Item = TestReply>) -> Self {
            let auth = build_auth(
                Arc::clone(&self.storage),
                Arc::clone(&self.clock),
                Arc::clone(&self.credentials),
            );
            auth.restore().await.expect("restore fixture session");
            let transport = Arc::new(QueueTransport::new(replies));
            let service = Arc::new(QQMusicAccountService::new(
                Arc::clone(&transport) as Arc<dyn QqTransport>,
                Arc::clone(&self.clock) as Arc<dyn Clock>,
                Arc::clone(&self.storage),
                Arc::clone(&auth),
            ));
            {
                let mut references = service.track_references.lock().await;
                references.remember("qqmusic:track:SANITIZED_TRACK_A".to_owned(), 1001);
                references.remember("qqmusic:track:SANITIZED_TRACK_B".to_owned(), 1002);
                references.remember("qqmusic:track:SANITIZED_TRACK_C".to_owned(), 1003);
            }
            Self {
                service,
                auth,
                transport,
                storage: Arc::clone(&self.storage),
                clock: Arc::clone(&self.clock),
                credentials: Arc::clone(&self.credentials),
                session: self.session.clone(),
            }
        }
    }

    fn build_auth(
        storage: Arc<StorageService>,
        clock: Arc<ManualClock>,
        credentials: Arc<MemoryCredentialStore>,
    ) -> Arc<QQMusicAuthService> {
        Arc::new(QQMusicAuthService::new(
            Arc::new(StaticAuthProtocol),
            SpawnBlockingCredentialStore::new(credentials as Arc<dyn CredentialStore>),
            clock as Arc<dyn Clock>,
            storage,
        ))
    }

    fn synthetic_session(scope_character: char) -> SessionRecord {
        SessionRecord {
            version: 1,
            uin: "1000000001".to_owned(),
            cookie_header: "synthetic_session=redacted".to_owned(),
            expires_at_ms: 1_800_000_000_000,
            account_cache_scope: OpaqueAccountScope::parse(scope_character.to_string().repeat(32))
                .expect("valid scope"),
        }
    }

    fn validated_account() -> ValidatedAccount {
        ValidatedAccount {
            profile: AccountProfile {
                avatar_url: Some("https://qpic.y.qq.com/synthetic-avatar.png".to_owned()),
                nickname: "Synthetic Listener".to_owned(),
                masked_identity: "10******01".to_owned(),
            },
            entitlement: AccountEntitlement {
                tier: EntitlementTier::MusicVip,
                membership: MembershipState::Active,
                expires_at_ms: Some(1_800_000_000_000),
                permitted_qualities: vec![AudioQuality::Standard, AudioQuality::High],
                observed_maximum_quality: Some(AudioQuality::High),
                restrictions: Vec::new(),
            },
        }
    }

    fn body(raw: &str) -> TestReply {
        TestReply::Body(raw.as_bytes().to_vec())
    }

    fn terminal_favorites_body() -> TestReply {
        let mut value: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/qqmusic/account/favorites-page-2.json"
        ))
        .expect("terminal favorite fixture");
        value["req"]["data"]["song_begin"] = json!(0);
        value["req"]["data"]["total_song_num"] = json!(1);
        TestReply::Body(serde_json::to_vec(&value).expect("fixture serializes"))
    }

    fn authenticated_snapshot() -> AccountSnapshot {
        AccountSnapshot {
            account: AccountState::Authenticated {
                profile: AccountProfile {
                    avatar_url: Some("https://qpic.y.qq.com/sanitized-avatar".to_owned()),
                    nickname: "Synthetic Listener".to_owned(),
                    masked_identity: "10******01".to_owned(),
                },
                entitlement: AccountEntitlement {
                    tier: EntitlementTier::MusicVip,
                    membership: MembershipState::Active,
                    expires_at_ms: Some(1_800_000_000_000),
                    permitted_qualities: vec![AudioQuality::Standard, AudioQuality::High],
                    observed_maximum_quality: Some(AudioQuality::High),
                    restrictions: Vec::new(),
                },
            },
            revision: 7,
            capabilities: AccountCapabilities {
                qr_login: true,
                favorite_read: true,
                favorite_write: true,
                playlist_read: true,
                playlist_write: true,
                recent_history_read: true,
            },
        }
    }

    #[test]
    fn account_snapshot_serialization_has_no_secret_fields() {
        let json = serde_json::to_string(&authenticated_snapshot()).expect("snapshot serializes");
        for forbidden in [
            "cookie",
            "qm_keyst",
            "qrsig",
            "ptqrtoken",
            "authorization",
            "callback",
        ] {
            assert!(!json.to_ascii_lowercase().contains(forbidden));
        }
        assert!(json.contains("maskedIdentity"));
        assert!(json.contains("observedMaximumQuality"));
    }

    #[test]
    fn null_only_account_states_cannot_carry_a_profile() {
        let value = serde_json::to_value(AccountSnapshot {
            account: AccountState::Guest {
                profile: (),
                entitlement: (),
            },
            revision: 1,
            capabilities: AccountCapabilities {
                qr_login: true,
                favorite_read: false,
                favorite_write: false,
                playlist_read: false,
                playlist_write: false,
                recent_history_read: false,
            },
        })
        .expect("guest snapshot serializes");

        assert_eq!(value["state"], "guest");
        assert!(value["profile"].is_null());
        assert!(value["entitlement"].is_null());
        assert_eq!(value["capabilities"]["qrLogin"], true);
    }

    #[test]
    fn provider_error_codes_serialize_to_the_exact_frontend_set() {
        let expected = [
            (ProviderErrorCode::Offline, "offline"),
            (ProviderErrorCode::Timeout, "timeout"),
            (
                ProviderErrorCode::AuthenticationExpired,
                "authentication-expired",
            ),
            (
                ProviderErrorCode::AuthorizationRejected,
                "authorization-rejected",
            ),
            (
                ProviderErrorCode::EntitlementUnavailable,
                "entitlement-unavailable",
            ),
            (ProviderErrorCode::RateLimited, "rate-limited"),
            (ProviderErrorCode::SchemaChanged, "schema-changed"),
            (ProviderErrorCode::SongUnavailable, "song-unavailable"),
            (ProviderErrorCode::MalformedResponse, "malformed-response"),
            (ProviderErrorCode::ProviderFailure, "provider-failure"),
            (ProviderErrorCode::Cancelled, "cancelled"),
            (ProviderErrorCode::NotFound, "not-found"),
            (ProviderErrorCode::InvalidRequest, "invalid-request"),
            (
                ProviderErrorCode::UnsupportedOperation,
                "unsupported-operation",
            ),
            (
                ProviderErrorCode::MutationInProgress,
                "mutation-in-progress",
            ),
            (ProviderErrorCode::StorageFailure, "storage-failure"),
        ];
        for (code, spelling) in expected {
            assert_eq!(code.as_str(), spelling);
            assert_eq!(
                serde_json::to_string(&code).expect("code serializes"),
                format!("\"{spelling}\"")
            );
        }
    }

    #[test]
    fn favorite_pages_normalize_distinct_provider_cursors_and_total() {
        let first = normalize_favorite_fixture(include_str!(
            "../../tests/fixtures/qqmusic/account/favorites-page-1.json"
        ))
        .expect("page one");
        let second = normalize_favorite_fixture(include_str!(
            "../../tests/fixtures/qqmusic/account/favorites-page-2.json"
        ))
        .expect("page two");
        assert_eq!(first.items.len(), 2);
        assert_eq!(first.next_cursor.as_deref(), Some("cursor:2"));
        assert_eq!(second.next_cursor, None);
        assert_eq!(first.total, Some(3));
        assert!(first.items.iter().all(|song| song.is_favorite));
    }

    #[test]
    fn collected_playlist_has_no_owner_mutation_capabilities() {
        let playlist = normalize_playlist_fixture(include_str!(
            "../../tests/fixtures/qqmusic/account/playlist-collected.json"
        ))
        .expect("playlist");
        assert_eq!(playlist.ownership, PlaylistOwnership::Collected);
        assert_eq!(playlist.capabilities, PlaylistCapabilities::read_only());
    }

    #[test]
    fn owned_playlist_without_lossless_edit_metadata_disables_only_rename() {
        for (raw, expected) in [
            (
                owned_playlist_fixture_missing_tag_field(),
                PlaylistEditSafetyError::SchemaChanged,
            ),
            (
                owned_playlist_fixture_with_tags(),
                PlaylistEditSafetyError::TaggedRenameUnverified,
            ),
        ] {
            let playlist = normalize_playlist_fixture(&raw).expect("playlist remains readable");
            assert_eq!(playlist.ownership, PlaylistOwnership::Owned);
            assert!(!playlist.capabilities.can_rename);
            assert!(playlist.capabilities.can_delete);
            assert!(
                matches!(parse_owned_playlist_edit_snapshot(&raw), Err(error) if error == expected)
            );
        }
    }

    #[test]
    fn owned_untagged_playlist_preserves_present_empty_tag_names_losslessly() {
        let raw = owned_playlist_fixture_with_present_empty_tag_names();
        let playlist = normalize_playlist_fixture(&raw).expect("playlist");
        let edit = parse_owned_playlist_edit_snapshot(&raw).expect("complete empty tags");
        assert!(playlist.capabilities.can_rename);
        assert!(edit.tag_names.is_empty());
        assert_eq!(edit.description, "");
        assert_eq!(edit.picture_url, "");
    }

    #[test]
    fn recent_history_normalizes_synthetic_items_without_raw_account_fields() {
        let page = normalize_recent_fixture(include_str!(
            "../../tests/fixtures/qqmusic/account/recent-history.json"
        ))
        .expect("recent history");
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.items[0].song.id, "qqmusic:track:SANITIZED_TRACK_B");
        assert_eq!(
            page.items[0].source,
            RemotePlayHistorySource::QqmusicAccount
        );
        let json = serde_json::to_string(&page).expect("page serializes");
        assert!(!json.contains("1000000001"));
        assert!(!json.to_ascii_lowercase().contains("cookie"));
    }

    #[tokio::test]
    async fn two_page_favorites_commit_one_complete_projection_and_opaque_cursors() {
        let fixture = AccountServiceFixture::authenticated([
            body(include_str!(
                "../../tests/fixtures/qqmusic/account/favorites-page-1.json"
            )),
            body(include_str!(
                "../../tests/fixtures/qqmusic/account/favorites-page-2.json"
            )),
        ])
        .await;

        let first = fixture
            .service
            .favorite_songs(None, 500)
            .await
            .expect("first page");
        let cursor = first.next_cursor.clone().expect("opaque next cursor");
        assert!(cursor.starts_with("cursor:"));
        assert_eq!(cursor.len(), "cursor:".len() + 32);
        assert_ne!(cursor, "cursor:2");
        assert_eq!(first.items.len(), 2);
        assert!(fixture
            .storage
            .get_json::<AccountLibraryProjection>(
                &AccountCache::projection_key(&fixture.session.account_cache_scope),
                true,
            )
            .expect("projection lookup")
            .is_none());

        let second = fixture
            .service
            .favorite_songs(Some(cursor), 500)
            .await
            .expect("second page");
        assert_eq!(second.items.len(), 1);
        assert!(second.next_cursor.is_none());
        let projection = fixture
            .storage
            .get_json::<AccountLibraryProjection>(
                &AccountCache::projection_key(&fixture.session.account_cache_scope),
                true,
            )
            .expect("projection lookup")
            .expect("terminal projection");
        assert_eq!(projection.favorite_ids.len(), 3);
        assert_eq!(fixture.transport.call_count(), 2);
    }

    #[tokio::test]
    async fn offline_fallback_is_explicitly_stale_but_auth_expiry_is_not() {
        let fixture = AccountServiceFixture::authenticated([
            body(include_str!(
                "../../tests/fixtures/qqmusic/account/favorites-page-1.json"
            )),
            body(include_str!(
                "../../tests/fixtures/qqmusic/account/favorites-page-2.json"
            )),
        ])
        .await;
        let first = fixture
            .service
            .favorite_songs(None, 50)
            .await
            .expect("first page");
        fixture
            .service
            .favorite_songs(first.next_cursor, 50)
            .await
            .expect("terminal page");
        fixture.clock.advance(FAVORITES_TTL_MS + 1);

        fixture
            .transport
            .push(TestReply::Error(QQMusicError::Offline))
            .await;
        let stale = fixture
            .service
            .favorite_songs(None, 50)
            .await
            .expect("stale page");
        assert!(stale.stale);
        assert_eq!(stale.items.len(), 2);
        assert!(stale.next_cursor.is_none());

        fixture
            .transport
            .push(TestReply::Error(QQMusicError::AuthenticationExpired))
            .await;
        assert!(matches!(
            fixture.service.favorite_songs(None, 50).await,
            Err(QQMusicError::AuthenticationExpired)
        ));
    }

    #[tokio::test]
    async fn interrupted_refresh_preserves_then_terminal_refresh_replaces_projection() {
        let fixture = AccountServiceFixture::authenticated([
            body(include_str!(
                "../../tests/fixtures/qqmusic/account/favorites-page-1.json"
            )),
            body(include_str!(
                "../../tests/fixtures/qqmusic/account/favorites-page-2.json"
            )),
        ])
        .await;
        let first = fixture.service.favorite_songs(None, 50).await.unwrap();
        fixture
            .service
            .favorite_songs(first.next_cursor, 50)
            .await
            .unwrap();
        let projection_key = AccountCache::projection_key(&fixture.session.account_cache_scope);

        fixture
            .transport
            .push(body(include_str!(
                "../../tests/fixtures/qqmusic/account/favorites-page-1.json"
            )))
            .await;
        fixture.service.favorite_songs(None, 50).await.unwrap();
        let interrupted = fixture
            .storage
            .get_json::<AccountLibraryProjection>(&projection_key, true)
            .unwrap()
            .unwrap();
        assert_eq!(interrupted.favorite_ids.len(), 3);

        fixture.transport.push(terminal_favorites_body()).await;
        fixture.service.favorite_songs(None, 50).await.unwrap();
        let replaced = fixture
            .storage
            .get_json::<AccountLibraryProjection>(&projection_key, true)
            .unwrap()
            .unwrap();
        assert_eq!(replaced.favorite_ids.len(), 1);
        assert_eq!(replaced.favorite_ids[0], "qqmusic:track:SANITIZED_TRACK_C");
    }

    #[tokio::test]
    async fn restart_refetches_nonterminal_cache_before_issuing_a_live_cursor() {
        let first_runtime = AccountServiceFixture::authenticated([
            body(include_str!(
                "../../tests/fixtures/qqmusic/account/favorites-page-1.json"
            )),
            body(include_str!(
                "../../tests/fixtures/qqmusic/account/favorites-page-2.json"
            )),
        ])
        .await;
        let first_page = first_runtime
            .service
            .favorite_songs(None, 50)
            .await
            .expect("first runtime page one");
        let first_cursor = first_page.next_cursor.expect("first runtime cursor");
        first_runtime
            .service
            .favorite_songs(Some(first_cursor.clone()), 50)
            .await
            .expect("first runtime page two");

        let second_runtime = first_runtime
            .restarted([
                body(include_str!(
                    "../../tests/fixtures/qqmusic/account/favorites-page-1.json"
                )),
                body(include_str!(
                    "../../tests/fixtures/qqmusic/account/favorites-page-2.json"
                )),
            ])
            .await;
        let restored_first = second_runtime
            .service
            .favorite_songs(None, 50)
            .await
            .expect("restored first page is refetched");
        let restored_cursor = restored_first.next_cursor.expect("new live cursor");
        assert_ne!(restored_cursor, first_cursor);
        let restored_second = second_runtime
            .service
            .favorite_songs(Some(restored_cursor), 50)
            .await
            .expect("new cursor reaches page two");
        assert!(restored_second.next_cursor.is_none());
        assert_eq!(second_runtime.transport.call_count(), 2);

        let offline_runtime = second_runtime
            .restarted([TestReply::Error(QQMusicError::Offline)])
            .await;
        let offline = offline_runtime
            .service
            .favorite_songs(None, 50)
            .await
            .expect("offline cached first page");
        assert!(offline.stale);
        assert!(offline.next_cursor.is_none());
    }

    #[tokio::test]
    async fn unknown_or_cross_runtime_cursor_is_rejected_without_transport() {
        let fixture = AccountServiceFixture::authenticated([]).await;
        let error = fixture
            .service
            .favorite_songs(Some(format!("cursor:{}", "0".repeat(32))), 50)
            .await
            .expect_err("unknown cursor");
        assert!(matches!(error, QQMusicError::InvalidRequest));
        assert_eq!(fixture.transport.call_count(), 0);
    }

    #[tokio::test]
    async fn playlist_detail_and_recent_reads_use_normalized_account_surfaces() {
        let fixture = AccountServiceFixture::authenticated([
            body(include_str!(
                "../../tests/fixtures/qqmusic/account/favorites-page-1.json"
            )),
            body(include_str!(
                "../../tests/fixtures/qqmusic/account/favorites-page-2.json"
            )),
            body(include_str!(
                "../../tests/fixtures/qqmusic/account/playlists.json"
            )),
            body(include_str!(
                "../../tests/fixtures/qqmusic/account/playlist-owned.json"
            )),
            body(include_str!(
                "../../tests/fixtures/qqmusic/account/recent-history.json"
            )),
        ])
        .await;
        let first = fixture.service.favorite_songs(None, 50).await.unwrap();
        fixture
            .service
            .favorite_songs(first.next_cursor, 50)
            .await
            .unwrap();
        let playlists = fixture.service.playlists(None, 50).await.unwrap();
        assert_eq!(playlists.items.len(), 2);
        assert!(playlists.next_cursor.is_none());
        let detail = fixture
            .service
            .playlist_tracks(playlists.items[0].id.clone(), None, 50)
            .await
            .unwrap();
        assert_eq!(detail.tracks.items.len(), 2);
        assert!(detail.tracks.items.iter().all(|song| song.is_favorite));
        let recent = fixture.service.recently_played(None, 50).await.unwrap();
        assert_eq!(recent.items.len(), 2);
        assert!(recent.items.iter().all(|item| item.song.is_favorite));
        assert_eq!(fixture.transport.call_count(), 5);
    }

    #[tokio::test]
    async fn logout_or_login_swap_cancels_reads_at_every_commit_boundary() {
        for boundary in [
            ReadBoundary::Response,
            ReadBoundary::BeforeRetry,
            ReadBoundary::BeforeCacheCommit,
        ] {
            let replies = match boundary {
                ReadBoundary::BeforeRetry => vec![TestReply::Error(QQMusicError::Offline)],
                ReadBoundary::Response | ReadBoundary::BeforeCacheCommit => {
                    vec![terminal_favorites_body()]
                }
            };
            let fixture = AccountServiceFixture::authenticated(replies).await;
            let barrier = fixture.service.set_read_barrier(boundary);
            let service = Arc::clone(&fixture.service);
            let read = tokio::spawn(async move { service.favorite_songs(None, 50).await });
            tokio::time::timeout(
                std::time::Duration::from_secs(2),
                barrier.entered.notified(),
            )
            .await
            .expect("read reaches boundary");
            fixture.auth.logout().await.expect("logout");
            barrier.release.notify_one();
            assert!(matches!(
                read.await.expect("read joins"),
                Err(QQMusicError::Cancelled)
            ));
            assert!(fixture
                .storage
                .get_json::<Value>(
                    &AccountCache::projection_key(&fixture.session.account_cache_scope),
                    true,
                )
                .expect("projection lookup")
                .is_none());
        }
    }

    fn favorite_request(track: &str, favorite: bool, operation: &str) -> FavoriteMutationRequest {
        FavoriteMutationRequest {
            track_id: format!("qqmusic:track:{track}"),
            favorite,
            client_operation_id: operation.to_owned(),
        }
    }

    fn favorite_success_body() -> TestReply {
        body(include_str!(
            "../../tests/fixtures/qqmusic/account/favorite-success.json"
        ))
    }

    fn favorite_rejected_body() -> TestReply {
        body(include_str!(
            "../../tests/fixtures/qqmusic/account/favorite-rejected.json"
        ))
    }

    #[tokio::test]
    async fn favorite_success_and_rejection_update_only_confirmed_projection_state() {
        let fixture = AccountServiceFixture::authenticated([
            favorite_success_body(),
            favorite_rejected_body(),
        ])
        .await;
        let accepted = fixture
            .service
            .set_favorite(favorite_request(
                "SANITIZED_TRACK_A",
                true,
                "favorite-op-0001",
            ))
            .await
            .expect("accepted favorite");
        assert_eq!(accepted.status, MutationStatus::Applied);
        let projection_key = AccountCache::projection_key(&fixture.session.account_cache_scope);
        let projection = fixture
            .storage
            .get_json::<AccountLibraryProjection>(&projection_key, true)
            .expect("projection lookup")
            .expect("projection after accepted favorite");
        assert_eq!(projection.favorite_ids, ["qqmusic:track:SANITIZED_TRACK_A"]);

        let rejected = fixture
            .service
            .set_favorite(favorite_request(
                "SANITIZED_TRACK_A",
                false,
                "favorite-op-0002",
            ))
            .await
            .expect("typed rejection");
        assert_eq!(rejected.status, MutationStatus::Rejected);
        let projection = fixture
            .storage
            .get_json::<AccountLibraryProjection>(&projection_key, true)
            .expect("projection lookup")
            .expect("projection remains");
        assert_eq!(projection.favorite_ids, ["qqmusic:track:SANITIZED_TRACK_A"]);
        assert_eq!(
            fixture
                .transport
                .operation_count("account.favorite.write")
                .await,
            2
        );
        let request: Value = serde_json::from_slice(
            &fixture
                .transport
                .request_body("account.favorite.write")
                .await
                .expect("captured favorite request"),
        )
        .expect("favorite request JSON");
        assert_eq!(
            request.pointer("/req/param/v_songInfo/0/songId"),
            Some(&json!(1001))
        );
        assert_eq!(
            request.pointer("/req/param/v_songInfo/0/songType"),
            Some(&json!(13))
        );
    }

    #[tokio::test]
    async fn completed_favorite_operation_is_idempotent_and_rejects_conflicting_reuse() {
        let fixture = AccountServiceFixture::authenticated([favorite_success_body()]).await;
        let request = favorite_request("SANITIZED_TRACK_A", true, "favorite-idempotent-operation");
        let first = fixture
            .service
            .set_favorite(request.clone())
            .await
            .expect("first favorite");
        let second = fixture
            .service
            .set_favorite(request)
            .await
            .expect("cached favorite");
        assert_eq!(first.status, second.status);
        assert_eq!(first.favorite, second.favorite);
        assert_eq!(fixture.transport.call_count(), 1);

        assert!(matches!(
            fixture
                .service
                .set_favorite(favorite_request(
                    "SANITIZED_TRACK_A",
                    false,
                    "favorite-idempotent-operation",
                ))
                .await,
            Err(QQMusicError::InvalidRequest)
        ));
        assert_eq!(fixture.transport.call_count(), 1);
    }

    #[tokio::test]
    async fn favorite_requires_a_native_numeric_track_reference_before_transport() {
        let fixture = AccountServiceFixture::authenticated([favorite_success_body()]).await;
        assert!(matches!(
            fixture
                .service
                .set_favorite(favorite_request(
                    "UNSEEN_TRACK",
                    true,
                    "favorite-unseen-operation",
                ))
                .await,
            Err(QQMusicError::InvalidRequest)
        ));
        assert_eq!(fixture.transport.call_count(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn favorite_timeout_reconciles_by_safe_read_without_retrying_the_write() {
        let fixture = AccountServiceFixture::authenticated([
            TestReply::Error(QQMusicError::OutcomeUnknown),
            terminal_favorites_body(),
        ])
        .await;
        let service = Arc::clone(&fixture.service);
        let mutation = tokio::spawn(async move {
            service
                .set_favorite(favorite_request(
                    "SANITIZED_TRACK_C",
                    true,
                    "favorite-op-0003",
                ))
                .await
        });
        tokio::time::advance(std::time::Duration::from_millis(300)).await;
        let result = mutation
            .await
            .expect("mutation joins")
            .expect("mutation reconciles");

        assert_eq!(result.status, MutationStatus::Reconciled);
        assert_eq!(
            fixture
                .transport
                .operation_count("account.favorite.write")
                .await,
            1
        );
        assert_eq!(
            fixture
                .transport
                .operation_count("account.favorite.reconcile")
                .await,
            1
        );
    }

    #[tokio::test(start_paused = true)]
    async fn favorite_unknown_outcome_stops_after_three_read_checks() {
        let fixture = AccountServiceFixture::authenticated([
            TestReply::Error(QQMusicError::OutcomeUnknown),
            TestReply::Error(QQMusicError::Offline),
            TestReply::Error(QQMusicError::Timeout),
            TestReply::Error(QQMusicError::Protocol),
        ])
        .await;
        let service = Arc::clone(&fixture.service);
        let mutation = tokio::spawn(async move {
            service
                .set_favorite(favorite_request(
                    "SANITIZED_TRACK_A",
                    true,
                    "favorite-op-unknown",
                ))
                .await
        });
        tokio::time::advance(std::time::Duration::from_millis(2_500)).await;
        let result = mutation
            .await
            .expect("mutation joins")
            .expect("typed unknown outcome");

        assert_eq!(result.status, MutationStatus::OutcomeUnknown);
        assert_eq!(
            fixture
                .transport
                .operation_count("account.favorite.write")
                .await,
            1
        );
        assert_eq!(
            fixture
                .transport
                .operation_count("account.favorite.reconcile")
                .await,
            3
        );
    }

    #[tokio::test]
    async fn concurrent_favorite_for_one_track_is_rejected_before_transport() {
        let fixture = AccountServiceFixture::authenticated([favorite_success_body()]).await;
        let barrier = fixture
            .service
            .set_write_barrier(WriteBoundary::WriteClassified);
        let service = Arc::clone(&fixture.service);
        let first = tokio::spawn(async move {
            service
                .set_favorite(favorite_request(
                    "SANITIZED_TRACK_A",
                    true,
                    "favorite-op-0004",
                ))
                .await
        });
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            barrier.entered.notified(),
        )
        .await
        .expect("first write reaches barrier");

        assert!(matches!(
            fixture
                .service
                .set_favorite(favorite_request(
                    "SANITIZED_TRACK_A",
                    false,
                    "favorite-op-0005",
                ))
                .await,
            Err(QQMusicError::MutationInProgress)
        ));
        assert_eq!(fixture.transport.call_count(), 1);
        barrier.release.notify_one();
        first
            .await
            .expect("first write joins")
            .expect("first write succeeds");
    }

    #[tokio::test]
    async fn auth_epoch_change_at_write_or_cache_boundaries_cancels_without_old_cache() {
        for (index, boundary) in [
            WriteBoundary::WriteClassified,
            WriteBoundary::BeforeCacheCommit,
            WriteBoundary::AfterCacheCommit,
        ]
        .into_iter()
        .enumerate()
        {
            let fixture = AccountServiceFixture::authenticated([favorite_success_body()]).await;
            let barrier = fixture.service.set_write_barrier(boundary);
            let service = Arc::clone(&fixture.service);
            let mutation = tokio::spawn(async move {
                service
                    .set_favorite(favorite_request(
                        "SANITIZED_TRACK_A",
                        true,
                        &format!("favorite-boundary-{index}"),
                    ))
                    .await
            });
            tokio::time::timeout(
                std::time::Duration::from_secs(2),
                barrier.entered.notified(),
            )
            .await
            .expect("write reaches boundary");
            fixture.auth.logout().await.expect("logout");
            barrier.release.notify_one();

            assert!(matches!(
                mutation.await.expect("mutation joins"),
                Err(QQMusicError::Cancelled)
            ));
            assert!(fixture
                .storage
                .get_json::<AccountLibraryProjection>(
                    &AccountCache::projection_key(&fixture.session.account_cache_scope),
                    true,
                )
                .expect("projection lookup")
                .is_none());
        }
    }

    #[tokio::test(start_paused = true)]
    async fn auth_epoch_change_during_reconciliation_cancels_before_projection_commit() {
        let fixture = AccountServiceFixture::authenticated([
            TestReply::Error(QQMusicError::OutcomeUnknown),
            terminal_favorites_body(),
        ])
        .await;
        let barrier = fixture
            .service
            .set_write_barrier(WriteBoundary::ReconciliationRead);
        let service = Arc::clone(&fixture.service);
        let mutation = tokio::spawn(async move {
            service
                .set_favorite(favorite_request(
                    "SANITIZED_TRACK_C",
                    true,
                    "favorite-reconcile-boundary",
                ))
                .await
        });
        tokio::time::advance(std::time::Duration::from_millis(300)).await;
        barrier.entered.notified().await;
        fixture.auth.logout().await.expect("logout");
        barrier.release.notify_one();

        assert!(matches!(
            mutation.await.expect("mutation joins"),
            Err(QQMusicError::Cancelled)
        ));
        assert!(fixture
            .storage
            .get_json::<AccountLibraryProjection>(
                &AccountCache::projection_key(&fixture.session.account_cache_scope),
                true,
            )
            .expect("projection lookup")
            .is_none());
    }

    #[tokio::test]
    async fn favorite_authentication_failure_transitions_to_reauthentication_required() {
        let fixture = AccountServiceFixture::authenticated([TestReply::Error(
            QQMusicError::AuthenticationExpired,
        )])
        .await;

        assert!(matches!(
            fixture
                .service
                .set_favorite(favorite_request(
                    "SANITIZED_TRACK_A",
                    true,
                    "favorite-auth-expired",
                ))
                .await,
            Err(QQMusicError::AuthenticationExpired)
        ));
        assert!(matches!(
            fixture.auth.snapshot().await.account,
            AccountState::ReauthenticationRequired { .. }
        ));
    }

    #[tokio::test]
    async fn favorite_cgi_authentication_code_transitions_to_reauthentication_required() {
        let fixture = AccountServiceFixture::authenticated([body(
            r#"{"code":0,"req":{"code":104401,"data":{}}}"#,
        )])
        .await;

        assert!(matches!(
            fixture
                .service
                .set_favorite(favorite_request(
                    "SANITIZED_TRACK_A",
                    true,
                    "favorite-cgi-auth-expired",
                ))
                .await,
            Err(QQMusicError::AuthenticationExpired)
        ));
        assert!(matches!(
            fixture.auth.snapshot().await.account,
            AccountState::ReauthenticationRequired { .. }
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn favorite_reconciliation_cgi_authentication_code_requires_reauthentication() {
        let fixture = AccountServiceFixture::authenticated([
            TestReply::Error(QQMusicError::OutcomeUnknown),
            body(r#"{"code":0,"req":{"code":104400,"data":{}}}"#),
        ])
        .await;
        let service = Arc::clone(&fixture.service);
        let mutation = tokio::spawn(async move {
            service
                .set_favorite(favorite_request(
                    "SANITIZED_TRACK_A",
                    true,
                    "favorite-reconcile-auth-expired",
                ))
                .await
        });
        tokio::time::advance(std::time::Duration::from_millis(300)).await;

        assert!(matches!(
            mutation.await.expect("mutation joins"),
            Err(QQMusicError::AuthenticationExpired)
        ));
        assert!(matches!(
            fixture.auth.snapshot().await.account,
            AccountState::ReauthenticationRequired { .. }
        ));
    }

    #[tokio::test]
    async fn favorite_operation_id_is_reusable_after_account_epoch_change() {
        let fixture = AccountServiceFixture::authenticated([
            favorite_success_body(),
            favorite_success_body(),
        ])
        .await;
        fixture
            .service
            .set_favorite(favorite_request(
                "SANITIZED_TRACK_A",
                true,
                "favorite-shared-operation",
            ))
            .await
            .expect("first epoch write");
        fixture
            .auth
            .complete_confirmation(synthetic_session('b'))
            .await
            .expect("new epoch");
        fixture
            .service
            .set_favorite(favorite_request(
                "SANITIZED_TRACK_A",
                false,
                "favorite-shared-operation",
            ))
            .await
            .expect("second epoch write");

        assert_eq!(
            fixture
                .transport
                .operation_count("account.favorite.write")
                .await,
            2
        );
    }
}
