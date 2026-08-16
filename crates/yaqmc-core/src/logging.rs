//! Centralized logging, session identity, path sanitization, and a bounded in-memory
//! recent-error ring buffer.
//!
//! The design keeps three foundations coherent:
//!   * a random per-run session ID used to correlate log lines across layers,
//!   * a rotating file appender under the platform application log directory,
//!   * a defensive per-line redaction pass that strips high-risk substrings before
//!     they can ever reach disk.
//!
//! Sensitive fields are also expected to be redacted at their source by the owning
//! host/provider adapter. The redaction here is a belt-and-suspenders layer, not the
//! primary defense.

use rand::{rng, RngCore};
use serde::{Deserialize, Serialize};
use std::{
    borrow::Cow,
    collections::VecDeque,
    fmt as std_fmt, fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tracing_appender::{
    non_blocking::WorkerGuard,
    rolling::{RollingFileAppender, Rotation},
};
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

/// Number of past error records kept in memory for issue reporting.
pub const RECENT_ERROR_CAPACITY: usize = 32;
/// Maximum daily log files kept on disk.
pub const MAX_LOG_FILES: usize = 7;
/// Cap on user-supplied description bytes that we ever log/report.
pub const DESCRIPTION_MAX_BYTES: usize = 4_096;
/// Cap on a single logged field value before truncation.
pub const FIELD_VALUE_TRUNCATE: usize = 512;
/// File name prefix used for rotated logs.
pub const LOG_FILE_PREFIX: &str = "yaqmc";
/// Persistent settings key used by host adapters for the selected startup level.
pub const LOG_LEVEL_SETTING_KEY: &str = "logging.level";

const REDACTED: &str = "[REDACTED]";

/// Log level enum surfaced to the frontend and persisted in preferences.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

impl LogLevel {
    pub fn as_env_filter(self) -> &'static str {
        match self {
            LogLevel::Error => "yaqmc=error,error",
            LogLevel::Warn => "yaqmc=warn,warn",
            LogLevel::Info => "yaqmc=info,info",
            LogLevel::Debug => "yaqmc=debug,info",
            LogLevel::Trace => "yaqmc=trace,debug",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "error" => Some(LogLevel::Error),
            "warn" => Some(LogLevel::Warn),
            "info" => Some(LogLevel::Info),
            "debug" => Some(LogLevel::Debug),
            "trace" => Some(LogLevel::Trace),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            LogLevel::Error => "error",
            LogLevel::Warn => "warn",
            LogLevel::Info => "info",
            LogLevel::Debug => "debug",
            LogLevel::Trace => "trace",
        }
    }
}

// Debug builds default to DEBUG so a fresh developer install captures ample context;
// release builds default to INFO so users do not sink to disk high-frequency events.
// Kept as a manual impl because `derive(Default)` cannot switch on `cfg`.
#[allow(clippy::derivable_impls)]
impl Default for LogLevel {
    fn default() -> Self {
        #[cfg(debug_assertions)]
        {
            LogLevel::Debug
        }
        #[cfg(not(debug_assertions))]
        {
            LogLevel::Info
        }
    }
}

/// Immutable per-run identity plus writable ring buffer for recent errors.
#[derive(Clone)]
pub struct LoggingHandle {
    session_id: Arc<str>,
    log_dir: Arc<PathBuf>,
    level: LogLevel,
    recent_errors: Arc<Mutex<VecDeque<ErrorRecord>>>,
}

impl LoggingHandle {
    /// Construct the portable state handle without installing a process-global subscriber.
    /// Hosts use [`init`] once during boot; tests and alternate hosts can inject a directory.
    pub fn for_directory(log_dir: PathBuf, level: LogLevel) -> Self {
        Self {
            session_id: generate_session_id().into(),
            log_dir: Arc::new(log_dir),
            level,
            recent_errors: Arc::new(Mutex::new(VecDeque::with_capacity(RECENT_ERROR_CAPACITY))),
        }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn log_dir(&self) -> &Path {
        self.log_dir.as_path()
    }

    pub fn level(&self) -> LogLevel {
        self.level
    }

    pub fn recent_errors(&self) -> Vec<ErrorRecord> {
        self.recent_errors
            .lock()
            .map(|guard| guard.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Record a user-reportable error into the bounded ring buffer.
    ///
    /// This is *not* the same as `tracing::error!`. Only errors that a user could
    /// plausibly want to include in an Issue report should end up here.
    pub fn record_error(&self, record: ErrorRecord) {
        let Ok(mut guard) = self.recent_errors.lock() else {
            return;
        };
        if guard.len() >= RECENT_ERROR_CAPACITY {
            guard.pop_front();
        }
        guard.push_back(record);
    }
}

/// A single reportable error kept in the ring buffer.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorRecord {
    pub code: String,
    pub domain: String,
    pub message: String,
    pub op_id: Option<String>,
    pub captured_at_unix_ms: u128,
}

impl ErrorRecord {
    pub fn new(
        code: impl Into<String>,
        domain: impl Into<String>,
        message: impl AsRef<str>,
    ) -> Self {
        Self {
            code: code.into(),
            domain: domain.into(),
            message: sanitize_field(message.as_ref()).into_owned(),
            op_id: None,
            captured_at_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|value| value.as_millis())
                .unwrap_or_default(),
        }
    }

    pub fn with_op_id(mut self, op_id: impl Into<String>) -> Self {
        self.op_id = Some(op_id.into());
        self
    }
}

/// Global reference to the handle installed by `init`. Present only after the app
/// has started; unit tests should construct an isolated handle with
/// [`LoggingHandle::for_directory`] instead.
static GLOBAL_HANDLE: OnceLock<LoggingHandle> = OnceLock::new();
static GUARDS: OnceLock<Vec<WorkerGuard>> = OnceLock::new();

/// Initialize the logger for the running application.
///
/// * `log_dir` – platform application log directory (created if missing).
/// * `level` – requested level; overridden by the `RUST_LOG` env var if set.
///
/// Returns the shared handle. Safe to call at most once per process.
pub fn init(log_dir: PathBuf, level: LogLevel) -> io::Result<LoggingHandle> {
    fs::create_dir_all(&log_dir)?;

    let session_id = generate_session_id();

    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(level.as_env_filter()));

    let file_appender = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix(LOG_FILE_PREFIX)
        .filename_suffix("log")
        .max_log_files(MAX_LOG_FILES)
        .build(&log_dir)
        .map_err(io::Error::other)?;
    let (non_blocking, guard) = tracing_appender::non_blocking(RedactingWriter::new(file_appender));

    let file_layer = fmt::layer()
        .with_ansi(false)
        .with_target(true)
        .with_level(true)
        .with_writer(non_blocking);
    let console_layer = fmt::layer()
        .with_ansi(true)
        .with_target(true)
        .with_writer(io::stderr);

    let subscriber = tracing_subscriber::registry()
        .with(filter)
        .with(file_layer)
        .with(console_layer);
    let install_result = subscriber.try_init();

    let handle = LoggingHandle {
        session_id: session_id.into(),
        ..LoggingHandle::for_directory(log_dir, level)
    };

    let _ = GUARDS.set(vec![guard]);
    let _ = GLOBAL_HANDLE.set(handle.clone());

    if install_result.is_ok() {
        tracing::info!(
            target: "app.startup",
            session = %handle.session_id(),
            log_dir = %handle.log_dir().display(),
            level = handle.level.as_str(),
            "logger installed"
        );
    }

    Ok(handle)
}

/// Access the process-global handle if `init` succeeded.
#[allow(dead_code)]
pub fn global() -> Option<&'static LoggingHandle> {
    GLOBAL_HANDLE.get()
}

/// Generate a short random correlation ID (16 hex chars) suitable for the `op` field
/// on a chain of related log lines.
pub fn new_op_id() -> String {
    let mut bytes = [0u8; 8];
    rng().fill_bytes(&mut bytes);
    hex_encode(&bytes)
}

/// Parse the persisted setting value without reinstalling the process logger.
pub fn persisted_log_level(value: Option<&str>) -> LogLevel {
    value.and_then(LogLevel::parse).unwrap_or_default()
}

fn generate_session_id() -> String {
    let mut bytes = [0u8; 8];
    rng().fill_bytes(&mut bytes);
    hex_encode(&bytes)
}

fn hex_encode(bytes: &[u8]) -> String {
    const CHARS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(CHARS[(byte >> 4) as usize] as char);
        out.push(CHARS[(byte & 0x0f) as usize] as char);
    }
    out
}

/// Truncate an arbitrary log field value to a stable byte cap and apply defensive
/// redaction. Used for structured tracing field values that could otherwise dump
/// unbounded payloads to disk.
pub fn sanitize_field(value: &str) -> Cow<'_, str> {
    truncate_with_scrub(value, FIELD_VALUE_TRUNCATE)
}

/// Scrub secrets from a user-authored value destined for an issue body preview.
/// Uses [`DESCRIPTION_MAX_BYTES`] rather than the aggressive per-log-line cap so
/// meaningful reproduction steps survive intact.
pub fn sanitize_report_field(value: &str) -> Cow<'_, str> {
    truncate_with_scrub(value, DESCRIPTION_MAX_BYTES)
}

fn truncate_with_scrub(value: &str, max_bytes: usize) -> Cow<'_, str> {
    let scrubbed = scrub_high_risk_patterns(value);
    if scrubbed.len() > max_bytes {
        let mut end = max_bytes;
        while end > 0 && !scrubbed.is_char_boundary(end) {
            end -= 1;
        }
        Cow::Owned(format!(
            "{}...[truncated {} bytes]",
            &scrubbed[..end],
            scrubbed.len().saturating_sub(end)
        ))
    } else {
        scrubbed
    }
}

/// Replace any Windows local user path or Linux home path with `<USER_HOME>/…`.
///
/// This avoids leaking the local OS username through file paths that end up in logs.
pub fn sanitize_path(value: &str) -> String {
    let mut result = value.to_owned();
    #[cfg(target_os = "windows")]
    {
        if let Some(idx) = result.find("C:\\Users\\") {
            let tail = &result[idx + "C:\\Users\\".len()..];
            if let Some(slash) = tail.find('\\') {
                let replaced = format!("{}<USER_HOME>{}", &result[..idx], &tail[slash..]);
                result = replaced;
            }
        }
    }
    let home = std::env::var("HOME").ok();
    let userprofile = std::env::var("USERPROFILE").ok();
    let roots = [home.as_deref(), userprofile.as_deref()]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    sanitize_path_with_roots(&result, &roots)
}

/// Pure path-sanitization primitive for deterministic host-independent tests.
pub fn sanitize_path_with_roots(value: &str, roots: &[&str]) -> String {
    roots
        .iter()
        .filter(|root| !root.is_empty())
        .fold(value.to_owned(), |result, root| {
            result.replace(root, "<USER_HOME>")
        })
}

/// Names of high-risk keys that must never appear in log output values.
pub const HIGH_RISK_KEYS: &[&str] = &[
    "cookie",
    "set-cookie",
    "authorization",
    "proxy-authorization",
    "bearer",
    "qm_keyst",
    "qmkeyst",
    "qrsig",
    "ptqrtoken",
    "musickey",
    "access_token",
    "accesstoken",
    "refresh_token",
    "refreshtoken",
    "refresh_key",
    "refreshkey",
    "ekey",
    "vkey",
    "pskey",
    "ptsigx",
    "ptloginsig",
];

/// Defensive per-line/per-field scrubber applied before values reach disk or the
/// diagnostic bundle. This handles patterns callers may accidentally interpolate
/// without going through the structured helpers (`redact_url` etc.).
pub fn scrub_high_risk_patterns(value: &str) -> Cow<'_, str> {
    if value.is_empty() {
        return Cow::Borrowed(value);
    }
    let lowered = value.to_ascii_lowercase();
    let mut mutated: Option<String> = None;
    for key in HIGH_RISK_KEYS {
        if !lowered.contains(key) {
            continue;
        }
        let source = mutated.as_deref().unwrap_or(value).to_owned();
        let replaced = redact_key_value_occurrences(&source, key);
        if replaced != source {
            mutated = Some(replaced);
        }
    }
    if let Some(text) = mutated {
        Cow::Owned(text)
    } else {
        Cow::Borrowed(value)
    }
}

/// Given `text` and a lower-cased `key`, replace every `key<sep>value` occurrence
/// (case-insensitive, JSON- or header- or query-shaped) with `key<sep>[REDACTED]`.
fn redact_key_value_occurrences(text: &str, key: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let key_len = key.len();
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    let bytes = text.as_bytes();

    while cursor < bytes.len() {
        let Some(rel) = lower[cursor..].find(key) else {
            out.push_str(&text[cursor..]);
            break;
        };
        let start = cursor + rel;
        // Require that the preceding char is a boundary so we don't hit `cookiecrumb` when
        // scanning for `cookie`.
        let before_ok = start == 0
            || matches!(
                bytes[start - 1] as char,
                '"' | '\'' | ' ' | '\t' | '\n' | ',' | '{' | '&' | '?' | ';' | ':'
            );
        let end = start + key_len;
        if !before_ok || end > bytes.len() {
            out.push_str(&text[cursor..end.min(bytes.len())]);
            cursor = end;
            continue;
        }
        // Look at the next non-whitespace char to see whether this looks like an
        // assignment (`=`, `:`, or `":`).
        let mut lookahead = end;
        while lookahead < bytes.len() && matches!(bytes[lookahead] as char, ' ' | '\t' | '"' | '\'')
        {
            lookahead += 1;
        }
        if lookahead >= bytes.len() || !matches!(bytes[lookahead] as char, '=' | ':') {
            out.push_str(&text[cursor..end]);
            cursor = end;
            continue;
        }
        // Copy the key itself untouched.
        out.push_str(&text[cursor..lookahead + 1]);
        // Skip whitespace and quotes after the separator.
        let mut value_start = lookahead + 1;
        while value_start < bytes.len()
            && matches!(bytes[value_start] as char, ' ' | '\t' | '"' | '\'')
        {
            out.push(bytes[value_start] as char);
            value_start += 1;
        }
        // Value ends at the next delimiter that a URL, header or JSON might use.
        let mut value_end = value_start;
        while value_end < bytes.len()
            && !matches!(
                bytes[value_end] as char,
                '"' | '\'' | ',' | ';' | '&' | '}' | ']' | '\n' | '\r'
            )
        {
            value_end += 1;
        }
        out.push_str(REDACTED);
        cursor = value_end;
    }
    out
}

/// Writer that runs [`scrub_high_risk_patterns`] on each log line before it hits disk.
struct RedactingWriter<W: Write> {
    inner: W,
    tail: Vec<u8>,
}

impl<W: Write> RedactingWriter<W> {
    fn new(inner: W) -> Self {
        Self {
            inner,
            tail: Vec::new(),
        }
    }

    fn flush_scrubbed(&mut self, bytes: &[u8]) -> io::Result<usize> {
        // We work per whole line to avoid splitting a redaction pattern across writes.
        let mut written = 0usize;
        let mut buffer: Vec<u8> = std::mem::take(&mut self.tail);
        buffer.extend_from_slice(bytes);
        let mut start = 0usize;
        while let Some(pos) = buffer[start..].iter().position(|byte| *byte == b'\n') {
            let end = start + pos + 1;
            let line = &buffer[start..end];
            let scrubbed = match std::str::from_utf8(line) {
                Ok(text) => scrub_high_risk_patterns(text).into_owned(),
                Err(_) => String::from_utf8_lossy(line).into_owned(),
            };
            self.inner.write_all(scrubbed.as_bytes())?;
            written += end - start;
            start = end;
        }
        self.tail = buffer[start..].to_vec();
        // Report the number of *input* bytes accepted (including any queued tail).
        Ok(written.max(bytes.len()))
    }
}

impl<W: Write> Write for RedactingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.flush_scrubbed(buf)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        if !self.tail.is_empty() {
            let text = String::from_utf8_lossy(&self.tail);
            let scrubbed = scrub_high_risk_patterns(&text).into_owned();
            self.inner.write_all(scrubbed.as_bytes())?;
            self.tail.clear();
        }
        self.inner.flush()
    }
}

impl<W: Write> Drop for RedactingWriter<W> {
    fn drop(&mut self) {
        let _ = <Self as Write>::flush(self);
    }
}

impl<W: Write> std_fmt::Debug for RedactingWriter<W> {
    fn fmt(&self, f: &mut std_fmt::Formatter<'_>) -> std_fmt::Result {
        f.debug_struct("RedactingWriter")
            .field("buffered_bytes", &self.tail.len())
            .finish()
    }
}

#[cfg(test)]
pub(crate) fn test_handle() -> LoggingHandle {
    LoggingHandle::for_directory(PathBuf::from("<test>"), LogLevel::Debug)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn session_id_is_stable_length_and_hex() {
        for _ in 0..16 {
            let id = generate_session_id();
            assert_eq!(id.len(), 16);
            assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
        }
    }

    #[test]
    fn op_id_is_stable_length_and_hex() {
        let id = new_op_id();
        assert_eq!(id.len(), 16);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn log_level_parses_and_round_trips() {
        for level in [
            LogLevel::Error,
            LogLevel::Warn,
            LogLevel::Info,
            LogLevel::Debug,
            LogLevel::Trace,
        ] {
            assert_eq!(LogLevel::parse(level.as_str()), Some(level));
        }
        assert!(LogLevel::parse("verbose").is_none());
    }

    #[test]
    fn log_level_env_filter_scopes_yaqmc_and_workspace() {
        assert!(LogLevel::Debug.as_env_filter().contains("yaqmc=debug"));
        assert!(LogLevel::Trace.as_env_filter().contains("yaqmc=trace"));
        assert!(LogLevel::Warn.as_env_filter().contains("warn"));
    }

    #[test]
    fn ring_buffer_is_bounded_and_preserves_recent_order() {
        let handle = test_handle();
        for index in 0..(RECENT_ERROR_CAPACITY + 5) {
            handle.record_error(ErrorRecord::new(
                format!("YAQMC-TEST-{index:02}"),
                "test",
                format!("message-{index}"),
            ));
        }
        let recent = handle.recent_errors();
        assert_eq!(recent.len(), RECENT_ERROR_CAPACITY);
        let first = &recent[0];
        assert_eq!(first.code, "YAQMC-TEST-05");
        let last = &recent[RECENT_ERROR_CAPACITY - 1];
        assert_eq!(
            last.code,
            format!("YAQMC-TEST-{:02}", RECENT_ERROR_CAPACITY + 4)
        );
    }

    #[test]
    fn error_record_message_is_scrubbed_and_bounded() {
        let record = ErrorRecord::new(
            "YAQMC-QQ-AUTH-001",
            "qqmusic.auth",
            "Cookie=uin=1234567; qm_keyst=SECRET",
        );
        assert!(!record.message.contains("SECRET"));
        assert!(record.message.contains("[REDACTED]"));
    }

    #[test]
    fn scrubber_leaves_public_metadata_alone() {
        let sample = "trackId=qqmusic:track:PUBLIC and duration=213";
        assert_eq!(scrub_high_risk_patterns(sample), sample);
    }

    #[test]
    fn scrubber_replaces_query_and_header_secrets() {
        let cases = [
            ("Cookie: uin=1; qm_keyst=SECRET", "qm_keyst=[REDACTED]"),
            ("Authorization: Bearer SECRET.jwt.value", "[REDACTED]"),
            ("{\"qrsig\":\"SECRET\"}", "[REDACTED]"),
            ("&ekey=abcdef123&guid=1", "ekey=[REDACTED]"),
            ("refresh_token = \"SECRET\"", "[REDACTED]"),
        ];
        for (input, expected_substr) in cases {
            let scrubbed = scrub_high_risk_patterns(input).into_owned();
            assert!(
                scrubbed.contains(expected_substr),
                "input={input}, got {scrubbed}"
            );
            assert!(
                !scrubbed.contains("SECRET"),
                "SECRET leaked from {input}: {scrubbed}"
            );
        }
    }

    #[test]
    fn scrubber_does_not_match_similar_prefixes() {
        let ok = "cookiecutter=oatmeal and eKeyword=ignored";
        assert_eq!(scrub_high_risk_patterns(ok), ok);
    }

    #[test]
    fn redacting_writer_masks_lines_across_multiple_writes() {
        let sink = Cursor::new(Vec::<u8>::new());
        let mut writer = RedactingWriter::new(sink);
        writer.write_all(b"line1 cookie=\"foo\";\n").unwrap();
        writer.write_all(b"partial ekey=SECR").unwrap();
        writer.write_all(b"ET\n").unwrap();
        writer
            .write_all(b"tail without newline authorization=Bearer TAIL")
            .unwrap();
        writer.flush().unwrap();
        let output = std::mem::take(writer.inner.get_mut());
        drop(writer);
        let output = String::from_utf8(output).unwrap();
        assert!(!output.contains("SECRET"), "output: {output}");
        assert!(!output.contains("Bearer TAIL"), "output: {output}");
        assert!(output.contains("[REDACTED]"), "output: {output}");
        // Every keyed occurrence must have been replaced.
        for key in ["cookie", "ekey", "authorization"] {
            assert!(
                output.matches(&format!("{key}=")).count() > 0
                    || output.matches(&format!("{key}=\"")).count() > 0,
                "missing key {key} in output: {output}"
            );
        }
    }

    #[test]
    fn sanitize_field_truncates_very_long_strings() {
        let payload = "a".repeat(FIELD_VALUE_TRUNCATE + 10);
        let out = sanitize_field(&payload);
        assert!(out.contains("[truncated"));
        assert!(out.len() < payload.len() + 60);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn sanitize_path_hides_windows_username() {
        let raw = "C:\\Users\\realuser\\Music\\song.flac";
        let cleaned = sanitize_path(raw);
        assert_eq!(cleaned, "<USER_HOME>\\Music\\song.flac");
    }

    #[test]
    fn sanitize_path_accepts_injected_home_roots() {
        let cleaned =
            sanitize_path_with_roots("/home/realuser/logs/yaqmc.log", &["/home/realuser"]);
        assert_eq!(cleaned, "<USER_HOME>/logs/yaqmc.log");
    }
}
