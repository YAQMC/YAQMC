use crate::{
    desktop_integration::DesktopIntegrationStatus, player::PlayerService,
    system_media::SystemMediaStatus,
};
use std::{
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

#[cfg(target_os = "linux")]
use std::{collections::BTreeMap, fs};

use yaqmc_core::platform::{
    assemble_platform_diagnostics, export_bundle as export_core_bundle,
    log_startup as log_core_startup, PlatformDiagnosticAssets, PlatformFacts,
};
pub use yaqmc_core::platform::{AudioDiagnostics, LinuxDiagnostics, PlatformDiagnostics};

#[cfg(target_os = "linux")]
use yaqmc_core::platform::GpuDevice;

#[cfg(test)]
use yaqmc_core::platform::capabilities_for_backend;

#[cfg(target_os = "linux")]
use std::path::Path;

#[cfg(target_os = "linux")]
const GRAPHICS_MODE_ENV: &str = "YAQMC_LINUX_RENDERER";
const DIAGNOSTIC_SCRIPT: &str = include_str!("../../scripts/collect-linux-diagnostics.sh");
const LINUX_TESTER_README: &str = r#"YAQMC Linux final-AppImage acceptance

Use only the extracted YAQMC-linux-x86_64 tester bundle produced by GitHub Actions for the exact build under test.
The physical tester does not need a repository checkout. BUILD-IDENTITY.json, SHA256SUMS and the AppImage bind every
report to the final repacked artifact.

From the extracted bundle directory, verify identity before launch:
  sha256sum -c SHA256SUMS
  node verify-lyrics-acceptance.mjs --platform linux --identity-only --build-identity "$PWD/BUILD-IDENTITY.json"

Make the AppImage and collector executable, then collect the required modes into one root:
  appimage="$(node -p "require('./BUILD-IDENTITY.json').appImage.fileName")"
  chmod +x "$appimage" collect-linux-diagnostics.sh
  export YAQMC_ACCEPTANCE_ROOT="$PWD/YAQMC-linux-acceptance"
  ./collect-linux-diagnostics.sh "$PWD/$appimage" auto
  ./collect-linux-diagnostics.sh "$PWD/$appimage" native-wayland
  ./collect-linux-diagnostics.sh "$PWD/$appimage" x11

`baseline` is only a compatibility alias for `auto`; it does not mean XWayland. Run `software` only after a matching
native graphics failure and preserve that failed native report:
  YAQMC_ALLOW_SOFTWARE=confirmed-native-failure ./collect-linux-diagnostics.sh "$PWD/$appimage" software

Complete these phases in order for every required mode:
  startup-idle, playback, seek-pause-resume, main-scroll-resize, lyrics-normal, lyrics-focus, lyrics-fullscreen,
  desktop-lyrics, island-lyrics, both-surfaces, shutdown.

Verify and archive after auto, native-wayland and x11 are all present:
  node verify-lyrics-acceptance.mjs --platform linux --root "$YAQMC_ACCEPTANCE_ROOT" --build-identity "$PWD/BUILD-IDENTITY.json"
  tar -C "$(dirname "$YAQMC_ACCEPTANCE_ROOT")" -czf YAQMC-linux-acceptance.tar.gz "$(basename "$YAQMC_ACCEPTANCE_ROOT")"
  sha256sum YAQMC-linux-acceptance.tar.gz

Return the archive, its SHA-256, distribution/kernel/compositor/monitor/scale details, and concise visual/audio notes
to the maintainer. Collection is evidence, not a pass claim; the maintainer records the final verdict.
"#;

/// WebKitGTK env mutation used to live here (`WEBKIT_DISABLE_DMABUF_RENDERER`,
/// NVIDIA/Hyprland sniffing, `YAQMC_LINUX_RENDERER` modes). That stack is gone
/// from this shim: Electron maps `YAQMC_LINUX_RENDERER` as a host compat *read*
/// in `apps/desktop/main/linux-graphics.ts`. Core/shim must not set it.
/// Kept as a no-op so the Tauri composition point still compiles; diagnostics
/// below still probe distro/session/compositor/GPU and *read* env.
pub fn apply_startup_graphics_policy() {}

pub fn collect(
    app: &AppHandle,
    player: &PlayerService,
    system_media: SystemMediaStatus,
    desktop_integration: DesktopIntegrationStatus,
) -> PlatformDiagnostics {
    let linux = linux_diagnostics(app);
    let devices = player.output_devices().unwrap_or_default();
    let selected_device = devices.iter().find(|device| device.is_selected);
    let selected_output = selected_device.map(|device| device.label.clone());
    let selected_output_kind = selected_device.map(|device| device.selection_kind.clone());
    let resolved_output = selected_device.and_then(|device| device.resolved_output.as_ref());
    assemble_platform_diagnostics(PlatformFacts {
        generated_at_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        app_version: app.package_info().version.to_string(),
        os: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        linux,
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
            selected_output_kind,
            resolved_output: resolved_output.map(|output| output.name.clone()),
            resolved_driver: resolved_output.map(|output| output.driver.clone()),
            resolved_host: resolved_output.map(|output| output.host.clone()),
            resolved_sample_rate: resolved_output.map(|output| output.sample_rate),
            resolved_channels: resolved_output.map(|output| output.channels),
            resolved_sample_format: resolved_output.map(|output| output.sample_format.clone()),
        },
        system_media,
        desktop_integration,
    })
}

pub fn log_startup(diagnostics: &PlatformDiagnostics) {
    log_core_startup(diagnostics);
}

pub fn export_bundle(
    app: &AppHandle,
    diagnostics: &PlatformDiagnostics,
) -> Result<PathBuf, String> {
    let downloads = app
        .path()
        .download_dir()
        .map_err(|error| error.to_string())?;
    export_core_bundle(
        &downloads,
        diagnostics,
        PlatformDiagnosticAssets {
            collector_script: DIAGNOSTIC_SCRIPT,
            readme: LINUX_TESTER_README,
        },
    )
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

    #[test]
    fn startup_graphics_policy_does_not_mutate_webkitgtk_env() {
        let keys = [
            "WEBKIT_DISABLE_DMABUF_RENDERER",
            "WEBKIT_DISABLE_COMPOSITING_MODE",
            "LIBGL_ALWAYS_SOFTWARE",
            "__NV_DISABLE_EXPLICIT_SYNC",
            "YAQMC_LINUX_RENDERER",
        ];
        let before: Vec<Option<std::ffi::OsString>> =
            keys.iter().map(|key| std::env::var_os(key)).collect();
        apply_startup_graphics_policy();
        let after: Vec<Option<std::ffi::OsString>> =
            keys.iter().map(|key| std::env::var_os(key)).collect();
        assert_eq!(
            before, after,
            "core/shim must not set or clear WebKitGTK renderer env vars"
        );
    }

    #[test]
    fn tester_readme_requires_identity_modes_phases_and_verification() {
        for required in [
            "final-AppImage",
            "does not need a repository checkout",
            "BUILD-IDENTITY.json",
            "--identity-only",
            "auto",
            "native-wayland",
            "x11",
            "software",
            "startup-idle",
            "playback",
            "seek-pause-resume",
            "main-scroll-resize",
            "lyrics-normal",
            "lyrics-focus",
            "lyrics-fullscreen",
            "desktop-lyrics",
            "island-lyrics",
            "both-surfaces",
            "shutdown",
            "verify-lyrics-acceptance.mjs",
            "YAQMC-linux-acceptance.tar.gz",
        ] {
            assert!(
                LINUX_TESTER_README.contains(required),
                "tester README is missing {required}"
            );
        }
        assert!(LINUX_TESTER_README.contains(
            "`baseline` is only a compatibility alias for `auto`; it does not mean XWayland"
        ));
        assert!(!LINUX_TESTER_README.contains("baseline is XWayland"));
    }
}
