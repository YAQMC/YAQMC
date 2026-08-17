# ACCT-03: Tauri-to-Electron session continuity checklist

Source: `YAQMC_ELECTRON_MIGRATION_PLAN.md` §36 P8 row **ACCT-03** (Tauri-login → Electron boot, no re-login) and risk **R-10** (keyring / Secret Service under the Electron-spawned core). Method **L** = LIVE VERIFY (real QQ account, maintainer-only).

This document prepares the upgrade-in-place re-verify. **ACCT-03 is not green.** Windows / GNOME / KDE boxes stay empty until a maintainer runs the row on that host. The recorded stay-logged-in demo is **PENDING** (maintainer). **Do not claim R-10 closed.**

QR login, staging, and refresh steps live in [ACCT-02](acct02-qr-session.md). This checklist does not rewrite that document. OAuth popup lifecycle is ACCT-01. Do not start `qm-api-rs`. Never print keyring values, cookies, tokens, session records, or UIN.

## FACT (unchanged across host swap)

Credentials stay in the OS keyring. PACK-01 `appId` equals the live Tauri `identifier`: **`org.yaqmc.desktop`**. Electron Main injects BASE-04 directories into yaqmc-core; Chromium `userData` is not the session store. See [data-paths.md](data-paths.md).

| Item | FACT |
| ---- | ---- |
| `appId` / identifier | `org.yaqmc.desktop` |
| Keyring service | `org.yaqmc.desktop` |
| Legacy read-migration service | `dev.music-client.desktop` |
| Active session entry | `qqmusic-session` |
| Staging session entry | `qqmusic-session-staging` |
| Windows app data | `%APPDATA%\org.yaqmc.desktop` |
| Linux app data | `$XDG_DATA_HOME/org.yaqmc.desktop` (fallback `~/.local/share/org.yaqmc.desktop`) |

Electron yaqmc-core uses the same `PlatformCredentialStore`. Do not rename the service or entries. Diagnostics and this checklist may name the **service** and **entry names** only.

Linux Secret Service also needs session-bus env on the spawned core (`DBUS_SESSION_BUS_ADDRESS` / `XDG_RUNTIME_DIR` — SUP-01). That is the R-10 investigation path; it is not a green claim here.

## How to run

Use the **same OS user** that was logged in on the Tauri build. Do not switch to a scratch profile, and do not open `?provider=fake`.

1. Log in on the Tauri build (QR per ACCT-02, or OAuth per ACCT-01). Confirm a masked authenticated account snapshot.
2. Quit Tauri completely (no leftover `yaqmc-core` / `yaqmc-core.exe`).
3. Install or run the Electron build so it shares that BASE-04 tree (`appId` / identifier `org.yaqmc.desktop`).
4. Assert the user is still signed in. No re-login UI.

Packaged Electron: `npm run pack:dir -w @yaqmc/desktop` or the PACK-02 / PACK-03 artifacts. Dev loop: `npm run dev:desktop` (real provider, Vite `/`).

## Upgrade steps (empty until LIVE VERIFY)

| Step | Expected result | Windows | GNOME | KDE |
| ---- | --------------- | ------- | ----- | --- |
| Log in on Tauri build | Masked authenticated snapshot; active keyring entry `qqmusic-session` | [ ] | [ ] | [ ] |
| Quit Tauri | Process gone; no leftover `yaqmc-core` holding the profile | [ ] | [ ] | [ ] |
| Install/run Electron on the same user data | Core data dir is still BASE-04 `org.yaqmc.desktop`; not a new profile | [ ] | [ ] | [ ] |
| Assert still signed in | Authenticated snapshot restored from `qqmusic-session`; no QR/OAuth wall | [ ] | [ ] | [ ] |

All rows stay `LIVE VERIFY pending` until a maintainer signs the box. Do not claim green from this prep.

## What must not happen

| Failure | Why it fails ACCT-03 | Windows | GNOME | KDE |
| ------- | -------------------- | ------- | ----- | --- |
| Re-login prompt (QR or OAuth) on Electron boot | Session was not restored from the existing keyring entry | [ ] | [ ] | [ ] |
| New keyring service name | Breaks continuity; service must stay `org.yaqmc.desktop` (not productName / Electron defaults) | [ ] | [ ] | [ ] |

Do not dump Windows Credential Manager or Secret Service / KWallet item bodies to check the service name. Name the service only.

## Recorded demo

Maintainer records Tauri-login → quit → Electron boot, still signed in, on Windows and on GNOME + KDE.

| Evidence | Status |
| -------- | ------ |
| Recorded stay-logged-in demo | **PENDING** (maintainer) |
| R-10 (GNOME + KDE Secret Service under Electron core) | not closed — LIVE VERIFY pending |

## Checkpoint

Electron stays **43.4.0**. The 32 MiB protocol hard cap is unchanged. P0 remains `PENDING`; provenance remains **BLOCKED**. No Playwright. No `qm-api-rs`.
