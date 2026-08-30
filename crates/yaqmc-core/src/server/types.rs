use serde::Deserialize;

use crate::diagnostics::{DiagnosticsHostPayload, LyricsPresetSection};
use crate::logging::LogLevel;
use crate::statistics::StatisticsRange;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsRequest {
    pub account_state: Option<String>,
    pub membership_tier: Option<String>,
    pub membership_status: Option<String>,
    #[serde(default)]
    pub lyrics_preset: Option<LyricsPresetSection>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsBundleRequest {
    pub include_logs: Option<bool>,
    pub override_unresolved: Option<bool>,
    pub description: Option<String>,
    pub issue_category: Option<String>,
    #[serde(default)]
    pub host_payload: Option<DiagnosticsHostPayload>,
    #[serde(flatten)]
    pub base: DiagnosticsRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendLogEntry {
    pub level: LogLevel,
    pub target: String,
    pub message: String,
    pub op_id: Option<String>,
    pub fields: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordErrorRequest {
    pub code: String,
    pub domain: String,
    pub message: String,
    pub op_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugPerfSample {
    pub fps: u32,
    pub average_ms: f64,
    pub p95_ms: f64,
    pub max_ms: f64,
    pub long_tasks: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedRequest<T> {
    pub request: T,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderNamedRequest<T> {
    pub provider_id: String,
    pub request: T,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderIdParams {
    pub provider_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderEntityParams {
    pub provider_id: String,
    pub id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRefreshParams {
    pub provider_id: String,
    pub refresh: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAreaParams {
    pub provider_id: String,
    pub enc_area: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSearchParams {
    pub provider_id: String,
    pub query: String,
    pub kind: yaqmc_provider_api::CatalogSearchKind,
    pub page: u32,
    pub limit: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderArtistCatalogParams {
    pub provider_id: String,
    pub id: String,
    pub kind: yaqmc_provider_api::ArtistCatalogKind,
    pub page: u32,
    pub limit: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUrlParams {
    pub provider_id: String,
    pub url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCursorPageParams {
    pub provider_id: String,
    pub cursor: Option<String>,
    pub limit: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPlaylistTracksParams {
    pub provider_id: String,
    pub playlist: yaqmc_provider_api::AccountPlaylistSummary,
    pub cursor: Option<String>,
    pub limit: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderQualityParams {
    pub provider_id: String,
    pub quality: yaqmc_provider_api::AudioQualityPreference,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAuthHeartbeatParams {
    pub provider_id: String,
    pub attempt_id: String,
    pub owner_lease_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAttemptParams {
    pub provider_id: String,
    pub attempt_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderOptionalAttemptParams {
    pub provider_id: String,
    pub attempt_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderOAuthPrepareParams {
    pub provider_id: String,
    pub method_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderOAuthCompleteParams {
    pub provider_id: String,
    pub attempt_id: String,
    pub callback_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatisticsRangeParams {
    pub range: StatisticsRange,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshParams {
    pub refresh: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncAreaParams {
    pub enc_area: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchParams {
    pub query: String,
    pub kind: yaqmc_provider_api::CatalogSearchKind,
    pub page: u32,
    pub limit: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistCatalogParams {
    pub id: String,
    pub kind: yaqmc_provider_api::ArtistCatalogKind,
    pub page: u32,
    pub limit: u32,
}

#[cfg(test)]
mod search_params_tests {
    use super::{ArtistCatalogParams, SearchParams};

    #[test]
    fn typed_search_params_accept_lowercase_kind_and_camel_case_fields() {
        let params: SearchParams = serde_json::from_value(serde_json::json!({
            "query": "MIRA",
            "kind": "playlist",
            "page": 2,
            "limit": 8
        }))
        .expect("typed search params");
        assert_eq!(params.kind, yaqmc_provider_api::CatalogSearchKind::Playlist);
        assert_eq!(params.page, 2);
        assert_eq!(params.limit, 8);
    }

    #[test]
    fn typed_artist_catalog_params_accept_the_frozen_shape() {
        let params: ArtistCatalogParams = serde_json::from_value(serde_json::json!({
            "id": "qqmusic:artist:mid",
            "kind": "album",
            "page": 3,
            "limit": 20
        }))
        .expect("typed artist catalog params");
        assert_eq!(params.id, "qqmusic:artist:mid");
        assert_eq!(params.kind, yaqmc_provider_api::ArtistCatalogKind::Album);
        assert_eq!(params.page, 3);
        assert_eq!(params.limit, 20);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdParams {
    pub id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SongIdParams {
    pub song_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareSongParams {
    pub provider_id: String,
    pub id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UrlParams {
    pub url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorPageParams {
    pub cursor: Option<String>,
    pub limit: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistTracksParams {
    pub playlist: yaqmc_provider_api::AccountPlaylistSummary,
    pub cursor: Option<String>,
    pub limit: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthHeartbeatParams {
    pub attempt_id: String,
    pub owner_lease_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptIdParams {
    pub attempt_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthPrepareParams {
    pub provider_kind: yaqmc_provider_api::OAuthLoginProvider,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthCompleteParams {
    pub attempt_id: String,
    pub callback_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionalAttemptParams {
    pub attempt_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdParams {
    pub device_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexParams {
    pub index: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryIdParams {
    pub entry_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeekParams {
    pub position_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeParams {
    pub volume: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnabledParams {
    pub enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortParams {
    pub port: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueParams {
    pub value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceParams {
    pub reference: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathParams {
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsExportToParams {
    pub path: String,
    pub request: DiagnosticsBundleRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginIdParams {
    pub plugin_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenParams {
    pub token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingKeyParams {
    pub key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingWriteParams {
    pub key: String,
    pub value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginReadAssetParams {
    pub plugin_id: String,
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMarkFailedParams {
    pub id: String,
    pub reason: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderParams {
    pub entry_id: String,
    pub target_index: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueReporterPreviewParams {
    pub draft: crate::issue_reporter::IssueDraft,
    pub request: DiagnosticsRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleParams {
    pub sample: DebugPerfSample,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelParams {
    pub level: LogLevel,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendLogParams {
    pub entries: Vec<FrontendLogEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityParams {
    pub quality: crate::playback_types::AudioQualityPreference,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TracksParams {
    pub tracks: Vec<crate::player::Song>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackParams {
    pub track: crate::player::Song,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepeatParams {
    pub mode: crate::player::RepeatMode,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimaryModeParams {
    pub mode: crate::player::PrimaryPlaybackMode,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsDocumentParams {
    pub document: Option<crate::player::LyricDocument>,
}
