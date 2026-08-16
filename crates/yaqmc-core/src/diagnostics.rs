//! Diagnostic snapshot, ZIP bundle export, and second-pass redaction scanning.
//!
//! This module intentionally does NOT open any account-scoped storage. Everything it
//! reads comes from platform metadata, rotating log files under the application log
//! directory, and short in-memory state passed in by the caller. The bundle it
//! produces contains only non-secret runtime facts plus previously-persisted logs.
//!
//! The second-pass scan runs [`crate::logging::scrub_high_risk_patterns`] on every
//! text file added to the ZIP and records the outcome in `redaction-report.txt`. If
//! the caller passes `override_unresolved: false` (the default) and any unresolved
//! high-risk pattern remains, bundle creation is refused so we never silently ship a
//! log line we could not confidently redact.

use crate::{
    logging::{
        self, sanitize_path, sanitize_path_with_roots, scrub_high_risk_patterns, ErrorRecord,
        LogLevel, LoggingHandle, HIGH_RISK_KEYS, LOG_FILE_PREFIX,
    },
    platform::PlatformDiagnostics,
};
use serde::{Deserialize, Serialize};
use std::{
    borrow::Cow,
    fs,
    io::{Read, Seek, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

/// Stable schema version for the diagnostic snapshot and bundle manifest.
pub const BUNDLE_SCHEMA_VERSION: u32 = 1;
/// Stable identifier of the redaction scanner that produced a bundle. Bumping this
/// signals to consumers that the redaction rules changed.
pub const REDACTION_SCANNER_VERSION: u32 = 1;
/// Cap on the total uncompressed bytes copied into a bundle. Prevents runaway log
/// growth from producing multi-GiB attachments.
pub const BUNDLE_MAX_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSection {
    pub name: &'static str,
    pub version: String,
    pub commit: Option<String>,
    pub channel: String,
    pub build_type: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSection {
    pub state: &'static str,
    pub selected_quality: Option<String>,
    pub decoder_hint: Option<String>,
    pub queue_length: usize,
    pub current_source_kind: Option<&'static str>,
    pub playback_order: &'static str,
    pub repeat_mode: &'static str,
    pub primary_playback_mode: &'static str,
    #[serde(default)]
    pub playback_session_id: u64,
    #[serde(default)]
    pub snapshot_revision: u64,
    #[serde(default)]
    pub source_generation: u64,
    #[serde(default)]
    pub last_seek_revision: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSection {
    pub id: String,
    pub connection: String,
    pub account_state: String,
    pub membership_tier: Option<String>,
    pub membership_status: Option<String>,
}

/// Provider-independent plugin wire model. Host plugin runtimes map to this DTO at
/// their aggregation boundary so Core never depends on plugin implementation types.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
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

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LyricsPresetSection {
    pub id: String,
    pub kind: String,
    pub schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub renderer_version: Option<u32>,
}

/// Structured snapshot separate from raw logs, safe for direct display in the UI
/// and safe for pasting into a GitHub issue.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsSnapshot {
    pub schema_version: u32,
    pub session_id: String,
    pub generated_at_unix_ms: u128,
    pub app: AppSection,
    pub platform: PlatformDiagnostics,
    pub provider: Option<ProviderSection>,
    pub playback: PlaybackSection,
    pub log_level: LogLevel,
    pub recent_errors: Vec<ErrorRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lyrics_preset: Option<LyricsPresetSection>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub plugins: Vec<PluginDiagnostic>,
}

impl DiagnosticsSnapshot {
    #[allow(clippy::too_many_arguments)]
    pub fn assemble(
        session_id: &str,
        log_level: LogLevel,
        app: AppSection,
        platform: PlatformDiagnostics,
        provider: Option<ProviderSection>,
        playback: PlaybackSection,
        recent_errors: Vec<ErrorRecord>,
    ) -> Self {
        Self {
            schema_version: BUNDLE_SCHEMA_VERSION,
            session_id: session_id.to_owned(),
            generated_at_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|value| value.as_millis())
                .unwrap_or_default(),
            app,
            platform,
            provider,
            playback,
            log_level,
            recent_errors,
            lyrics_preset: None,
            plugins: Vec::new(),
        }
    }

    /// Render a stable, secret-free plaintext block suitable for copy-paste.
    pub fn to_plain_text(&self) -> String {
        let mut out = String::new();
        let audio = &self.platform.audio;
        let commit = self.app.commit.as_deref().unwrap_or("unknown");
        out.push_str(&format!(
            "YAQMC diagnostics snapshot (schema v{})\n",
            self.schema_version
        ));
        out.push_str(&format!("Session: {}\n", self.session_id));
        out.push_str(&format!("Timestamp (ms): {}\n", self.generated_at_unix_ms));
        out.push_str(&format!(
            "App: {} {} (commit={commit}, channel={}, build={})\n",
            self.app.name, self.app.version, self.app.channel, self.app.build_type
        ));
        out.push_str(&format!(
            "Platform: {} / {}\n",
            self.platform.os, self.platform.architecture
        ));
        out.push_str(&format!(
            "Audio: {} · route={} · policy={} · host={}\n",
            audio.implementation,
            audio.route,
            audio
                .selected_output_kind
                .as_deref()
                .unwrap_or("unavailable"),
            audio.resolved_host.as_deref().unwrap_or("unavailable"),
        ));
        if let Some(provider) = &self.provider {
            out.push_str(&format!(
                "Provider: {} · {} · account={} · tier={} · status={}\n",
                provider.id,
                provider.connection,
                provider.account_state,
                provider.membership_tier.as_deref().unwrap_or("unknown"),
                provider.membership_status.as_deref().unwrap_or("unknown"),
            ));
        }
        out.push_str(&format!(
            "Playback: state={} · quality={} · source={} · queue_len={} · order={} · repeat={} · mode={} · player_session={} · revision={} · source_gen={} · seek={}\n",
            self.playback.state,
            self.playback
                .selected_quality
                .as_deref()
                .unwrap_or("unknown"),
            self.playback.current_source_kind.unwrap_or("none"),
            self.playback.queue_length,
            self.playback.playback_order,
            self.playback.repeat_mode,
            self.playback.primary_playback_mode,
            self.playback.playback_session_id,
            self.playback.snapshot_revision,
            self.playback.source_generation,
            self.playback.last_seek_revision
        ));
        out.push_str(&format!("Log level: {}\n", self.log_level.as_str()));
        if let Some(preset) = &self.lyrics_preset {
            out.push_str(&format!(
                "Lyrics preset: {} ({}, schema v{}{})\n",
                preset.id,
                preset.kind,
                preset.schema_version,
                preset
                    .renderer_version
                    .map(|version| format!(", renderer v{version}"))
                    .unwrap_or_default()
            ));
        }
        if !self.plugins.is_empty() {
            out.push_str("Plugins:\n");
            for plugin in &self.plugins {
                out.push_str(&format!(
                    "  - {} {} · enabled={} · status={:?} · api=v{} · sha256={} · perms={} · risk={}\n",
                    plugin.id,
                    plugin.version,
                    plugin.enabled,
                    plugin.status,
                    plugin.api_version,
                    plugin.package_sha256,
                    plugin.permissions.join(","),
                    plugin.risk_rating
                ));
            }
        }
        if !self.recent_errors.is_empty() {
            out.push_str("Recent errors:\n");
            for record in &self.recent_errors {
                out.push_str(&format!(
                    "  [{}] {} · {}{}\n",
                    record.code,
                    record.domain,
                    record.message,
                    record
                        .op_id
                        .as_deref()
                        .map(|op| format!(" · op={op}"))
                        .unwrap_or_default()
                ));
            }
        }
        out
    }
}

/// Aggregated result of a bundle export, ready to be surfaced to the frontend.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleExportResult {
    pub path: PathBuf,
    pub bytes: u64,
    pub sha256: String,
    pub redaction: RedactionReport,
    pub warnings: Vec<String>,
    pub manifest: BundleManifest,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleManifest {
    pub schema_version: u32,
    pub scanner_version: u32,
    pub app_name: String,
    pub app_version: String,
    pub platform: String,
    pub architecture: String,
    pub generated_at_unix_ms: u128,
    pub session_id: String,
    pub log_files: Vec<String>,
    pub include_snapshot: bool,
    pub include_logs: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactionReport {
    pub scanner_version: u32,
    pub files_scanned: usize,
    pub values_redacted: usize,
    pub unresolved_patterns: Vec<String>,
}

impl RedactionReport {
    fn render(&self) -> String {
        let mut out = format!(
            "Redaction scanner: v{}\nFiles scanned: {}\nValues automatically redacted: {}\nUnresolved high-risk patterns: {}\n",
            self.scanner_version, self.files_scanned, self.values_redacted, self.unresolved_patterns.len()
        );
        if !self.unresolved_patterns.is_empty() {
            out.push_str("Unresolved pattern categories:\n");
            for pattern in &self.unresolved_patterns {
                out.push_str("  - ");
                out.push_str(pattern);
                out.push('\n');
            }
        }
        out
    }
}

/// Parameters controlling how the bundle is produced.
pub struct BundleOptions<'a> {
    pub include_logs: bool,
    pub override_unresolved: bool,
    pub description: Option<&'a str>,
    pub issue_category: Option<&'a str>,
}

impl<'a> Default for BundleOptions<'a> {
    fn default() -> Self {
        Self {
            include_logs: true,
            override_unresolved: false,
            description: None,
            issue_category: None,
        }
    }
}

/// Produce a diagnostic ZIP at `dest_dir/YAQMC-diagnostics-YYYYMMDD-HHMMSS.zip`.
///
/// Returns `Err` if unresolved high-risk patterns remain and the caller did not
/// pass `override_unresolved: true`. In that case the partially-written ZIP is
/// removed and the user is expected to be prompted upstream.
pub fn export_bundle(
    dest_dir: &Path,
    snapshot: &DiagnosticsSnapshot,
    log_dir: &Path,
    options: BundleOptions<'_>,
) -> Result<BundleExportResult, BundleError> {
    fs::create_dir_all(dest_dir).map_err(|error| BundleError::Io(error.to_string()))?;
    let stamp = format_stamp(snapshot.generated_at_unix_ms);
    let path = dest_dir.join(format!("YAQMC-diagnostics-{stamp}.zip"));

    let log_files = if options.include_logs {
        collect_log_files(log_dir)
    } else {
        Vec::new()
    };
    let log_file_names: Vec<String> = log_files
        .iter()
        .filter_map(|path| {
            path.file_name()
                .and_then(|name| name.to_str().map(String::from))
        })
        .collect();

    let manifest = BundleManifest {
        schema_version: BUNDLE_SCHEMA_VERSION,
        scanner_version: REDACTION_SCANNER_VERSION,
        app_name: "YAQMC".to_owned(),
        app_version: snapshot.app.version.clone(),
        platform: snapshot.platform.os.to_owned(),
        architecture: snapshot.platform.architecture.to_owned(),
        generated_at_unix_ms: snapshot.generated_at_unix_ms,
        session_id: snapshot.session_id.clone(),
        log_files: log_file_names.clone(),
        include_snapshot: true,
        include_logs: options.include_logs,
    };

    let mut base_redaction = RedactionReport {
        scanner_version: REDACTION_SCANNER_VERSION,
        files_scanned: 0,
        values_redacted: 0,
        unresolved_patterns: Vec::new(),
    };
    let raw_manifest = serde_json::to_vec_pretty(&manifest).map_err(BundleError::from_serde)?;
    let (manifest_bytes, manifest_stats) = scrub_bytes(&raw_manifest);
    absorb_scrub_stats(&mut base_redaction, manifest_stats);
    let manifest = serde_json::from_slice(&manifest_bytes).map_err(BundleError::from_serde)?;
    let mut mandatory_entries = vec![BundleEntry::new("manifest.json", manifest_bytes)];
    let mut warnings = Vec::new();

    let snapshot_bytes = serde_json::to_vec_pretty(snapshot).map_err(BundleError::from_serde)?;
    let (scrubbed_snapshot, snapshot_stats) = scrub_bytes(&snapshot_bytes);
    absorb_scrub_stats(&mut base_redaction, snapshot_stats);
    mandatory_entries.push(BundleEntry::new("diagnostics.json", scrubbed_snapshot));

    let plain = snapshot.to_plain_text();
    let (scrubbed_text, text_stats) = scrub_bytes(plain.as_bytes());
    absorb_scrub_stats(&mut base_redaction, text_stats);
    mandatory_entries.push(BundleEntry::new("diagnostics.txt", scrubbed_text));

    if let Some(description) = options.description {
        let description = sanitize_user_description(description);
        let payload = format!(
            "Category: {}\n\n{}\n",
            options.issue_category.unwrap_or("(none)"),
            description
        );
        let (scrubbed, stats) = scrub_bytes(payload.as_bytes());
        absorb_scrub_stats(&mut base_redaction, stats);
        mandatory_entries.push(BundleEntry::new("user-description.txt", scrubbed));
    }

    if total_entry_bytes(&mandatory_entries) > BUNDLE_MAX_BYTES {
        return Err(BundleError::TooLarge);
    }

    let mut log_entries = Vec::new();
    if options.include_logs {
        for source in &log_files {
            let Some(name) = source.file_name().and_then(|value| value.to_str()) else {
                warnings.push("skipped log with invalid file name".to_owned());
                continue;
            };
            let name = sanitize_log_name(name);
            let used = total_entry_bytes(&mandatory_entries)
                .saturating_add(total_entry_bytes_for_logs(&log_entries));
            let remaining = BUNDLE_MAX_BYTES.saturating_sub(used);
            let bytes = match read_bounded_log(source, remaining) {
                Ok(bytes) => bytes,
                Err(BoundedLogReadError::TooLarge) => {
                    warnings.push(format!(
                        "log {name} skipped because it exceeds remaining bundle budget"
                    ));
                    continue;
                }
                Err(BoundedLogReadError::Io(error)) => {
                    warnings.push(format!(
                        "log {name} could not be read: {}",
                        sanitize_path(&error)
                    ));
                    continue;
                }
            };
            let (scrubbed, stats) = scrub_bytes(&bytes);
            if scrubbed.len() as u64 > remaining {
                warnings.push(format!(
                    "log {name} skipped because redaction exceeds remaining bundle budget"
                ));
                continue;
            }
            log_entries.push(BundleLogEntry {
                entry: BundleEntry::new(format!("logs/{name}"), scrubbed),
                stats,
            });
        }
    }

    let (redaction, report_bytes) = loop {
        let redaction = redaction_with_logs(&base_redaction, &log_entries);
        let report_bytes = redaction.render().into_bytes();
        let total = total_entry_bytes(&mandatory_entries)
            .saturating_add(total_entry_bytes_for_logs(&log_entries))
            .saturating_add(report_bytes.len() as u64);
        if total <= BUNDLE_MAX_BYTES {
            break (redaction, report_bytes);
        }
        let Some(removed) = log_entries.pop() else {
            return Err(BundleError::TooLarge);
        };
        warnings.push(format!(
            "log {} skipped because the complete bundle exceeds {BUNDLE_MAX_BYTES} bytes",
            removed.entry.name.trim_start_matches("logs/")
        ));
    };

    if !redaction.unresolved_patterns.is_empty() && !options.override_unresolved {
        return Err(BundleError::UnresolvedRedactionPatterns(
            redaction.unresolved_patterns,
        ));
    }

    let mut entries = mandatory_entries;
    entries.extend(log_entries.into_iter().map(|log| log.entry));
    entries.push(BundleEntry::new("redaction-report.txt", report_bytes));
    if total_entry_bytes(&entries) > BUNDLE_MAX_BYTES {
        return Err(BundleError::TooLarge);
    }

    let write_result = (|| -> Result<(), BundleError> {
        let file = fs::File::create(&path).map_err(|error| BundleError::Io(error.to_string()))?;
        let mut writer = ZipWriter::new(file);
        let entry_options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o644);
        for entry in &entries {
            write_entry(&mut writer, &entry.name, &entry.bytes, entry_options)?;
        }
        writer
            .finish()
            .map_err(|error| BundleError::Io(error.to_string()))?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&path);
        return Err(error);
    }

    let final_bytes = fs::metadata(&path)
        .map_err(|error| BundleError::Io(error.to_string()))?
        .len();
    let sha256 = sha256_of(&path).map_err(|error| BundleError::Io(error.to_string()))?;

    Ok(BundleExportResult {
        path,
        bytes: final_bytes,
        sha256,
        redaction,
        warnings,
        manifest,
    })
}

struct BundleEntry {
    name: String,
    bytes: Vec<u8>,
}

impl BundleEntry {
    fn new(name: impl Into<String>, bytes: Vec<u8>) -> Self {
        Self {
            name: name.into(),
            bytes,
        }
    }
}

struct BundleLogEntry {
    entry: BundleEntry,
    stats: ScrubStats,
}

enum BoundedLogReadError {
    TooLarge,
    Io(String),
}

fn total_entry_bytes(entries: &[BundleEntry]) -> u64 {
    entries.iter().map(|entry| entry.bytes.len() as u64).sum()
}

fn total_entry_bytes_for_logs(entries: &[BundleLogEntry]) -> u64 {
    entries
        .iter()
        .map(|entry| entry.entry.bytes.len() as u64)
        .sum()
}

fn absorb_scrub_stats(report: &mut RedactionReport, stats: ScrubStats) {
    report.files_scanned += 1;
    report.values_redacted += stats.replacements;
    report.unresolved_patterns.extend(stats.unresolved);
}

fn redaction_with_logs(base: &RedactionReport, logs: &[BundleLogEntry]) -> RedactionReport {
    let mut report = base.clone();
    for log in logs {
        report.files_scanned += 1;
        report.values_redacted += log.stats.replacements;
        report
            .unresolved_patterns
            .extend(log.stats.unresolved.iter().cloned());
    }
    report.unresolved_patterns.sort();
    report.unresolved_patterns.dedup();
    report
}

fn read_bounded_log(source: &Path, max_bytes: u64) -> Result<Vec<u8>, BoundedLogReadError> {
    let metadata =
        fs::metadata(source).map_err(|error| BoundedLogReadError::Io(error.to_string()))?;
    if !metadata.is_file() || metadata.len() > max_bytes {
        return Err(BoundedLogReadError::TooLarge);
    }
    let capacity = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
    let file =
        fs::File::open(source).map_err(|error| BoundedLogReadError::Io(error.to_string()))?;
    let mut bounded = file.take(max_bytes.saturating_add(1));
    let mut bytes = Vec::with_capacity(capacity);
    bounded
        .read_to_end(&mut bytes)
        .map_err(|error| BoundedLogReadError::Io(error.to_string()))?;
    if bytes.len() as u64 > max_bytes {
        return Err(BoundedLogReadError::TooLarge);
    }
    Ok(bytes)
}

fn sanitize_log_name(name: &str) -> String {
    sanitize_path(&logging::sanitize_field(name)).replace(['\n', '\r'], " ")
}

/// Compute an issue-form-safe description block that respects our size cap and does
/// not carry raw user paths or high-risk secrets.
pub fn sanitize_user_description(input: &str) -> String {
    sanitize_user_description_after_path_sanitization(sanitize_path(input))
}

pub fn sanitize_user_description_with_roots(input: &str, roots: &[&str]) -> String {
    sanitize_user_description_after_path_sanitization(sanitize_path_with_roots(input, roots))
}

fn sanitize_user_description_after_path_sanitization(sanitized_path: String) -> String {
    let scrubbed = scrub_high_risk_patterns(&sanitized_path).into_owned();
    if scrubbed.len() > logging::DESCRIPTION_MAX_BYTES {
        let truncated = truncate_utf8(&scrubbed, logging::DESCRIPTION_MAX_BYTES);
        format!("{truncated}\n...[truncated by YAQMC]")
    } else {
        scrubbed
    }
}

fn truncate_utf8(value: &str, max_bytes: usize) -> &str {
    let mut end = max_bytes.min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

/// Compute the recent-errors substring for an issue body (bounded, human-readable).
/// Not currently used by the reporter (which walks the snapshot directly), but kept
/// as an ergonomic helper for downstream tooling and tests.
#[allow(dead_code)]
pub fn format_recent_errors_summary(records: &[ErrorRecord], limit: usize) -> String {
    if records.is_empty() {
        return "None captured".to_owned();
    }
    let take = records.len().min(limit);
    let start = records.len() - take;
    let mut out = String::new();
    for record in &records[start..] {
        out.push_str(&format!(
            "- [{}] {} · {}{}\n",
            record.code,
            record.domain,
            record.message,
            record
                .op_id
                .as_deref()
                .map(|op| format!(" · op={op}"))
                .unwrap_or_default()
        ));
    }
    out
}

/// Public wrapper for the frontend to preview a snapshot without exporting.
pub fn snapshot_from_handle(
    handle: &LoggingHandle,
    platform: PlatformDiagnostics,
    provider: Option<ProviderSection>,
    playback: PlaybackSection,
    app: AppSection,
) -> DiagnosticsSnapshot {
    DiagnosticsSnapshot::assemble(
        handle.session_id(),
        handle.level(),
        app,
        platform,
        provider,
        playback,
        handle.recent_errors(),
    )
}

#[derive(Debug, thiserror::Error)]
pub enum BundleError {
    #[error("bundle io error: {0}")]
    Io(String),
    #[error("serialization failure: {0}")]
    Serde(String),
    #[error("unresolved high-risk patterns after redaction: {0:?}")]
    UnresolvedRedactionPatterns(Vec<String>),
    #[error("required diagnostic entries exceed the {BUNDLE_MAX_BYTES}-byte bundle limit")]
    TooLarge,
}

impl BundleError {
    fn from_serde(error: serde_json::Error) -> Self {
        BundleError::Serde(error.to_string())
    }
}

struct ScrubStats {
    replacements: usize,
    unresolved: Vec<String>,
}

fn scrub_bytes(source: &[u8]) -> (Vec<u8>, ScrubStats) {
    let text = match std::str::from_utf8(source) {
        Ok(text) => Cow::Borrowed(text),
        Err(_) => Cow::Owned(String::from_utf8_lossy(source).into_owned()),
    };
    let sanitized_paths = sanitize_path(text.as_ref());
    let scrubbed = scrub_high_risk_patterns(&sanitized_paths).into_owned();
    let replacements = scrubbed.matches("[REDACTED]").count();
    let unresolved = detect_unresolved_patterns(&scrubbed);
    (
        scrubbed.into_bytes(),
        ScrubStats {
            replacements,
            unresolved,
        },
    )
}

/// Look for shapes that our scrubber cannot fully rewrite (e.g., a raw Bearer token
/// that appears without an explicit key/separator, or a plain 32+ hex string). If we
/// find any, we surface the *category*, not the value, so the report itself never
/// leaks the actual bytes.
fn detect_unresolved_patterns(text: &str) -> Vec<String> {
    let mut findings = Vec::new();
    let lowered = text.to_ascii_lowercase();
    if lowered.contains("bearer ") && !lowered.contains("bearer [redacted]") {
        // If any 'Bearer <token>' survives without the redaction sentinel next to it,
        // treat as unresolved.
        for line in text.lines() {
            let lower = line.to_ascii_lowercase();
            if let Some(idx) = lower.find("bearer ") {
                let after = &line[idx + "bearer ".len()..];
                let candidate = after
                    .split(|character: char| character.is_ascii_whitespace() || character == '"')
                    .next()
                    .unwrap_or("");
                if candidate.len() >= 12
                    && candidate != "[REDACTED]"
                    && !candidate.starts_with("[REDACTED]")
                {
                    findings.push("bearer-token".to_owned());
                    break;
                }
            }
        }
    }
    // Detect very-long hex-like runs that look like ekey/qm_keyst residue.
    let mut current_hex = 0usize;
    for character in text.chars() {
        if character.is_ascii_hexdigit() {
            current_hex += 1;
            if current_hex >= 128 {
                findings.push("long-hex-token".to_owned());
                break;
            }
        } else {
            current_hex = 0;
        }
    }
    // Cookie / qm_keyst residues (already excluded by our scrubber, but if our regex
    // missed an edge case we surface the category name only).
    for key in HIGH_RISK_KEYS {
        let needle = format!("{key}=");
        if let Some(idx) = text.to_ascii_lowercase().find(needle.as_str()) {
            let end = idx + needle.len();
            let after = &text[end..];
            if !after.starts_with("[REDACTED]") && !after.starts_with('\n') && !after.is_empty() {
                findings.push((*key).to_owned());
            }
        }
    }
    findings.sort();
    findings.dedup();
    findings
}

fn collect_log_files(log_dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(log_dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let is_log = path
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.starts_with(LOG_FILE_PREFIX))
                .unwrap_or(false);
            if is_log {
                Some(path)
            } else {
                None
            }
        })
        .collect();
    files.sort();
    files
}

fn write_entry(
    writer: &mut ZipWriter<fs::File>,
    name: &str,
    bytes: &[u8],
    options: SimpleFileOptions,
) -> Result<(), BundleError> {
    writer
        .start_file(name, options)
        .map_err(|error| BundleError::Io(error.to_string()))?;
    writer
        .write_all(bytes)
        .map_err(|error| BundleError::Io(error.to_string()))?;
    Ok(())
}

fn sha256_of(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8_192];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    file.seek(std::io::SeekFrom::Start(0))?;
    Ok(format!("{:x}", hasher.finalize()))
}

fn format_stamp(unix_ms: u128) -> String {
    // Manual UTC formatter avoids pulling `chrono`/`time`; the stamp is a monotone
    // sort key, not a wall-clock display.
    let seconds = (unix_ms / 1_000) as i64;
    let days = seconds.div_euclid(86_400);
    let time_of_day = seconds.rem_euclid(86_400);
    let hour = (time_of_day / 3_600) as u32;
    let minute = ((time_of_day % 3_600) / 60) as u32;
    let second = (time_of_day % 60) as u32;
    let (year, month, day) = date_from_days_since_epoch(days);
    format!("{year:04}{month:02}{day:02}-{hour:02}{minute:02}{second:02}")
}

fn date_from_days_since_epoch(mut days: i64) -> (i32, u32, u32) {
    days += 719_468;
    let era = days.div_euclid(146_097);
    let doe = (days - era * 146_097) as u32;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i32 + (era as i32) * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d)
}

#[cfg(test)]
pub(crate) fn stub_platform_diagnostics() -> PlatformDiagnostics {
    use crate::platform::{
        AudioDiagnostics, DesktopIntegrationStatus, PlatformCapabilities, SystemMediaStatus,
    };
    PlatformDiagnostics {
        generated_at_unix_ms: 1,
        app_name: "YAQMC",
        app_version: "0.1.0".into(),
        os: "windows",
        architecture: "x86_64",
        linux: None,
        capabilities: PlatformCapabilities {
            reliable_always_on_top: true,
            click_through: true,
            transparent_window: true,
            global_positioning: true,
            absolute_window_placement: true,
            fullscreen_detection: true,
            global_shortcuts: true,
            notes: vec![],
        },
        audio: AudioDiagnostics {
            implementation: "Rodio 0.22 / CPAL 0.17 (WASAPI)".into(),
            route: "WASAPI default host".into(),
            available: true,
            selected_output: Some("Speakers".into()),
            selected_output_kind: Some("system-default".into()),
            resolved_output: Some("Speakers".into()),
            resolved_driver: Some("WASAPI".into()),
            resolved_host: Some("WASAPI".into()),
            resolved_sample_rate: Some(48_000),
            resolved_channels: Some(2),
            resolved_sample_format: Some("f32".into()),
        },
        system_media: SystemMediaStatus {
            available: true,
            backend: "SMTC",
            specification: "Windows SMTC",
            error: None,
        },
        desktop_integration: DesktopIntegrationStatus {
            tray_available: true,
            tray_error: None,
            global_shortcuts_supported: true,
            global_shortcuts_enabled: true,
            global_shortcuts: vec![],
            shortcut_error: None,
        },
    }
}

#[cfg(test)]
pub(crate) fn stub_provider_section() -> ProviderSection {
    ProviderSection {
        id: "qqmusic".into(),
        connection: "online".into(),
        account_state: "authenticated".into(),
        membership_tier: Some("green-diamond".into()),
        membership_status: Some("active".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logging::{test_handle, LogLevel};
    use std::fs;
    use tempfile::tempdir;

    fn stub_diagnostics(session: &str) -> DiagnosticsSnapshot {
        DiagnosticsSnapshot::assemble(
            session,
            LogLevel::Info,
            AppSection {
                name: "YAQMC",
                version: "0.1.0".into(),
                commit: Some("abcdef123456".into()),
                channel: "development".into(),
                build_type: "release".into(),
            },
            stub_platform_diagnostics(),
            Some(stub_provider_section()),
            PlaybackSection {
                state: "playing",
                selected_quality: Some("high".into()),
                decoder_hint: Some("flac".into()),
                queue_length: 3,
                current_source_kind: Some("qqmusic"),
                playback_order: "sequential",
                repeat_mode: "off",
                primary_playback_mode: "sequential",
                playback_session_id: 0,
                snapshot_revision: 0,
                source_generation: 0,
                last_seek_revision: 0,
            },
            vec![],
        )
    }

    #[test]
    fn snapshot_plaintext_contains_key_facts_without_secrets() {
        let snapshot = stub_diagnostics("abc123");
        let text = snapshot.to_plain_text();
        assert!(text.contains("YAQMC 0.1.0"));
        assert!(text.contains("commit=abcdef123456"));
        assert!(text.contains("policy=system-default"));
        assert!(text.contains("Provider: qqmusic"));
        assert!(text.contains("tier=green-diamond"));
        assert!(!text.contains("cookie"));
        assert!(!text.contains("ekey"));
    }

    #[test]
    fn snapshot_plaintext_includes_compact_lyrics_preset() {
        let mut snapshot = stub_diagnostics("abc123");
        snapshot.lyrics_preset = Some(LyricsPresetSection {
            id: "builtin.classic".into(),
            kind: "built-in".into(),
            schema_version: 1,
            renderer_version: None,
        });
        let text = snapshot.to_plain_text();
        assert!(text.contains("Lyrics preset: builtin.classic (built-in, schema v1)"));
        assert!(!text.contains("overrides"));
        assert!(!text.contains("backgrounds"));
    }

    #[test]
    fn bundle_export_produces_valid_zip_and_manifest() {
        let temp = tempdir().unwrap();
        let log_dir = temp.path().join("logs");
        fs::create_dir_all(&log_dir).unwrap();
        fs::write(
            log_dir.join("yaqmc.2026-08-14.log"),
            b"first line\nsecond line\n",
        )
        .unwrap();
        let dest = temp.path().join("out");
        let snapshot = stub_diagnostics("session-x");
        let result = export_bundle(
            &dest,
            &snapshot,
            &log_dir,
            BundleOptions {
                include_logs: true,
                override_unresolved: false,
                description: Some("Playback stalls"),
                issue_category: Some("bug-report"),
            },
        )
        .expect("bundle");
        assert!(result.path.exists());
        assert!(result.bytes > 0);
        assert_eq!(result.sha256.len(), 64);
        assert!(result.redaction.unresolved_patterns.is_empty());
        assert_eq!(result.manifest.schema_version, BUNDLE_SCHEMA_VERSION);
        assert!(result
            .manifest
            .log_files
            .iter()
            .any(|name| name.starts_with("yaqmc")));

        let mut zip = zip::ZipArchive::new(fs::File::open(&result.path).unwrap()).unwrap();
        let names: Vec<String> = zip.file_names().map(String::from).collect();
        for required in [
            "manifest.json",
            "diagnostics.json",
            "diagnostics.txt",
            "redaction-report.txt",
        ] {
            assert!(
                names.iter().any(|name| name == required),
                "missing {required}"
            );
        }
        let mut report = String::new();
        zip.by_name("redaction-report.txt")
            .unwrap()
            .read_to_string(&mut report)
            .unwrap();
        assert!(report.contains("Redaction scanner: v1"));
    }

    #[test]
    fn bundle_export_scrubs_and_reports_high_risk_lines() {
        let temp = tempdir().unwrap();
        let log_dir = temp.path().join("logs");
        fs::create_dir_all(&log_dir).unwrap();
        fs::write(
            log_dir.join("yaqmc.2026-08-14.log"),
            b"session start\nreq cookie=uin=1234; qm_keyst=SECRETVAL\nreq authorization=Bearer TOKENVALUE\n",
        )
        .unwrap();
        let snapshot = stub_diagnostics("scrub");
        let dest = temp.path().join("out");
        let result =
            export_bundle(&dest, &snapshot, &log_dir, BundleOptions::default()).expect("bundle");
        let mut zip = zip::ZipArchive::new(fs::File::open(&result.path).unwrap()).unwrap();
        let mut log = String::new();
        zip.by_name("logs/yaqmc.2026-08-14.log")
            .unwrap()
            .read_to_string(&mut log)
            .unwrap();
        assert!(!log.contains("SECRETVAL"));
        assert!(!log.contains("TOKENVALUE"));
        assert!(log.contains("[REDACTED]"));
        assert!(result.redaction.values_redacted >= 2);
    }

    #[test]
    fn bundle_manifest_scrubs_log_names_and_returns_the_written_safe_value() {
        let temp = tempdir().unwrap();
        let log_dir = temp.path().join("logs");
        fs::create_dir_all(&log_dir).unwrap();
        fs::write(log_dir.join("yaqmc cookie=SECRET.log"), b"normal log\n").unwrap();

        let result = export_bundle(
            &temp.path().join("out"),
            &stub_diagnostics("manifest-scrub"),
            &log_dir,
            BundleOptions::default(),
        )
        .expect("recognized manifest secrets should be scrubbed");
        assert!(result.redaction.values_redacted >= 1);
        assert!(result
            .manifest
            .log_files
            .iter()
            .all(|name| !name.contains("SECRET")));

        let mut archive = zip::ZipArchive::new(fs::File::open(&result.path).unwrap()).unwrap();
        let mut manifest = String::new();
        archive
            .by_name("manifest.json")
            .unwrap()
            .read_to_string(&mut manifest)
            .unwrap();
        assert!(!manifest.contains("SECRET"));
        assert!(manifest.contains("[REDACTED]"));
    }

    #[test]
    fn bundle_manifest_refuses_an_unresolved_secret_in_a_log_name() {
        let temp = tempdir().unwrap();
        let log_dir = temp.path().join("logs");
        fs::create_dir_all(&log_dir).unwrap();
        fs::write(
            log_dir.join("yaqmc-authorization=Bearer SECRET0123456789.log"),
            b"normal log\n",
        )
        .unwrap();
        let dest = temp.path().join("out");

        let error = export_bundle(
            &dest,
            &stub_diagnostics("manifest-refuse"),
            &log_dir,
            BundleOptions::default(),
        )
        .expect_err("unresolved manifest secrets must fail closed");
        assert!(matches!(error, BundleError::UnresolvedRedactionPatterns(_)));
        assert!(fs::read_dir(&dest)
            .expect("destination directory")
            .flatten()
            .all(|entry| !entry.path().to_string_lossy().ends_with(".zip")));
    }

    #[test]
    fn bundle_refuses_unresolved_bearer_token() {
        let temp = tempdir().unwrap();
        let log_dir = temp.path().join("logs");
        fs::create_dir_all(&log_dir).unwrap();
        // A bare "Bearer <token>" without a preceding key can slip past keyed scrubbers.
        fs::write(
            log_dir.join("yaqmc.log"),
            b"note Bearer 0123456789abcdef01234567890\n",
        )
        .unwrap();
        let snapshot = stub_diagnostics("refuse");
        let dest = temp.path().join("out");
        let error = export_bundle(&dest, &snapshot, &log_dir, BundleOptions::default())
            .expect_err("should refuse when unresolved");
        matches!(error, BundleError::UnresolvedRedactionPatterns(_));
        // ZIP must have been removed to avoid shipping the unsafe bundle.
        for entry in fs::read_dir(&dest).unwrap().flatten() {
            assert!(!entry
                .path()
                .to_string_lossy()
                .contains("YAQMC-diagnostics-"));
        }
    }

    #[test]
    fn bundle_refuses_oversized_mandatory_entries_without_creating_a_zip() {
        let temp = tempdir().unwrap();
        let log_dir = temp.path().join("logs");
        let dest = temp.path().join("out");
        let mut snapshot = stub_diagnostics("required-too-large");
        snapshot.app.version = "v".repeat(BUNDLE_MAX_BYTES as usize);
        let error = export_bundle(&dest, &snapshot, &log_dir, BundleOptions::default())
            .expect_err("mandatory entries must not exceed the uncompressed bundle cap");
        assert!(matches!(error, BundleError::TooLarge));
        let entries = fs::read_dir(&dest)
            .expect("destination directory exists")
            .flatten()
            .collect::<Vec<_>>();
        assert!(entries.is_empty(), "no partial ZIP may remain");
    }

    #[test]
    fn sanitize_user_description_scrubs_secrets_and_paths() {
        let cleaned = sanitize_user_description_with_roots(
            "reproduces at /home/tester/Music/ with cookie=uin=1; qm_keyst=SECRET",
            &["/home/tester"],
        );
        assert!(!cleaned.contains("SECRET"));
        assert!(!cleaned.contains("/home/tester/"));
        assert!(cleaned.contains("<USER_HOME>/Music/"));
    }

    #[test]
    fn format_stamp_produces_stable_iso_like_key() {
        let stamp = format_stamp(1_755_190_800_000);
        assert_eq!(stamp.len(), 15);
        assert!(stamp.chars().nth(8) == Some('-'));
    }

    #[test]
    fn snapshot_helper_reuses_handle_session_and_recent_errors() {
        let handle = test_handle();
        handle.record_error(ErrorRecord::new(
            "YAQMC-QQ-AUTH-001",
            "qqmusic.auth",
            "session invalidated",
        ));
        let snap = snapshot_from_handle(
            &handle,
            stub_platform_diagnostics(),
            None,
            PlaybackSection {
                state: "idle",
                selected_quality: None,
                decoder_hint: None,
                queue_length: 0,
                current_source_kind: None,
                playback_order: "sequential",
                repeat_mode: "off",
                primary_playback_mode: "sequential",
                playback_session_id: 0,
                snapshot_revision: 0,
                source_generation: 0,
                last_seek_revision: 0,
            },
            AppSection {
                name: "YAQMC",
                version: "0.1.0".into(),
                commit: None,
                channel: "development".into(),
                build_type: "test".into(),
            },
        );
        assert_eq!(snap.session_id, handle.session_id());
        assert_eq!(snap.recent_errors.len(), 1);
        assert_eq!(snap.recent_errors[0].code, "YAQMC-QQ-AUTH-001");
    }
}
