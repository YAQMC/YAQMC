use serde::Deserialize;

use crate::diagnostics::LyricsPresetSection;
use crate::logging::LogLevel;

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
pub struct LimitParams {
    pub limit: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchParams {
    pub query: String,
    pub page: u32,
    pub limit: u32,
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
    pub playlist: crate::qqmusic::account::AccountPlaylistSummary,
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
