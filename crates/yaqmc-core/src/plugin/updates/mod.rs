//! Host-owned plugin updates. Plugins cannot supply trust anchors or invoke this API.
pub mod remote;
pub(crate) mod storage;

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub(crate) fn atomic_bytes(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let parent = path.parent().ok_or("update-path-invalid")?;
    std::fs::create_dir_all(parent).map_err(|_| "update-state-write-failed")?;
    let temporary = parent.join(format!(".update-{:032x}.tmp", rand::random::<u128>()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "update-state-write-failed")?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "update-state-write-failed")?;
        drop(file);
        std::fs::rename(&temporary, path).map_err(|_| "update-state-replace-failed")
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result.map_err(str::to_owned)
}

pub(crate) fn atomic_json(path: &std::path::Path, value: &impl Serialize) -> Result<(), String> {
    atomic_bytes(
        path,
        &serde_json::to_vec(value).map_err(|_| "update-state-encode-failed")?,
    )
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReleaseChannel {
    #[default]
    Stable,
    Beta,
    Nightly,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseInfo {
    pub channel: ReleaseChannel,
    pub build_id: String,
    pub release_sequence: u64,
}

impl ReleaseInfo {
    pub fn valid(&self) -> bool {
        !self.build_id.is_empty()
            && self.build_id.len() <= 128
            && !self.build_id.chars().any(char::is_control)
            && self.release_sequence > 0
            && self.release_sequence <= 9_007_199_254_740_991
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePolicy {
    pub source_id: Option<String>,
    pub channel: ReleaseChannel,
    pub automatic: bool,
    pub bound: bool,
    pub last_check_ms: u64,
    pub last_result: Option<String>,
    pub failed_sha256: Option<String>,
    #[serde(default)]
    pub failed_release_id: Option<String>,
    #[serde(default)]
    pub trust_digest: String,
    #[serde(default)]
    pub source_history: BTreeMap<String, SourceHistory>,
    #[serde(default)]
    pub feed_sequence: u64,
    #[serde(default)]
    pub feed_digest: String,
    #[serde(default)]
    pub releases_seen: BTreeMap<u64, String>,
    #[serde(default)]
    pub retry_after_ms: u64,
    #[serde(default)]
    pub failures: u32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceHistory {
    pub feed_sequence: u64,
    pub feed_digest: String,
    pub releases_seen: BTreeMap<u64, String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyRequest {
    pub plugin_id: String,
    pub source_id: Option<String>,
    pub channel: ReleaseChannel,
    pub automatic: bool,
    #[serde(default)]
    pub confirm_source: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareRequest {
    pub plugin_id: Option<String>,
    pub path: Option<String>,
    pub release_id: Option<String>,
    #[serde(default)]
    pub unpacked: bool,
    /// Plugin store asset; downloaded by the host and reviewed as unverified.
    #[serde(default)]
    pub github: Option<crate::plugin::store::StoreAssetRef>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyRequest {
    pub operation_id: String,
    #[serde(default)]
    pub grant: Vec<String>,
    #[serde(default)]
    pub confirm: bool,
    #[serde(default)]
    pub stop_using: bool,
    #[serde(default)]
    pub automatic: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePreview {
    pub plugin_id: String,
    pub provider_ids: Vec<String>,
    pub name: String,
    pub current_version: Option<String>,
    pub expected_generation: Option<u64>,
    pub version: String,
    pub current_sha256: Option<String>,
    pub sha256: String,
    pub release: Option<ReleaseInfo>,
    pub permissions: Vec<String>,
    pub granted_permissions: Vec<String>,
    pub added_permissions: Vec<String>,
    pub removed_permissions: Vec<String>,
    pub session_changes: Vec<String>,
    pub confirmations: Vec<String>,
    pub trusted_source: Option<String>,
    /// Recorded installation source for unsigned packages (`github:owner/repo/releases/id`).
    #[serde(default)]
    pub origin: Option<String>,
    pub enabled: bool,
    pub needs_renderer: bool,
    pub has_script: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOperation {
    pub operation_id: String,
    pub plugin_id: Option<String>,
    pub phase: String,
    pub preview: Option<UpdatePreview>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub error: Option<String>,
    #[serde(default)]
    pub runtime_changed: bool,
}

impl UpdateOperation {
    pub fn terminal(&self) -> bool {
        matches!(
            self.phase.as_str(),
            "completed" | "unchanged" | "cancelled" | "failed"
        )
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeReadyRequest {
    pub operation_id: String,
    pub sha256: String,
    pub stage: String,
    pub error: Option<String>,
}

pub fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

pub fn version_change(current: &str, next: &str) -> &'static str {
    match (
        semver::Version::parse(current),
        semver::Version::parse(next),
    ) {
        (Ok(current), Ok(next)) => match next.cmp_precedence(&current) {
            std::cmp::Ordering::Greater => "upgrade",
            std::cmp::Ordering::Equal => "replacement",
            std::cmp::Ordering::Less => "downgrade",
        },
        _ => "uncomparable-version",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compares_prereleases_and_ignores_build_precedence() {
        assert_eq!(version_change("1.0.0-beta.9", "1.0.0-beta.10"), "upgrade");
        assert_eq!(version_change("1.0.0-beta.10", "1.0.0"), "upgrade");
        assert_eq!(version_change("1.0.0+aaa", "1.0.0+zzz"), "replacement");
        assert_eq!(version_change("2.0.0", "1.0.0"), "downgrade");
        assert_eq!(version_change("legacy", "1.0.0"), "uncomparable-version");
    }
}
