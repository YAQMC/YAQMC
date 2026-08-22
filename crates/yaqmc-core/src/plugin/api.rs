use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::plugin::{scanner::ScanReport, PluginManifest};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallRequest {
    pub path: String,
    #[serde(default)]
    pub enable: bool,
    #[serde(default)]
    pub grant: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEnableRequest {
    pub id: String,
    pub enabled: bool,
    #[serde(default)]
    pub grant: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUninstallRequest {
    pub id: String,
    #[serde(default)]
    pub remove_data: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginBridgeRequest {
    pub token: String,
    pub method: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSettingsWrite {
    pub id: String,
    pub values: Map<String, Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInspectResult {
    pub sha256: String,
    pub compressed_bytes: u64,
    pub expanded_bytes: u64,
    pub file_count: usize,
    pub manifest: PluginManifest,
    pub permissions: Vec<String>,
    pub style_scan: ScanReport,
    pub script_scan: ScanReport,
    pub files: Vec<String>,
}
