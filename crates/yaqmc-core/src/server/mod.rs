//! Protocol method dispatch over the P1 Core service graph.

mod events;
mod methods;
pub mod ops;
mod runtime;
mod serve;
mod types;

pub use events::{
    actions_for_player_event, host_command_event, lagged_resync_channels,
    spawn_account_restore_fanout, spawn_host_command_fanout, spawn_player_fanout, EventSink,
    FanoutActions,
};
pub use methods::{core_dispatch_methods, dispatch, DispatchError};
#[cfg(feature = "plugins")]
pub use ops::map_plugin_diagnostic_for_test;
pub use ops::{
    map_provider_section_for_test, perf_sample_header, perf_sample_line, write_perf_sample,
};
pub use runtime::{unavailable_error, CoreRuntime, JsonEventSink};
pub use serve::serve_protocol;
pub use types::{
    DebugPerfSample, DiagnosticsBundleRequest, DiagnosticsRequest, FrontendLogEntry,
    RecordErrorRequest,
};

use crate::diagnostics::AppSection;
use crate::platform::{DesktopIntegrationStatus, PlatformDiagnostics};
use std::path::PathBuf;

pub trait HostDispatchHooks: Send + Sync {
    fn platform_diagnostics(&self) -> PlatformDiagnostics;
    fn download_dir(&self) -> PathBuf;
    fn app_section(&self) -> AppSection;
    fn diagnostic_collector_script(&self) -> &'static str {
        ""
    }
    fn diagnostic_readme(&self) -> &'static str {
        ""
    }
    fn renderer_label(&self, _platform: &PlatformDiagnostics) -> String {
        "electron/unknown".to_owned()
    }
    fn notify_preferences_changed(&self, _value: &str) {}
    fn notify_plugin_changed(&self) {}
    fn desktop_integration_status(&self) -> DesktopIntegrationStatus {
        crate::platform::empty_desktop_integration()
    }
    fn linux_display_backend(&self) -> Option<String> {
        None
    }
    fn linux_graphics_mode(&self) -> Option<String> {
        None
    }
    fn oauth_window_is_live(&self, _attempt_id: &str) -> bool {
        true
    }
    fn close_oauth_window(&self, _attempt_id: &str) {}
}

pub struct NoopHost {
    pub download_dir: PathBuf,
}

impl HostDispatchHooks for NoopHost {
    fn platform_diagnostics(&self) -> PlatformDiagnostics {
        empty_platform_diagnostics()
    }

    fn download_dir(&self) -> PathBuf {
        self.download_dir.clone()
    }

    fn app_section(&self) -> AppSection {
        AppSection {
            name: "YAQMC",
            version: "0.0.0".to_owned(),
            commit: Some("test".to_owned()),
            channel: "test".to_owned(),
            build_type: "debug".to_owned(),
        }
    }

    /// Stdio Electron host: issue-reporter Environment block uses this as
    /// `host: electron/<version>`.
    fn renderer_label(&self, _platform: &PlatformDiagnostics) -> String {
        "electron/43.4.0".to_owned()
    }
}

pub fn empty_platform_diagnostics() -> PlatformDiagnostics {
    use crate::platform::{
        AudioDiagnostics, DesktopIntegrationStatus, PlatformCapabilities, SystemMediaStatus,
    };
    PlatformDiagnostics {
        generated_at_unix_ms: 0,
        app_name: "YAQMC",
        app_version: "0.0.0".to_owned(),
        os: "test",
        architecture: "x86_64",
        linux: None,
        capabilities: PlatformCapabilities {
            reliable_always_on_top: true,
            click_through: true,
            transparent_window: true,
            global_positioning: true,
            absolute_window_placement: true,
            fullscreen_detection: false,
            global_shortcuts: false,
            notes: Vec::new(),
        },
        audio: AudioDiagnostics {
            implementation: "test".to_owned(),
            route: "none".to_owned(),
            available: false,
            selected_output: None,
            selected_output_kind: None,
            resolved_output: None,
            resolved_driver: None,
            resolved_host: None,
            resolved_sample_rate: None,
            resolved_channels: None,
            resolved_sample_format: None,
        },
        system_media: SystemMediaStatus {
            available: false,
            backend: "none",
            specification: "none",
            error: None,
        },
        desktop_integration: DesktopIntegrationStatus {
            tray_available: false,
            tray_error: None,
            global_shortcuts_supported: false,
            global_shortcuts_enabled: false,
            global_shortcuts: Vec::new(),
            shortcut_error: None,
        },
    }
}
