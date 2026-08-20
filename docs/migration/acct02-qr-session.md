# ACCT-02: Electron QR login and session staging/refresh checklist

Source: `YAQMC_ELECTRON_MIGRATION_PLAN.md` §36 P8 rows **QR login** and **session persist/staging/refresh (keyring untouched)**. Method **L** = LIVE VERIFY (real QQ account, maintainer-only).

This document prepares the re-verify steps. **ACCT-02 is not green.** Windows and Linux boxes stay empty until a maintainer runs the row on that host. The recorded Tauri→Electron stay-logged-in demo is **ACCT-03**; do not treat a pass here as that demo.

Do not start `qm-api-rs`. Do not open OAuth at boot (ACCT-01 owns `oauth-window.ts`). Never print keyring values, cookies, tokens, session records, or QR payload bytes.

## How to run

Use the real provider, not `?provider=fake`:

```text
npm run dev:desktop
```

`scripts/dev-desktop.mjs` sets `YAQMC_VITE_DEV=1`. Electron Main then loads `http://127.0.0.1:1420/` with no `provider` query. `selectHostBridge()` uses `window.yaqmc` (Electron → yaqmc-core). Opening `http://127.0.0.1:1420/?provider=fake` is the **fake** column only and cannot satisfy ACCT-02.

OAuth QQ/WeChat popup buttons are ACCT-01. This checklist is Core QR (`qqmusic_auth_start` / `qqmusic_auth_heartbeat` / `qqmusic_auth_cancel` / `qqmusic_auth_refresh`) plus session staging/restore. Do not start an OAuth window to mark a QR row.

## FACT keyring (untouched across host swap)

From `crates/yaqmc-core/src/credentials.rs` and `crates/yaqmc-provider-qqmusic/src/qqmusic/auth.rs`:

| Item | FACT |
| ---- | ---- |
| Current service | `org.yaqmc.desktop` |
| Legacy read-migration service | `dev.music-client.desktop` |
| Active session entry | `qqmusic-session` |
| Staging session entry | `qqmusic-session-staging` |
| Local API token entry | `local-api-bearer-token` |

Electron yaqmc-core uses the same `PlatformCredentialStore`. Do not rename the service or entries. Values are never exported into this document, logs, or diagnostics.

No in-repo script prints whether a live keyring entry **exists** without new native deps or reading secrets, so `scripts/migration/acct02-session-probe.mjs` is **not** added.

## Fake vs real account

| Check | Fake (`?provider=fake`) | Real QQ account (Electron + core) |
| ----- | ----------------------- | --------------------------------- |
| Host bridge | `selectHostBridge` → `createFakeBridge()` even if `window.yaqmc` is present | `window.yaqmc` → Electron bridge → yaqmc-core |
| Account UI | `FakeMusicProvider` is catalog-only (not `AccountMusicProvider`); Account dialog does not mount | QQ Music provider: `startQrLogin` → `qqmusic_auth_start` |
| QR login | No Tencent QR, no poll, no keyring write | `waiting-for-scan` + QR data URI; heartbeat / cancel / refresh through Core |
| Session persist | None (in-memory fake) | Staging then active under FACT entry names |
| After host swap | N/A | Restore `qqmusic-session` without re-login (expected; ACCT-03 records the demo) |

## QR login (real provider)

Core methods: `qqmusic_auth_start`, `qqmusic_auth_heartbeat`, `qqmusic_auth_cancel`, `qqmusic_auth_refresh`. Renderer wrappers: `startQrLogin` / `heartbeatQrLogin` / `cancelQrLogin` / `refreshQrLogin`.

Promotion (same as Tauri): validate candidate → load prior active → save+read-back staging (`qqmusic-session-staging`) → validate staged → save+read-back active (`qqmusic-session`) → delete staging. Failure before activation clears staging; failure after activation restores the prior active record.

| Step | Expected result | Windows | Linux |
| ---- | --------------- | ------- | ----- |
| Start QR (`qqmusic_auth_start`) | Snapshot `waiting-for-scan`; QR image projected; no OAuth popup | [ ] | [ ] |
| Heartbeat while waiting | Snapshot stays owned; scan/confirm advances without dropping the attempt | [ ] | [ ] |
| Cancel | Snapshot cancelled/guest; staging not left as the active session | [ ] | [ ] |
| Refresh expired QR (`qqmusic_auth_refresh`) | New attempt; previous attempt id is not reused as live | [ ] | [ ] |
| Confirm / promote | Masked authenticated snapshot; active entry is `qqmusic-session` | [ ] | [ ] |

All rows stay `LIVE VERIFY pending` until a maintainer signs the box. Do not claim green from this prep.

## Session staging / refresh after host swap

Keyring service and entry names stay FACT. Boot restore is core `restore_session` from `qqmusic-session` (same OS credential store as Tauri).

Expected: a profile that was logged in on Tauri stays logged in on Electron **without** scanning again. That recorded demo is **ACCT-03**. This table only prepares the ACCT-02 steps.

| Step | Expected result | Windows | Linux |
| ---- | --------------- | ------- | ----- |
| Staging slot during QR promote | Writes `qqmusic-session-staging`, then active, then deletes staging | [ ] | [ ] |
| Refresh / restore on Electron boot | Authenticated snapshot from existing `qqmusic-session`; no re-login | [ ] | [ ] |
| Tauri-login → Electron boot (same OS user) | User stays logged in; keyring service name unchanged | [ ] | [ ] |

Linux live keyring also needs session-bus env passthrough (`DBUS_SESSION_BUS_ADDRESS` / `XDG_RUNTIME_DIR` — SUP-01). That matrix is ACCT-03 / PLAT-05, not a green claim here.

## Token / keyring hygiene

- Never print or paste secrets, cookie headers, tokens, UIN values, or session JSON.
- Do not dump Windows Credential Manager / Secret Service item bodies.
- Diagnostics and this checklist may name the **service** and **entry names** only.
- Local API bearer reveal stays on the Settings path; it is not part of ACCT-02 evidence.

## Checkpoint

Electron stays **43.4.0**. The 32 MiB protocol hard cap is unchanged. P0 remains `PENDING`; provenance remains **BLOCKED**. No Playwright. No `qm-api-rs`.
