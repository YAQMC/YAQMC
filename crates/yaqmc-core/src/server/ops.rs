use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine;
use serde_json::{json, Value};

use crate::app_preferences::{
    self, ManagedBackgroundImage, PreferencesChangeSink, PreferencesRepository, PREFERENCES_KEY,
};
use crate::audio::{AudioOutputDevice, AUDIO_OUTPUT_DEVICE_SETTING};
use crate::diagnostics::{
    self, AppSection, BundleExportResult, BundleOptions, DiagnosticsSnapshot, PlaybackSection,
    PluginDiagnostic as WirePluginDiagnostic, PluginStatus as WirePluginStatus, ProviderSection,
};
use crate::issue_reporter::{self, IssueDraft, IssuePreview};
use crate::local_api::{LocalApiService, LocalApiStatus};
use crate::logging::{self, ErrorRecord, LogLevel, LoggingHandle, LOG_LEVEL_SETTING_KEY};
use crate::player::{PlayerService, PlayerSnapshot, RepeatMode};
use crate::plugin::api::{
    PluginBridgeRequest, PluginEnableRequest, PluginInspectResult, PluginInstallRequest,
    PluginSettingsWrite, PluginUninstallRequest,
};
use crate::plugin::host::{ActivePluginResources, ExtensionHost, PluginRecord};
use crate::plugin::permissions::parse_permission;
use crate::plugin::{PluginDiagnostic, PluginStatus};
use crate::storage::StorageService;
use crate::CoreHandle;
use yaqmc_provider_api::{
    AccountSnapshot, AudioQualityPreference, MusicProvider, OAuthLoginProvider, OAuthPrepareResult,
    ProviderCommandError, ProviderResult, ProviderStatus,
};

use super::types::{
    DebugPerfSample, DiagnosticsBundleRequest, DiagnosticsRequest, FrontendLogEntry,
    RecordErrorRequest,
};
use super::HostDispatchHooks;

pub const PERF_LOG_MAX_BYTES: u64 = 1 << 20;

struct StoragePreferences<'a> {
    storage: &'a StorageService,
}

impl PreferencesRepository for StoragePreferences<'_> {
    fn load_preferences(&self) -> Result<Option<String>, String> {
        self.storage
            .get_setting(PREFERENCES_KEY)
            .map_err(|error| error.to_string())
    }

    fn update_preferences<F>(&self, update: F) -> Result<String, String>
    where
        F: FnOnce(Option<String>) -> String,
    {
        self.storage
            .update_setting(PREFERENCES_KEY, update)
            .map_err(|error| error.to_string())
    }
}

struct FnSink<F: Fn(&str)>(F);

impl<F: Fn(&str)> PreferencesChangeSink for FnSink<F> {
    fn preferences_changed(&self, value: &str) {
        (self.0)(value);
    }
}

fn stringify(error: impl std::fmt::Display) -> String {
    error.to_string()
}

pub fn parse_grants(values: &[String]) -> Result<Vec<String>, String> {
    values
        .iter()
        .map(|value| {
            parse_permission(value)
                .map(|_| value.clone())
                .map_err(|error| error.to_string())
        })
        .collect()
}

fn build_playback_section(snapshot: &PlayerSnapshot) -> PlaybackSection {
    let current = snapshot
        .current_index
        .and_then(|index| snapshot.queue.get(index));
    let quality_label = current.map(|song| match song.quality {
        crate::player::AudioQuality::Standard => "standard".to_owned(),
        crate::player::AudioQuality::High => "high".to_owned(),
        crate::player::AudioQuality::Lossless => "lossless".to_owned(),
        crate::player::AudioQuality::HiRes => "hi-res".to_owned(),
        crate::player::AudioQuality::Master => "master".to_owned(),
    });
    PlaybackSection {
        state: if snapshot.is_playing {
            "playing"
        } else if current.is_some() {
            "paused"
        } else {
            "idle"
        },
        selected_quality: quality_label,
        decoder_hint: None,
        queue_length: snapshot.queue.len(),
        current_source_kind: current.map(|_| "qqmusic"),
        playback_order: snapshot.playback_order.as_str(),
        repeat_mode: match snapshot.repeat {
            RepeatMode::Off => "off",
            RepeatMode::All => "all",
            RepeatMode::One => "one",
        },
        primary_playback_mode: snapshot.primary_playback_mode.as_str(),
        playback_session_id: snapshot.session_id,
        snapshot_revision: snapshot.snapshot_revision,
        source_generation: snapshot.source_generation,
        last_seek_revision: snapshot.last_seek_revision,
    }
}

fn map_provider_section(status: ProviderStatus, request: &DiagnosticsRequest) -> ProviderSection {
    let membership_tier = request.membership_tier.clone();
    let membership_status = membership_tier.as_ref().map(|_| {
        request
            .membership_status
            .clone()
            .unwrap_or_else(|| "unknown".into())
    });
    ProviderSection {
        id: status.provider_id,
        connection: status.connection,
        account_state: request
            .account_state
            .clone()
            .unwrap_or_else(|| "unknown".into()),
        membership_tier,
        membership_status,
    }
}

fn map_plugin_diagnostic(diagnostic: PluginDiagnostic) -> WirePluginDiagnostic {
    let status = match diagnostic.status {
        PluginStatus::Installed => WirePluginStatus::Installed,
        PluginStatus::Disabled => WirePluginStatus::Disabled,
        PluginStatus::Enabling => WirePluginStatus::Enabling,
        PluginStatus::Active => WirePluginStatus::Active,
        PluginStatus::Disabling => WirePluginStatus::Disabling,
        PluginStatus::Failed => WirePluginStatus::Failed,
        PluginStatus::Incompatible => WirePluginStatus::Incompatible,
    };
    WirePluginDiagnostic {
        id: diagnostic.id,
        version: diagnostic.version,
        enabled: diagnostic.enabled,
        status,
        entrypoint_kinds: diagnostic.entrypoint_kinds,
        api_version: diagnostic.api_version,
        package_sha256: diagnostic.package_sha256,
        permissions: diagnostic.permissions,
        risk_rating: diagnostic.risk_rating,
    }
}

pub async fn assemble_diagnostics_snapshot(
    player: &PlayerService,
    provider: &dyn MusicProvider,
    logging: &LoggingHandle,
    plugins: Option<&ExtensionHost>,
    platform: crate::platform::PlatformDiagnostics,
    app: AppSection,
    request: DiagnosticsRequest,
) -> DiagnosticsSnapshot {
    let player_snapshot = player.snapshot().await;
    let provider_status = provider.status().await;
    let mut snapshot = diagnostics::snapshot_from_handle(
        logging,
        platform,
        Some(map_provider_section(provider_status, &request)),
        build_playback_section(&player_snapshot),
        app,
    );
    snapshot.lyrics_preset = request.lyrics_preset;
    snapshot.plugins = plugins
        .map(|host| {
            host.diagnostics()
                .into_iter()
                .map(map_plugin_diagnostic)
                .collect()
        })
        .unwrap_or_default();
    snapshot
}

pub fn map_provider_section_for_test(
    status: ProviderStatus,
    request: &DiagnosticsRequest,
) -> ProviderSection {
    map_provider_section(status, request)
}

pub fn map_plugin_diagnostic_for_test(diagnostic: PluginDiagnostic) -> WirePluginDiagnostic {
    map_plugin_diagnostic(diagnostic)
}

pub fn perf_sample_header() -> String {
    "unix_ms,fps,average_ms,p95_ms,max_ms,long_tasks\n".to_owned()
}

pub fn perf_sample_line(sample: &DebugPerfSample) -> Option<String> {
    if sample.fps > 10_000
        || !sample.average_ms.is_finite()
        || !sample.p95_ms.is_finite()
        || !sample.max_ms.is_finite()
    {
        return None;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis();
    Some(format!(
        "{now},{},{:.2},{:.2},{:.2},{}",
        sample.fps, sample.average_ms, sample.p95_ms, sample.max_ms, sample.long_tasks
    ))
}

pub fn write_perf_sample(dir: &Path, sample: &DebugPerfSample) -> Result<(), String> {
    tracing::info!(
        target: "perf",
        fps = sample.fps,
        average_ms = format_args!("{:.2}", sample.average_ms),
        p95_ms = format_args!("{:.2}", sample.p95_ms),
        max_ms = format_args!("{:.2}", sample.max_ms),
        long_tasks = sample.long_tasks,
        "render sample received"
    );
    let Some(line) = perf_sample_line(sample) else {
        return Err("invalid performance sample".to_owned());
    };
    std::fs::create_dir_all(dir).map_err(stringify)?;
    let path = dir.join("performance-samples.csv");
    let rotated = std::fs::metadata(&path)
        .map(|meta| meta.len() > PERF_LOG_MAX_BYTES)
        .unwrap_or(true);
    if rotated {
        std::fs::write(&path, perf_sample_header()).map_err(stringify)?;
    }
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(stringify)?;
    writeln!(file, "{line}").map_err(stringify)?;
    Ok(())
}

pub fn audio_output_devices(player: &PlayerService) -> Result<Vec<AudioOutputDevice>, String> {
    player.output_devices().map_err(stringify)
}

pub fn audio_set_output_device(
    player: &PlayerService,
    storage: &StorageService,
    device_id: &str,
) -> Result<Vec<AudioOutputDevice>, String> {
    let devices = player.set_output_device(device_id).map_err(stringify)?;
    let selected_id = devices
        .iter()
        .find(|device| device.is_selected)
        .map(|device| device.id.as_str())
        .ok_or_else(|| {
            "the selected audio output was not reported by the audio engine".to_owned()
        })?;
    storage
        .set_setting(AUDIO_OUTPUT_DEVICE_SETTING, selected_id)
        .map_err(stringify)?;
    Ok(devices)
}

pub async fn qqmusic_set_preferred_quality(
    provider: &dyn MusicProvider,
    player: &PlayerService,
    quality: AudioQualityPreference,
) -> ProviderResult<ProviderStatus> {
    let current = player.current_track().await;
    let current_is_qqmusic = current
        .as_ref()
        .and_then(|song| song.provider.as_ref())
        .is_some_and(|reference| reference.provider_id == "qqmusic");
    let status = provider.set_preferred_quality(quality).await?;
    if current_is_qqmusic {
        player
            .reload_current()
            .await
            .map_err(|error| ProviderCommandError {
                code: "player-reload-failed".to_owned(),
                message: error.to_string(),
                retryable: true,
            })?;
    }
    Ok(status)
}

pub async fn qqmusic_set_current_quality(
    provider: &dyn MusicProvider,
    player: &PlayerService,
    quality: AudioQualityPreference,
) -> ProviderResult<PlayerSnapshot> {
    let track_id = player
        .current_track()
        .await
        .and_then(|song| song.provider)
        .filter(|reference| reference.provider_id == "qqmusic")
        .map(|reference| reference.track_id)
        .ok_or_else(|| ProviderCommandError::invalid_request("the QQ Music request was invalid"))?;
    provider.set_current_quality(track_id, quality).await?;
    player
        .reload_current()
        .await
        .map_err(|error| ProviderCommandError {
            code: "player-reload-failed".to_owned(),
            message: error.to_string(),
            retryable: true,
        })
}

pub async fn qqmusic_auth_heartbeat(
    provider: &dyn MusicProvider,
    attempt_id: String,
    owner_lease_id: String,
    oauth_window_live: bool,
) -> ProviderResult<AccountSnapshot> {
    if provider.is_oauth_login(&attempt_id).await && !oauth_window_live {
        return provider.cancel_qr_login(attempt_id).await;
    }
    provider
        .heartbeat_qr_login(attempt_id, owner_lease_id)
        .await
}

pub async fn auth_oauth_prepare(
    provider: &dyn MusicProvider,
    kind: OAuthLoginProvider,
) -> ProviderResult<OAuthPrepareResult> {
    provider.prepare_oauth_login(kind).await
}

pub async fn auth_oauth_complete(
    provider: &dyn MusicProvider,
    attempt_id: &str,
    callback_url: reqwest::Url,
) -> ProviderResult<AccountSnapshot> {
    provider
        .complete_oauth_login(attempt_id, callback_url)
        .await
}

pub async fn auth_oauth_cancel(
    provider: &dyn MusicProvider,
    attempt_id: &str,
) -> ProviderResult<AccountSnapshot> {
    provider.cancel_oauth_login(attempt_id).await
}

pub fn app_preferences_get(storage: &StorageService) -> Result<Option<String>, String> {
    app_preferences::get_preferences(&StoragePreferences { storage })
}

pub fn app_preferences_set(
    storage: &StorageService,
    value: String,
    notify: impl Fn(&str),
) -> Result<(), String> {
    app_preferences::set_preferences(&StoragePreferences { storage }, &FnSink(notify), value)
}

const LYRICS_SURFACE_GEOMETRY_PREFIX: &str = "lyrics-surface-geometry:";

fn lyrics_surface_geometry_key(key: &str) -> Result<&str, String> {
    match key {
        "lyrics-surface-geometry:desktop" | "lyrics-surface-geometry:island" => Ok(key),
        _ => Err(format!(
            "unsupported app setting key (expected {LYRICS_SURFACE_GEOMETRY_PREFIX}desktop|island)"
        )),
    }
}

pub fn app_settings_get(storage: &StorageService, key: &str) -> Result<Option<String>, String> {
    storage
        .get_setting(lyrics_surface_geometry_key(key)?)
        .map_err(stringify)
}

pub fn app_settings_set(storage: &StorageService, key: &str, value: &str) -> Result<(), String> {
    storage
        .set_setting(lyrics_surface_geometry_key(key)?, value)
        .map_err(stringify)
}

pub fn app_settings_remove(storage: &StorageService, key: &str) -> Result<(), String> {
    storage
        .remove_setting(lyrics_surface_geometry_key(key)?)
        .map_err(stringify)
}

pub async fn appearance_background_load(
    data_root: &Path,
    reference: String,
) -> Result<Option<ManagedBackgroundImage>, String> {
    Ok(app_preferences::load_background(data_root, &reference)
        .await?
        .map(protocol_managed_background))
}

pub async fn preferences_set_background_from(
    data_root: &Path,
    path: String,
) -> Result<ManagedBackgroundImage, String> {
    Ok(protocol_managed_background(
        app_preferences::persist_background(Path::new(&path), data_root).await?,
    ))
}

/// Stdio method responses stay under the 1 MiB default cap. A 24 MiB image's
/// base64 `dataUri` cannot fit that cap (or the 32 MiB frame hard cap). Core
/// still copies/validates the file; Electron Main hydrates `dataUri` from the
/// managed path after the protocol round-trip.
fn protocol_managed_background(stored: ManagedBackgroundImage) -> ManagedBackgroundImage {
    ManagedBackgroundImage {
        reference: stored.reference,
        data_uri: String::new(),
    }
}

pub async fn local_api_set_port(
    api: &Arc<LocalApiService>,
    port: u16,
) -> Result<LocalApiStatus, String> {
    if port < 1_024 {
        return Err("port must be between 1024 and 65535".to_owned());
    }
    api.set_port(port).await.map_err(stringify)
}

pub fn diagnostics_clear_logs(logging: &LoggingHandle) -> usize {
    let mut removed = 0usize;
    let entries = match std::fs::read_dir(logging.log_dir()) {
        Ok(entries) => entries,
        Err(_) => return 0,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_log = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.starts_with(logging::LOG_FILE_PREFIX))
            .unwrap_or(false);
        if is_log && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

pub fn diagnostics_set_log_level(
    storage: &StorageService,
    level: LogLevel,
) -> Result<LogLevel, String> {
    storage
        .set_setting(LOG_LEVEL_SETTING_KEY, level.as_str())
        .map_err(stringify)?;
    Ok(level)
}

pub fn diagnostics_record_error(logging: &LoggingHandle, request: RecordErrorRequest) {
    let mut record = ErrorRecord::new(request.code, request.domain, request.message);
    if let Some(op_id) = request.op_id {
        record = record.with_op_id(op_id);
    }
    logging.record_error(record);
}

pub fn diagnostics_log_frontend(logging: &LoggingHandle, entries: Vec<FrontendLogEntry>) {
    for entry in entries {
        let target = if entry.target.is_empty() {
            "frontend".to_owned()
        } else {
            format!("frontend.{}", entry.target)
        };
        let message = logging::sanitize_field(&entry.message).into_owned();
        let fields_repr = entry
            .fields
            .as_ref()
            .map(|value| logging::sanitize_field(&value.to_string()).into_owned())
            .unwrap_or_default();
        let op = entry.op_id.unwrap_or_default();
        match entry.level {
            LogLevel::Error => {
                tracing::error!(target: "frontend", %target, op = %op, fields = %fields_repr, "{message}")
            }
            LogLevel::Warn => {
                tracing::warn!(target: "frontend", %target, op = %op, fields = %fields_repr, "{message}")
            }
            LogLevel::Info => {
                tracing::info!(target: "frontend", %target, op = %op, fields = %fields_repr, "{message}")
            }
            LogLevel::Debug => {
                tracing::debug!(target: "frontend", %target, op = %op, fields = %fields_repr, "{message}")
            }
            LogLevel::Trace => {
                tracing::trace!(target: "frontend", %target, op = %op, fields = %fields_repr, "{message}")
            }
        }
        if matches!(entry.level, LogLevel::Error | LogLevel::Warn) {
            logging.record_error(ErrorRecord::new("YAQMC-UI-EVENT", target, &message));
        }
    }
}

pub async fn diagnostics_export_bundle_to(
    core: &CoreHandle,
    host: &dyn HostDispatchHooks,
    path: String,
    request: DiagnosticsBundleRequest,
) -> Result<BundleExportResult, String> {
    let snapshot = assemble_diagnostics_snapshot(
        &core.player(),
        core.qq_music().as_ref(),
        &core.logging(),
        Some(&core.plugins()),
        live_platform_diagnostics(core, host),
        host.app_section(),
        request.base,
    )
    .await;
    let options = BundleOptions {
        include_logs: request.include_logs.unwrap_or(true),
        override_unresolved: request.override_unresolved.unwrap_or(false),
        description: request.description.as_deref(),
        issue_category: request.issue_category.as_deref(),
        host_payload: request.host_payload,
    };
    diagnostics::export_bundle_to_path(
        Path::new(&path),
        &snapshot,
        core.logging().log_dir(),
        options,
    )
    .map_err(stringify)
}

pub async fn issue_reporter_preview(
    core: &CoreHandle,
    host: &dyn HostDispatchHooks,
    draft: IssueDraft,
    request: DiagnosticsRequest,
) -> IssuePreview {
    let snapshot = assemble_diagnostics_snapshot(
        &core.player(),
        core.qq_music().as_ref(),
        &core.logging(),
        Some(&core.plugins()),
        live_platform_diagnostics(core, host),
        host.app_section(),
        request,
    )
    .await;
    let label = host.renderer_label(&snapshot.platform);
    issue_reporter::prepare_preview(&draft, &snapshot, &label)
}

pub fn plugin_inspect_path(
    host: &ExtensionHost,
    path: String,
) -> Result<PluginInspectResult, String> {
    let inspection = host.inspect_path(&PathBuf::from(path)).map_err(stringify)?;
    Ok(PluginInspectResult {
        sha256: inspection.sha256,
        compressed_bytes: inspection.compressed_bytes,
        expanded_bytes: inspection.expanded_bytes,
        file_count: inspection.file_count,
        permissions: inspection.manifest.requested_permission_keys(),
        manifest: inspection.manifest,
        style_scan: inspection.style_scan,
        script_scan: inspection.script_scan,
        files: inspection.files.into_iter().map(|file| file.path).collect(),
    })
}

pub fn plugin_install(
    host: &ExtensionHost,
    request: PluginInstallRequest,
    notify: impl FnOnce(),
) -> Result<PluginRecord, String> {
    let grants = parse_grants(&request.grant)?;
    let path = PathBuf::from(&request.path);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let record = match extension.as_str() {
        "css" => host.install_loose_css(&path).map_err(stringify)?,
        "js" => host.install_loose_script(&path).map_err(stringify)?,
        "ts" => {
            return Err(
                "TypeScript plugins must be built to dist/main.js with the Plugin SDK".into(),
            )
        }
        _ if path.is_dir() => {
            return Err("unpacked plugin folders can only be installed from Developer Mode".into())
        }
        _ => host
            .install(&path, request.enable, &grants)
            .map_err(stringify)?,
    };
    notify();
    Ok(record)
}

pub fn plugin_install_from(
    host: &ExtensionHost,
    request: PluginInstallRequest,
    notify: impl FnOnce(),
) -> Result<PluginRecord, String> {
    plugin_install(host, request, notify)
}

pub fn plugin_set_enabled(
    host: &ExtensionHost,
    request: PluginEnableRequest,
    notify: impl FnOnce(),
) -> Result<PluginRecord, String> {
    let grants = parse_grants(&request.grant)?;
    let record = host
        .set_enabled_with_grants(&request.id, request.enabled, &grants)
        .map_err(stringify)?;
    notify();
    Ok(record)
}

pub fn plugin_uninstall(
    host: &ExtensionHost,
    request: PluginUninstallRequest,
    notify: impl FnOnce(),
) -> Result<(), String> {
    host.uninstall(&request.id, request.remove_data)
        .map_err(stringify)?;
    notify();
    Ok(())
}

pub fn plugin_set_safe_mode(
    host: &ExtensionHost,
    enabled: bool,
    notify: impl FnOnce(),
) -> Result<bool, String> {
    host.set_safe_mode(enabled).map_err(stringify)?;
    notify();
    Ok(host.safe_mode())
}

pub fn plugin_set_developer_mode(
    host: &ExtensionHost,
    enabled: bool,
    notify: impl FnOnce(),
) -> Result<bool, String> {
    host.set_developer_mode(enabled).map_err(stringify)?;
    notify();
    Ok(host.developer_mode())
}

pub fn plugin_install_unpacked(
    host: &ExtensionHost,
    request: PluginInstallRequest,
    notify: impl FnOnce(),
) -> Result<PluginRecord, String> {
    let grants = parse_grants(&request.grant)?;
    let record = host
        .install_unpacked(&PathBuf::from(&request.path), request.enable, &grants)
        .map_err(stringify)?;
    notify();
    Ok(record)
}

pub fn plugin_reload(
    host: &ExtensionHost,
    id: &str,
    notify: impl FnOnce(),
) -> Result<PluginRecord, String> {
    let record = host.reload(id).map_err(stringify)?;
    notify();
    Ok(record)
}

pub fn plugin_read_asset(
    host: &ExtensionHost,
    plugin_id: &str,
    path: &str,
) -> Result<Value, String> {
    let (mime, bytes) = host.read_asset(plugin_id, path).map_err(stringify)?;
    Ok(json!({
        "mime": mime,
        "dataBase64": base64::engine::general_purpose::STANDARD.encode(bytes),
    }))
}

pub fn plugin_settings_set(
    host: &ExtensionHost,
    request: PluginSettingsWrite,
    notify: impl FnOnce(),
) -> Result<Value, String> {
    let value = host
        .settings_set(&request.id, request.values)
        .map_err(stringify)?;
    notify();
    Ok(value)
}

pub fn plugin_mark_failed(
    host: &ExtensionHost,
    id: &str,
    reason: &str,
    notify: impl FnOnce(),
) -> Result<PluginRecord, String> {
    let record = host.mark_failed(id, reason).map_err(stringify)?;
    notify();
    Ok(record)
}

pub async fn plugin_bridge(
    host: &ExtensionHost,
    player: &PlayerService,
    request: PluginBridgeRequest,
) -> Result<Value, String> {
    crate::plugin::bridge::dispatch_bridge(host, player, &request).await
}

pub fn plugin_list(host: &ExtensionHost) -> Vec<PluginRecord> {
    host.list()
}

pub fn plugin_active_resources(host: &ExtensionHost) -> ActivePluginResources {
    host.active_resources()
}

pub fn plugin_diagnostics(host: &ExtensionHost) -> Vec<PluginDiagnostic> {
    host.diagnostics()
}

pub fn plugin_runtime_start(host: &ExtensionHost, plugin_id: &str) -> Result<String, String> {
    Ok(host.start_runtime(plugin_id).map_err(stringify)?.token)
}

pub fn plugin_runtime_stop(host: &ExtensionHost, token: &str) {
    host.stop_runtime(token);
}

pub fn live_platform_diagnostics(
    core: &CoreHandle,
    host: &dyn HostDispatchHooks,
) -> crate::platform::PlatformDiagnostics {
    crate::platform::assemble_live_platform_diagnostics(crate::platform::LivePlatformInputs {
        app_version: host.app_section().version,
        audio_devices: core.player().output_devices().unwrap_or_default(),
        system_media: core.start_system_media().status(),
        desktop_integration: host.desktop_integration_status(),
        display_backend_override: host.linux_display_backend(),
        graphics_mode: host.linux_graphics_mode(),
    })
}

pub fn plugin_settings_get(host: &ExtensionHost, id: &str) -> Result<Value, String> {
    host.settings_get(id, false).map_err(stringify)
}

pub fn platform_export_diagnostics(
    core: &CoreHandle,
    host: &dyn HostDispatchHooks,
) -> Result<String, String> {
    let diagnostics = live_platform_diagnostics(core, host);
    crate::platform::export_bundle(
        &host.download_dir(),
        &diagnostics,
        crate::platform::PlatformDiagnosticAssets {
            collector_script: host.diagnostic_collector_script(),
            readme: host.diagnostic_readme(),
        },
    )
    .map(|path| path.to_string_lossy().into_owned())
}
