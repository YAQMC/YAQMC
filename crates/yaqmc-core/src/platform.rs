use serde::Serialize;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformCapabilities {
    pub reliable_always_on_top: bool,
    pub click_through: bool,
    pub transparent_window: bool,
    pub global_positioning: bool,
    pub absolute_window_placement: bool,
    pub fullscreen_detection: bool,
    pub global_shortcuts: bool,
    pub notes: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuDevice {
    pub card: String,
    pub vendor_id: Option<String>,
    pub device_id: Option<String>,
    pub driver: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinuxDiagnostics {
    pub session_type: Option<String>,
    pub display_backend: String,
    pub desktop_environment: Option<String>,
    pub compositor_hint: Option<String>,
    pub webkitgtk_version: Option<String>,
    pub graphics_mode: String,
    pub environment: BTreeMap<String, Option<String>>,
    pub gpu_devices: Vec<GpuDevice>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDiagnostics {
    pub implementation: String,
    pub route: String,
    pub available: bool,
    pub selected_output: Option<String>,
    pub selected_output_kind: Option<String>,
    pub resolved_output: Option<String>,
    pub resolved_driver: Option<String>,
    pub resolved_host: Option<String>,
    pub resolved_sample_rate: Option<u32>,
    pub resolved_channels: Option<u16>,
    pub resolved_sample_format: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMediaStatus {
    pub available: bool,
    pub backend: &'static str,
    pub specification: &'static str,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopIntegrationStatus {
    pub tray_available: bool,
    pub tray_error: Option<String>,
    pub global_shortcuts_supported: bool,
    pub global_shortcuts_enabled: bool,
    pub global_shortcuts: Vec<&'static str>,
    pub shortcut_error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformDiagnostics {
    pub generated_at_unix_ms: u128,
    pub app_name: &'static str,
    pub app_version: String,
    pub os: &'static str,
    pub architecture: &'static str,
    pub linux: Option<LinuxDiagnostics>,
    pub capabilities: PlatformCapabilities,
    pub audio: AudioDiagnostics,
    pub system_media: SystemMediaStatus,
    pub desktop_integration: DesktopIntegrationStatus,
}

/// Host-observed values collected by platform adapters before deterministic Core
/// assembly. It intentionally contains no window, player, or webview type.
pub struct PlatformFacts {
    pub generated_at_unix_ms: u128,
    pub app_version: String,
    pub os: &'static str,
    pub architecture: &'static str,
    pub linux: Option<LinuxDiagnostics>,
    pub audio: AudioDiagnostics,
    pub system_media: SystemMediaStatus,
    pub desktop_integration: DesktopIntegrationStatus,
}

pub fn assemble_platform_diagnostics(facts: PlatformFacts) -> PlatformDiagnostics {
    let backend = facts
        .linux
        .as_ref()
        .map(|value| value.display_backend.as_str())
        .unwrap_or(facts.os);
    let capabilities = capabilities_for_backend(
        backend,
        facts.desktop_integration.global_shortcuts_supported,
    );
    PlatformDiagnostics {
        generated_at_unix_ms: facts.generated_at_unix_ms,
        app_name: "YAQMC",
        app_version: facts.app_version,
        os: facts.os,
        architecture: facts.architecture,
        linux: facts.linux,
        capabilities,
        audio: facts.audio,
        system_media: facts.system_media,
        desktop_integration: facts.desktop_integration,
    }
}

pub fn capabilities_for_backend(
    backend: &str,
    global_shortcuts_supported: bool,
) -> PlatformCapabilities {
    if backend == "wayland-native" {
        PlatformCapabilities {
            reliable_always_on_top: false,
            click_through: false,
            transparent_window: false,
            global_positioning: false,
            absolute_window_placement: false,
            fullscreen_detection: false,
            global_shortcuts: false,
            notes: vec![
                "Native Wayland intentionally does not promise X11-style overlay placement, click-through or always-on-top semantics.".to_owned(),
                "Media keys remain available through MPRIS; configurable global shortcuts use an X11 backend and are disabled for native Wayland.".to_owned(),
            ],
        }
    } else {
        PlatformCapabilities {
            reliable_always_on_top: true,
            click_through: true,
            transparent_window: true,
            global_positioning: true,
            absolute_window_placement: true,
            fullscreen_detection: backend == "windows",
            global_shortcuts: global_shortcuts_supported,
            notes: if backend == "xwayland" {
                vec!["The desktop session is Wayland, but YAQMC is using an X11/XWayland window backend.".to_owned()]
            } else {
                Vec::new()
            },
        }
    }
}

pub fn log_startup(diagnostics: &PlatformDiagnostics) {
    if let Some(linux) = &diagnostics.linux {
        tracing::info!(
            target: "linux.window",
            session_type = linux.session_type.as_deref().unwrap_or("unknown"),
            display_backend = linux.display_backend,
            desktop = linux.desktop_environment.as_deref().unwrap_or("unknown"),
            "Linux window backend detected"
        );
        tracing::info!(
            target: "linux.graphics",
            webkitgtk = linux.webkitgtk_version.as_deref().unwrap_or("unknown"),
            graphics_mode = linux.graphics_mode,
            gpu_count = linux.gpu_devices.len(),
            "Linux graphics environment detected"
        );
    }
    tracing::info!(
        target: "audio.backend",
        implementation = diagnostics.audio.implementation,
        route = diagnostics.audio.route,
        selection = diagnostics.audio.selected_output_kind.as_deref().unwrap_or("unavailable"),
        output = diagnostics.audio.resolved_output.as_deref().unwrap_or("unavailable"),
        driver = diagnostics.audio.resolved_driver.as_deref().unwrap_or("unavailable"),
        host = diagnostics.audio.resolved_host.as_deref().unwrap_or("unavailable"),
        "audio backend detected"
    );
}

pub struct PlatformDiagnosticAssets<'a> {
    pub collector_script: &'a str,
    pub readme: &'a str,
}

pub fn export_bundle(
    destination_directory: &Path,
    diagnostics: &PlatformDiagnostics,
    assets: PlatformDiagnosticAssets<'_>,
) -> Result<PathBuf, String> {
    let directory = destination_directory.join(format!(
        "YAQMC-linux-diagnostics-{}",
        diagnostics.generated_at_unix_ms
    ));
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let json = serde_json::to_vec_pretty(diagnostics).map_err(|error| error.to_string())?;
    fs::write(directory.join("yaqmc-diagnostics.json"), json).map_err(|error| error.to_string())?;
    fs::write(
        directory.join("collect-linux-diagnostics.sh"),
        assets.collector_script,
    )
    .map_err(|error| error.to_string())?;
    fs::write(directory.join("README.txt"), assets.readme).map_err(|error| error.to_string())?;
    Ok(directory)
}
