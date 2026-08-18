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

const GRAPHICS_MODE_ENV: &str = "YAQMC_LINUX_RENDERER";

pub fn empty_desktop_integration() -> DesktopIntegrationStatus {
    DesktopIntegrationStatus {
        tray_available: false,
        tray_error: None,
        global_shortcuts_supported: false,
        global_shortcuts_enabled: false,
        global_shortcuts: Vec::new(),
        shortcut_error: None,
    }
}

/// Env sockets are not the window backend. Electron Main probes Ozone and
/// client fds, then overlays `display_backend`. DISPLAY on a Wayland session
/// is the XWayland compatibility socket, not proof this process is an X11 client.
pub fn infer_linux_display_backend() -> String {
    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some();
    let x11 = std::env::var_os("DISPLAY").is_some();
    if wayland && !x11 {
        "wayland-native".to_owned()
    } else if !wayland && x11 {
        "x11".to_owned()
    } else {
        "unavailable".to_owned()
    }
}

pub fn collect_linux_diagnostics(
    display_backend: impl Into<String>,
    graphics_mode: impl Into<String>,
) -> LinuxDiagnostics {
    #[cfg(target_os = "linux")]
    {
        collect_linux_diagnostics_linux(display_backend.into(), graphics_mode.into())
    }
    #[cfg(not(target_os = "linux"))]
    {
        LinuxDiagnostics {
            session_type: None,
            display_backend: display_backend.into(),
            desktop_environment: None,
            compositor_hint: None,
            webkitgtk_version: None,
            graphics_mode: graphics_mode.into(),
            environment: BTreeMap::new(),
            gpu_devices: Vec::new(),
        }
    }
}

#[cfg(target_os = "linux")]
fn collect_linux_diagnostics_linux(
    display_backend: String,
    graphics_mode: String,
) -> LinuxDiagnostics {
    const KEYS: [&str; 10] = [
        "XDG_SESSION_TYPE",
        "XDG_CURRENT_DESKTOP",
        "XDG_SESSION_DESKTOP",
        "WAYLAND_DISPLAY",
        "DISPLAY",
        GRAPHICS_MODE_ENV,
        "WEBKIT_DISABLE_DMABUF_RENDERER",
        "WEBKIT_DISABLE_COMPOSITING_MODE",
        "LIBGL_ALWAYS_SOFTWARE",
        "__NV_DISABLE_EXPLICIT_SYNC",
    ];
    let environment = KEYS
        .into_iter()
        .map(|key| (key.to_owned(), std::env::var(key).ok()))
        .collect();
    LinuxDiagnostics {
        session_type: std::env::var("XDG_SESSION_TYPE").ok(),
        display_backend,
        desktop_environment: std::env::var("XDG_CURRENT_DESKTOP")
            .or_else(|_| std::env::var("XDG_SESSION_DESKTOP"))
            .ok(),
        compositor_hint: compositor_hint(),
        webkitgtk_version: None,
        graphics_mode,
        environment,
        gpu_devices: gpu_devices(),
    }
}

#[cfg(target_os = "linux")]
fn compositor_hint() -> Option<String> {
    [
        "SWAYSOCK",
        "HYPRLAND_INSTANCE_SIGNATURE",
        "KDE_FULL_SESSION",
        "GNOME_DESKTOP_SESSION_ID",
    ]
    .into_iter()
    .find(|key| std::env::var_os(key).is_some())
    .map(str::to_owned)
}

#[cfg(target_os = "linux")]
fn gpu_devices() -> Vec<GpuDevice> {
    let Ok(entries) = fs::read_dir("/sys/class/drm") else {
        return Vec::new();
    };
    let mut devices = entries
        .flatten()
        .filter_map(|entry| {
            let card = entry.file_name().to_string_lossy().into_owned();
            if !card.starts_with("card") || card.contains('-') {
                return None;
            }
            let device = entry.path().join("device");
            Some(GpuDevice {
                card,
                vendor_id: read_trimmed(&device.join("vendor")),
                device_id: read_trimmed(&device.join("device")),
                driver: fs::read_link(device.join("driver")).ok().and_then(|path| {
                    path.file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                }),
            })
        })
        .collect::<Vec<_>>();
    devices.sort_by(|left, right| left.card.cmp(&right.card));
    devices
}

#[cfg(target_os = "linux")]
fn read_trimmed(path: &Path) -> Option<String> {
    fs::read_to_string(path)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

pub fn audio_diagnostics_from_devices(
    devices: &[crate::audio::AudioOutputDevice],
) -> AudioDiagnostics {
    let selected_device = devices.iter().find(|device| device.is_selected);
    let selected_output = selected_device.map(|device| device.label.clone());
    let selected_output_kind = selected_device.map(|device| device.selection_kind.clone());
    let resolved_output = selected_device.and_then(|device| device.resolved_output.as_ref());
    AudioDiagnostics {
        implementation: if cfg!(target_os = "linux") {
            "Rodio 0.22 / CPAL 0.17".to_owned()
        } else if cfg!(target_os = "windows") {
            "Rodio 0.22 / CPAL 0.17 (WASAPI)".to_owned()
        } else {
            "Rodio 0.22 / CPAL 0.17".to_owned()
        },
        route: if cfg!(target_os = "linux") {
            "ALSA host; desktop routing may be provided by PipeWire/PulseAudio compatibility"
                .to_owned()
        } else if cfg!(target_os = "windows") {
            "WASAPI default host".to_owned()
        } else {
            "CPAL default host".to_owned()
        },
        available: !devices.is_empty(),
        selected_output,
        selected_output_kind,
        resolved_output: resolved_output.map(|output| output.name.clone()),
        resolved_driver: resolved_output.map(|output| output.driver.clone()),
        resolved_host: resolved_output.map(|output| output.host.clone()),
        resolved_sample_rate: resolved_output.map(|output| output.sample_rate),
        resolved_channels: resolved_output.map(|output| output.channels),
        resolved_sample_format: resolved_output.map(|output| output.sample_format.clone()),
    }
}

pub struct LivePlatformInputs {
    pub app_version: String,
    pub audio_devices: Vec<crate::audio::AudioOutputDevice>,
    pub system_media: SystemMediaStatus,
    pub desktop_integration: DesktopIntegrationStatus,
    pub display_backend_override: Option<String>,
    pub graphics_mode: Option<String>,
}

pub fn assemble_live_platform_diagnostics(inputs: LivePlatformInputs) -> PlatformDiagnostics {
    let graphics_mode = inputs
        .graphics_mode
        .unwrap_or_else(|| std::env::var(GRAPHICS_MODE_ENV).unwrap_or_else(|_| "auto".to_owned()));
    let linux = if cfg!(target_os = "linux") {
        let backend = inputs
            .display_backend_override
            .unwrap_or_else(infer_linux_display_backend);
        Some(collect_linux_diagnostics(backend, graphics_mode))
    } else {
        let _ = inputs.display_backend_override;
        None
    };
    assemble_platform_diagnostics(PlatformFacts {
        generated_at_unix_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        app_version: inputs.app_version,
        os: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        linux,
        audio: audio_diagnostics_from_devices(&inputs.audio_devices),
        system_media: inputs.system_media,
        desktop_integration: inputs.desktop_integration,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_wayland_is_not_a_degraded_native_backend() {
        // Cannot safely mutate process env in parallel tests; assert the
        // capability table instead and lock the labels Settings shows.
        let capabilities = capabilities_for_backend("xwayland", false);
        assert!(capabilities.reliable_always_on_top);
        assert!(capabilities
            .notes
            .iter()
            .any(|note| note.contains("XWayland")));
        let default_wayland = capabilities_for_backend("wayland", true);
        assert!(default_wayland.reliable_always_on_top);
        assert!(default_wayland.notes.is_empty());
        let native = capabilities_for_backend("wayland-native", true);
        assert!(!native.reliable_always_on_top);
        assert!(!native.global_shortcuts);
    }

    #[test]
    fn live_assembly_uses_host_os_not_test_stub() {
        let diagnostics = assemble_live_platform_diagnostics(LivePlatformInputs {
            app_version: "1.2.3".to_owned(),
            audio_devices: Vec::new(),
            system_media: SystemMediaStatus {
                available: true,
                backend: "mpris-server 0.10 (zbus)",
                specification: "MPRIS 2.2",
                error: None,
            },
            desktop_integration: empty_desktop_integration(),
            display_backend_override: Some("wayland-native".to_owned()),
            graphics_mode: Some("auto".to_owned()),
        });
        assert_ne!(diagnostics.os, "test");
        assert_eq!(diagnostics.app_version, "1.2.3");
        assert_eq!(diagnostics.system_media.specification, "MPRIS 2.2");
        if cfg!(target_os = "linux") {
            let linux = diagnostics.linux.expect("linux blob");
            assert_eq!(linux.display_backend, "wayland-native");
            assert_eq!(linux.graphics_mode, "auto");
            assert!(linux.webkitgtk_version.is_none());
        } else {
            assert!(diagnostics.linux.is_none());
        }
    }
}
