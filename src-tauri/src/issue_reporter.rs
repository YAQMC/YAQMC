//! GitHub Issue Reporter URL composition.
//!
//! This module is deliberately pure: it does not open a browser, hit the network,
//! or read any account state. It converts a structured `IssueDraft` into a GitHub
//! issue-form URL that the frontend can either open through the existing scoped
//! [`tauri-plugin-opener`] boundary or copy-to-clipboard as a fallback.
//!
//! Design constraints:
//!   * never carries a GitHub token or personal credentials,
//!   * URL length capped at [`GITHUB_URL_SOFT_LIMIT`] (GitHub itself accepts a
//!     couple KiB but browsers vary; we stay conservative),
//!   * only emits URLs whose origin+path match [`ISSUE_URL_PREFIX`] and matches the
//!     Tauri opener allowlist in `capabilities/main-window.json`,
//!   * category → template mapping is stable so form-field IDs remain valid.

use crate::{diagnostics::DiagnosticsSnapshot, logging::sanitize_report_field};
use serde::{Deserialize, Serialize};
use std::fmt::Write as _;

/// The origin+path prefix that every generated URL must start with. Anything else
/// is rejected before the URL is handed to the opener plugin.
pub const ISSUE_URL_PREFIX: &str = "https://github.com/YAQMC/YAQMC/issues/new";
/// Conservative body cap so the generated URL stays well below the GitHub server
/// limit and typical browser address bar limit. Anything longer forces the user
/// into copy-issue-text fallback.
pub const ISSUE_BODY_SOFT_LIMIT: usize = 3_500;
/// Absolute cap on the total URL length we will hand to the browser.
pub const GITHUB_URL_SOFT_LIMIT: usize = 6_000;

/// Issue categories the reporter supports. Adding a new category means also mapping
/// it to a stable template file name in `.github/ISSUE_TEMPLATE/`. Scene is
/// intentionally reserved for a future milestone but not exposed yet.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum IssueCategory {
    Bug,
    Linux,
    Playback,
    Provider,
    Lyrics,
    Ui,
    Other,
}

impl IssueCategory {
    /// Ordered list of every category the reporter surfaces. Used by the frontend
    /// dialog and by category-completeness tests.
    #[allow(dead_code)]
    pub const ALL: &'static [IssueCategory] = &[
        IssueCategory::Bug,
        IssueCategory::Linux,
        IssueCategory::Playback,
        IssueCategory::Provider,
        IssueCategory::Lyrics,
        IssueCategory::Ui,
        IssueCategory::Other,
    ];

    /// The GitHub issue-form template file used for this category.
    pub fn template(self) -> &'static str {
        match self {
            IssueCategory::Bug => "bug-report.yml",
            IssueCategory::Linux => "linux-compatibility.yml",
            IssueCategory::Playback => "bug-report.yml",
            IssueCategory::Provider => "bug-report.yml",
            IssueCategory::Lyrics => "bug-report.yml",
            IssueCategory::Ui => "bug-report.yml",
            IssueCategory::Other => "bug-report.yml",
        }
    }

    /// Title prefix injected into the form title. Kept short so we stay under URL
    /// limits even for long user descriptions.
    pub fn title_prefix(self) -> &'static str {
        match self {
            IssueCategory::Bug => "[Bug]",
            IssueCategory::Linux => "[Linux]",
            IssueCategory::Playback => "[Bug]",
            IssueCategory::Provider => "[Bug]",
            IssueCategory::Lyrics => "[Bug]",
            IssueCategory::Ui => "[Bug]",
            IssueCategory::Other => "[Bug]",
        }
    }

    /// GitHub Issue Form field IDs the reporter prefills for this template.
    pub fn area_label(self) -> Option<&'static str> {
        match self {
            IssueCategory::Playback => Some("播放 / 队列 / 随机 / 循环"),
            IssueCategory::Provider => Some("登录 / 头像 / 账号资料"),
            IssueCategory::Lyrics => Some("主歌词 / 桌面歌词 / 歌词岛"),
            IssueCategory::Ui => Some("主题 / 布局 / 无障碍"),
            IssueCategory::Bug => Some("其他"),
            IssueCategory::Linux => None,
            IssueCategory::Other => Some("其他"),
        }
    }

    pub fn slug(self) -> &'static str {
        match self {
            IssueCategory::Bug => "bug",
            IssueCategory::Linux => "linux",
            IssueCategory::Playback => "playback",
            IssueCategory::Provider => "provider",
            IssueCategory::Lyrics => "lyrics",
            IssueCategory::Ui => "ui",
            IssueCategory::Other => "other",
        }
    }

    /// GitHub Issue Form field ID that receives the generated technical body.
    /// Each supported template exposes a distinct diagnostics/evidence field.
    pub fn body_field_id(self) -> &'static str {
        match self {
            IssueCategory::Linux => "evidence",
            _ => "diagnostics",
        }
    }
}

/// User input plus optional linked application error, ready to be rendered into a
/// GitHub issue URL and preview.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueDraft {
    pub category: IssueCategory,
    /// User-provided short summary (line 1 of the issue).
    pub summary: String,
    /// User-provided steps/description (may be empty).
    pub description: String,
    /// Optional attached bundle filename (only the file *name*, never a full path).
    pub bundle_file_name: Option<String>,
    /// Optional recent-error code linked from an error surface.
    pub linked_error_code: Option<String>,
    /// Optional correlation ID for the linked error.
    pub linked_op_id: Option<String>,
}

/// Fully prepared preview + URL for the frontend Issue Reporter dialog.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuePreview {
    pub title: String,
    pub body: String,
    pub url: String,
    pub too_long_for_browser: bool,
    pub included_fields: Vec<&'static str>,
    pub template: &'static str,
}

/// Prepare an issue preview from a draft and diagnostics snapshot.
pub fn prepare_preview(draft: &IssueDraft, snapshot: &DiagnosticsSnapshot) -> IssuePreview {
    let title = compose_title(draft);
    let body = compose_body(draft, snapshot);
    let (url, too_long) = compose_url(draft.category, &title, &body);
    IssuePreview {
        title,
        body,
        url,
        too_long_for_browser: too_long,
        included_fields: included_fields_for(draft.category),
        template: draft.category.template(),
    }
}

/// Validate a URL that the frontend is about to hand to the opener plugin. Returns
/// `Ok(())` iff the URL matches the strict allowlist we ship with the app.
pub fn validate_open_url(url: &str) -> Result<(), &'static str> {
    if !url.starts_with(ISSUE_URL_PREFIX) {
        return Err("only YAQMC issue URLs may be opened by the reporter");
    }
    if url.contains('\n') || url.contains('\r') || url.contains(' ') {
        return Err("issue URL contains whitespace");
    }
    if url.len() > GITHUB_URL_SOFT_LIMIT {
        return Err("issue URL exceeds the soft length limit");
    }
    Ok(())
}

fn compose_title(draft: &IssueDraft) -> String {
    let sanitized = sanitize_report_field(&draft.summary).trim().to_owned();
    let base = if sanitized.is_empty() {
        "issue".to_owned()
    } else {
        sanitized
    };
    // Limit the summary itself to 120 chars so the full title stays readable.
    let truncated = truncate_chars(&base, 120);
    format!("{} {}", draft.category.title_prefix(), truncated)
}

fn compose_body(draft: &IssueDraft, snapshot: &DiagnosticsSnapshot) -> String {
    let mut body = String::new();
    if !draft.summary.trim().is_empty() {
        writeln!(
            &mut body,
            "**Summary**\n\n{}\n",
            sanitize_report_field(draft.summary.trim())
        )
        .ok();
    }
    if !draft.description.trim().is_empty() {
        writeln!(
            &mut body,
            "**Steps / Details**\n\n{}\n",
            sanitize_report_field(draft.description.trim())
        )
        .ok();
    }
    writeln!(&mut body, "**Environment**").ok();
    writeln!(&mut body, "- YAQMC: {}", snapshot.app.version).ok();
    if let Some(commit) = snapshot.app.commit.as_deref() {
        writeln!(&mut body, "- Commit: {commit}").ok();
    }
    writeln!(
        &mut body,
        "- Channel/build: {} / {}",
        snapshot.app.channel, snapshot.app.build_type
    )
    .ok();
    writeln!(
        &mut body,
        "- OS: {} · Architecture: {}",
        snapshot.platform.os, snapshot.platform.architecture
    )
    .ok();
    writeln!(
        &mut body,
        "- Renderer: {}",
        renderer_label(&snapshot.platform)
    )
    .ok();
    writeln!(
        &mut body,
        "- Audio backend: {} · policy={} · host={}",
        snapshot.platform.audio.implementation,
        snapshot
            .platform
            .audio
            .selected_output_kind
            .as_deref()
            .unwrap_or("unavailable"),
        snapshot
            .platform
            .audio
            .resolved_host
            .as_deref()
            .unwrap_or("unavailable")
    )
    .ok();
    if let Some(provider) = &snapshot.provider {
        writeln!(
            &mut body,
            "- Provider: {} · {} · account={} · tier={}",
            provider.id,
            provider.connection,
            provider.account_state,
            provider.membership_tier.as_deref().unwrap_or("unknown")
        )
        .ok();
    }
    writeln!(
        &mut body,
        "- Log level: {} · Session: `{}`",
        snapshot.log_level.as_str(),
        snapshot.session_id
    )
    .ok();
    if let Some(error) = draft.linked_error_code.as_deref() {
        writeln!(
            &mut body,
            "- Linked error: `{error}`{}",
            draft
                .linked_op_id
                .as_deref()
                .map(|op| format!(" (op=`{op}`)"))
                .unwrap_or_default()
        )
        .ok();
    }
    if !snapshot.recent_errors.is_empty() {
        writeln!(&mut body, "\n**Recent errors (bounded)**").ok();
        for record in snapshot.recent_errors.iter().rev().take(5) {
            writeln!(
                &mut body,
                "- `{}` {} · {}",
                record.code, record.domain, record.message
            )
            .ok();
        }
    }
    if let Some(name) = draft.bundle_file_name.as_deref() {
        writeln!(
            &mut body,
            "\n**Attached diagnostic bundle**: `{name}` (drag from your file manager into this Issue)"
        )
        .ok();
    }
    writeln!(&mut body, "\n---\n> Generated by YAQMC Issue Reporter. Please review the fields above before submitting.").ok();
    // Enforce body cap.
    if body.len() > ISSUE_BODY_SOFT_LIMIT {
        let mut truncated = truncate_bytes_at_char(&body, ISSUE_BODY_SOFT_LIMIT);
        truncated.push_str("\n\n> _...body truncated by YAQMC to fit URL length limits. Full diagnostics are inside the attached bundle._");
        return truncated;
    }
    body
}

fn compose_url(category: IssueCategory, title: &str, body: &str) -> (String, bool) {
    let mut url = String::from(ISSUE_URL_PREFIX);
    url.push('?');
    url.push_str("template=");
    url.push_str(&percent_encode(category.template()));
    url.push_str("&labels=");
    url.push_str(&percent_encode(&format!(
        "needs-triage,reporter:{}",
        category.slug()
    )));
    url.push_str("&title=");
    url.push_str(&percent_encode(title));
    url.push('&');
    url.push_str(category.body_field_id());
    url.push('=');
    url.push_str(&percent_encode(body));
    if let Some(area) = category.area_label() {
        url.push_str("&area=");
        url.push_str(&percent_encode(area));
    }
    let too_long = url.len() > GITHUB_URL_SOFT_LIMIT;
    (url, too_long)
}

fn included_fields_for(category: IssueCategory) -> Vec<&'static str> {
    let mut fields = vec!["title", category.body_field_id()];
    if category.area_label().is_some() {
        fields.push("area");
    }
    fields.push("labels");
    fields
}

fn renderer_label(platform: &crate::platform::PlatformDiagnostics) -> String {
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

fn truncate_chars(value: &str, max: usize) -> String {
    let mut result = String::new();
    for (index, character) in value.chars().enumerate() {
        if index >= max {
            result.push('…');
            break;
        }
        result.push(character);
    }
    result
}

fn truncate_bytes_at_char(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

/// Percent-encode according to RFC 3986 unreserved plus GitHub's tolerance. We
/// escape everything except ASCII letters, digits, and `-_.~`.
fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char);
            }
            _ => {
                let _ = write!(&mut out, "%{byte:02X}");
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostics::{
        stub_platform_diagnostics, AppSection, DiagnosticsSnapshot, PlaybackSection,
    };
    use crate::logging::{ErrorRecord, LogLevel};

    fn snapshot() -> DiagnosticsSnapshot {
        DiagnosticsSnapshot::assemble(
            "sessionid00000000",
            LogLevel::Info,
            AppSection {
                name: "YAQMC",
                version: "0.1.0".into(),
                commit: Some("deadbeef1234".into()),
                channel: "development".into(),
                build_type: "release".into(),
            },
            stub_platform_diagnostics(),
            None,
            None,
            None,
            PlaybackSection {
                state: "paused",
                selected_quality: Some("automatic".into()),
                decoder_hint: Some("flac".into()),
                queue_length: 0,
                current_source_kind: None,
            },
            vec![ErrorRecord::new(
                "YAQMC-AUDIO-OUTPUT-001",
                "audio.output",
                "cannot open selected device",
            )],
        )
    }

    #[test]
    fn category_enum_is_complete_and_ordered() {
        assert_eq!(IssueCategory::ALL.len(), 7);
        for category in IssueCategory::ALL {
            assert!(!category.template().is_empty());
            assert!(!category.slug().is_empty());
        }
    }

    #[test]
    fn preview_contains_environment_and_prefill_fields() {
        let draft = IssueDraft {
            category: IssueCategory::Playback,
            summary: "Song pauses at 0:22".into(),
            description: "Steps:\n1. Play G.E.M.\n2. Wait\n".into(),
            bundle_file_name: Some("YAQMC-diagnostics-20260814-133000.zip".into()),
            linked_error_code: Some("YAQMC-AUDIO-DECODE-004".into()),
            linked_op_id: Some("8f3b41".into()),
        };
        let preview = prepare_preview(&draft, &snapshot());
        assert!(preview.title.starts_with("[Bug] Song pauses"));
        assert!(preview.body.contains("YAQMC: 0.1.0"));
        assert!(preview.body.contains("Renderer: WebView2"));
        assert!(preview.body.contains("Session: `sessionid00000000`"));
        assert!(preview
            .body
            .contains("Linked error: `YAQMC-AUDIO-DECODE-004`"));
        assert!(preview
            .body
            .contains("YAQMC-diagnostics-20260814-133000.zip"));
        assert!(preview.url.starts_with(ISSUE_URL_PREFIX));
        assert!(preview.url.contains("template=bug-report.yml"));
        assert!(preview.url.contains("area="));
        assert!(preview.included_fields.contains(&"area"));
        assert_eq!(preview.template, "bug-report.yml");
    }

    #[test]
    fn preview_encodes_unicode_chinese_summary_and_body() {
        let draft = IssueDraft {
            category: IssueCategory::Bug,
            summary: "播放暂停在 0:22".into(),
            description: "复现步骤: 播放 G.E.M.".into(),
            bundle_file_name: None,
            linked_error_code: None,
            linked_op_id: None,
        };
        let preview = prepare_preview(&draft, &snapshot());
        assert!(preview.title.contains("播放暂停在"));
        // Percent-encoded UTF-8 bytes for the leading Chinese char '播' = 0xE6 0x92 0xAD
        assert!(preview.url.contains("%E6%92%AD"));
        assert!(preview.url.is_ascii());
    }

    #[test]
    fn preview_respects_body_and_url_length_limits() {
        let big = "A".repeat(20_000);
        let draft = IssueDraft {
            category: IssueCategory::Bug,
            summary: "issue".into(),
            description: big,
            bundle_file_name: None,
            linked_error_code: None,
            linked_op_id: None,
        };
        let preview = prepare_preview(&draft, &snapshot());
        assert!(preview.body.len() <= ISSUE_BODY_SOFT_LIMIT + 200);
        assert!(preview.body.contains("_...body truncated by YAQMC"));
        // With truncation the URL should stay within the browser cap.
        assert!(preview.url.len() <= GITHUB_URL_SOFT_LIMIT + 50);
    }

    #[test]
    fn preview_scrubs_secrets_in_summary_and_description() {
        let draft = IssueDraft {
            category: IssueCategory::Provider,
            summary: "cookie=uin=1; qm_keyst=SECRET fails login".into(),
            description: "authorization=Bearer TOKEN123".into(),
            bundle_file_name: None,
            linked_error_code: None,
            linked_op_id: None,
        };
        let preview = prepare_preview(&draft, &snapshot());
        assert!(!preview.title.contains("SECRET"));
        assert!(!preview.body.contains("SECRET"));
        assert!(!preview.body.contains("TOKEN123"));
        assert!(preview.body.contains("[REDACTED]"));
    }

    #[test]
    fn validate_open_url_rejects_other_origins() {
        assert!(validate_open_url("https://example.com/issues/new?title=x").is_err());
        assert!(validate_open_url("https://github.com/other/repo/issues/new").is_err());
        assert!(validate_open_url("https://github.com/YAQMC/YAQMC/pulls").is_err());
        let ok = compose_url(IssueCategory::Bug, "hi", "there").0;
        assert!(validate_open_url(&ok).is_ok());
    }

    #[test]
    fn validate_open_url_rejects_whitespace_and_oversize() {
        let ok_base = compose_url(IssueCategory::Bug, "hi", "there").0;
        let with_space = format!("{ok_base} extra");
        assert!(validate_open_url(&with_space).is_err());
        let oversize = format!("{ok_base}{}", "x".repeat(GITHUB_URL_SOFT_LIMIT));
        assert!(validate_open_url(&oversize).is_err());
    }

    #[test]
    fn percent_encoding_matches_rfc3986_unreserved_set() {
        let sample = "abcXYZ012-_.~";
        assert_eq!(percent_encode(sample), sample);
        assert_eq!(percent_encode(" "), "%20");
        assert_eq!(percent_encode("/"), "%2F");
        assert_eq!(percent_encode("?"), "%3F");
        assert_eq!(percent_encode("["), "%5B");
    }

    #[test]
    fn empty_summary_falls_back_to_generic_title() {
        let draft = IssueDraft {
            category: IssueCategory::Bug,
            summary: "  ".into(),
            description: "".into(),
            bundle_file_name: None,
            linked_error_code: None,
            linked_op_id: None,
        };
        let preview = prepare_preview(&draft, &snapshot());
        assert_eq!(preview.title, "[Bug] issue");
    }
}
