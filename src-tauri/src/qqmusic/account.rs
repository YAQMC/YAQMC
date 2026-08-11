#![expect(
    dead_code,
    reason = "account services consume these shared contracts in later tasks"
)]

use super::PlaylistOwner;
use crate::player::{Artwork, AudioQuality, Song};
use serde::{Deserialize, Serialize};

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
    pub total: Option<u64>,
    pub fetched_at_ms: u64,
    pub stale: bool,
    pub auth_revision: u64,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistCapabilities {
    pub can_add_tracks: bool,
    pub can_remove_tracks: bool,
    pub can_rename: bool,
    pub can_delete: bool,
    pub can_reorder: bool,
}

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
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

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
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

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
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

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
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
pub struct PlaylistMutationResult {
    pub client_operation_id: String,
    pub status: MutationStatus,
    pub playlist: Option<AccountPlaylistSummary>,
    pub error_code: Option<ProviderErrorCode>,
    pub auth_revision: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
