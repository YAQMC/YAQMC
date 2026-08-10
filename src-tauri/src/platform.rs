use crate::{
    desktop_integration::DesktopIntegrationStatus, player::PlayerService,
    system_media::SystemMediaStatus,
};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

#[cfg(target_os = "linux")]
use std::path::Path;

#[cfg(target_os = "linux")]
const GRAPHICS_MODE_ENV: &str = "YAQMC_LINUX_RENDERER";
const DIAGNOSTIC_SCRIPT: &str = include_str!("../../scripts/collect-linux-diagnostics.sh");

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

/// Applies only an explicitly requested compatibility mode. Auto mode leaves GTK/WebKitGTK's
/// backend and acceleration decisions untouched.
pub fn apply_startup_graphics_policy() {
    #[cfg(target_os = "linux")]
    match std::env::var(GRAPHICS_MODE_ENV)
        .unwrap_or_else(|_| "auto".to_owned())
        .to_ascii_lowercase()
        .as_str()
    {
        "disable-dmabuf" | "compatibility" => {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
        "software" | "safe" => {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            std::env::set_var("LIBGL_ALWAYS_SOFTWARE", "1");
        }
        _ => {}
    }
}

pub fn collect(
    app: &AppHandle,
    player: &PlayerService,
    system_media: SystemMediaStatus,
    desktop_integration: DesktopIntegrationStatus,
) -> PlatformDiagnostics {
    let linux = linux_diagnostics(app);
    let capabilities = capabilities_for_backend(
        linux
            .as_ref()
            .map(|value| value.display_backend.as_str())
            .unwrap_or(std::env::consts::OS),
        desktop_integration.global_shortcuts_supported,
    );
    let devices = player.output_devices().unwrap_or_default();
    let selected_output = devices
        .iter()
        .find(|device| device.is_selected)
        .map(|device| device.label.clone());
    PlatformDiagnostics {
        generated_at_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        app_name: "YAQMC",
        app_version: app.package_info().version.to_string(),
        os: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        linux,
        capabilities,
        audio: AudioDiagnostics {
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
        },
        system_media,
        desktop_integration,
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
        output = diagnostics.audio.selected_output.as_deref().unwrap_or("unavailable"),
        "audio backend detected"
    );
}

pub fn export_bundle(
    app: &AppHandle,
    diagnostics: &PlatformDiagnostics,
) -> Result<PathBuf, String> {
    let downloads = app
        .path()
        .download_dir()
        .map_err(|error| error.to_string())?;
    let stamp = diagnostics.generated_at_unix_ms;
    let directory = downloads.join(format!("YAQMC-linux-diagnostics-{stamp}"));
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let json = serde_json::to_vec_pretty(diagnostics).map_err(|error| error.to_string())?;
    fs::write(directory.join("yaqmc-diagnostics.json"), json).map_err(|error| error.to_string())?;
    fs::write(
        directory.join("collect-linux-diagnostics.sh"),
        DIAGNOSTIC_SCRIPT,
    )
    .map_err(|error| error.to_string())?;
    fs::write(
        directory.join("README.txt"),
        "YAQMC Linux diagnostic bundle\n\nRun with session-aware backend selection:\n  chmod +x collect-linux-diagnostics.sh\n  ./collect-linux-diagnostics.sh /path/to/YAQMC.AppImage baseline\n\nControlled backend comparisons:\n  ./collect-linux-diagnostics.sh /path/to/YAQMC.AppImage native-wayland\n  ./collect-linux-diagnostics.sh /path/to/YAQMC.AppImage x11\n\nClose YAQMC after testing; send the generated report directory back to the maintainer.\nThe script collects only operating-system, graphics, audio, YAQMC logs and process-tree resource samples. ps %CPU is a lifetime average, not an instantaneous sample; summed RSS can double-count shared pages.\n",
    )
    .map_err(|error| error.to_string())?;
    Ok(directory)
}

#[cfg(target_os = "linux")]
pub fn display_backend(app: &AppHandle) -> String {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let raw = app
        .get_webview_window("main")
        .and_then(|window| window.window_handle().ok().map(|handle| handle.as_raw()));
    match raw {
        Some(RawWindowHandle::Wayland(_)) => "wayland-native".to_owned(),
        Some(RawWindowHandle::Xlib(_)) | Some(RawWindowHandle::Xcb(_)) => {
            if env_lower("XDG_SESSION_TYPE").as_deref() == Some("wayland") {
                "xwayland".to_owned()
            } else {
                "x11".to_owned()
            }
        }
        Some(_) => "linux-unknown".to_owned(),
        None => "unavailable".to_owned(),
    }
}

fn capabilities_for_backend(
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
            fullscreen_detection: cfg!(target_os = "windows"),
            global_shortcuts: global_shortcuts_supported,
            notes: if backend == "xwayland" {
                vec!["The desktop session is Wayland, but YAQMC is using an X11/XWayland window backend.".to_owned()]
            } else {
                Vec::new()
            },
        }
    }
}

#[cfg(target_os = "linux")]
fn linux_diagnostics(app: &AppHandle) -> Option<LinuxDiagnostics> {
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
    Some(LinuxDiagnostics {
        session_type: std::env::var("XDG_SESSION_TYPE").ok(),
        display_backend: display_backend(app),
        desktop_environment: std::env::var("XDG_CURRENT_DESKTOP")
            .or_else(|_| std::env::var("XDG_SESSION_DESKTOP"))
            .ok(),
        compositor_hint: compositor_hint(),
        webkitgtk_version: webkitgtk_version(),
        graphics_mode: std::env::var(GRAPHICS_MODE_ENV).unwrap_or_else(|_| "auto".to_owned()),
        environment,
        gpu_devices: gpu_devices(),
    })
}

#[cfg(not(target_os = "linux"))]
fn linux_diagnostics(_app: &AppHandle) -> Option<LinuxDiagnostics> {
    None
}

#[cfg(target_os = "linux")]
fn webkitgtk_version() -> Option<String> {
    // These version functions are side-effect free and provided by the linked WebKitGTK runtime.
    let (major, minor, micro) = unsafe {
        (
            webkit2gtk_sys::webkit_get_major_version(),
            webkit2gtk_sys::webkit_get_minor_version(),
            webkit2gtk_sys::webkit_get_micro_version(),
        )
    };
    Some(format!("{major}.{minor}.{micro}"))
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
fn env_lower(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_wayland_does_not_overpromise_x11_window_semantics() {
        let capabilities = capabilities_for_backend("wayland-native", true);
        assert!(!capabilities.click_through);
        assert!(!capabilities.global_positioning);
        assert!(!capabilities.global_shortcuts);
    }

    #[test]
    fn xwayland_is_reported_as_a_degraded_backend_not_native_wayland() {
        let capabilities = capabilities_for_backend("xwayland", true);
        assert!(capabilities.click_through);
        assert!(capabilities
            .notes
            .iter()
            .any(|note| note.contains("XWayland")));
    }
}
