use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use thiserror::Error;

use crate::plugin::permissions::{parse_permission, permission_allowed_for_api, PluginPermission};

pub const LEGACY_MANIFEST_VERSION: u32 = 1;
pub const CURRENT_MANIFEST_VERSION: u32 = 2;
pub const CURRENT_API_VERSION: u32 = 3;
pub const MIN_API_VERSION: u32 = 1;
pub const PROVIDER_WIT_VERSION: &str = "0.1.0";
pub const PROVIDER_WIT_WORLD: &str = "provider";
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn api_supported(version: u32) -> bool {
    (MIN_API_VERSION..=CURRENT_API_VERSION).contains(&version)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub manifest_version: u32,
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub version: String,
    pub api_version: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub authors: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(default)]
    pub engines: PluginEngines,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub platforms: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub architectures: Vec<String>,
    #[serde(default)]
    pub entrypoints: PluginEntrypoints,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<ProviderPluginManifest>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub permissions: Vec<String>,
    #[serde(default, skip_serializing_if = "indexmap_empty")]
    pub dependencies: std::collections::BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conflicts: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings_schema: Option<serde_json::Value>,
    /// Reserved for a future publisher-signature model. v1 never treats this as verified.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signatures: Option<serde_json::Value>,
}

fn indexmap_empty(map: &std::collections::BTreeMap<String, String>) -> bool {
    map.is_empty()
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEngines {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub yaqmc: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEntrypoints {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub styles: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scenes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub component: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum ProviderCapability {
    #[serde(rename = "provider.catalog")]
    Catalog,
    #[serde(rename = "provider.playback")]
    Playback,
    #[serde(rename = "provider.recommendation")]
    Recommendation,
    #[serde(rename = "provider.lyrics")]
    Lyrics,
    #[serde(rename = "provider.account")]
    Account,
}

impl ProviderCapability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Catalog => "provider.catalog",
            Self::Playback => "provider.playback",
            Self::Recommendation => "provider.recommendation",
            Self::Lyrics => "provider.lyrics",
            Self::Account => "provider.account",
        }
    }

    pub fn permission(self) -> PluginPermission {
        match self {
            Self::Catalog => PluginPermission::ProviderCatalog,
            Self::Playback => PluginPermission::ProviderPlayback,
            Self::Recommendation => PluginPermission::ProviderRecommendation,
            Self::Lyrics => PluginPermission::ProviderLyrics,
            Self::Account => PluginPermission::ProviderAccount,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPluginManifest {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub wit_version: String,
    pub world: String,
    pub capabilities: Vec<ProviderCapability>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ManifestError {
    #[error("the plugin manifest is not valid JSON")]
    InvalidJson,
    #[error("unsupported plugin manifest version")]
    UnsupportedManifestVersion,
    #[error("the plugin manifest and API versions are incompatible")]
    ManifestApiMismatch,
    #[error("the plugin id is invalid")]
    InvalidId,
    #[error("the plugin version is not valid semver")]
    InvalidVersion,
    #[error("a plugin entrypoint path is malformed")]
    MalformedEntrypoint,
    #[error("the provider component declaration is invalid")]
    InvalidProvider,
    #[error("the plugin requests an unknown or forbidden permission")]
    UnknownPermission,
}

impl PluginManifest {
    pub fn parse(bytes: &[u8]) -> Result<Self, ManifestError> {
        let manifest: Self =
            serde_json::from_slice(bytes).map_err(|_| ManifestError::InvalidJson)?;
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn validate(&self) -> Result<(), ManifestError> {
        if !matches!(
            self.manifest_version,
            LEGACY_MANIFEST_VERSION | CURRENT_MANIFEST_VERSION
        ) {
            return Err(ManifestError::UnsupportedManifestVersion);
        }
        if !is_plugin_id(&self.id) {
            return Err(ManifestError::InvalidId);
        }
        if parse_semver(&self.version).is_none() {
            return Err(ManifestError::InvalidVersion);
        }
        if self.name.trim().is_empty() || self.name.len() > 80 {
            return Err(ManifestError::InvalidId);
        }
        validate_entrypoints(&self.entrypoints)?;
        for permission in &self.permissions {
            let (permission, _) =
                parse_permission(permission).map_err(|_| ManifestError::UnknownPermission)?;
            if !permission_allowed_for_api(permission, self.api_version) {
                return Err(ManifestError::UnknownPermission);
            }
        }
        self.validate_runtime_shape()?;
        for (dependency, range) in &self.dependencies {
            if !is_plugin_id(dependency) || range.trim().is_empty() {
                return Err(ManifestError::InvalidId);
            }
        }
        for conflict in &self.conflicts {
            if !is_plugin_id(conflict) {
                return Err(ManifestError::InvalidId);
            }
        }
        Ok(())
    }

    fn validate_runtime_shape(&self) -> Result<(), ManifestError> {
        if self.manifest_version == LEGACY_MANIFEST_VERSION {
            if self.api_version == 3
                || self.entrypoints.component.is_some()
                || self.provider.is_some()
            {
                return Err(ManifestError::ManifestApiMismatch);
            }
            return Ok(());
        }

        if self.api_version != 3
            || self.entrypoints.component.is_none()
            || self.entrypoints.script.is_some()
            || !self.entrypoints.styles.is_empty()
            || !self.entrypoints.scenes.is_empty()
        {
            return Err(ManifestError::ManifestApiMismatch);
        }
        let provider = self
            .provider
            .as_ref()
            .ok_or(ManifestError::InvalidProvider)?;
        if !is_plugin_id(&provider.id)
            || provider
                .name
                .as_ref()
                .is_some_and(|name| name.trim().is_empty() || name.len() > 80)
            || provider.wit_version != PROVIDER_WIT_VERSION
            || provider.world != PROVIDER_WIT_WORLD
            || provider.capabilities.is_empty()
        {
            return Err(ManifestError::InvalidProvider);
        }
        let capabilities = provider
            .capabilities
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();
        if capabilities.len() != provider.capabilities.len() {
            return Err(ManifestError::InvalidProvider);
        }
        let requested = self.requested_permissions();
        if capabilities
            .iter()
            .any(|capability| !requested.contains(&capability.permission()))
        {
            return Err(ManifestError::InvalidProvider);
        }
        Ok(())
    }

    /// Structural parse succeeds for incompatible engines/API so the package can
    /// stay installed-but-disabled with an explanation. Activation still refuses.
    pub fn compatibility_issue(&self) -> Option<String> {
        if !api_supported(self.api_version) {
            return Some("this plugin API version is not supported".into());
        }
        if let Some(engine) = &self.engines.yaqmc {
            if !engine_matches(engine, APP_VERSION) {
                return Some("this plugin requires a different YAQMC version".into());
            }
        }
        if !self.platforms.is_empty() {
            let current = current_platform();
            if !self
                .platforms
                .iter()
                .any(|platform| platform.eq_ignore_ascii_case(current))
            {
                return Some(format!("this plugin does not support {current}"));
            }
        }
        None
    }

    #[allow(dead_code)]
    pub fn requested_permissions(&self) -> BTreeSet<PluginPermission> {
        self.requested_permission_keys()
            .into_iter()
            .filter_map(|key| {
                parse_permission(&key)
                    .ok()
                    .map(|(permission, _)| permission)
            })
            .collect()
    }

    pub fn requested_permission_keys(&self) -> Vec<String> {
        let mut keys = BTreeSet::new();
        for permission in &self.permissions {
            if let Ok((parsed, origin)) = parse_permission(permission) {
                if let Some(origin) = origin {
                    keys.insert(format!("network:{origin}"));
                } else {
                    keys.insert(parsed.as_str().to_owned());
                }
            }
        }
        if !self.entrypoints.styles.is_empty() {
            keys.insert(PluginPermission::StyleRegister.as_str().to_owned());
        }
        if !self.entrypoints.scenes.is_empty() {
            keys.insert(PluginPermission::SceneRegister.as_str().to_owned());
        }
        keys.into_iter().collect()
    }
}

pub fn is_plugin_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 3 || bytes.len() > 128 || !value.contains('.') {
        return false;
    }
    let mut last_dot = false;
    for (index, ch) in value.chars().enumerate() {
        match ch {
            'a'..='z' | '0'..='9' => last_dot = false,
            '-' if index > 0 && !last_dot => {}
            '.' if index > 0 && !last_dot => last_dot = true,
            _ => return false,
        }
    }
    !last_dot
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct SemVer {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

pub fn parse_semver(value: &str) -> Option<SemVer> {
    let core = value.split('-').next().unwrap_or(value).split('+').next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(SemVer {
        major,
        minor,
        patch,
    })
}

pub fn engine_matches(requirement: &str, installed: &str) -> bool {
    let installed = parse_semver(installed);
    let Some(installed) = installed else {
        return false;
    };
    let requirement = requirement.trim();
    if let Some(min) = requirement.strip_prefix(">=") {
        return parse_semver(min.trim()).is_some_and(|min| installed >= min);
    }
    if let Some(exact) = requirement.strip_prefix('=') {
        return parse_semver(exact.trim()).is_some_and(|exact| installed == exact);
    }
    parse_semver(requirement).is_some_and(|exact| installed == exact)
}

fn validate_entrypoints(entrypoints: &PluginEntrypoints) -> Result<(), ManifestError> {
    let mut seen = BTreeSet::new();
    for path in entrypoints
        .styles
        .iter()
        .chain(entrypoints.scenes.iter())
        .chain(entrypoints.script.iter())
        .chain(entrypoints.component.iter())
    {
        if !is_safe_package_path(path) || !seen.insert(path.replace('\\', "/")) {
            return Err(ManifestError::MalformedEntrypoint);
        }
    }
    if let Some(script) = &entrypoints.script {
        if !script.ends_with(".js") {
            return Err(ManifestError::MalformedEntrypoint);
        }
    }
    if let Some(component) = &entrypoints.component {
        if !component.ends_with(".wasm") {
            return Err(ManifestError::MalformedEntrypoint);
        }
    }
    for style in &entrypoints.styles {
        if !style.ends_with(".css") {
            return Err(ManifestError::MalformedEntrypoint);
        }
    }
    for scene in &entrypoints.scenes {
        if !scene.ends_with(".json") && !scene.ends_with(".scene.json") {
            return Err(ManifestError::MalformedEntrypoint);
        }
    }
    Ok(())
}

pub fn is_safe_package_path(path: &str) -> bool {
    if path.is_empty() || path.len() > 240 || path.contains('\0') || path.contains(':') {
        return false;
    }
    let normalized = path.replace('\\', "/");
    if normalized.starts_with('/') || normalized.starts_with("./") {
        return false;
    }
    let mut parts = 0;
    for component in normalized.split('/') {
        if component.is_empty()
            || component == "."
            || component == ".."
            || component.starts_with('.')
        {
            return false;
        }
        parts += 1;
        if parts > 8 {
            return false;
        }
    }
    true
}

pub fn current_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "unknown"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_json() -> String {
        r#"{
            "manifestVersion": 1,
            "id": "dev.example.sakura",
            "name": "Sakura",
            "version": "1.0.0",
            "apiVersion": 1,
            "entrypoints": { "styles": ["styles/main.css"] }
        }"#
        .to_owned()
    }

    fn valid_provider_json() -> String {
        r#"{
            "manifestVersion": 2,
            "id": "dev.example.catalog",
            "name": "Example catalog",
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
        }"#
        .to_owned()
    }

    #[test]
    fn parses_a_valid_compositional_manifest() {
        let manifest = PluginManifest::parse(valid_json().as_bytes()).expect("valid");
        assert_eq!(manifest.id, "dev.example.sakura");
        assert!(manifest
            .requested_permissions()
            .contains(&PluginPermission::StyleRegister));
    }

    #[test]
    fn rejects_invalid_ids_and_semver() {
        assert!(!is_plugin_id("Sakura"));
        assert!(!is_plugin_id("local"));
        assert!(is_plugin_id("dev.example.plugin"));
        assert!(parse_semver("1.2.3-local").is_some());
        assert!(parse_semver("01").is_none());
        let mut json = valid_json().replace("dev.example.sakura", "not an id");
        assert_eq!(
            PluginManifest::parse(json.as_bytes()).unwrap_err(),
            ManifestError::InvalidId
        );
        json = valid_json().replace("1.0.0", "v1");
        assert_eq!(
            PluginManifest::parse(json.as_bytes()).unwrap_err(),
            ManifestError::InvalidVersion
        );
    }

    #[test]
    fn rejects_path_escape_and_marks_unsupported_api_incompatible() {
        let json = valid_json().replace("\"apiVersion\": 1", "\"apiVersion\": 99");
        let manifest = PluginManifest::parse(json.as_bytes()).expect("structurally valid");
        assert_eq!(
            manifest.compatibility_issue().as_deref(),
            Some("this plugin API version is not supported")
        );
        let v2 = valid_json().replace("\"apiVersion\": 1", "\"apiVersion\": 2");
        assert!(PluginManifest::parse(v2.as_bytes())
            .expect("v2")
            .compatibility_issue()
            .is_none());
        let json = valid_json().replace("styles/main.css", "../main.css");
        assert_eq!(
            PluginManifest::parse(json.as_bytes()).unwrap_err(),
            ManifestError::MalformedEntrypoint
        );
    }

    #[test]
    fn engine_requirement_accepts_current_app() {
        assert!(engine_matches(">=0.1.0", "0.1.0"));
        assert!(!engine_matches(">=9.0.0", "0.1.0"));
    }

    #[test]
    fn provider_v3_requires_a_component_matching_permissions_and_frozen_wit() {
        let manifest = PluginManifest::parse(valid_provider_json().as_bytes()).expect("v3");
        assert_eq!(manifest.manifest_version, 2);
        assert_eq!(manifest.api_version, 3);
        assert_eq!(
            manifest.provider.as_ref().expect("provider").capabilities,
            vec![ProviderCapability::Catalog]
        );
        assert!(api_supported(3));

        let missing_permission = valid_provider_json().replace(
            r#""permissions": ["provider.catalog"]"#,
            r#""permissions": []"#,
        );
        assert_eq!(
            PluginManifest::parse(missing_permission.as_bytes()).unwrap_err(),
            ManifestError::InvalidProvider
        );
        let wrong_wit = valid_provider_json().replace("0.1.0", "0.2.0");
        assert_eq!(
            PluginManifest::parse(wrong_wit.as_bytes()).unwrap_err(),
            ManifestError::InvalidProvider
        );
    }

    #[test]
    fn legacy_and_component_runtime_shapes_cannot_be_mixed() {
        let legacy_api_three = valid_json().replace("\"apiVersion\": 1", "\"apiVersion\": 3");
        assert_eq!(
            PluginManifest::parse(legacy_api_three.as_bytes()).unwrap_err(),
            ManifestError::ManifestApiMismatch
        );
        let component_script = valid_provider_json().replace(
            r#""component": "component/provider.wasm""#,
            r#""component": "component/provider.wasm", "script": "dist/main.js""#,
        );
        assert_eq!(
            PluginManifest::parse(component_script.as_bytes()).unwrap_err(),
            ManifestError::ManifestApiMismatch
        );
        let legacy_provider_permission = valid_json().replace(
            r#""entrypoints": { "styles": ["styles/main.css"] }"#,
            r#""entrypoints": { "styles": ["styles/main.css"] }, "permissions": ["provider.catalog"]"#,
        );
        assert_eq!(
            PluginManifest::parse(legacy_provider_permission.as_bytes()).unwrap_err(),
            ManifestError::UnknownPermission
        );
    }
}
