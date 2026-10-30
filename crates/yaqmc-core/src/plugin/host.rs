use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use thiserror::Error;

use crate::credentials::CredentialStore;
use crate::plugin::{
    component_host::ComponentHostServices,
    federation::{FederatedProvider, FederationMember},
    manifest::{is_plugin_id, parse_semver, PluginManifest},
    package::{
        content_sha256, extract_to, inspect_directory, inspect_package, sha256_bytes,
        PackageInspection,
    },
    permissions::PluginPermission,
    provider::ComponentProviderAdapter,
    scanner::{css_is_blocked, ScanReport},
    PLUGIN_STORAGE_QUOTA,
};
use yaqmc_provider_api::{ProviderCapabilitySummary, ProviderRegistry};

mod updates;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PluginStatus {
    Installed,
    Disabled,
    Enabling,
    Active,
    Disabling,
    Failed,
    Incompatible,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRecord {
    pub id: String,
    pub name: String,
    pub version: String,
    pub release: Option<crate::plugin::updates::ReleaseInfo>,
    pub description: Option<String>,
    pub authors: Vec<String>,
    pub enabled: bool,
    pub status: PluginStatus,
    pub status_reason: Option<String>,
    pub api_version: u32,
    pub package_sha256: String,
    pub source: String,
    pub unsigned: bool,
    pub entrypoints: EntrypointSummary,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<ProviderEntrypointSummary>,
    pub permissions: Vec<String>,
    pub granted_permissions: Vec<String>,
    pub risk_rating: String,
    pub style_scan: ScanReport,
    pub script_scan: ScanReport,
    pub compatible: bool,
    pub platforms: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings_schema: Option<serde_json::Value>,
    #[serde(default)]
    pub network_origins: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unpacked_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveStyleSheet {
    pub plugin_id: String,
    pub css: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveSceneResource {
    pub plugin_id: String,
    pub plugin_name: String,
    pub scene_id: String,
    pub css: Option<String>,
    pub definition: serde_json::Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveScriptResource {
    pub plugin_id: String,
    pub plugin_name: String,
    pub source: String,
    pub package_sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivePluginResources {
    pub safe_mode: bool,
    pub developer_mode: bool,
    pub style_order: Vec<String>,
    pub styles: Vec<ActiveStyleSheet>,
    pub scenes: Vec<ActiveSceneResource>,
    pub scripts: Vec<ActiveScriptResource>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntrypointSummary {
    pub styles: usize,
    pub scenes: usize,
    pub script: bool,
    pub component: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderEntrypointSummary {
    pub id: String,
    pub wit_version: String,
    pub world: String,
    pub capabilities: Vec<String>,
    pub circuit_open: bool,
    pub consecutive_faults: u8,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDiagnostic {
    pub id: String,
    pub version: String,
    pub enabled: bool,
    pub status: PluginStatus,
    pub entrypoint_kinds: Vec<String>,
    pub api_version: u32,
    pub package_sha256: String,
    pub permissions: Vec<String>,
    pub risk_rating: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginStateFile {
    id: String,
    active_version: String,
    #[serde(default)]
    active_package: Option<String>,
    #[serde(default)]
    release: Option<crate::plugin::updates::ReleaseInfo>,
    #[serde(default)]
    session_epochs: BTreeMap<String, String>,
    #[serde(default)]
    session_secret_fields: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    retained_session_namespaces: Vec<String>,
    #[serde(default)]
    generation: u64,
    enabled: bool,
    status: PluginStatus,
    status_reason: Option<String>,
    granted_permissions: Vec<String>,
    package_sha256: String,
    #[serde(default)]
    content_sha256: String,
    source: String,
    style_scan: ScanReport,
    script_scan: ScanReport,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    unpacked_path: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostFile {
    developer_mode: bool,
    safe_mode: bool,
    style_order: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JournalFile {
    boot_id: String,
    activation_started: bool,
    clean_exit: bool,
}

#[derive(Clone, Debug)]
pub struct RuntimeToken {
    pub token: String,
    pub plugin_id: String,
    pub permissions: HashSet<PluginPermission>,
    #[allow(dead_code)]
    pub granted: Vec<String>,
    pub network_origins: HashSet<String>,
}

#[derive(Debug, Error)]
pub enum HostError {
    #[error("{0}")]
    Message(String),
}

impl HostError {
    fn from(message: impl Into<String>) -> Self {
        Self::Message(message.into())
    }
}

struct RateBucket {
    window_start_ms: u64,
    count: u32,
}

pub struct ExtensionHost {
    root: PathBuf,
    inner: Mutex<HostInner>,
    provider_runtime: Mutex<ProviderRuntimeState>,
    runtime_seq: AtomicU64,
    updates: updates::UpdateState,
}

#[derive(Default)]
struct ProviderRuntimeState {
    registry: Option<Arc<ProviderRegistry>>,
    host_services: Option<ComponentHostServices>,
    active: HashMap<String, ActiveComponentProvider>,
    federations: HashMap<String, Vec<String>>,
    restore_accounts_on_activation: bool,
}

struct ActiveComponentProvider {
    plugin_id: String,
    provider_id: String,
    adapter: Arc<ComponentProviderAdapter>,
    registered: bool,
}

struct HostInner {
    host: HostFile,
    journal: JournalFile,
    records: BTreeMap<String, (PluginStateFile, PluginManifest, PathBuf)>,
    runtimes: HashMap<String, RuntimeToken>,
    storage: HashMap<String, BTreeMap<String, String>>,
    settings: HashMap<String, crate::plugin::settings::ValidatedSettings>,
    rates: HashMap<String, RateBucket>,
}

impl ExtensionHost {
    pub fn open(root: PathBuf) -> Result<Self, HostError> {
        fs::create_dir_all(&root)
            .map_err(|_| HostError::from("plugin storage could not be created"))?;
        let recovered_update = updates::recover(&root)?;
        let mut host: HostFile = read_json(&root.join("host.json")).unwrap_or_default();
        let previous: JournalFile = read_json(&root.join("journal.json")).unwrap_or_default();
        let crashed = previous.activation_started && !previous.clean_exit && !recovered_update;
        if crashed {
            host.safe_mode = true;
        }
        let mut journal = JournalFile {
            boot_id: format!("{:x}", now_ms()),
            activation_started: false,
            clean_exit: false,
        };
        write_json(&root.join("host.json"), &host)?;
        write_json(&root.join("journal.json"), &journal)?;
        let mut records = BTreeMap::new();
        if let Ok(entries) = fs::read_dir(&root) {
            for entry in entries.flatten() {
                let Ok(file_type) = entry.file_type() else {
                    continue;
                };
                if !file_type.is_dir() || file_type.is_symlink() {
                    continue;
                }
                let state_path = entry.path().join("state.json");
                let Some(mut state): Option<PluginStateFile> = read_json(&state_path) else {
                    continue;
                };
                if !is_plugin_id(&state.id) || entry.file_name().to_string_lossy() != state.id {
                    continue;
                }
                let version_dir = updates::package_path(&root, &state)?;
                let manifest_path = version_dir.join("manifest.json");
                let Ok(bytes) = fs::read(&manifest_path) else {
                    continue;
                };
                let Ok(manifest) = PluginManifest::parse(&bytes) else {
                    continue;
                };
                let integrity_error = match inspect_directory(&version_dir) {
                    Ok(inspection)
                        if inspection.manifest.id == state.id
                            && inspection.manifest.version == state.active_version =>
                    {
                        if state.content_sha256.is_empty() {
                            state.content_sha256 = inspection.sha256;
                            persist_state(&root, &state, &manifest, version_dir.clone())?;
                            None
                        } else if state.content_sha256 == inspection.sha256 {
                            None
                        } else {
                            Some("plugin package content hash mismatch")
                        }
                    }
                    Ok(_) => Some("plugin package manifest identity mismatch"),
                    Err(_) => Some("plugin package integrity check failed"),
                };
                if let Some(reason) = integrity_error {
                    state.enabled = false;
                    state.status = PluginStatus::Failed;
                    state.status_reason = Some(reason.into());
                    persist_state(&root, &state, &manifest, version_dir.clone())?;
                }
                records.insert(state.id.clone(), (state, manifest, version_dir));
            }
        }
        if crashed {
            for (state, manifest, dir) in records.values_mut() {
                if state.enabled {
                    state.enabled = false;
                    state.status = PluginStatus::Failed;
                    state.status_reason =
                        Some("disabled after an unclean shutdown during plugin activation".into());
                    let _ = persist_state(&root, state, manifest, dir.clone());
                }
            }
        }
        if records.values().any(|(state, _, _)| state.enabled) {
            journal.activation_started = true;
            write_json(&root.join("journal.json"), &journal)?;
        }
        let mut storage = HashMap::new();
        let mut settings = HashMap::new();
        if let Ok(entries) = fs::read_dir(&root) {
            for entry in entries.flatten() {
                let path = entry.path();
                let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                    continue;
                };
                if let Some(plugin_id) = name.strip_suffix(".storage.json") {
                    if let Some(namespace) = read_json::<BTreeMap<String, String>>(&path) {
                        storage.insert(plugin_id.to_owned(), namespace);
                    }
                }
                if let Some(plugin_id) = name.strip_suffix(".settings.json") {
                    if let Some(values) = read_json::<BTreeMap<String, serde_json::Value>>(&path) {
                        let mut validated = crate::plugin::settings::ValidatedSettings {
                            values,
                            ..Default::default()
                        };
                        if let Some(secrets) = read_json::<BTreeMap<String, String>>(
                            &root.join(format!("{plugin_id}.secrets.json")),
                        ) {
                            validated.secrets = secrets;
                        }
                        settings.insert(plugin_id.to_owned(), validated);
                    }
                }
            }
        }
        Ok(Self {
            updates: updates::UpdateState::open(&root),
            root,
            inner: Mutex::new(HostInner {
                host,
                journal,
                records,
                runtimes: HashMap::new(),
                storage,
                settings,
                rates: HashMap::new(),
            }),
            provider_runtime: Mutex::new(ProviderRuntimeState::default()),
            runtime_seq: AtomicU64::new(1),
        })
    }

    pub fn attach_provider_registry(
        &self,
        registry: Arc<ProviderRegistry>,
    ) -> Result<(), HostError> {
        self.attach_provider_state(registry, None)
    }

    pub(crate) fn inspect_component_cache(&self, clear: bool) -> Result<(u64, u64), String> {
        let services = self
            .provider_runtime
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .host_services
            .clone();
        services.map_or(Ok((0, 0)), |services| services.inspect_cache(clear))
    }

    pub fn attach_provider_runtime(
        &self,
        registry: Arc<ProviderRegistry>,
        credentials: Arc<dyn CredentialStore>,
        cache_root: PathBuf,
        runtime: tokio::runtime::Handle,
    ) -> Result<(), HostError> {
        let services = ComponentHostServices::open(
            self.root.join("component-data"),
            cache_root,
            credentials,
            runtime,
        )
        .map_err(HostError::from)?;
        self.recover_update_credentials(&services)?;
        self.attach_provider_state(registry, Some(services))
    }

    fn attach_provider_state(
        &self,
        registry: Arc<ProviderRegistry>,
        host_services: Option<ComponentHostServices>,
    ) -> Result<(), HostError> {
        {
            let mut runtime = self
                .provider_runtime
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if runtime.registry.is_some() {
                return Err(HostError::from(
                    "the plugin provider registry is already attached",
                ));
            }
            runtime.registry = Some(registry);
            runtime.host_services = host_services;
        }
        self.register_installed_provider_descriptors();
        self.reconcile_provider_plugins();
        Ok(())
    }

    fn register_installed_provider_descriptors(&self) {
        let registry = self
            .provider_runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .registry
            .clone();
        let Some(registry) = registry else { return };
        let providers = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .records
            .values()
            .flat_map(|(_, manifest, _)| {
                manifest
                    .provider_declarations()
                    .into_iter()
                    .map(|provider| {
                        let has = |capability| provider.capabilities.contains(&capability);
                        (
                            provider.id.clone(),
                            provider
                                .name
                                .clone()
                                .unwrap_or_else(|| manifest.name.clone()),
                            ProviderCapabilitySummary {
                                catalog: has(crate::plugin::manifest::ProviderCapability::Catalog),
                                playback: has(
                                    crate::plugin::manifest::ProviderCapability::Playback,
                                ),
                                recommendations: has(
                                    crate::plugin::manifest::ProviderCapability::Recommendation,
                                ),
                                lyrics: has(crate::plugin::manifest::ProviderCapability::Lyrics),
                                comments: has(
                                    crate::plugin::manifest::ProviderCapability::Comments,
                                ),
                                share: false,
                                account: has(crate::plugin::manifest::ProviderCapability::Account),
                            },
                        )
                    })
            })
            .collect::<Vec<_>>();
        for (id, name, capabilities) in providers {
            let _ = registry.register_inactive(id, name, capabilities);
        }
    }

    pub async fn restore_provider_accounts(&self) {
        let (registry, provider_ids) = {
            let mut runtime = self
                .provider_runtime
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            runtime.restore_accounts_on_activation = true;
            let Some(registry) = runtime.registry.clone() else {
                return;
            };
            let provider_ids = registry.provider_ids().collect::<Vec<_>>();
            (registry, provider_ids)
        };
        for provider_id in provider_ids {
            if let Ok(account) = registry.require_account_provider(provider_id.as_str()) {
                account.provider_account().restore_session().await;
            }
        }
    }

    fn reconcile_provider_plugins(&self) {
        let desired = {
            let inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if inner.host.safe_mode {
                Vec::new()
            } else {
                inner
                    .records
                    .iter()
                    .filter(|(_, (state, manifest, _))| state.enabled && manifest.api_version == 3)
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>()
            }
        };
        let desired_set = desired.iter().cloned().collect::<HashSet<_>>();
        let installed = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .records
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for id in installed {
            if !desired_set.contains(&id) {
                if let Err(error) = self.deactivate_provider_plugin(&id) {
                    tracing::warn!(target: "plugin.provider", plugin_id = %id, error = %error, "provider plugin could not be deactivated cleanly");
                }
            }
        }
        for id in desired {
            if let Err(error) = self.activate_provider_plugin(&id) {
                let reason = error.to_string();
                let _ = self.deactivate_provider_plugin(&id);
                let _ = self.mark_provider_failed_state(&id, &reason);
                tracing::error!(target: "plugin.provider", plugin_id = %id, error = %error, "provider plugin activation failed");
            }
        }
    }

    fn reconcile_provider_plugin(
        &self,
        id: &str,
        enabled: bool,
    ) -> Result<PluginRecord, HostError> {
        let transition = if enabled {
            self.activate_provider_plugin(id)
        } else {
            self.deactivate_provider_plugin(id)
        };
        if let Err(error) = transition {
            let reason = error.to_string();
            let _ = self.deactivate_provider_plugin(id);
            let _ = self.mark_provider_failed_state(id, &reason);
            return Err(error);
        }
        self.record(id)
    }

    fn activate_provider_plugin(&self, id: &str) -> Result<(), HostError> {
        let (manifest, dir, granted, enabled, session_epochs, session_secret_fields) = {
            let inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some((state, manifest, dir)) = inner.records.get(id) else {
                return Err(HostError::from("the plugin is not installed"));
            };
            (
                manifest.clone(),
                dir.clone(),
                state.granted_permissions.clone(),
                state.enabled && !inner.host.safe_mode,
                state.session_epochs.clone(),
                state.session_secret_fields.clone(),
            )
        };
        if enabled {
            let state = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .records
                .get(id)
                .map(|(state, _, _)| state.clone())
                .ok_or_else(|| HostError::from("the plugin is not installed"))?;
            if !package_matches_state(&state, &manifest, &dir) {
                return Err(HostError::from("plugin package integrity check failed"));
            }
        }
        if manifest.api_version != 3 || !enabled {
            return Ok(());
        }
        let settings = self
            .settings_get(&manifest.id, true)
            .unwrap_or_else(|_| serde_json::json!({}));
        let mode = settings
            .get("mode")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("isolated");
        if !matches!(mode, "isolated" | "aggregate") {
            return Err(HostError::from("the plugin mode setting is invalid"));
        }
        let declarations = manifest.provider_declarations();
        let active_declarations = declarations.clone();
        if active_declarations.is_empty() {
            return Err(HostError::from("the plugin does not declare a provider"));
        }
        let provider_ids = active_declarations
            .iter()
            .map(|provider| provider.id.clone())
            .collect::<Vec<_>>();
        let partially_active = {
            let runtime = self
                .provider_runtime
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if provider_ids.iter().any(|provider_id| {
                runtime
                    .active
                    .get(provider_id)
                    .is_some_and(|active| active.plugin_id != id)
            }) {
                return Err(HostError::from(
                    "a provider ID is already owned by another plugin",
                ));
            }
            if provider_ids.iter().all(|provider_id| {
                runtime
                    .active
                    .get(provider_id)
                    .is_some_and(|active| active.plugin_id == id)
            }) {
                for provider_id in &provider_ids {
                    if let Some(active) = runtime.active.get(provider_id) {
                        active.adapter.component().enable();
                    }
                }
                return Ok(());
            }
            provider_ids.iter().any(|provider_id| {
                runtime
                    .active
                    .get(provider_id)
                    .is_some_and(|active| active.plugin_id == id)
            })
        };
        if partially_active {
            self.deactivate_provider_plugin(id)?;
        }
        let (registry, host_services, restore_account) = {
            let runtime = self
                .provider_runtime
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            (
                runtime.registry.clone().ok_or_else(|| {
                    HostError::from("the plugin provider registry is not attached")
                })?,
                runtime.host_services.clone(),
                runtime.restore_accounts_on_activation,
            )
        };
        let component_path = manifest
            .entrypoints
            .component
            .as_ref()
            .ok_or_else(|| HostError::from("the provider component entrypoint is missing"))?;
        let bytes = fs::read(dir.join(component_path))
            .map_err(|_| HostError::from("the provider component entrypoint is missing"))?;
        let allowed_origins = granted
            .iter()
            .filter_map(|permission| {
                crate::plugin::permissions::parse_permission(permission)
                    .ok()
                    .and_then(|(_, origin)| origin)
            })
            .collect::<HashSet<_>>();
        let runtime_handle = host_services
            .as_ref()
            .map(ComponentHostServices::runtime_handle);
        let mut adapters = Vec::<(String, Arc<ComponentProviderAdapter>)>::new();
        for provider in active_declarations {
            for capability in &provider.capabilities {
                if !granted
                    .iter()
                    .any(|permission| permission == capability.as_str())
                {
                    return Err(HostError::from("the provider capability was not granted"));
                }
            }
            let host = host_services.as_ref().map(|services| {
                let services = self
                    .staged_component_services(id)
                    .unwrap_or_else(|| services.clone());
                let epoch = session_epochs.get(&provider.id).map(String::as_str);
                let mut provider_settings = settings.clone();
                if epoch.is_some() {
                    if let Some(schema) = &manifest.settings_schema {
                        for field in crate::plugin::settings::parse_settings_fields(schema)
                            .unwrap_or_default()
                        {
                            if field.secret
                                && !session_secret_fields
                                    .get(&provider.id)
                                    .is_some_and(|fields| fields.contains(&field.id))
                            {
                                if let Some(object) = provider_settings.as_object_mut() {
                                    object.remove(&field.id);
                                }
                            }
                        }
                    }
                }
                services.for_plugin_session(
                    &manifest.id,
                    &provider.id,
                    allowed_origins.clone(),
                    provider_settings,
                    epoch,
                )
            });
            let adapter = if let Some(compiled) = self.precompiled_component(id) {
                ComponentProviderAdapter::from_precompiled(&manifest, provider, compiled, host)
            } else {
                ComponentProviderAdapter::from_manifest_with_provider(
                    &manifest, provider, &bytes, host,
                )
            }
            .map_err(|error| HostError::from(error.to_string()))?;
            if self.staged_component_services(id).is_some() {
                adapter
                    .component()
                    .validate_start()
                    .map_err(|e| HostError::from(e.to_string()))?;
            }
            adapters.push((provider.id.clone(), adapter));
        }
        let mut activated = Vec::<(String, Arc<ComponentProviderAdapter>)>::new();
        for (provider_id, adapter) in adapters {
            if let Err(error) = registry
                .register_capabilities(adapter.provider_id(), adapter.registry_capabilities())
            {
                Self::rollback_registered_components(&registry, &activated, &[]);
                return Err(HostError::from(error.to_string()));
            }
            activated.push((provider_id, adapter));
        }
        let mut federation_ids = Vec::new();
        if settings
            .get("mode")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|mode| mode == "aggregate")
        {
            for federation in manifest.federation_declarations() {
                let mut members = Vec::new();
                if federation.include_default_provider {
                    let provider_id = registry.default_id().to_string();
                    if let (Ok(catalog), Ok(playback), Ok(lyrics)) = (
                        registry.require_catalog_provider(&provider_id),
                        registry.require_playback_provider(&provider_id),
                        registry.require_lyrics_provider(&provider_id),
                    ) {
                        members.push(FederationMember {
                            provider_id: provider_id.clone(),
                            profile_id: yaqmc_provider_api::DEFAULT_PROFILE_ID.to_owned(),
                            catalog,
                            playback: Some(playback),
                            lyrics: Some(lyrics),
                            comments: registry
                                .require_comments_provider_for_profile(Some(&provider_id), None)
                                .ok(),
                        });
                    }
                }
                for member_id in &federation.members {
                    let Ok(catalog) = registry.require_catalog_provider(member_id) else {
                        continue;
                    };
                    let playback = registry.require_playback_provider(member_id).ok();
                    let lyrics = registry.require_lyrics_provider(member_id).ok();
                    members.push(FederationMember {
                        provider_id: member_id.clone(),
                        profile_id: yaqmc_provider_api::DEFAULT_PROFILE_ID.to_owned(),
                        catalog,
                        playback,
                        lyrics,
                        comments: registry
                            .require_comments_provider_for_profile(Some(member_id), None)
                            .ok(),
                    });
                }
                if members.is_empty() {
                    continue;
                }
                let federated = FederatedProvider::new(
                    federation.id.clone(),
                    federation
                        .name
                        .clone()
                        .unwrap_or_else(|| "YAQMC Music Platforms".to_owned()),
                    members,
                );
                let capabilities = federated.registry_capabilities();
                if let Err(error) = registry.register_capabilities(&federation.id, capabilities) {
                    Self::rollback_registered_components(&registry, &activated, &federation_ids);
                    return Err(HostError::from(error.to_string()));
                }
                federation_ids.push(federation.id.clone());
            }
        }
        {
            let mut runtime = self
                .provider_runtime
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            for (provider_id, adapter) in &activated {
                runtime.active.insert(
                    provider_id.clone(),
                    ActiveComponentProvider {
                        plugin_id: id.to_owned(),
                        provider_id: adapter.provider_id().to_owned(),
                        adapter: Arc::clone(adapter),
                        registered: true,
                    },
                );
            }
            if !federation_ids.is_empty() {
                runtime
                    .federations
                    .insert(id.to_owned(), federation_ids.clone());
            }
        }
        if restore_account && !self.update_in_progress(id) {
            for (_, adapter) in &activated {
                if let (Some(runtime_handle), Ok(account)) = (
                    runtime_handle.clone(),
                    registry.require_account_provider(adapter.provider_id()),
                ) {
                    runtime_handle.spawn(async move {
                        account.provider_account().restore_session().await;
                    });
                }
            }
        }
        Ok(())
    }

    fn rollback_registered_components(
        registry: &ProviderRegistry,
        active: &[(String, Arc<ComponentProviderAdapter>)],
        federation_ids: &[String],
    ) {
        for (_, adapter) in active {
            adapter.component().disable();
        }
        for federation_id in federation_ids {
            let _ = registry.unregister(federation_id);
            registry.forget_inactive(federation_id);
        }
        for (_, adapter) in active {
            let _ = registry.unregister(adapter.provider_id());
        }
    }

    fn deactivate_provider_plugin(&self, id: &str) -> Result<(), HostError> {
        let provider_ids = {
            let inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            inner
                .records
                .get(id)
                .map(|(_, manifest, _)| {
                    manifest
                        .provider_declarations()
                        .into_iter()
                        .map(|provider| provider.id.clone())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        };
        let (registry, active, federation_ids) = {
            let mut runtime = self
                .provider_runtime
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let active = provider_ids
                .iter()
                .filter_map(|provider_id| {
                    let owned = runtime
                        .active
                        .get(provider_id)
                        .is_some_and(|active| active.plugin_id == id);
                    owned.then(|| runtime.active.remove(provider_id)).flatten()
                })
                .collect::<Vec<_>>();
            let federation_ids = runtime.federations.remove(id).unwrap_or_default();
            (runtime.registry.clone(), active, federation_ids)
        };
        if active.is_empty() && federation_ids.is_empty() {
            return Ok(());
        }
        for active in &active {
            active.adapter.component().disable();
        }
        if let Some(registry) = registry {
            for active in active {
                if active.registered {
                    registry
                        .unregister(&active.provider_id)
                        .map_err(|error| HostError::from(error.to_string()))?;
                }
            }
            for federation_id in federation_ids {
                registry
                    .unregister(&federation_id)
                    .map_err(|error| HostError::from(error.to_string()))?;
                registry.forget_inactive(&federation_id);
            }
        }
        Ok(())
    }

    fn mark_provider_failed_state(&self, id: &str, reason: &str) -> Result<(), HostError> {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some((state, manifest, dir)) = inner.records.get_mut(id) else {
            return Ok(());
        };
        state.enabled = false;
        state.status = PluginStatus::Failed;
        state.status_reason = Some(reason.to_owned());
        persist_state(&self.root, state, manifest, dir.clone())
    }

    fn record(&self, id: &str) -> Result<PluginRecord, HostError> {
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (state, manifest, _) = inner
            .records
            .get(id)
            .ok_or_else(|| HostError::from("the plugin is not installed"))?;
        Ok(self.decorate_record(to_record(state, manifest, inner.host.safe_mode)))
    }

    fn decorate_record(&self, mut record: PluginRecord) -> PluginRecord {
        let provider_id = record.provider.as_ref().map(|provider| provider.id.clone());
        if let Some(provider) = record.provider.as_mut() {
            if let Some(active) = self
                .provider_runtime
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .active
                .get(provider_id.as_deref().unwrap_or(&record.id))
            {
                provider.circuit_open = active.adapter.component().circuit_open();
                provider.consecutive_faults = active.adapter.component().consecutive_faults();
            }
        }
        record
    }

    fn finish_provider_transition(&self, record: PluginRecord) -> Result<PluginRecord, HostError> {
        if record.api_version == 3 {
            self.reconcile_provider_plugin(&record.id, record.enabled)
        } else {
            Ok(record)
        }
    }

    pub fn mark_clean_exit(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.journal.clean_exit = true;
            let _ = write_json(&self.root.join("journal.json"), &inner.journal);
        }
    }

    pub fn inspect_path(&self, path: &Path) -> Result<PackageInspection, HostError> {
        inspect_package(path).map_err(|error| HostError::from(error.to_string()))
    }

    pub fn list(&self) -> Vec<PluginRecord> {
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner
            .records
            .values()
            .map(|(state, manifest, _)| {
                self.decorate_record(to_record(state, manifest, inner.host.safe_mode))
            })
            .collect()
    }

    pub fn diagnostics(&self) -> Vec<PluginDiagnostic> {
        self.list()
            .into_iter()
            .map(|record| PluginDiagnostic {
                id: record.id,
                version: record.version,
                enabled: record.enabled,
                status: record.status,
                entrypoint_kinds: {
                    let mut kinds = Vec::new();
                    if record.entrypoints.styles > 0 {
                        kinds.push("style".into());
                    }
                    if record.entrypoints.scenes > 0 {
                        kinds.push("scene".into());
                    }
                    if record.entrypoints.script {
                        kinds.push("script".into());
                    }
                    if record.entrypoints.component {
                        kinds.push("component".into());
                    }
                    kinds
                },
                api_version: record.api_version,
                package_sha256: record.package_sha256,
                permissions: record.granted_permissions,
                risk_rating: record.risk_rating,
            })
            .collect()
    }

    pub fn developer_mode(&self) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .host
            .developer_mode
    }

    pub fn set_developer_mode(&self, enabled: bool) -> Result<(), HostError> {
        let _mutation = self.mutation_guard("*")?;
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner.host.developer_mode = enabled;
        write_json(&self.root.join("host.json"), &inner.host)
    }

    pub fn safe_mode(&self) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .host
            .safe_mode
    }

    pub fn set_safe_mode(&self, enabled: bool) -> Result<(), HostError> {
        let _mutation = self.mutation_guard("*")?;
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner.host.safe_mode = enabled;
        write_json(&self.root.join("host.json"), &inner.host)?;
        drop(inner);
        self.reconcile_provider_plugins();
        Ok(())
    }

    pub fn install(
        &self,
        path: &Path,
        enable: bool,
        grant: &[String],
    ) -> Result<PluginRecord, HostError> {
        let inspection =
            inspect_package(path).map_err(|error| HostError::from(error.to_string()))?;
        if self.record(&inspection.manifest.id).is_ok() {
            return Err(HostError::from(
                "use plugin_update_prepare to review an installed plugin replacement",
            ));
        }
        if css_is_blocked(&inspection.style_scan) {
            return Err(HostError::from(
                "the style entrypoint uses blocked remote or filesystem CSS",
            ));
        }
        let record = self.install_inspection(inspection, enable, grant, "local-file")?;
        self.finish_provider_transition(record)
    }

    pub fn install_loose_css(&self, path: &Path) -> Result<PluginRecord, HostError> {
        let inspection = Self::inspect_loose_css(path)?;
        if self.record(&inspection.manifest.id).is_ok() {
            return Err(HostError::from(
                "use plugin_update_prepare to review an installed plugin replacement",
            ));
        }
        self.install_inspection(inspection, true, &[], "loose-css")
    }

    fn inspect_loose_css(path: &Path) -> Result<PackageInspection, HostError> {
        use std::io::Read;
        let mut source = String::new();
        fs::File::open(path)
            .map_err(|_| HostError::from("the CSS file could not be read"))?
            .take(crate::plugin::LEGACY_MAX_COMPRESSED_BYTES + 1)
            .read_to_string(&mut source)
            .map_err(|_| HostError::from("the CSS file could not be read"))?;
        if source.len() as u64 > crate::plugin::LEGACY_MAX_COMPRESSED_BYTES {
            return Err(HostError::from("the CSS file is too large"));
        }
        let scan = crate::plugin::scanner::scan_css(&source);
        if css_is_blocked(&scan) {
            return Err(HostError::from(
                "the CSS file uses blocked remote resources",
            ));
        }
        let stem = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("style")
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() {
                    ch.to_ascii_lowercase()
                } else {
                    '-'
                }
            })
            .collect::<String>();
        let id = format!("local.css.{stem}");
        let id = if is_plugin_id(&id) {
            id
        } else {
            format!("local.css.import-{}", &sha256_bytes(stem.as_bytes())[..8])
        };
        let manifest = PluginManifest {
            manifest_version: 1,
            id: id.clone(),
            name: stem,
            description: Some("Local CSS convenience import".into()),
            version: "0.0.0-local".into(),
            release: None,
            api_version: 2,
            authors: Vec::new(),
            homepage: None,
            repository: None,
            license: None,
            engines: Default::default(),
            platforms: Vec::new(),
            architectures: Vec::new(),
            entrypoints: crate::plugin::manifest::PluginEntrypoints {
                styles: vec!["styles/main.css".into()],
                scenes: Vec::new(),
                script: None,
                component: None,
            },
            provider: None,
            providers: Vec::new(),
            federations: Vec::new(),
            permissions: Vec::new(),
            dependencies: BTreeMap::new(),
            conflicts: Vec::new(),
            settings_schema: None,
            signatures: None,
        };
        let inspection = PackageInspection {
            sha256: sha256_bytes(source.as_bytes()),
            compressed_bytes: source.len() as u64,
            expanded_bytes: source.len() as u64,
            file_count: 2,
            manifest: manifest.clone(),
            files: vec![
                crate::plugin::package::PackageFile {
                    path: "manifest.json".into(),
                    bytes: serde_json::to_vec_pretty(&manifest).unwrap_or_default(),
                },
                crate::plugin::package::PackageFile {
                    path: "styles/main.css".into(),
                    bytes: source.into_bytes(),
                },
            ],
            style_scan: scan,
            script_scan: ScanReport::default(),
        };
        Ok(inspection)
    }

    pub fn install_unpacked(
        &self,
        path: &Path,
        enable: bool,
        grant: &[String],
    ) -> Result<PluginRecord, HostError> {
        if !self.developer_mode() {
            return Err(HostError::from(
                "unpacked plugins can only be loaded in Developer Mode",
            ));
        }
        let inspection =
            inspect_package(path).map_err(|error| HostError::from(error.to_string()))?;
        if self.record(&inspection.manifest.id).is_ok() {
            return Err(HostError::from(
                "use plugin_update_prepare to review an installed plugin replacement",
            ));
        }
        if let Some(message) = crate::plugin::package::stale_typescript_message(&inspection.files) {
            return Err(HostError::from(message));
        }
        if css_is_blocked(&inspection.style_scan) {
            return Err(HostError::from(
                "the style entrypoint uses blocked remote or filesystem CSS",
            ));
        }
        let mut record = self.install_inspection(inspection, enable, grant, "unpacked")?;
        self.set_unpacked_path(&record.id, path)?;
        record.unpacked_path = Some(path.display().to_string());
        self.finish_provider_transition(record)
    }

    fn set_unpacked_path(&self, id: &str, path: &Path) -> Result<(), HostError> {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some((state, manifest, dir)) = inner.records.get_mut(id) else {
            return Err(HostError::from("the plugin is not installed"));
        };
        state.unpacked_path = Some(path.display().to_string());
        persist_state(&self.root, state, manifest, dir.clone())
    }

    /// Compatibility entry point: replacement now requires a prepared review.
    pub fn reload(&self, id: &str) -> Result<PluginRecord, HostError> {
        self.record(id)?;
        Err(HostError::from(
            "use plugin_update_prepare with the unpacked path to review a reload",
        ))
    }

    fn install_inspection(
        &self,
        inspection: PackageInspection,
        enable: bool,
        grant: &[String],
        source: &str,
    ) -> Result<PluginRecord, HostError> {
        let _mutation = self.mutation_guard(&inspection.manifest.id)?;
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((existing, _, _)) = inner.records.get(&inspection.manifest.id) {
            if existing.enabled {
                return Err(HostError::from(
                    "disable the current version before installing an update",
                ));
            }
        }
        if let Some(reason) = compatibility_reason(&inspection.manifest, &inner.records) {
            let version_dir = self.version_dir(&inspection.manifest);
            let staging = version_dir.with_extension("staging");
            let _ = fs::remove_dir_all(&staging);
            extract_to(&inspection, &staging)
                .map_err(|error| HostError::from(error.to_string()))?;
            atomic_replace(&staging, &version_dir)?;
            let state = PluginStateFile {
                id: inspection.manifest.id.clone(),
                active_version: inspection.manifest.version.clone(),
                active_package: None,
                release: inspection.manifest.release.clone(),
                session_epochs: BTreeMap::new(),
                session_secret_fields: BTreeMap::new(),
                retained_session_namespaces: Vec::new(),
                generation: 0,
                enabled: false,
                status: PluginStatus::Incompatible,
                status_reason: Some(reason.clone()),
                granted_permissions: Vec::new(),
                package_sha256: inspection.sha256.clone(),
                content_sha256: content_sha256(&inspection.files),
                source: source.to_owned(),
                style_scan: inspection.style_scan.clone(),
                script_scan: inspection.script_scan.clone(),
                unpacked_path: None,
            };
            persist_state(
                &self.root,
                &state,
                &inspection.manifest,
                version_dir.clone(),
            )?;
            inner.records.insert(
                state.id.clone(),
                (state.clone(), inspection.manifest.clone(), version_dir),
            );
            return Ok(to_record(
                &state,
                &inspection.manifest,
                inner.host.safe_mode,
            ));
        }
        let previous_granted: HashSet<String> = inner
            .records
            .get(&inspection.manifest.id)
            .map(|(state, _, _)| state.granted_permissions.iter().cloned().collect())
            .unwrap_or_default();
        let requested = inspection.manifest.requested_permission_keys();
        if enable {
            for key in &requested {
                let is_expansion = !previous_granted.is_empty() && !previous_granted.contains(key);
                if (permission_key_sensitive(key) || is_expansion)
                    && !grant.iter().any(|value| value == key)
                {
                    return Err(HostError::from(
                        "new or sensitive permissions must be explicitly accepted",
                    ));
                }
            }
        }
        let version_dir = self.version_dir(&inspection.manifest);
        let staging = version_dir.with_extension("staging");
        let _ = fs::remove_dir_all(&staging);
        extract_to(&inspection, &staging).map_err(|error| HostError::from(error.to_string()))?;
        atomic_replace(&staging, &version_dir)?;
        let granted: Vec<String> = if enable { requested } else { Vec::new() };
        let state = PluginStateFile {
            id: inspection.manifest.id.clone(),
            active_version: inspection.manifest.version.clone(),
            active_package: None,
            release: inspection.manifest.release.clone(),
            session_epochs: BTreeMap::new(),
            session_secret_fields: BTreeMap::new(),
            retained_session_namespaces: Vec::new(),
            generation: 0,
            enabled: enable && !inner.host.safe_mode,
            status: if enable && !inner.host.safe_mode {
                PluginStatus::Active
            } else {
                PluginStatus::Disabled
            },
            status_reason: None,
            granted_permissions: granted,
            package_sha256: inspection.sha256.clone(),
            content_sha256: content_sha256(&inspection.files),
            source: source.to_owned(),
            style_scan: inspection.style_scan.clone(),
            script_scan: inspection.script_scan.clone(),
            unpacked_path: None,
        };
        persist_state(
            &self.root,
            &state,
            &inspection.manifest,
            version_dir.clone(),
        )?;
        if enable {
            inner.journal.activation_started = true;
            write_json(&self.root.join("journal.json"), &inner.journal)?;
        }
        if !inner.host.style_order.contains(&state.id) {
            inner.host.style_order.push(state.id.clone());
            write_json(&self.root.join("host.json"), &inner.host)?;
        }
        inner.records.insert(
            state.id.clone(),
            (state.clone(), inspection.manifest.clone(), version_dir),
        );
        Ok(to_record(
            &state,
            &inspection.manifest,
            inner.host.safe_mode,
        ))
    }

    #[allow(dead_code)]
    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<PluginRecord, HostError> {
        self.set_enabled_with_grants(id, enabled, &[])
    }

    pub fn set_enabled_with_grants(
        &self,
        id: &str,
        enabled: bool,
        grants: &[String],
    ) -> Result<PluginRecord, HostError> {
        let _mutation = self.mutation_guard(id)?;
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let safe_mode = inner.host.safe_mode;
        if enabled && safe_mode {
            return Err(HostError::from(
                "safe mode has disabled third-party plugins",
            ));
        }
        let Some((existing, manifest, _)) = inner.records.get(id) else {
            return Err(HostError::from("the plugin is not installed"));
        };
        let manifest = manifest.clone();
        let mut granted = existing.granted_permissions.clone();
        if let Some(reason) = compatibility_reason(&manifest, &inner.records) {
            drop_enable_locked(
                &mut inner,
                id,
                PluginStatus::Incompatible,
                Some(reason.clone()),
            )?;
            persist_locked(&self.root, &inner, id)?;
            return Err(HostError::from(reason));
        }
        if enabled {
            if let Some(reason) = missing_dependency(&manifest, &inner.records) {
                drop_enable_locked(
                    &mut inner,
                    id,
                    PluginStatus::Incompatible,
                    Some(reason.clone()),
                )?;
                persist_locked(&self.root, &inner, id)?;
                return Err(HostError::from(reason));
            }
            if dependency_cycle(id, &manifest, &inner.records) {
                return Err(HostError::from("plugin dependency cycle detected"));
            }
            for key in manifest.requested_permission_keys() {
                let already = granted.iter().any(|value| value == &key);
                if permission_key_sensitive(&key)
                    && !already
                    && !grants.iter().any(|value| value == &key)
                {
                    return Err(HostError::from(
                        "sensitive permissions must be explicitly accepted",
                    ));
                }
                if !already
                    && (!permission_key_sensitive(&key) || grants.iter().any(|value| value == &key))
                {
                    granted.push(key);
                }
            }
            inner.journal.activation_started = true;
            write_json(&self.root.join("journal.json"), &inner.journal)?;
        } else {
            inner.runtimes.retain(|_, runtime| runtime.plugin_id != id);
        }
        let (state, stored_manifest, dir) = inner
            .records
            .get_mut(id)
            .ok_or_else(|| HostError::from("the plugin is not installed"))?;
        state.granted_permissions = granted;
        state.generation = state.generation.saturating_add(1);
        state.enabled = enabled;
        state.status = if enabled {
            PluginStatus::Active
        } else {
            PluginStatus::Disabled
        };
        state.status_reason = None;
        persist_state(&self.root, state, stored_manifest, dir.clone())?;
        let record = to_record(state, stored_manifest, safe_mode);
        drop(inner);
        self.finish_provider_transition(record)
    }

    pub fn mark_failed(&self, id: &str, reason: &str) -> Result<PluginRecord, HostError> {
        let _mutation = self.mutation_guard(id)?;
        let _ = self.deactivate_provider_plugin(id);
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner.runtimes.retain(|_, runtime| runtime.plugin_id != id);
        let safe_mode = inner.host.safe_mode;
        let (state, manifest, dir) = inner
            .records
            .get_mut(id)
            .ok_or_else(|| HostError::from("the plugin is not installed"))?;
        state.enabled = false;
        state.status = PluginStatus::Failed;
        state.status_reason = Some(reason.to_owned());
        state.generation = state.generation.saturating_add(1);
        persist_state(&self.root, state, manifest, dir.clone())?;
        Ok(to_record(state, manifest, safe_mode))
    }

    pub fn install_loose_script(&self, path: &Path) -> Result<PluginRecord, HostError> {
        let inspection = Self::inspect_loose_script(path)?;
        if self.record(&inspection.manifest.id).is_ok() {
            return Err(HostError::from(
                "use plugin_update_prepare to review an installed plugin replacement",
            ));
        }
        self.install_inspection(inspection, false, &[], "loose-script")
    }

    fn inspect_loose_script(path: &Path) -> Result<PackageInspection, HostError> {
        use std::io::Read;
        let mut source = String::new();
        fs::File::open(path)
            .map_err(|_| HostError::from("the script file could not be read"))?
            .take(crate::plugin::LEGACY_MAX_COMPRESSED_BYTES + 1)
            .read_to_string(&mut source)
            .map_err(|_| HostError::from("the script file could not be read"))?;
        if source.len() as u64 > crate::plugin::LEGACY_MAX_COMPRESSED_BYTES {
            return Err(HostError::from("the script file is too large"));
        }
        let scan = crate::plugin::scanner::scan_script(&source);
        let stem = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("script")
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() {
                    ch.to_ascii_lowercase()
                } else {
                    '-'
                }
            })
            .collect::<String>();
        let id = format!("local.script.{stem}");
        let id = if is_plugin_id(&id) {
            id
        } else {
            format!(
                "local.script.import-{}",
                &sha256_bytes(stem.as_bytes())[..8]
            )
        };
        let manifest = PluginManifest {
            manifest_version: 1,
            id: id.clone(),
            name: stem,
            description: Some("Local script convenience import".into()),
            version: "0.0.0-local".into(),
            release: None,
            api_version: 2,
            authors: Vec::new(),
            homepage: None,
            repository: None,
            license: None,
            engines: Default::default(),
            platforms: Vec::new(),
            architectures: Vec::new(),
            entrypoints: crate::plugin::manifest::PluginEntrypoints {
                styles: Vec::new(),
                scenes: Vec::new(),
                script: Some("dist/main.js".into()),
                component: None,
            },
            provider: None,
            providers: Vec::new(),
            federations: Vec::new(),
            permissions: Vec::new(),
            dependencies: BTreeMap::new(),
            conflicts: Vec::new(),
            settings_schema: None,
            signatures: None,
        };
        let inspection = PackageInspection {
            sha256: sha256_bytes(source.as_bytes()),
            compressed_bytes: source.len() as u64,
            expanded_bytes: source.len() as u64,
            file_count: 2,
            manifest: manifest.clone(),
            files: vec![
                crate::plugin::package::PackageFile {
                    path: "manifest.json".into(),
                    bytes: serde_json::to_vec_pretty(&manifest).unwrap_or_default(),
                },
                crate::plugin::package::PackageFile {
                    path: "dist/main.js".into(),
                    bytes: source.into_bytes(),
                },
            ],
            style_scan: ScanReport::default(),
            script_scan: scan,
        };
        Ok(inspection)
    }

    pub fn active_resources(&self) -> ActivePluginResources {
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if inner.host.safe_mode {
            return ActivePluginResources {
                safe_mode: true,
                developer_mode: inner.host.developer_mode,
                style_order: inner.host.style_order.clone(),
                styles: Vec::new(),
                scenes: Vec::new(),
                scripts: Vec::new(),
            };
        }
        let mut styles = Vec::new();
        let mut seen_styles = HashSet::new();
        for id in inner.host.style_order.iter().chain(inner.records.keys()) {
            if !seen_styles.insert(id.clone()) {
                continue;
            }
            let Some((state, manifest, dir)) = inner.records.get(id) else {
                continue;
            };
            if !state.enabled && self.update_phase(id).as_deref() != Some("validating") {
                continue;
            }
            if !package_matches_state(state, manifest, dir) {
                continue;
            }
            for style in &manifest.entrypoints.styles {
                let Ok(css) = fs::read_to_string(dir.join(style)) else {
                    continue;
                };
                styles.push(ActiveStyleSheet {
                    plugin_id: id.clone(),
                    css,
                });
            }
        }
        let mut scenes = Vec::new();
        let mut scripts = Vec::new();
        for (id, (state, manifest, dir)) in &inner.records {
            if !state.enabled && self.update_phase(id).as_deref() != Some("validating") {
                continue;
            }
            if !package_matches_state(state, manifest, dir) {
                continue;
            }
            for scene_path in &manifest.entrypoints.scenes {
                let Ok(bytes) = fs::read(dir.join(scene_path)) else {
                    continue;
                };
                let Ok(definition) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
                    continue;
                };
                let scene_id = definition
                    .get("id")
                    .and_then(|value| value.as_str())
                    .unwrap_or("scene")
                    .to_owned();
                let css_path = scene_css_path(scene_path);
                let css = fs::read_to_string(dir.join(&css_path)).ok();
                scenes.push(ActiveSceneResource {
                    plugin_id: id.clone(),
                    plugin_name: manifest.name.clone(),
                    scene_id,
                    css,
                    definition,
                });
            }
            if let Some(script) = &manifest.entrypoints.script {
                if let Ok(source) = fs::read_to_string(dir.join(script)) {
                    scripts.push(ActiveScriptResource {
                        plugin_id: id.clone(),
                        plugin_name: manifest.name.clone(),
                        source,
                        package_sha256: state.package_sha256.clone(),
                    });
                }
            }
        }
        ActivePluginResources {
            safe_mode: false,
            developer_mode: inner.host.developer_mode,
            style_order: inner.host.style_order.clone(),
            styles,
            scenes,
            scripts,
        }
    }

    pub fn uninstall(&self, id: &str, remove_data: bool) -> Result<(), HostError> {
        let _mutation = self.mutation_guard(id)?;
        self.deactivate_provider_plugin(id)?;
        let provider_ids = {
            let inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            inner
                .records
                .get(id)
                .map(|(_, manifest, _)| {
                    manifest
                        .provider_declarations()
                        .into_iter()
                        .map(|provider| provider.id.clone())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        };
        let provider_registry = self
            .provider_runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .registry
            .clone();
        if remove_data {
            let services = self
                .provider_runtime
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .host_services
                .clone();
            if let Some(services) = services {
                for provider_id in &provider_ids {
                    if let Err(error) = services.remove_plugin_data(id, provider_id) {
                        let _ = self.activate_provider_plugin(id);
                        return Err(HostError::from(error));
                    }
                }
                let namespaces = self
                    .inner
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .records
                    .get(id)
                    .map(|(state, manifest, _)| {
                        let mut namespaces = state.retained_session_namespaces.clone();
                        for provider in manifest.provider_declarations() {
                            namespaces.push(crate::plugin::component_host::session_namespace(
                                id,
                                &provider.id,
                                state.session_epochs.get(&provider.id).map(String::as_str),
                            ));
                        }
                        namespaces
                    })
                    .unwrap_or_default();
                for namespace in namespaces {
                    services
                        .remove_namespace_data(&namespace)
                        .map_err(HostError::from)?;
                }
            }
        }
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner.records.remove(id);
        inner.host.style_order.retain(|candidate| candidate != id);
        inner.runtimes.retain(|_, runtime| runtime.plugin_id != id);
        if let Some(registry) = provider_registry {
            for provider_id in provider_ids {
                registry.forget_inactive(&provider_id);
            }
        }
        let plugin_root = self.root.join(id);
        let _ = fs::remove_dir_all(&plugin_root);
        if remove_data {
            inner.storage.remove(id);
            inner.settings.remove(id);
            let _ = fs::remove_file(self.root.join(format!("{id}.storage.json")));
            let _ = fs::remove_file(self.root.join(format!("{id}.settings.json")));
            let _ = fs::remove_file(self.root.join(format!("{id}.secrets.json")));
        }
        write_json(&self.root.join("host.json"), &inner.host)
    }

    #[allow(dead_code)]
    pub fn style_order(&self) -> Vec<String> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .host
            .style_order
            .clone()
    }

    #[allow(dead_code)]
    pub fn read_installed_text(&self, id: &str, relative: &str) -> Result<String, HostError> {
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (state, manifest, dir) = inner
            .records
            .get(id)
            .ok_or_else(|| HostError::from("the plugin is not installed"))?;
        if !package_matches_state(state, manifest, dir) {
            return Err(HostError::from("plugin package integrity check failed"));
        }
        crate::plugin::manifest::is_safe_package_path(relative)
            .then_some(())
            .ok_or_else(|| HostError::from("invalid plugin path"))?;
        let path = dir.join(relative);
        if !path.starts_with(dir) {
            return Err(HostError::from("invalid plugin path"));
        }
        fs::read_to_string(path).map_err(|_| HostError::from("plugin file is missing"))
    }

    pub fn start_runtime(&self, plugin_id: &str) -> Result<RuntimeToken, HostError> {
        let phase = self.update_phase(plugin_id);
        if phase.as_deref().is_some_and(|phase| phase != "validating") {
            return Err(HostError::from("update-validation-in-progress"));
        }
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if inner.host.safe_mode {
            return Err(HostError::from("safe mode has disabled plugin scripts"));
        }
        let (state, manifest, dir) = inner
            .records
            .get(plugin_id)
            .ok_or_else(|| HostError::from("the plugin is not installed"))?;
        if !state.enabled && phase.as_deref() != Some("validating") {
            return Err(HostError::from("the plugin is disabled"));
        }
        if !package_matches_state(state, manifest, dir) {
            return Err(HostError::from("plugin package integrity check failed"));
        }
        let token = format!(
            "rt-{}-{}",
            self.runtime_seq.fetch_add(1, Ordering::AcqRel),
            now_ms()
        );
        let mut permissions = HashSet::new();
        let mut network_origins = HashSet::new();
        for value in &state.granted_permissions {
            if let Ok((permission, origin)) = crate::plugin::permissions::parse_permission(value) {
                permissions.insert(permission);
                if let Some(origin) = origin {
                    network_origins.insert(origin);
                }
            }
        }
        let runtime = RuntimeToken {
            token: token.clone(),
            plugin_id: plugin_id.to_owned(),
            permissions,
            granted: state.granted_permissions.clone(),
            network_origins,
        };
        inner.runtimes.insert(token, runtime.clone());
        Ok(runtime)
    }

    pub fn stop_runtime(&self, token: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.runtimes.remove(token);
        }
    }

    pub fn runtime(&self, token: &str) -> Option<RuntimeToken> {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| inner.runtimes.get(token).cloned())
    }

    pub fn check_permission(
        &self,
        token: &str,
        permission: PluginPermission,
    ) -> Result<RuntimeToken, HostError> {
        let runtime = self
            .runtime(token)
            .ok_or_else(|| HostError::from("unknown plugin runtime"))?;
        if !runtime.permissions.contains(&permission) {
            return Err(HostError::from(
                "the plugin was not granted this permission",
            ));
        }
        Ok(runtime)
    }

    pub fn rate_limit(&self, plugin_id: &str, key: &str, limit: u32) -> Result<(), HostError> {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = now_ms();
        let bucket_key = format!("{plugin_id}:{key}");
        let bucket = inner.rates.entry(bucket_key).or_insert(RateBucket {
            window_start_ms: now,
            count: 0,
        });
        if now.saturating_sub(bucket.window_start_ms) >= 1_000 {
            bucket.window_start_ms = now;
            bucket.count = 0;
        }
        bucket.count += 1;
        if bucket.count > limit {
            return Err(HostError::from("plugin rate limit exceeded"));
        }
        Ok(())
    }

    pub fn storage_get(&self, plugin_id: &str, key: &str) -> Option<String> {
        self.inner
            .lock()
            .ok()?
            .storage
            .get(plugin_id)?
            .get(key)
            .cloned()
    }

    pub fn storage_set(&self, plugin_id: &str, key: &str, value: &str) -> Result<(), HostError> {
        if key.len() > 64 || value.len() > 4_096 {
            return Err(HostError::from("plugin storage entry is too large"));
        }
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let namespace = inner.storage.entry(plugin_id.to_owned()).or_default();
        namespace.insert(key.to_owned(), value.to_owned());
        let encoded = serde_json::to_string(namespace).unwrap_or_default();
        if encoded.len() > PLUGIN_STORAGE_QUOTA {
            namespace.remove(key);
            return Err(HostError::from("plugin storage quota exceeded"));
        }
        write_json(&self.update_storage_path(plugin_id), namespace)
    }

    pub fn settings_get(
        &self,
        plugin_id: &str,
        include_secrets: bool,
    ) -> Result<serde_json::Value, HostError> {
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (_, manifest, _) = inner
            .records
            .get(plugin_id)
            .ok_or_else(|| HostError::from("the plugin is not installed"))?;
        let schema = manifest
            .settings_schema
            .clone()
            .unwrap_or(serde_json::json!({ "fields": [] }));
        let fields =
            crate::plugin::settings::parse_settings_fields(&schema).map_err(HostError::from)?;
        let stored = inner
            .settings
            .get(plugin_id)
            .cloned()
            .unwrap_or_else(|| crate::plugin::settings::defaults_from_schema(&schema));
        if include_secrets {
            let mut map = serde_json::Map::new();
            for field in &fields {
                if field.secret {
                    if let Some(secret) = stored.secrets.get(&field.id) {
                        map.insert(field.id.clone(), serde_json::Value::String(secret.clone()));
                    }
                } else if let Some(value) = stored.values.get(&field.id) {
                    map.insert(field.id.clone(), value.clone());
                }
            }
            Ok(serde_json::Value::Object(map))
        } else {
            Ok(crate::plugin::settings::public_settings(&fields, &stored))
        }
    }

    pub fn settings_set(
        &self,
        plugin_id: &str,
        patch: serde_json::Map<String, serde_json::Value>,
    ) -> Result<serde_json::Value, HostError> {
        let _mutation = self.mutation_guard(plugin_id)?;
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (_, manifest, _) = inner
            .records
            .get(plugin_id)
            .ok_or_else(|| HostError::from("the plugin is not installed"))?;
        let schema = manifest
            .settings_schema
            .clone()
            .ok_or_else(|| HostError::from("this plugin has no settings schema"))?;
        let current = inner
            .settings
            .get(plugin_id)
            .cloned()
            .unwrap_or_else(|| crate::plugin::settings::defaults_from_schema(&schema));
        let next = crate::plugin::settings::validate_settings_write(&schema, &patch, &current)
            .map_err(HostError::from)?;
        write_json(
            &self.root.join(format!("{plugin_id}.settings.json")),
            &next.values,
        )?;
        write_json(
            &self.root.join(format!("{plugin_id}.secrets.json")),
            &next.secrets,
        )?;
        let fields =
            crate::plugin::settings::parse_settings_fields(&schema).map_err(HostError::from)?;
        let public = crate::plugin::settings::public_settings(&fields, &next);
        inner.settings.insert(plugin_id.to_owned(), next);
        if let Some((state, manifest, dir)) = inner.records.get_mut(plugin_id) {
            state.generation = state.generation.saturating_add(1);
            for provider in state.session_epochs.keys() {
                let allowed = state
                    .session_secret_fields
                    .entry(provider.clone())
                    .or_default();
                for field in &fields {
                    if field.secret && patch.contains_key(&field.id) && !allowed.contains(&field.id)
                    {
                        allowed.push(field.id.clone());
                    }
                }
            }
            persist_state(&self.root, state, manifest, dir.clone())?;
        }
        let enabled = inner
            .records
            .get(plugin_id)
            .is_some_and(|(state, _, _)| state.enabled);
        drop(inner);
        if enabled {
            self.deactivate_provider_plugin(plugin_id)?;
            self.activate_provider_plugin(plugin_id)?;
        }
        Ok(public)
    }

    pub fn read_asset(
        &self,
        plugin_id: &str,
        relative: &str,
    ) -> Result<(String, Vec<u8>), HostError> {
        if !relative.starts_with("assets/") {
            return Err(HostError::from("plugin assets must live under assets/"));
        }
        crate::plugin::manifest::is_safe_package_path(relative)
            .then_some(())
            .ok_or_else(|| HostError::from("invalid plugin asset path"))?;
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (state, _, dir) = inner
            .records
            .get(plugin_id)
            .ok_or_else(|| HostError::from("the plugin is not installed"))?;
        if !state.enabled {
            return Err(HostError::from("the plugin is disabled"));
        }
        let path = dir.join(relative);
        if !path.starts_with(dir) {
            return Err(HostError::from("invalid plugin asset path"));
        }
        let bytes = fs::read(&path).map_err(|_| HostError::from("plugin asset is missing"))?;
        let mime = match path.extension().and_then(|value| value.to_str()) {
            Some("png") => "image/png",
            Some("jpg") | Some("jpeg") => "image/jpeg",
            Some("webp") => "image/webp",
            Some("gif") => "image/gif",
            Some("svg") => "image/svg+xml",
            Some("webm") => "video/webm",
            Some("mp4") => "video/mp4",
            Some("woff2") => "font/woff2",
            _ => "application/octet-stream",
        };
        Ok((mime.to_owned(), bytes))
    }

    fn version_dir(&self, manifest: &PluginManifest) -> PathBuf {
        self.root
            .join(&manifest.id)
            .join("versions")
            .join(&manifest.version)
    }
}

fn permission_key_sensitive(key: &str) -> bool {
    crate::plugin::permissions::parse_permission(key)
        .map(|(permission, _)| permission.sensitive())
        .unwrap_or(true)
}

fn scene_css_path(scene_path: &str) -> String {
    if let Some(stem) = scene_path.strip_suffix(".scene.json") {
        return format!("{stem}.css");
    }
    scene_path
        .rsplit_once('.')
        .map(|(stem, _)| format!("{stem}.css"))
        .unwrap_or_default()
}

fn compatibility_reason(
    manifest: &PluginManifest,
    installed: &BTreeMap<String, (PluginStateFile, PluginManifest, PathBuf)>,
) -> Option<String> {
    if let Some(reason) = manifest.compatibility_issue() {
        return Some(reason);
    }
    if let Some(conflict) = manifest
        .conflicts
        .iter()
        .find(|conflict| *conflict != &manifest.id && installed.contains_key(*conflict))
    {
        return Some(format!("conflicts with {conflict}"));
    }
    missing_dependency(manifest, installed)
}

fn dependency_cycle(
    id: &str,
    manifest: &PluginManifest,
    installed: &BTreeMap<String, (PluginStateFile, PluginManifest, PathBuf)>,
) -> bool {
    fn visit(
        current: &str,
        stack: &mut Vec<String>,
        installed: &BTreeMap<String, (PluginStateFile, PluginManifest, PathBuf)>,
    ) -> bool {
        if stack.iter().any(|value| value == current) {
            return true;
        }
        stack.push(current.to_owned());
        if let Some((_, other, _)) = installed.get(current) {
            for dependency in other.dependencies.keys() {
                if visit(dependency, stack, installed) {
                    return true;
                }
            }
        }
        stack.pop();
        false
    }
    let mut stack = vec![id.to_owned()];
    manifest
        .dependencies
        .keys()
        .any(|dependency| visit(dependency, &mut stack, installed))
}

fn drop_enable_locked(
    inner: &mut HostInner,
    id: &str,
    status: PluginStatus,
    reason: Option<String>,
) -> Result<(), HostError> {
    if let Some((state, _, _)) = inner.records.get_mut(id) {
        state.enabled = false;
        state.status = status;
        state.status_reason = reason;
    }
    Ok(())
}

fn persist_locked(root: &Path, inner: &HostInner, id: &str) -> Result<(), HostError> {
    let Some((state, manifest, dir)) = inner.records.get(id) else {
        return Ok(());
    };
    persist_state(root, state, manifest, dir.clone())
}

fn missing_dependency(
    manifest: &PluginManifest,
    installed: &BTreeMap<String, (PluginStateFile, PluginManifest, PathBuf)>,
) -> Option<String> {
    for (dependency, range) in &manifest.dependencies {
        let Some((_, other, _)) = installed.get(dependency) else {
            return Some(format!("missing dependency {dependency} {range}"));
        };
        if let (Some(need), Some(have)) = (
            parse_semver(range.trim_start_matches('^').trim_start_matches(">=")),
            parse_semver(&other.version),
        ) {
            if have < need {
                return Some(format!("missing dependency {dependency} {range}"));
            }
        }
    }
    None
}

fn to_record(state: &PluginStateFile, manifest: &PluginManifest, safe_mode: bool) -> PluginRecord {
    let enabled = state.enabled && !safe_mode;
    PluginRecord {
        id: manifest.id.clone(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        release: state.release.clone().or_else(|| manifest.release.clone()),
        description: manifest.description.clone(),
        authors: manifest.authors.clone(),
        enabled,
        status: if safe_mode && state.enabled {
            PluginStatus::Disabled
        } else {
            state.status
        },
        status_reason: if safe_mode && state.enabled {
            Some("safe mode disabled third-party plugins".into())
        } else {
            state.status_reason.clone()
        },
        api_version: manifest.api_version,
        package_sha256: state.package_sha256.clone(),
        source: state.source.clone(),
        unsigned: !state.source.starts_with("trusted:"),
        entrypoints: EntrypointSummary {
            styles: manifest.entrypoints.styles.len(),
            scenes: manifest.entrypoints.scenes.len(),
            script: manifest.entrypoints.script.is_some(),
            component: manifest.entrypoints.component.is_some(),
        },
        provider: manifest
            .provider
            .as_ref()
            .map(|provider| ProviderEntrypointSummary {
                id: provider.id.clone(),
                wit_version: provider.wit_version.clone(),
                world: provider.world.clone(),
                capabilities: provider
                    .capabilities
                    .iter()
                    .map(|capability| capability.as_str().to_owned())
                    .collect(),
                circuit_open: false,
                consecutive_faults: 0,
            }),
        permissions: manifest.requested_permission_keys(),
        granted_permissions: state.granted_permissions.clone(),
        risk_rating: if state.script_scan.severity.is_some() {
            state.script_scan.rating().to_owned()
        } else {
            state.style_scan.rating().to_owned()
        },
        style_scan: state.style_scan.clone(),
        script_scan: state.script_scan.clone(),
        compatible: !matches!(state.status, PluginStatus::Incompatible),
        platforms: manifest.platforms.clone(),
        settings_schema: manifest.settings_schema.clone(),
        network_origins: manifest
            .requested_permission_keys()
            .into_iter()
            .filter(|key| key.starts_with("network:"))
            .map(|key| key.trim_start_matches("network:").to_owned())
            .collect(),
        unpacked_path: state.unpacked_path.clone(),
        last_error: state.status_reason.clone(),
    }
}

fn persist_state(
    root: &Path,
    state: &PluginStateFile,
    _manifest: &PluginManifest,
    _dir: PathBuf,
) -> Result<(), HostError> {
    let plugin_root = root.join(&state.id);
    fs::create_dir_all(&plugin_root)
        .map_err(|_| HostError::from("plugin state could not be saved"))?;
    write_json(&plugin_root.join("state.json"), state)
}

fn package_matches_state(state: &PluginStateFile, manifest: &PluginManifest, dir: &Path) -> bool {
    if state.content_sha256.is_empty() {
        return false;
    }
    inspect_directory(dir).is_ok_and(|inspection| {
        inspection.manifest.id == state.id
            && inspection.manifest.version == manifest.version
            && inspection.sha256 == state.content_sha256
    })
}

fn atomic_replace(staging: &Path, destination: &Path) -> Result<(), HostError> {
    if destination.exists() {
        let backup = destination.with_extension("previous");
        let _ = fs::remove_dir_all(&backup);
        fs::rename(destination, &backup)
            .map_err(|_| HostError::from("plugin version could not be replaced"))?;
        if fs::rename(staging, destination).is_err() {
            let _ = fs::rename(&backup, destination);
            return Err(HostError::from("plugin version could not be replaced"));
        }
        let _ = fs::remove_dir_all(&backup);
        return Ok(());
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| HostError::from("plugin version could not be created"))?;
    }
    fs::rename(staging, destination)
        .map_err(|_| HostError::from("plugin version could not be created"))
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), HostError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| HostError::from("plugin state could not be saved"))?;
    }
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|_| HostError::from("plugin state could not be saved"))?;
    updates::atomic_bytes(path, &bytes).map_err(HostError::from)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::scanner::ScanReport;
    use crate::plugin::{
        component::static_test_component, manifest::ProviderCapability, package::PackageFile,
    };
    use serde_json::json;
    use yaqmc_provider_api::{CredentialStore, ProviderRegistry};

    pub(super) fn style_inspection(id: &str) -> PackageInspection {
        let manifest = PluginManifest::parse(
            format!(
                r#"{{
                    "manifestVersion": 1,
                    "id": "{id}",
                    "name": "Demo",
                    "version": "1.0.0",
                    "apiVersion": 1,
                    "entrypoints": {{ "styles": ["styles/main.css"] }}
                }}"#
            )
            .as_bytes(),
        )
        .expect("manifest");
        PackageInspection {
            sha256: sha256_bytes(id.as_bytes()),
            compressed_bytes: 12,
            expanded_bytes: 12,
            file_count: 2,
            files: vec![
                PackageFile {
                    path: "manifest.json".into(),
                    bytes: serde_json::to_vec(&manifest).unwrap(),
                },
                PackageFile {
                    path: "styles/main.css".into(),
                    bytes: b"[data-yaqmc=\"player-bar\"]{border-radius:8px}".to_vec(),
                },
            ],
            manifest,
            style_scan: ScanReport::default(),
            script_scan: ScanReport::default(),
        }
    }

    pub(super) fn component_inspection(plugin_id: &str, provider_id: &str) -> PackageInspection {
        let manifest = PluginManifest::parse(
            format!(
                r#"{{
                    "manifestVersion": 2,
                    "id": "{plugin_id}",
                    "name": "Catalog Component",
                    "version": "1.0.0",
                    "apiVersion": 3,
                    "entrypoints": {{ "component": "component/provider.wasm" }},
                    "provider": {{
                        "id": "{provider_id}",
                        "witVersion": "0.1.0",
                        "world": "provider",
                        "capabilities": ["provider.catalog"]
                    }},
                    "permissions": ["provider.catalog"]
                }}"#
            )
            .as_bytes(),
        )
        .expect("component manifest");
        let component = wat::parse_str(static_test_component("{}"))
            .expect("component fixture compiles to binary");
        PackageInspection {
            sha256: sha256_bytes(&component),
            compressed_bytes: component.len() as u64,
            expanded_bytes: component.len() as u64,
            file_count: 2,
            files: vec![
                PackageFile {
                    path: "manifest.json".into(),
                    bytes: serde_json::to_vec(&manifest).expect("manifest bytes"),
                },
                PackageFile {
                    path: "component/provider.wasm".into(),
                    bytes: component,
                },
            ],
            manifest,
            style_scan: ScanReport::default(),
            script_scan: ScanReport::default(),
        }
    }

    pub(super) fn account_component_inspection() -> PackageInspection {
        let manifest = PluginManifest::parse(
            br#"{
                "manifestVersion": 2,
                "id": "dev.example.host-probe",
                "name": "Host Probe Component",
                "version": "1.0.0",
                "apiVersion": 3,
                "entrypoints": { "component": "component/provider.wasm" },
                "provider": {
                    "id": "provider.host-probe",
                    "witVersion": "0.1.0",
                    "world": "provider-account",
                    "capabilities": ["provider.catalog", "provider.account"]
                },
                "permissions": [
                    "provider.catalog",
                    "provider.account",
                    "plugin.storage",
                    "network:https://api.example.com"
                ]
            }"#,
        )
        .expect("account component manifest");
        let component = include_bytes!("../../tests/fixtures/component-host-guest.wasm").to_vec();
        PackageInspection {
            sha256: sha256_bytes(&component),
            compressed_bytes: component.len() as u64,
            expanded_bytes: component.len() as u64,
            file_count: 2,
            files: vec![
                PackageFile {
                    path: "manifest.json".into(),
                    bytes: serde_json::to_vec(&manifest).expect("manifest bytes"),
                },
                PackageFile {
                    path: "component/provider.wasm".into(),
                    bytes: component,
                },
            ],
            manifest,
            style_scan: ScanReport::default(),
            script_scan: ScanReport::default(),
        }
    }

    pub(super) fn multi_provider_component_inspection() -> PackageInspection {
        let manifest: PluginManifest = serde_json::from_value(json!({
            "manifestVersion": 2,
            "id": "org.example.multi-music",
            "name": "Multi Music Component",
            "version": "1.0.0",
            "apiVersion": 3,
            "entrypoints": { "component": "component/provider.wasm" },
            "providers": [
                {
                    "id": "org.example.multi-music.spotify",
                    "name": "Spotify",
                    "platform": "spotify",
                    "witVersion": "0.1.0",
                    "world": "provider-account",
                    "capabilities": [
                        "provider.catalog",
                        "provider.playback",
                        "provider.lyrics",
                        "provider.account"
                    ]
                },
                {
                    "id": "org.example.multi-music.netease",
                    "name": "NetEase",
                    "platform": "netease",
                    "witVersion": "0.1.0",
                    "world": "provider-account",
                    "capabilities": [
                        "provider.catalog",
                        "provider.playback",
                        "provider.lyrics",
                        "provider.account"
                    ]
                },
                {
                    "id": "org.example.multi-music.kugou",
                    "name": "KuGou",
                    "platform": "kugou",
                    "witVersion": "0.1.0",
                    "world": "provider-account",
                    "capabilities": [
                        "provider.catalog",
                        "provider.playback",
                        "provider.lyrics",
                        "provider.account"
                    ]
                }
            ],
            "federations": [{
                "id": "org.example.multi-music.aggregate",
                "name": "All Music",
                "members": [
                    "org.example.multi-music.spotify",
                    "org.example.multi-music.netease",
                    "org.example.multi-music.kugou"
                ],
                "includeDefaultProvider": true
            }],
            "permissions": [
                "provider.catalog",
                "provider.playback",
                "provider.lyrics",
                "provider.account",
                "plugin.storage",
                "network:https://api.example.com"
            ],
            "settingsSchema": {
                "fields": [
                    {
                        "id": "mode",
                        "type": "select",
                        "options": ["isolated", "aggregate"],
                        "default": "isolated"
                    }
                ]
            }
        }))
        .expect("multi-provider manifest");
        let component = include_bytes!("../../tests/fixtures/component-host-guest.wasm").to_vec();
        PackageInspection {
            sha256: sha256_bytes(&component),
            compressed_bytes: component.len() as u64,
            expanded_bytes: component.len() as u64,
            file_count: 2,
            files: vec![
                PackageFile {
                    path: "manifest.json".into(),
                    bytes: serde_json::to_vec(&manifest).expect("manifest bytes"),
                },
                PackageFile {
                    path: "component/provider.wasm".into(),
                    bytes: component,
                },
            ],
            manifest,
            style_scan: ScanReport::default(),
            script_scan: ScanReport::default(),
        }
    }

    fn expanded_component_inspection() -> PackageInspection {
        let manifest = PluginManifest::parse(
            br#"{
                "manifestVersion": 2,
                "id": "dev.example.permission-expansion",
                "name": "Expanded Provider Component",
                "version": "1.1.0",
                "apiVersion": 3,
                "entrypoints": { "component": "component/provider.wasm" },
                "provider": {
                    "id": "provider.permission-expansion",
                    "witVersion": "0.1.0",
                    "world": "provider-account",
                    "capabilities": [
                        "provider.catalog",
                        "provider.playback",
                        "provider.recommendation",
                        "provider.lyrics",
                        "provider.account"
                    ]
                },
                "permissions": [
                    "provider.catalog",
                    "provider.playback",
                    "provider.recommendation",
                    "provider.lyrics",
                    "provider.account",
                    "plugin.storage",
                    "network:https://accounts.example.com"
                ]
            }"#,
        )
        .expect("expanded component manifest");
        let component = include_bytes!("../../tests/fixtures/component-host-guest.wasm").to_vec();
        PackageInspection {
            sha256: sha256_bytes(&component),
            compressed_bytes: component.len() as u64,
            expanded_bytes: component.len() as u64,
            file_count: 2,
            files: vec![
                PackageFile {
                    path: "manifest.json".into(),
                    bytes: serde_json::to_vec(&manifest).expect("manifest bytes"),
                },
                PackageFile {
                    path: "component/provider.wasm".into(),
                    bytes: component,
                },
            ],
            manifest,
            style_scan: ScanReport::default(),
            script_scan: ScanReport::default(),
        }
    }

    pub(super) fn provider_registry(root: &Path) -> Arc<ProviderRegistry> {
        let storage = Arc::new(
            crate::storage::StorageService::open(root.join("data"), root.join("cache"))
                .expect("storage"),
        );
        let credentials: Arc<dyn CredentialStore> =
            Arc::new(crate::credentials::MemoryCredentialStore::default());
        let provider = yaqmc_provider_qqmusic::create_intree_provider(
            storage,
            credentials,
            root.join("fixtures"),
        )
        .expect("built-in provider");
        Arc::new(ProviderRegistry::new("qqmusic", [provider]).expect("registry"))
    }

    #[test]
    fn component_provider_lifecycle_is_atomic_with_extension_host_state() {
        let root = tempfile::tempdir().expect("root");
        let host = ExtensionHost::open(root.path().join("plugins")).expect("host");
        let registry = provider_registry(root.path());
        host.attach_provider_registry(Arc::clone(&registry))
            .expect("attach");

        let record = host
            .install_inspection(
                component_inspection("dev.example.component", "plugin.example"),
                true,
                &[],
                "test",
            )
            .expect("install");
        host.finish_provider_transition(record).expect("activate");
        assert!(registry.contains("plugin.example"));
        assert!(host.active_resources().scripts.is_empty());

        host.set_enabled("dev.example.component", false)
            .expect("disable");
        assert!(!registry.contains("plugin.example"));
        host.set_enabled("dev.example.component", true)
            .expect("reenable");
        assert!(registry.contains("plugin.example"));

        host.set_safe_mode(true).expect("safe mode");
        assert!(!registry.contains("plugin.example"));
        host.set_safe_mode(false).expect("leave safe mode");
        assert!(registry.contains("plugin.example"));

        host.uninstall("dev.example.component", true)
            .expect("uninstall");
        assert!(!registry.contains("plugin.example"));
    }

    #[test]
    fn duplicate_component_provider_id_fails_closed_without_replacing_owner() {
        let root = tempfile::tempdir().expect("root");
        let host = ExtensionHost::open(root.path().join("plugins")).expect("host");
        let registry = provider_registry(root.path());
        host.attach_provider_registry(Arc::clone(&registry))
            .expect("attach");
        let first = host
            .install_inspection(
                component_inspection("dev.example.first", "plugin.shared"),
                true,
                &[],
                "test",
            )
            .expect("first install");
        host.finish_provider_transition(first)
            .expect("first activate");
        let second = host
            .install_inspection(
                component_inspection("dev.example.second", "plugin.shared"),
                true,
                &[],
                "test",
            )
            .expect("second install");
        assert!(host.finish_provider_transition(second).is_err());
        assert!(registry.contains("plugin.shared"));
        let failed = host
            .list()
            .into_iter()
            .find(|record| record.id == "dev.example.second")
            .expect("failed record");
        assert_eq!(failed.status, PluginStatus::Failed);
        assert!(!failed.enabled);
    }

    #[tokio::test]
    async fn multi_provider_modes_keep_individual_providers_and_toggle_federation_atomically() {
        let root = tempfile::tempdir().expect("root");
        let mut host = ExtensionHost::open(root.path().join("plugins")).expect("host");
        let mut registry = provider_registry(root.path());
        host.attach_provider_runtime(
            Arc::clone(&registry),
            Arc::new(crate::credentials::MemoryCredentialStore::default()),
            root.path().join("component-cache"),
            tokio::runtime::Handle::current(),
        )
        .expect("attach");
        let inspection = multi_provider_component_inspection();
        let grants = inspection.manifest.requested_permission_keys();
        let record = host
            .install_inspection(inspection, true, &grants, "test")
            .expect("install");
        host.finish_provider_transition(record).expect("activate");

        assert!(registry.contains("qqmusic"));
        for provider in ["spotify", "netease", "kugou"] {
            assert!(registry.contains(&format!("org.example.multi-music.{provider}")));
        }
        assert!(!registry.contains("org.example.multi-music.aggregate"));

        let aggregate = serde_json::Map::from_iter([("mode".to_owned(), json!("aggregate"))]);
        host.settings_set("org.example.multi-music", aggregate)
            .expect("aggregate settings");
        for provider in ["spotify", "netease", "kugou"] {
            assert!(registry.contains(&format!("org.example.multi-music.{provider}")));
        }
        assert!(registry.contains("org.example.multi-music.aggregate"));

        let isolated = serde_json::Map::from_iter([("mode".to_owned(), json!("isolated"))]);
        host.settings_set("org.example.multi-music", isolated)
            .expect("isolated settings");
        assert!(registry.contains("qqmusic"));
        for provider in ["spotify", "netease", "kugou"] {
            assert!(registry.contains(&format!("org.example.multi-music.{provider}")));
        }
        assert!(!registry.contains("org.example.multi-music.aggregate"));
        assert!(!registry
            .descriptors()
            .iter()
            .any(|descriptor| { descriptor.provider_id == "org.example.multi-music.aggregate" }));

        for mode in ["aggregate", "isolated"] {
            host.settings_set(
                "org.example.multi-music",
                serde_json::Map::from_iter([("mode".to_owned(), json!(mode))]),
            )
            .expect("mode before restart");
            host.mark_clean_exit();
            drop(host);
            host = ExtensionHost::open(root.path().join("plugins")).expect("reopened host");
            registry = provider_registry(root.path());
            host.attach_provider_runtime(
                Arc::clone(&registry),
                Arc::new(crate::credentials::MemoryCredentialStore::default()),
                root.path().join("component-cache"),
                tokio::runtime::Handle::current(),
            )
            .expect("reattach");
            let descriptors = registry.descriptors();
            assert_eq!(descriptors.len(), if mode == "aggregate" { 5 } else { 4 });
            assert!(descriptors.iter().all(|descriptor| descriptor.available));
            assert_eq!(
                descriptors.iter().any(|descriptor| {
                    descriptor.provider_id == "org.example.multi-music.aggregate"
                }),
                mode == "aggregate"
            );
        }
    }

    #[tokio::test]
    async fn account_components_restore_at_startup_and_after_reenable() {
        let root = tempfile::tempdir().expect("root");
        let host = ExtensionHost::open(root.path().join("plugins")).expect("host");
        let registry = provider_registry(root.path());
        let credentials: Arc<dyn CredentialStore> =
            Arc::new(crate::credentials::MemoryCredentialStore::default());
        host.attach_provider_runtime(
            Arc::clone(&registry),
            credentials,
            root.path().join("component-cache"),
            tokio::runtime::Handle::current(),
        )
        .expect("attach");
        let inspection = account_component_inspection();
        let grants = inspection.manifest.requested_permission_keys();
        let record = host
            .install_inspection(inspection, true, &grants, "test")
            .expect("install");
        host.finish_provider_transition(record).expect("activate");

        let account = registry
            .require_account_provider("provider.host-probe")
            .expect("account capability");
        let initial_generation = account.provider_account().account_generation();
        host.restore_provider_accounts().await;
        assert_eq!(
            account.provider_account().account_generation(),
            initial_generation + 1
        );

        host.set_enabled("dev.example.host-probe", false)
            .expect("disable");
        host.set_enabled("dev.example.host-probe", true)
            .expect("reenable");
        let restored = registry
            .require_account_provider("provider.host-probe")
            .expect("restored account capability");
        for _ in 0..32 {
            if restored.provider_account().account_generation() > initial_generation {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(restored.provider_account().account_generation() > initial_generation);
    }

    #[tokio::test]
    async fn component_host_authority_is_revoked_across_disable_and_remove_data() {
        let root = tempfile::tempdir().expect("root");
        let host = ExtensionHost::open(root.path().join("plugins")).expect("host");
        let registry = provider_registry(root.path());
        let credentials: Arc<dyn CredentialStore> =
            Arc::new(crate::credentials::MemoryCredentialStore::default());
        host.attach_provider_runtime(
            Arc::clone(&registry),
            credentials,
            root.path().join("component-cache"),
            tokio::runtime::Handle::current(),
        )
        .expect("attach");
        let grants = account_component_inspection()
            .manifest
            .requested_permission_keys();
        let record = host
            .install_inspection(account_component_inspection(), true, &grants, "test")
            .expect("install");
        host.finish_provider_transition(record).expect("activate");
        let first = host
            .provider_runtime
            .lock()
            .expect("runtime")
            .active
            .get("provider.host-probe")
            .expect("active")
            .adapter
            .component()
            .clone();
        assert_eq!(
            first
                .invoke(ProviderCapability::Catalog, "test.storage", "retained")
                .await,
            Ok("retained".to_owned())
        );

        host.set_enabled("dev.example.host-probe", false)
            .expect("disable");
        assert_eq!(
            first
                .invoke(ProviderCapability::Catalog, "test.storage", "blocked")
                .await,
            Err(crate::plugin::component::ComponentRuntimeError::Disabled)
        );
        host.set_enabled("dev.example.host-probe", true)
            .expect("re-enable");
        assert!(registry.contains("provider.host-probe"));

        let services = host
            .provider_runtime
            .lock()
            .expect("runtime")
            .host_services
            .clone()
            .expect("host services");
        host.uninstall("dev.example.host-probe", true)
            .expect("uninstall and remove data");
        let recovered = services.for_plugin(
            "dev.example.host-probe",
            "provider.host-probe",
            HashSet::from(["https://api.example.com".to_owned()]),
        );
        assert_eq!(recovered.kv_get("probe").expect("kv"), None);
        assert!(!registry.contains("provider.host-probe"));
    }

    #[test]
    fn install_enable_disable_uninstall_does_not_leak_style_registration() {
        let root = tempfile::tempdir().expect("root");
        let host = ExtensionHost::open(root.path().to_path_buf()).expect("host");
        host.install_inspection(style_inspection("dev.example.one"), true, &[], "test")
            .expect("install");
        assert!(host.style_order().contains(&"dev.example.one".to_owned()));
        assert!(host
            .read_installed_text("dev.example.one", "styles/main.css")
            .expect("css")
            .contains("player-bar"));
        assert_eq!(host.list()[0].status, PluginStatus::Active);
        host.set_enabled("dev.example.one", false).expect("disable");
        assert!(!host.list()[0].enabled);
        host.set_enabled("dev.example.one", true).expect("enable");
        host.uninstall("dev.example.one", true).expect("uninstall");
        assert!(host.list().is_empty());
    }

    #[test]
    fn unclean_shutdown_marks_enabled_plugins_failed() {
        let root = tempfile::tempdir().expect("root");
        let host = ExtensionHost::open(root.path().to_path_buf()).expect("host");
        host.install_inspection(style_inspection("dev.example.one"), true, &[], "test")
            .expect("install");
        drop(host);
        let journal = root.path().join("journal.json");
        std::fs::write(
            &journal,
            r#"{"bootId":"1","activationStarted":true,"cleanExit":false}"#,
        )
        .expect("journal");
        let recovered = ExtensionHost::open(root.path().to_path_buf()).expect("reopen");
        assert!(recovered.safe_mode());
        assert_eq!(recovered.list()[0].status, PluginStatus::Failed);
        assert!(!recovered.list()[0].enabled);
    }

    #[test]
    fn clean_exit_preserves_enabled_plugins() {
        let root = tempfile::tempdir().expect("root");
        let host = ExtensionHost::open(root.path().to_path_buf()).expect("host");
        host.install_inspection(style_inspection("dev.example.one"), true, &[], "test")
            .expect("install");
        assert!(host.list()[0].enabled);
        host.mark_clean_exit();
        drop(host);
        let recovered = ExtensionHost::open(root.path().to_path_buf()).expect("reopen");
        assert!(!recovered.safe_mode());
        assert!(recovered.list()[0].enabled);
        assert_eq!(recovered.list()[0].status, PluginStatus::Active);
    }

    #[test]
    fn startup_rejects_tampered_active_package_content() {
        let root = tempfile::tempdir().expect("root");
        let host = ExtensionHost::open(root.path().to_path_buf()).expect("host");
        host.install_inspection(style_inspection("dev.example.one"), true, &[], "test")
            .expect("install");
        host.mark_clean_exit();
        drop(host);
        let css = root
            .path()
            .join("dev.example.one")
            .join("versions")
            .join("1.0.0")
            .join("styles")
            .join("main.css");
        std::fs::write(&css, b"body{background:url(https://evil.invalid)}")
            .expect("tamper package");
        let recovered = ExtensionHost::open(root.path().to_path_buf()).expect("reopen");
        assert_eq!(recovered.list()[0].status, PluginStatus::Failed);
        assert!(!recovered.list()[0].enabled);
        assert_eq!(
            recovered.list()[0].status_reason.as_deref(),
            Some("plugin package content hash mismatch")
        );
    }

    #[test]
    fn safe_mode_is_host_level_even_without_plugins() {
        let root = tempfile::tempdir().expect("root");
        let host = ExtensionHost::open(root.path().to_path_buf()).expect("host");
        assert!(host.list().is_empty());
        assert!(!host.safe_mode());
        host.set_safe_mode(true).expect("safe");
        assert!(host.list().is_empty());
        assert!(host.safe_mode());
        assert!(host.active_resources().safe_mode);
        host.set_safe_mode(false).expect("leave");
        assert!(!host.safe_mode());
    }

    #[test]
    fn runtime_token_is_bound_and_cannot_be_spoofed() {
        let root = tempfile::tempdir().expect("root");
        let host = ExtensionHost::open(root.path().to_path_buf()).expect("host");
        host.install_inspection(style_inspection("dev.example.one"), true, &[], "test")
            .expect("install");
        let runtime = host.start_runtime("dev.example.one").expect("runtime");
        assert!(host.runtime("forged").is_none());
        assert!(host
            .check_permission(&runtime.token, PluginPermission::PlayerControl)
            .is_err());
        assert!(host
            .check_permission(&runtime.token, PluginPermission::StyleRegister)
            .is_ok());
        assert!(host.rate_limit("dev.example.one", "player", 2).is_ok());
        assert!(host.rate_limit("dev.example.one", "player", 2).is_ok());
        assert!(host.rate_limit("dev.example.one", "player", 2).is_err());
    }

    #[test]
    fn plugin_storage_is_namespaced_and_quota_bounded() {
        let root = tempfile::tempdir().expect("root");
        let host = ExtensionHost::open(root.path().to_path_buf()).expect("host");
        host.storage_set("dev.a", "k", "v").expect("a");
        host.storage_set("dev.b", "k", "other").expect("b");
        assert_eq!(host.storage_get("dev.a", "k").as_deref(), Some("v"));
        assert_eq!(host.storage_get("dev.b", "k").as_deref(), Some("other"));
        let huge = "x".repeat(70_000);
        assert!(host.storage_set("dev.a", "big", &huge).is_err());
        host.install_inspection(style_inspection("dev.a"), false, &[], "test")
            .expect("install");
        host.uninstall("dev.a", false).expect("keep");
        assert_eq!(host.storage_get("dev.a", "k").as_deref(), Some("v"));
        host.install_inspection(style_inspection("dev.a"), false, &[], "test")
            .expect("reinstall");
        host.uninstall("dev.a", true).expect("remove");
        assert!(host.storage_get("dev.a", "k").is_none());
    }

    fn scene_inspection(id: &str) -> PackageInspection {
        let manifest = PluginManifest::parse(
            format!(
                r#"{{
                    "manifestVersion": 1,
                    "id": "{id}",
                    "name": "Vinyl Pack",
                    "version": "1.0.0",
                    "apiVersion": 1,
                    "entrypoints": {{ "scenes": ["scenes/vinyl.scene.json"] }}
                }}"#
            )
            .as_bytes(),
        )
        .expect("manifest");
        PackageInspection {
            sha256: sha256_bytes(id.as_bytes()),
            compressed_bytes: 24,
            expanded_bytes: 24,
            file_count: 3,
            files: vec![
                PackageFile {
                    path: "manifest.json".into(),
                    bytes: serde_json::to_vec(&manifest).unwrap(),
                },
                PackageFile {
                    path: "scenes/vinyl.scene.json".into(),
                    bytes: br#"{"id":"vinyl","layout":"vinyl"}"#.to_vec(),
                },
                PackageFile {
                    path: "scenes/vinyl.css".into(),
                    bytes: b"[data-scene-widget=\"vinyl\"]{opacity:1}".to_vec(),
                },
            ],
            manifest,
            style_scan: ScanReport::default(),
            script_scan: ScanReport::default(),
        }
    }

    #[test]
    fn scene_css_path_maps_scene_json_to_sibling_css() {
        assert_eq!(
            scene_css_path("scenes/vinyl.scene.json"),
            "scenes/vinyl.css"
        );
        assert_eq!(scene_css_path("scenes/aurora.json"), "scenes/aurora.css");
    }

    #[test]
    fn scene_registration_is_removed_on_disable() {
        let root = tempfile::tempdir().expect("root");
        let host = ExtensionHost::open(root.path().to_path_buf()).expect("host");
        host.install_inspection(scene_inspection("dev.example.scene"), true, &[], "test")
            .expect("install");
        assert_eq!(host.active_resources().scenes.len(), 1);
        assert_eq!(host.active_resources().scenes[0].scene_id, "vinyl");
        assert_eq!(
            host.active_resources().scenes[0].css.as_deref(),
            Some("[data-scene-widget=\"vinyl\"]{opacity:1}")
        );
        host.set_enabled("dev.example.scene", false)
            .expect("disable");
        assert!(host.active_resources().scenes.is_empty());
        host.set_enabled("dev.example.scene", true).expect("enable");
        assert_eq!(host.active_resources().scenes.len(), 1);
    }

    #[test]
    fn style_order_is_deterministic_and_safe_mode_clears_resources() {
        let root = tempfile::tempdir().expect("root");
        let host = ExtensionHost::open(root.path().to_path_buf()).expect("host");
        host.install_inspection(style_inspection("dev.example.a"), true, &[], "test")
            .expect("a");
        host.install_inspection(style_inspection("dev.example.b"), true, &[], "test")
            .expect("b");
        assert_eq!(
            host.style_order(),
            vec!["dev.example.a".to_owned(), "dev.example.b".to_owned()]
        );
        assert_eq!(host.active_resources().styles.len(), 2);
        host.set_safe_mode(true).expect("safe");
        assert!(host.active_resources().styles.is_empty());
        assert!(host.active_resources().scenes.is_empty());
        assert!(host
            .set_enabled("dev.example.a", true)
            .unwrap_err()
            .to_string()
            .contains("safe mode"));
    }

    #[test]
    fn enabled_plugin_cannot_be_replaced_until_disabled() {
        let root = tempfile::tempdir().expect("root");
        let host = ExtensionHost::open(root.path().to_path_buf()).expect("host");
        host.install_inspection(style_inspection("dev.example.one"), true, &[], "test")
            .expect("install");
        let error = host
            .install_inspection(style_inspection("dev.example.one"), true, &[], "test")
            .unwrap_err();
        assert!(error.to_string().contains("disable the current version"));
        host.set_enabled("dev.example.one", false).expect("disable");
        host.install_inspection(style_inspection("dev.example.one"), false, &[], "test")
            .expect("update");
    }

    #[test]
    fn permission_expansion_requires_explicit_grant() {
        let root = tempfile::tempdir().expect("root");
        let host = ExtensionHost::open(root.path().to_path_buf()).expect("host");
        host.install_inspection(style_inspection("dev.example.ctrl"), true, &[], "test")
            .expect("install");
        host.set_enabled("dev.example.ctrl", false)
            .expect("disable");
        let mut next = style_inspection("dev.example.ctrl");
        next.manifest.permissions = vec!["player.control".into()];
        next.manifest.version = "1.1.0".into();
        let error = host
            .install_inspection(next.clone(), true, &[], "test")
            .unwrap_err();
        assert!(error.to_string().contains("explicitly accepted"));
        host.install_inspection(next, true, &["player.control".into()], "test")
            .expect("granted");
    }

    #[test]
    fn every_provider_capability_and_origin_expansion_requires_reauthorization() {
        let root = tempfile::tempdir().expect("root");
        let host = ExtensionHost::open(root.path().to_path_buf()).expect("host");
        let baseline = component_inspection(
            "dev.example.permission-expansion",
            "provider.permission-expansion",
        );
        host.install_inspection(baseline, true, &["provider.catalog".to_owned()], "test")
            .expect("baseline install");
        host.set_enabled("dev.example.permission-expansion", false)
            .expect("disable baseline");

        let update = expanded_component_inspection();
        let requested = update.manifest.requested_permission_keys();
        let added = [
            "provider.playback",
            "provider.recommendation",
            "provider.lyrics",
            "provider.account",
            "plugin.storage",
            "network:https://accounts.example.com",
        ];
        for missing in added {
            let grants = requested
                .iter()
                .filter(|permission| permission.as_str() != missing)
                .cloned()
                .collect::<Vec<_>>();
            let error = host
                .install_inspection(update.clone(), true, &grants, "test")
                .unwrap_err();
            assert!(
                error.to_string().contains("explicitly accepted"),
                "{missing} expansion must require a fresh grant"
            );
        }
        host.install_inspection(update, true, &requested, "test")
            .expect("all expanded permissions granted");
    }

    #[test]
    fn diagnostics_omit_plugin_source_and_include_hash() {
        let root = tempfile::tempdir().expect("root");
        let host = ExtensionHost::open(root.path().to_path_buf()).expect("host");
        host.install_inspection(style_inspection("dev.example.one"), true, &[], "test")
            .expect("install");
        let encoded = serde_json::to_string(&host.diagnostics()).expect("json");
        assert!(encoded.contains("dev.example.one"));
        assert!(encoded.contains("packageSha256"));
        assert!(!encoded.contains("player-bar"));
        assert!(!encoded.contains("stylesheet"));
    }
}
