# Diagnostics

> [简体中文](zh-CN/diagnostics.md) | **English**

The diagnostics subsystem builds a redacted, structured snapshot of
YAQMC's state and packages it — together with recent rotated logs — into a ZIP
bundle for maintainer review.

Diagnostics are **local by default**: nothing is uploaded, and the bundle is
only created when the user explicitly asks for it.

## What lives inside a diagnostic snapshot

`DiagnosticsSnapshot` is produced by
`crates/yaqmc-core/src/diagnostics.rs::snapshot_from_handle` and contains these
sections:

- **`app`** — application version, short commit SHA supplied by the Electron
  build metadata, build channel (`stable`/`beta`/`dev`), build type
  (`release`/`debug`), the session ID for the current run.
- **`platform`** — `PlatformDiagnostics` (OS, version, architecture, renderer),
  the audio implementation, the resolved output policy, MPRIS/SMTC/tray state,
  Electron/Chromium host versions and, on Linux, the observed Ozone/display
  backend. The legacy Linux renderer-version field remains `null` for schema compatibility.
- **`provider`** — QQ Music mode (`guest`/`authenticated`), connection state,
  account state, membership tier — but never cookies, session tokens, uin,
  or QR-login secrets.
- **`playback`** — current playback state, selected quality code, source
  classification (`direct-http`/`qmc-encrypted`/`local-file`), decoder type,
  short song identifier, playback order, repeat mode, and the player-facing
  primary mode (`sequential` / `shuffle` / `repeat-one`) — but never the raw
  signed media URL.
- **`lyricsPreset`** — compact active lyrics-preset identity (`id`,
  `kind` = `built-in` | `custom`, `schemaVersion`). The snapshot does not dump
  the full preset JSON or local asset paths.

The snapshot also carries:

- the ring buffer of recent errors (see the ring-buffer section below),
- the current log level,
- the current session ID,
- reserved fields for future Scene Engine metadata
  (`scene: null` today; the schema will grow additively).

## Diagnostic bundle

**Settings → Diagnostics & logging → Export bundle** invokes
`diagnostics_export_bundle`, which produces:

```
YAQMC-diagnostics-YYYYMMDD-HHMMSS.zip
├── manifest.json
├── diagnostics.json
├── diagnostics.txt
├── redaction-report.txt
└── logs/
    ├── yaqmc.YYYY-MM-DD.log
    └── … (bounded daily files)
```

- **`manifest.json`** — bundle schema version, YAQMC version, timestamp,
  platform, architecture, list of files included, redaction scanner version,
  and the session ID.
- **`diagnostics.json`** — the machine-readable snapshot described above.
- **`diagnostics.txt`** — a human-friendly rendering of the same snapshot
  (`DiagnosticsSnapshot::to_plain_text`).
- **`redaction-report.txt`** — the summary from the second-stage safety scan.
- **`logs/`** — a copy of the current log file and any rotated files, each
  re-scanned before being added to the ZIP.

### What the bundle never contains

- Cookies, `qm_keyst`, `qrsig`, `ekey`, `vkey`, OAuth codes, or bearer tokens.
- Local API secret token.
- Raw signed media URLs.
- Authenticated HTTP captures.
- Real usernames — home directories are rewritten to `<USER_HOME>` before
  being written to the bundle.

### Second-stage safety scan

Even though the runtime logger redacts sensitive values before they touch
disk, the export pipeline re-scans every text file it is about to place into
the ZIP. If a high-risk pattern is detected the value is replaced with
`[REDACTED]` and the incident is recorded in `redaction-report.txt`. If any
unresolved high-risk pattern is left after the scan, the export refuses to
produce a "safe" bundle unless the user passes an explicit override.

`redaction-report.txt` never contains the sensitive value itself; it only
records the file name and the count.

Example:

```
Redaction scanner: v1
Files scanned: 4
Values automatically redacted: 3
Unresolved high-risk patterns: 0
```

## Error ring buffer

`LoggingHandle` keeps a bounded in-memory ring buffer (`VecDeque<ErrorRecord>`
of the last 32 errors). Records include:

- stable error code (see [issue-reporting.md](issue-reporting.md#error-codes)),
- domain (`qqmusic.auth`, `audio.output`, …),
- correlation ID if one was attached,
- timestamp,
- short user-facing message (already-sanitized).

The buffer is captured into the diagnostic snapshot even before logs are
flushed to disk, so a bug report opened immediately after an error still
contains the relevant context.

## User-visible errors and diagnostics

User-facing error surfaces show short localized text such as
`无法打开音频输出设备` and never expose raw Rust `Debug` output. The full
technical trail (stack, correlation ID, decoder hints) stays in the log file
and in the diagnostic snapshot. From an error toast the user can invoke
**Report this issue**, which opens the reporter dialog with the linked error
code prepopulated.

## Settings surface

Everything the user needs is exposed under
**Settings → Diagnostics & logging**:

- **Log level** (`Info` / `Debug` / `Trace`).
- **Open log folder** — reveals the platform log folder in the file manager.
- **Export bundle** — creates the ZIP and shows the resulting path.
- **Reveal bundle** — reveals the most recent bundle in the file manager.
- **Clear old logs** — deletes rotated files only; the current log file stays.
- **Report a problem** — opens the guided Issue Reporter dialog.
- **Show frame rate** — optional overlay FPS counter for rendering diagnostics.
- **Platform collection** — the Linux/platform diagnostic export previously
  shown under Desktop integration.

About stays informational: product identity, build metadata, and project links.
The unofficial-client disclaimer sits under the version line. About does not
duplicate Report a problem or host a separate Debug section.

There is intentionally no dashboard of per-domain toggles: users should not
need to configure logging, and maintainers can enable `TRACE` when needed.

## Compatibility with future Scene Engine

The diagnostic schema is deliberately extensible. Once the Scene Engine
ships, `diagnostics.json` will grow a `scene` block containing scene name,
version, SHA-256, and permission flags. Consumers must ignore unknown fields
so old bundles remain readable and new bundles remain valid.
