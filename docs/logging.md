# Logging

> [简体中文](zh-CN/logging.md) | **English**

YAQMC uses a single centralized logging pipeline. It replaces ad-hoc `println!`
and `console.log` output with a bounded, redacted, rotating file log that both
the Rust core and the frontend feed into.

The pipeline is intentionally local. Nothing is uploaded, no telemetry is
collected, and no external service is ever contacted for logging.

## Layers

```
Frontend (React)           ─┐
Rust core (Tauri commands) ─┤─▶ tracing_subscriber
Platform adapters          ─┤        │
Provider / audio / player  ─┘        ▼
                                 RedactingWriter
                                     │
                                     ▼
                              rotating log files
```

- **Rust core.** `tracing` events are dispatched by
  `tracing_subscriber::registry()` with two layers: a formatted stderr layer for
  developer builds and a formatted file layer that writes through
  `RedactingWriter` into `tracing-appender`'s daily rotation.
- **Frontend.** `src/application/logger.ts` batches events (up to 128 in a
  queue, flushed every ~400 ms) and forwards them through the
  `diagnostics_log_frontend` command. The Rust command replays each entry into
  the same `tracing` targets so frontend events are indistinguishable from Rust
  events in the final log file.
- **Platform / provider / audio.** These modules use `tracing::info!` /
  `warn!` / `debug!` with structured fields (`tracing`'s key/value pairs). We
  deliberately avoid `{:?}` on large structs; every log line stays on a single
  screen row.
- **Redaction.** Every write goes through `RedactingWriter` before it touches
  disk. See [security.md](security.md) for the redaction contract.

## Levels

| Level | Meaning                                                        |
| ----- | -------------------------------------------------------------- |
| ERROR | User-visible failure. Recorded to the ring buffer and flushed. |
| WARN  | Recoverable degradation. Included in the bundle by default.    |
| INFO  | Steady-state milestone (release default).                      |
| DEBUG | Deep detail, only useful when reproducing (developer default). |
| TRACE | Per-callback trace. Only enable when actively investigating.   |

- The release default is `INFO`.
- The developer default is `DEBUG`.
- `TRACE` is strictly opt-in and never the default.
- Real-time paths (audio callbacks, per-frame lyric ticks) never log at
  `INFO`/`DEBUG` — they are throttled or promoted to `TRACE`.

`Settings → Diagnostics & logging → Log level` exposes only `Info`, `Debug`,
and `Trace`. The selection is persisted through the `application_settings`
store under `logging.level` and picked up on the next launch.

## Targets (logging domains)

Domains follow a `noun.verb` shape and are stable identifiers. Adding a new
domain requires touching the [docs](diagnostics.md) so the naming stays
disciplined.

```
app.startup            app.shutdown
qqmusic.auth           qqmusic.search      qqmusic.account
qqmusic.library        qqmusic.playlist    qqmusic.favorite
qqmusic.entitlement    qqmusic.source      qqmusic.lyrics
player.command         player.queue        player.order
player.seek            player.eos
audio.engine           audio.output        audio.decode
audio.stream           audio.qmc
lyrics.fetch           lyrics.parse        lyrics.timeline
lyrics.surface
network.http           network.range       cache.media   cache.artwork
platform.windows       platform.linux
platform.mpris         platform.smtc
ui.navigation          ui.error
issue.bundle           issue.report
```

Reserved for later: `scene.load`, `scene.render`, `scene.script`,
`scene.security`. They are not implemented yet.

## Correlation IDs

For any operation that crosses layers (provider resolution → HTTP range →
decoder → audio engine), the originating layer generates a short
`op-XXXXXXXX` ID with `logging::new_op_id()` and threads it through structured
fields. Example:

```
[qqmusic.source][INFO][op=8f3b41] resolve started track=QQ:003abc quality=lossless
[audio.qmc]    [WARN][op=8f3b41] encrypted source validation failed
[player.source][INFO][op=8f3b41] automatic fallback=high
```

Never log the sensitive URL itself — only the safe identifiers and the op ID.

## Session identity

Each process launch generates a random 16-byte session ID
(`logging::generate_session_id()`). It is:

- unique per run,
- non-persistent (regenerated on the next launch),
- unrelated to the user account, the device, or the install,
- included in the diagnostic snapshot so a bug report can be correlated with
  its own logs.

There is no analytics ID, no install ID, no fingerprint.

## Files, rotation, and location

Logs are written by `tracing_appender::rolling::Builder::new()` under the
Tauri app-log directory:

| Platform | Location                                              |
| -------- | ----------------------------------------------------- |
| Windows  | `%LOCALAPPDATA%\Velune\YAQMC\logs\yaqmc-current.log`  |
| Linux    | `$XDG_DATA_HOME/Velune/YAQMC/logs/yaqmc-current.log`  |
| Fallback | The Tauri path resolver `app_log_dir()` return value. |

The `yaqmc-current.log` file is followed by up to 7 rotated files
(`yaqmc-current.log.YYYY-MM-DD`) written by `tracing-appender`'s daily
rotation. `diagnostics_clear_logs` removes the rotated files.

Users can jump to this folder from **Settings → Diagnostics & logging → Open
log folder**.

## Performance

The pipeline is designed around three constraints:

1. **Never block audio.** Audio callbacks never call `tracing` at
   `INFO`/`DEBUG`; when they do log they use precomputed strings and `TRACE`.
2. **Never spam the disk.** Repetitive per-frame data (playback position,
   surface tick, MPRIS position callbacks) is either debounced (>500 ms) or
   only logged when a state transition occurs.
3. **Batch frontend IPC.** The frontend `logger.ts` queues events for at
   most 400 ms before invoking `diagnostics_log_frontend` with the batch, so
   even a burst of user interactions produces a handful of IPCs.

Measurements are captured in [windows-acceptance.md](windows-acceptance.md).

## What the logger will not do

- No analytics.
- No cloud upload.
- No automatic bug submission.
- No credentials, cookies, tokens, or signed URLs in the file.
- No user account information, real usernames, or device identifiers.
