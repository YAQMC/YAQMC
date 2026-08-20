//! Account-facing DTOs. Serde annotations are the frozen desktop wire contract.

use crate::{Artwork, AudioQuality, PlaylistOwner, Song};
use serde::{Deserialize, Serialize};

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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlaylistOwnership {
    Owned,
    Collected,
    Favorite,
    System,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum AccountPlaylistReference {
    Owned {
        tid: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dir_id: Option<u64>,
    },
    Collected {
        tid: String,
    },
    FavoriteSongs {
        dir_id: u64,
    },
    SystemCollection {
        dir_id: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tid: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        collection_type: Option<String>,
    },
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountPlaylistSummary {
    pub id: String,
    pub reference: AccountPlaylistReference,
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
    LocalPlayback,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePlayHistoryItem {
    pub song: Song,
    pub played_at_ms: Option<u64>,
    pub source: RemotePlayHistorySource,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EntitlementTier {
    Free,
    #[serde(alias = "music-vip")]
    GreenDiamond,
    SuperVip,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SecondaryEntitlement {
    LuxuryGreenDiamond,
    AnnualGreenDiamond,
    AnnualLuxuryGreenDiamond,
    Star,
    AnnualStar,
    EightPlatform,
    TwelvePlatform,
    Family,
    Child,
    Trial,
    Couple,
    AdFree,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MembershipState {
    Active,
    Expired,
    Inactive,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EntitlementFeature {
    Playback,
    FavoriteWrite,
    PlaylistWrite,
    Quality,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EntitlementRestrictionReason {
    MembershipRequired,
    RegionRestricted,
    UpstreamRestricted,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntitlementRestriction {
    pub feature: EntitlementFeature,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality: Option<AudioQuality>,
    pub reason: EntitlementRestrictionReason,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountEntitlement {
    pub tier: EntitlementTier,
    pub membership: MembershipState,
    pub expires_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub secondary_entitlements: Vec<SecondaryEntitlement>,
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
    pub fn state_name(&self) -> &'static str {
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
}

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderErrorCode {
    Offline,
    Timeout,
    AuthenticationExpired,
    AuthorizationRejected,
    EntitlementUnavailable,
    EntitlementUnknown,
    ClientUnsupported,
    RateLimited,
    SchemaChanged,
    SongUnavailable,
    MalformedResponse,
    Unavailable,
    ProviderFailure,
    Cancelled,
    NotFound,
    InvalidRequest,
    UnsupportedOperation,
    MutationInProgress,
    StorageFailure,
    InvalidPlaylistIdentifier,
    UnsupportedAccountCollection,
}

impl ProviderErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Offline => "offline",
            Self::Timeout => "timeout",
            Self::AuthenticationExpired => "authentication-expired",
            Self::AuthorizationRejected => "authorization-rejected",
            Self::EntitlementUnavailable => "entitlement-unavailable",
            Self::EntitlementUnknown => "entitlement-unknown",
            Self::ClientUnsupported => "client-unsupported",
            Self::RateLimited => "rate-limited",
            Self::SchemaChanged => "schema-changed",
            Self::SongUnavailable => "song-unavailable",
            Self::MalformedResponse => "malformed-response",
            Self::Unavailable => "unavailable",
            Self::ProviderFailure => "provider-failure",
            Self::Cancelled => "cancelled",
            Self::NotFound => "not-found",
            Self::InvalidRequest => "invalid-request",
            Self::UnsupportedOperation => "unsupported-operation",
            Self::MutationInProgress => "mutation-in-progress",
            Self::StorageFailure => "storage-failure",
            Self::InvalidPlaylistIdentifier => "invalid-playlist-identifier",
            Self::UnsupportedAccountCollection => "unsupported-account-collection",
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
pub struct CollectPlaylistRequest {
    pub playlist_id: String,
    pub collected: bool,
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
