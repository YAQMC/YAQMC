# P0 governance and factual deltas

## Starting point and working-tree rule

- Baseline commit: `bc55b7ddd2a57cde8987c96c7c20f0b7d4a2e742`.
- Migration branch: `feat/electron-migration`.
- This isolated worktree starts with the source migration specification as the sole untracked addition. It is added without modification in this checkpoint.
- P0 is documentation/inventory only: do not alter runtime code, package manifests, generated Tauri permissions, or existing tests.
- Keep Tauri buildable and releasable through P12. Remove it only after the `pre-tauri-removal` gate.

## Current desktop facts

| Item                        | Verified current value                                                                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application identifier      | `org.yaqmc.desktop`                                                                                                                                                                    |
| Main window                 | 1280 x 800; minimum 1000 x 680; frameless; transparent on Windows and opaque on Linux                                                                                                  |
| Registered commands         | 117 unique functions and 117 unique `generate_handler!` registrations                                                                                                                  |
| Textual command attributes  | 118 textual `#[tauri::command]` matches; the apparent extra match is the test string in `src-tauri/src/commands.rs:906`, not a command definition                                      |
| Frontend command references | 112 of 117 command-name string literals; the five unreferenced names are `system_integration_status`, `player_play`, `player_pause`, `lyrics_surface_status`, and `plugin_diagnostics` |

Electron Main must retain the current 1280 x 800 / 1000 x 680 minimum main-window dimensions. The `1180 x 760` construction-table value in the source plan is superseded by this baseline fact and must not be adopted.

## Corrections that govern migration work

| Topic                         | Fact and required consequence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime coupling              | Current host coupling is Tauri transport/window integration, not core business logic. The frontend has 22 host-coupled files (17 bridge-only + 5 deeply coupled); plugin JavaScript runs in blob-URL Web Workers in the renderer, while Rust remains the filesystem/permission/bridge service. Do not move plugin execution into Rust.                                                                                                                                                                                                                  |
| Updater and platform features | There is no Tauri updater, single-instance plugin, deep-link handler, or OS notification API. Electron updater and single-instance support are new functionality, not ports; deep links and notifications remain out of scope for parity.                                                                                                                                                                                                                                                                                                               |
| Protocol ACL                  | Electron Main derives the renderer origin from `webContents.id`; renderer input never controls origin. Main enforces the per-window ACL, and Core independently rechecks method ACL metadata before dispatch.                                                                                                                                                                                                                                                                                                                                           |
| Command identity              | Preserve all 117 registered names and serde payloads in protocol v1, except the three approved dialog splits. Window/surface/dialog host methods are intercepted in Main under the preserved public method name until their approved split/retirement point.                                                                                                                                                                                                                                                                                            |
| Dialog splits                 | Diagnostics export, background-image selection, and plugin install-from-file become host path selection plus Core pure IO (`*_to` / `*_from`); old dialog-shaped methods retire only at P13.                                                                                                                                                                                                                                                                                                                                                            |
| qm-api-rs                     | The repository is private. Current YAQMC pin is `56db511cfc98d2f860e48da4805d878ec3c2061e` (QMCDecode replacement and notice, descendant of the CGI/lyrics and `ApiTransport` fixes). Crate `qqmusic-api` (lib `qqmusic_api`), version `0.1.0`, GPL-3.0-or-later. QMC provenance is complete; L-1124 mapping/notice evidence remains a P14/release gate. CI needs authenticated dependency access. SHA1 `zzc_sign` differs from the in-tree MD5 `zzb` signer, so provider replacement remains separate from host migration and needs live verification. |

### qm-api-rs superseding correction

The source plan's qm-api-rs integration facts are historical input only. The following verified facts supersede any conflicting statements there and are prerequisites for P14:

- At pin `56db511cfc98d2f860e48da4805d878ec3c2061e`, `qqmusic-api` declares `rust-version = "1.88.0"` and upstream CI tests on that toolchain. That is metadata, not provenance clearance.
- The library still depends on `reqwest ^0.12` internally, while YAQMC uses `reqwest 0.13.4`. Public crate types no longer expose `reqwest::{Client, Method, HeaderMap, Error, Response}`. `ApiTransport` injection is the supported boundary; a reqwest 0.13 upgrade inside qm-api-rs remains conditional on full regression success and must not land merely for version uniformity.
- Upstream has no `tracing` dependency; do not assume YAQMC's tracing/redaction behavior is inherited by the library.
- The relevant context type is `ApiContext`, not `ClientContext`; upstream has no `radio` module.
- The rate limiter is global per `ApiContext`: 10 requests per second with a burst of 50, not a per-endpoint limiter.
- Default HTTP goes through `ApiTransport` (timeout, host allowlist, cancellation, retry class, redirect policy). YAQMC must not compensate only with a conditional logging wrapper. MQTT WebSocket login remains outside that trait.
- YAQMC records an **optional** `qqmusic-api` git pin at `56db511` behind feature `qmapi`. Default Core stays `intree` and must not resolve `qqmusic-api`. That optional pin is not crate-level provenance clearance, not a default backend change, and not P14-C.

### Binding amendment requirements

[The 2026-08-16 binding amendment](plan-amendment-2026-08-16.md) governs the protocol registry and payload caps,
HUMAN/LIVE_ACCOUNT gates, production Electron Fuses, conditional reqwest upgrade, subagent policy, and cutover/rollback
rules. Its requirements supersede conflicting source-plan text without reopening completed P0–P2 work.

## Electron and electron-builder observations

- This baseline has no Electron or electron-builder dependency in `package.json` or lockfile; version pinning happens only when the Electron host is introduced.
- Official verification on 2026-08-16 found Electron `43.4.0` stable with embedded Node `24.18.1`, and electron-builder `26.15.7` stable. electron-builder v27 is alpha only and is not an approved planning or package version.
- These are not package pins. Re-verify the current stable Electron line and exact stable electron-builder release at adoption, then pin exact versions in `apps/desktop/package.json`.
- Electron's official release schedule confirms an approximately eight-week major cadence and support for the latest three stable releases; choose a non-EOL stable major at adoption. The Electron release artifacts document Windows x64 and arm64 support, matching the approved i686 removal. [Electron schedule](https://releases.electronjs.org/schedule) and [Electron platform support](https://github.com/electron/electron) were checked on 2026-08-16.
- electron-builder supports the required Linux AppImage/deb/rpm targets; use the exact then-current stable release and lockfile at adoption. [electron-builder Linux documentation](https://www.electron.build/docs/linux/) was checked on 2026-08-16.

## Boundary invariants

- Preserve player seek/session fencing, SQLite schema v5, app paths, keyring identifiers, Local API, plugin API v2, and React UI behavior.
- Rust Core must not depend on Tauri, Electron, Node, or N-API.
- The source plan is an input record, not an invitation to silently change the current application facts recorded above.
