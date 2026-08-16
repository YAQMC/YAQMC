//! Tauri adapter for the Core-owned Issue Reporter composition.

use crate::diagnostics::DiagnosticsSnapshot;

pub use yaqmc_core::issue_reporter::{validate_open_url, IssueDraft, IssuePreview};

pub fn prepare_preview(draft: &IssueDraft, snapshot: &DiagnosticsSnapshot) -> IssuePreview {
    yaqmc_core::issue_reporter::prepare_preview(
        draft,
        snapshot,
        &renderer_label(&snapshot.platform),
    )
}

fn renderer_label(platform: &yaqmc_core::platform::PlatformDiagnostics) -> String {
    match platform.os {
        "windows" => "WebView2 / Tauri".to_owned(),
        "linux" => platform
            .linux
            .as_ref()
            .and_then(|linux| linux.webkitgtk_version.as_deref())
            .map(|version| format!("WebKitGTK {version} / Tauri"))
            .unwrap_or_else(|| "WebKitGTK / Tauri".to_owned()),
        "macos" => "WKWebView / Tauri".to_owned(),
        _ => "Tauri WebView".to_owned(),
    }
}
