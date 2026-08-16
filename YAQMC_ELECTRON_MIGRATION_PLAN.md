# YAQMC Electron Migration Plan

**Document status:** Implementation-Ready Migration Specification
**Prepared:** 2026-08-16 (all live-web facts verified on this date)
**Prepared against:** `YAQMC/YAQMC` @ `bc55b7ddd2a57cde8987c96c7c20f0b7d4a2e742` (`main`)
**Executor:** GPT-5.6 Sol Ultra (multi-subagent capable)
**Scope:** Migrate the YAQMC desktop host from Tauri 2 to Electron with a host-independent Rust Core, on Windows + Linux. Android is an architectural constraint, not a deliverable.

This document is self-contained. The executor is expected to have only (a) this repository at the SHA above and (b) this document. Every fact in this plan is tagged where it matters:

- **FACT** — verified directly in source at HEAD (file:line references included).
- **VERIFIED (web, 2026-08-16)** — verified against official/primary sources on the stated date.
- **NEEDS ACCEPTANCE TEST** — cannot be fully known until run on real hardware/compositors; the plan includes the test.
- **LIVE VERIFY** — depends on QQ Music server behavior; must be verified against the live service during execution.

---

## Table of Contents

1. Executive Summary
2. Source-of-Truth Git State
3. Current Architecture
4. Current Feature Inventory
5. Current Technical Debt
6. Fixed Architecture Decisions
7. Target Architecture
8. Dependency Rules
9. Target Repository Layout
10. Rust Core Architecture
11. Electron Architecture
12. Frontend Client/Bridge
13. Core IPC / Protocol
14. Lifecycle / Process Supervision
15. Player Migration
16. Provider Architecture
17. qm-api-rs Integration
18. Storage / Data Migration
19. Credential Security
20. Plugin Migration
21. Lyrics / Scene / Composer
22. Desktop Lyrics
23. Lyrics Island
24. Local API
25. SMTC / MPRIS
26. Tray / Shortcut / Notification
27. Logging / Diagnostics
28. Electron Security
29. Linux Strategy
30. Windows Strategy
31. Packaging
32. Updater
33. CI / Build
34. Testing Strategy
35. Performance / Soak
36. Feature Parity Matrix
37. File Migration Matrix
38. Tauri Removal Matrix
39. Risk Register
40. Migration Phases
41. Complete Task Catalog
42. Task Dependency DAG
43. Parallel Execution Plan
44. Git Checkpoints
45. Rollback Strategy
46. Final Acceptance Matrix
47. Definition of Done
48. GPT-5.6 Sol Ultra Execution Handoff

---

## 1. Executive Summary

YAQMC is a QQ Music desktop client: React 19 + TypeScript frontend, Rust backend, currently hosted by Tauri 2. The Rust side (~40k LOC in one crate, `src-tauri`) owns playback (rodio/cpal `PlayerService` with rigorous seek/session fencing), the full QQ Music protocol (~19k LOC in-tree), a plugin platform (blob-Worker sandbox + token-gated bridge), SQLite storage, OS keyring credentials, a localhost Axum API with SSE, SMTC/MPRIS, tray, global shortcuts, and two auxiliary lyric overlay windows.

This migration replaces **only the host**: Tauri 2 → Electron. It is explicitly **not** a UI redesign and **not** a rewrite of the playback or provider logic. The end state is:

```
                React Frontend  (unchanged UI, host-agnostic)
                       │
               YAQMC Client API  (packages/yaqmc-client, TypeScript)
                       │
               Electron Desktop Host  (apps/desktop: Main + Preloads, TypeScript)
                       │
              Versioned Core Protocol  (stdio, length-prefixed JSON, v1)
                       │
                 YAQMC Rust Core  (crates/yaqmc-core executable)
               /        |        \
          Player      Provider    Storage
                        │
                QQMusic Provider  (crates/yaqmc-provider-qqmusic)
                        │
                    qm-api-rs  (crate `qqmusic-api`, pinned git rev)
```

**Headline decisions (all final — see §6 and the ADRs referenced there):**

| Decision | Choice |
|---|---|
| Desktop host | Electron (pinned to current stable line, Electron 43.x at planning time; version policy in §11.6) |
| Rust ↔ Electron connection | **Separate `yaqmc-core` process** spawned and supervised by Electron Main. No NAPI module in this migration. |
| Core transport | **stdio, 4-byte little-endian length-prefixed frames, JSON (serde) payloads**, versioned handshake (`CoreHello`/`CoreReady`). stderr reserved for uncontrolled output. |
| Protocol schema | serde-defined Rust structs are the source of truth; TypeScript mirror types live in `packages/yaqmc-client`; golden-fixture contract tests keep both honest. **No Protobuf/codegen** (rationale in §13.6). |
| Method names | The existing 117 registered Tauri command names (112 referenced by the frontend — §37.9) are preserved verbatim as protocol method names for v1. Event channels keep existing names (`player://snapshot`, `lyrics://projection`, `lyrics://document`, `api://event`, `plugin://changed`, `preferences://changed`, `lyrics://surface-closed`, `app://open-settings`) plus new `host.*` / `core.*` channels. Zero semantic drift = testable parity. |
| Frontend bridge | `window.yaqmc` via `contextBridge`; React talks only to `packages/yaqmc-client` (`YaqmcClient` over a `HostBridge` interface). A temporary `TauriHostBridge` adapter lets the frontend migrate **before** Electron exists. |
| Packaging | **electron-builder v27** (NSIS + portable zip on Windows; AppImage + deb + rpm + tar.gz on Linux — same formats as today). Rationale vs Forge in §31.1. |
| Updater | **electron-updater** with GitHub Releases provider — new functionality (Tauri build has **no** updater today — FACT). Electron Host + frontend + core binary ship as one release unit. |
| Migration shape | Strangler pattern: extract `crates/yaqmc-core` first, keep `src-tauri` as a thin shim over it (both hosts share one core during co-existence), migrate frontend onto the Client SDK while still on Tauri, then bring Electron to parity, then delete Tauri, then swap provider internals onto qm-api-rs. No Big Bang. |
| User data | **Path parity, not data copy**: the core replicates Tauri's exact per-platform directories for identifier `org.yaqmc.desktop`, so existing SQLite/plugins/keyring survive untouched (verification tasks included; fallback copy-migration specified in §18.4). |

**The two highest-risk areas and how the plan de-risks them:**

1. **Playback consistency (rapid seek).** The seek/session fencing machinery (`SeekMailbox`, `session_id`, `snapshot_revision`, `source_generation`, `load_generation`) is already host-independent Rust — FACT (§15). The plan forbids touching its semantics; the host migration only replaces the event fan-out transport. Rapid-seek regression tests are a release gate at every checkpoint (§34.7, §46).
2. **Linux special windows (desktop lyrics / island).** Wayland caps what any Chromium app may do (`setAlwaysOnTop` is a protocol-level no-op; click-through landed only recently and is compositor-dependent — VERIFIED web 2026-08-16, §22.4). The plan defaults Linux to the X11/XWayland backend (Chromium's default), preserving current capability levels, and defines an explicit degraded-capability matrix for optional native-Wayland mode — replacing today's WebKitGTK env-var magic with a documented, detectable, disable-able policy (§29).

**What the executor gets:** a complete file-by-file migration map (§37), a phase plan with fixed per-phase fields (§40), 115 atomic tasks with dependencies (§41–42), parallelization guidance tuned for multi-subagent execution (§43), git checkpoints that always build and test (§44), rollback rules (§45), and a final acceptance matrix (§46).

---

## 2. Source-of-Truth Git State

Captured 2026-08-16 from the working repository at `D:\Velune` (all FACT):

| Item | Value |
|---|---|
| Repository | `https://github.com/YAQMC/YAQMC.git` (origin) |
| Current branch | `main`, tracking `origin/main`, **in sync** (`## main...origin/main`) |
| HEAD SHA | `bc55b7ddd2a57cde8987c96c7c20f0b7d4a2e742` |
| origin/main SHA | same as HEAD |
| Uncommitted changes | **None** (`git status --short` empty) |
| Unpushed commits | None |
| Local feature branches | `feat/ci-build-optimization` @ `1e0f2c0` (tracks `origin/feat/ci-build-optimization`; already merged into `main` via `bc55b7d`) |
| Other remote branches | `origin/apple-like-lyrics` (contributor branch — **do not delete, do not rebase**) |
| Working-tree extras | `node_modules/`, `dist/`, `release/`, `output/`, `artifacts/` are build outputs (gitignored); `.superpowers/` is historical planning material |

Recent history (`git log --oneline -10`): merge of `feat/ci-build-optimization`, discover/home feature work, plugin API v2 (`639d466`, `902de1c`), scene extras (`8e19929`), rapid-seek fix (`9bd4e61` "fix(player): make rapid seek session-safe").

**Rules for the executor (mandatory):**

- Never run `git reset --hard`, `git clean -fd`, `git push --force`, `git push --force-with-lease`, or any history rewrite.
- Never delete or rebase `origin/apple-like-lyrics` or any contributor branch.
- All migration work happens on a new branch `feat/electron-migration` cut from `bc55b7d` (§44). Use `git mv` for every relocation so blame/history survives.
- Tracked-but-generated artifacts (`examples/plugins/packages/*.yaqmc-plugin`) are rebuilt by `npm run plugin:pack`; regenerate rather than hand-edit.

### 2.4 Reality deltas vs the planning prompt (§105 corrections)

The migration prompt encodes some assumptions that do not match HEAD. **Planning follows the repository, not the prompt.** Each delta below states: prompt assumption → actual repository state → planning consequence.

| # | Prompt assumption | Actual state at HEAD (FACT unless noted) | Planning consequence |
|---|---|---|---|
| D1 | `QueueEntryId`, `PlaybackSessionId`, `SnapshotRevision`, `SeekRevision`, `SourceGeneration` exist as named types | Only `SeekMailbox` + `SeekIntent {session_id, revision, position_ms}` are types (`src-tauri/src/playback_session.rs:15-25`). The rest are **fields**: `session_id: u64`, `snapshot_revision: u64`, `source_generation: u64` on `PlayerCore`/`PlayerSnapshot` (`player.rs:430-455`, `295-336`), `last_seek_revision` on snapshots, plus an additional `load_generation: AtomicU64` on `PlayerService` not mentioned in the prompt | §15 protects the mechanisms under their real names; `load_generation` is added to the protected list |
| D2 | qm-api-rs is a public repo at `https://github.com/YAQMC/qm-api-rs` | Repo exists but is **private** (unauthenticated fetch → 404; local git credentials can read it). HEAD `a7430a831a256bb15212291f11a055d801e31648`, branches `main` and `fix/final-hardening` (same SHA). The crate is named **`qqmusic-api`** (lib `qqmusic_api`), version 0.1.0, license **GPL-3.0-or-later** | §17 pins the git rev; CI needs an auth story for the private dependency; license implication recorded (YAQMC repo currently has **no LICENSE file** — FACT) |
| D3 | Plugin runtime may live in Rust | Plugin JS executes in **blob-URL Web Workers inside the main webview**; Rust is a filesystem/permission/bridge service only (`src/application/plugin-runtime.ts:186-320,514-518`; `src-tauri/src/plugin/*`) | §20 keeps the Worker sandbox in the renderer and hardens it; no JS engine is added to core |
| D4 | A Tauri updater exists and must be removed/replaced | **No updater exists anywhere** (no `tauri-plugin-updater`, no updater config — verified by search) | §32 ships the Electron updater as *new* functionality, not a port |
| D5 | Tray/deep link/single-instance/notifications all exist | Tray + global shortcuts exist. **No single-instance plugin, no deep-link handler, no OS notification API** (`lib.rs` plugin list; searched) | Single-instance is added in Electron (it is one line and prevents dual-core spawn — §11.4). Deep link + OS notifications stay out of scope (parity-first) |
| D6 | "Library" is a full feature | `qqmusic_library` returns an **empty placeholder** `LibrarySnapshot` (`qqmusic.rs:1382-1384`); the Library page is account-backed via playlists | Parity target is the current actual behavior |
| D7 | Prompt lists `isTauri`, dialog, clipboard, notification, updater, tray usage in frontend | Frontend uses exactly: `invoke`, `listen`, `isTauri`, `getCurrentWindow` (2 files), `@tauri-apps/plugin-opener` (2 files), `data-tauri-drag-region` (2 files). No clipboard/notification/dialog plugin usage in frontend (dialogs are Rust-side via `tauri-plugin-dialog`) | §12/§37 scope the bridge work to the real 22 coupled files |
| D8 | In-tree QQ signing equals qm-api-rs signing | In-tree `musics.fcg` sign is MD5-based with prefix `zzb` (`qqmusic.rs:4454-4479`); qm-api-rs uses SHA1-based `zzc_sign`. Both pass server validation per their docs/tests — LIVE VERIFY | §17 keeps the proven in-tree path during host migration; sign-path swap happens only in the provider phase with live verification |
| D9 | Docs describe current paths | `docs/logging.md:123` still references `%LOCALAPPDATA%\Velune\YAQMC\logs`; the real identifier is `org.yaqmc.desktop` everywhere at runtime | Docs fixed in cleanup phase; data-dir parity is based on code, not docs |

---

## 3. Current Architecture

### 3.1 Process/layer diagram (as-is at HEAD — FACT)

```
┌───────────────────────────────── Tauri process ─────────────────────────────────┐
│                                                                                  │
│  WebView windows (WebView2 on Windows / WebKitGTK on Linux)                      │
│  ┌──────────────┐ ┌───────────────┐ ┌───────────────┐ ┌──────────────────────┐  │
│  │ main          │ │ lyrics-desktop│ │ lyrics-island │ │ lyrics-*-unlock (×2) │  │
│  │ index.html    │ │ ?surface=...  │ │ ?surface=...  │ │ ?unlockSurface=...   │  │
│  └──────┬───────┘ └──────┬────────┘ └──────┬────────┘ └──────────┬───────────┘  │
│         │ invoke (112 of 117 commands) + listen (7 events)         │              │
│  ┌──────▼────────────────────────────────────────────────────────▼───────────┐  │
│  │ Tauri Core: invoke_handler (117 registered commands), capabilities,       │  │
│  │ per-window permission sets, CSP, event emit                               │  │
│  └──────┬─────────────────────────────────────────────────────────────────── ┘  │
│         │ State<Arc<...>>                                                        │
│  ┌──────▼──────────────────────────────────────────────────────────────────┐    │
│  │ Rust services (single crate `yaqmc`, src-tauri/src/)                     │    │
│  │  PlayerService ── AudioEngine(rodio/cpal, worker thread)                 │    │
│  │       │  ▲             MediaPreparer / progressive streaming thread      │    │
│  │       │  └─ PlaybackSourceResolver = QQMusicService                      │    │
│  │  QQMusicService ── QQMusicClient + QqTransport (reqwest, in-tree proto)  │    │
│  │       ├─ auth (QR + OAuth), account, entitlement, cache, artwork         │    │
│  │  StorageService (SQLite library.sqlite3, media/artwork disk cache)       │    │
│  │  PlatformCredentialStore (OS keyring, service org.yaqmc.desktop)         │    │
│  │  ExtensionHost (plugin packages, permissions, token bridge)              │    │
│  │  LocalApiService (axum on 127.0.0.1:19532, bearer token, SSE)            │    │
│  │  SystemMediaIntegration (SMTC via souvlaki / MPRIS via mpris-server)     │    │
│  │  DesktopIntegration (tray, global shortcuts)                             │    │
│  │  LyricsSurfaceManager (overlay window lifecycle + geometry)              │    │
│  │  logging / diagnostics / issue_reporter / platform (Linux env policy)    │    │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│  OAuth: ephemeral incognito WebviewWindow `qqmusic-oauth-{attemptId}`            │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 The event fan-out (the single most load-bearing Tauri coupling — FACT)

`src-tauri/src/lib.rs:208-295`: one tokio task subscribes to `PlayerService`'s internal `tokio::sync::broadcast` bus (capacity 256) and:

- emits `api://event` for **every** internal event (types: `queue.changed`, `player.track`, `player.playback`, `player.position`, `player.seeked`, `player.volume`, `player.mode`, `player.error`, `lyrics.changed`, `lyrics.line`, `lyrics.word`);
- emits `player://snapshot` for queue/player events;
- emits `lyrics://projection` for position/seek/track/playback/error/lyrics events;
- emits `lyrics://document` on `lyrics.changed`;
- feeds `SystemMediaIntegration.update(snapshot, seeked)`;
- persists the queue snapshot on non-position events;
- on `broadcast` **Lagged**: logs, re-fetches authoritative snapshot + projection + document and re-emits all three (resync instead of replay).

Position cadence: internal clock ticks every **50 ms**; `player.position` is emitted at most every **250 ms** while playing (`player.rs:1998-1999, 2116-2120`). The audio worker polls at 20 ms. The frontend interpolates between snapshots client-side (`player-store.ts:892-899`) with a 250 ms discontinuity threshold. **This cadence is already IPC-friendly; the Electron migration keeps it unchanged (§13.8, §15.5).**

### 3.3 Frontend structure (FACT)

- 104 non-test source files: **82 fully host-agnostic**, **17 bridge-only** (import `@tauri-apps` only for `invoke`/`listen`/`isTauri`), **5 deeply host-coupled** (`TopBar.tsx` window chrome + drag region, `lyrics-presentation.ts` fullscreen, `external-links.ts` + `issue-reporter.ts` opener, `surfaces/LyricsSurfaceApp.tsx` drag + direct invokes).
- There is already a real abstraction layer: components → `usePlayerStore` → `dispatchPlayerCommand` (seek-coalescing mailbox in `player-command-adapter.ts`) → `native-player-runtime.ts` (the only file that invokes player commands); catalog/account goes components → `MusicProvider` interface → `qq-music-provider.ts` (thin invoke wrapper) or `fake-music-provider.ts` (browser dev, `?provider=fake`).
- Single `index.html`; window role selected by query params in `main.tsx:15-41` (`?surface=desktop|island`, `?unlockSurface=desktop|island`).
- Zustand stores: `usePlayerStore`, `useAccountStore`, `usePreferencesStore`, `useLyricsStore`, `useLyricsPresentationStore`, `useLyricsPresetPreviewStore`.

### 3.4 What is correct and must be preserved (design classification)

| Classification | Items |
|---|---|
| **Correct design — do not break** | PlayerService authority + seek/session fencing (§15); internal broadcast bus + lagged-resync pattern; snapshot-projection frontend stores with client-side interpolation; MusicProvider frontend interface + fake provider; plugin Worker sandbox + host-bound token bridge + permission model; storage schema v5; keyring usage; localhost API bearer-token + SSE; redaction layers (logging + transport + diagnostics); mutation reconciliation with `client_operation_id`; per-window capability scoping (main-window guard for account commands) |
| **Host coupling only — replace transport, keep semantics** | `lib.rs` bootstrap/fan-out; 117 `#[tauri::command]` wrappers; `command_guard.rs` window-label check; `tauri::async_runtime::spawn` call sites (4 in player.rs, 2 in oauth.rs, 1 in auth.rs); `oauth.rs` window mechanics; `LyricsSurfaceManager` window mechanics; tray/shortcuts; dialog/opener plugins; SMTC HWND acquisition from Tauri window; Tauri path resolver usage; `data-tauri-drag-region`; `TopBar` window controls |
| **True technical debt** (see §5) | WebKitGTK env-var magic in `platform.rs`; in-tree QQ protocol duplicating qm-api-rs; DTO leaks (QQ `mid`/`tid`/`dirId`/`encArea` in frontend-visible types); one crate for everything; Linux fullscreen detection stub; docs path staleness; no updater; no single-instance |

---

## 4. Current Feature Inventory

Status legend: **Implemented** (works, has tests or is exercised daily), **Partial** (works with platform/feature gaps), **Experimental** (behind flags/dev-only), **Legacy** (kept for compatibility), **Missing** (prompt assumed it, repo does not have it).

### 4.1 Playback & queue

| Feature | Status | Evidence / notes |
|---|---|---|
| Play/pause/stop/next/previous, position clock | Implemented | `player.rs` state machine; 50 ms clock, 250 ms position events |
| Latest-wins rapid seek with stale fencing | Implemented | `SeekMailbox` + audio-worker coalescing + `session_id`/`last_seek_revision` fencing; regression-tested (`player.rs` tests + `9bd4e61`) |
| Queue: replace/enqueue(next|end)/remove/move/jump; unique `entry_id: u64` per entry | Implemented | `player.rs:340-352` (`QueueEntry`), counter-assigned entry ids |
| Play modes: sequential / repeat-one / shuffle (bag-based, anti-adjacent-repeat) | Implemented | `player.rs` `PlayMode`, shuffle bag |
| Volume + mute with clamping | Implemented | `player_set_volume`, `player_toggle_mute` |
| Gapless-ish track advance (auto-advance on `TrackEnded`) | Implemented | audio worker end event → core advance |
| Queue persistence & restore (max 500 entries, revalidated lazily) | Implemented | `queue_snapshot` app-setting; restore path in `player.rs` |
| Media source resolution: QQ stream vkey / EKey-encrypted QMC / local file | Implemented | `media.rs` resolver → `qqmusic.rs` vkey; `qmc.rs` decrypt-on-read |
| Progressive HTTP range cache + sparse-file promotion | Implemented | `streaming.rs` background fill thread |
| Quality ladder + entitlement gating (128k/320k/flac/hires by VIP) | Implemented | `entitlement.rs`; LIVE VERIFY for server behavior |

### 4.2 Catalog / account (QQ Music)

| Feature | Status | Notes |
|---|---|---|
| Search: songs + albums (paged) | Implemented | `qqmusic_search_*` commands |
| Home / Discover: recommended playlists, new releases, rankings, MV & podcast cards, category browse (`encArea`) | Implemented | display-level; MV/podcast are card links, **no MV playback** |
| Album / playlist detail + paged tracks | Implemented | |
| Favorites: songs/albums/playlists/MVs, add/remove with `client_operation_id` reconciliation | Implemented | `account.rs` mutation queue |
| User playlists (own + collected), create/delete/add/remove tracks | Implemented | |
| QR login (QQ) + OAuth popup login (QQ/WeChat) | Implemented | OAuth uses ephemeral Tauri WebviewWindow — host-coupled |
| Session persistence + staging slot + auto-refresh | Implemented | keyring `qqmusic-session` / `qqmusic-session-staging`; poll-based account state (frontend polls, no push event) |
| Entitlement snapshot (VIP tier, quality rights) | Implemented | cached; LIVE VERIFY |
| "Library" aggregate | **Partial (placeholder)** | `qqmusic_library` returns empty `LibrarySnapshot` (D6) |
| Lyrics fetch QRC/LRC + decrypt + parse (word/line/plain) | Implemented | in-tree `lyrics-crypto` crate usage |

### 4.3 Lyrics presentation & scenes

| Feature | Status | Notes |
|---|---|---|
| In-app lyrics page: word-level karaoke, blur/scale effects, fonts, presets | Implemented | `LyricsPage`, `useLyricsStore`, presets in app_settings |
| Scene composer (user-composed lyric scenes) + presets + preview | Implemented | plugin scene API v2 integration |
| Desktop lyrics overlay window | Implemented (Windows-first) | transparent, always-on-top, click-through lock, unlock overlay, geometry persistence (350 ms debounce), fullscreen auto-hide **Windows-only** (`lyrics_surface/linux.rs` returns `NotSupported` — FACT) |
| Lyrics island (compact pill overlay) | Implemented (Windows-first) | same mechanics, separate geometry + unlock overlay |
| Lyrics offset per track | Implemented | `lyrics_set_offset` |

### 4.4 Plugins

| Feature | Status | Notes |
|---|---|---|
| Plugin install/enable/disable/uninstall (`.yaqmc-plugin` zip, ≤ 32 MiB, path-traversal-guarded) | Implemented | `plugin/host.rs` |
| Manifest v1 + v2 (`apiVersion: 2`, scene extensions) | Implemented | `plugin/manifest.rs` |
| Permission model (declared → granted, prompts, rate limits) | Implemented | `plugin/permissions.rs` |
| Worker sandbox (blob Workers in main webview) + token-gated bridge (20 `plugin_*`/bridge commands) | Implemented | D3 |
| Plugin network proxy (HTTPS-only, DNS/private-IP blocking, size caps) | Implemented | `plugin/network.rs` |
| Plugin JSON storage (per-plugin file, quota) | Implemented | `plugin/storage.rs` |
| Safe Mode (crash journal, boot-loop guard) | Implemented | `plugin/safety.rs` |
| Scene registration (lyric scene providers) API v2 | Implemented | `902de1c`, `639d466` |

### 4.5 Platform integration

| Feature | Status | Notes |
|---|---|---|
| Tray icon + menu (show/hide, play/pause, next/prev, settings, quit) + close-to-tray preference | Implemented | `desktop_integration.rs`; tray id `yaqmc-tray` |
| Global shortcuts (3 bindings: play-pause / next / prev; fixed, not user-configurable) | Implemented; **disabled on native Wayland** | `desktop_integration.rs` guard |
| SMTC (Windows) | Implemented | `souvlaki` with HWND from main Tauri window |
| MPRIS (Linux) | Implemented | `mpris-server` on dedicated thread, bus `org.mpris.MediaPlayer2.yaqmc` |
| Local HTTP API (127.0.0.1:19532) + SSE events + bearer token in keyring | Implemented | `local_api.rs`; token rotate command exists |
| Window: transparent main window (Windows), opaque on Linux (`tauri.linux.conf.json`) | Implemented | D-shaped: platform-conditional |
| Custom title bar with drag region + min/max/close | Implemented | `TopBar.tsx` — host-coupled |
| Single instance | **Missing** | no plugin, second launch = second app (D5) |
| Deep links / custom URI scheme | **Missing** | docs/deep-link.md is a security doc only |
| OS notifications | **Missing** | |
| Auto-update | **Missing** | D4 |

### 4.6 Infrastructure

| Feature | Status | Notes |
|---|---|---|
| SQLite storage `library.sqlite3`, `user_version = 5`, WAL | Implemented | tables: `tracks`, `albums`, `playlists`, `playlist_tracks`, `app_settings`, `provider_cache` (schema in §18.2) |
| Media disk cache (256 MiB cap) + artwork cache (64 MiB) with LRU eviction | Implemented | `storage.rs` |
| Keyring credentials (3 entries: session, staging, `local-api-token`) service `org.yaqmc.desktop` | Implemented | + one legacy read-migration from service `yaqmc` |
| Logging: `tracing` + daily rotation, 7 files, secret redaction, frontend log ingestion command | Implemented | `logging.rs` |
| Diagnostics snapshot + ZIP bundle (8 MiB cap, redacted) + GitHub issue URL builder | Implemented | `diagnostics.rs`, `issue_reporter.rs` |
| i18n en-US / zh-CN (i18next) | Implemented | |
| Preferences (`ui-preferences-v1` in app_settings) + `preferences://changed` broadcast | Implemented | `app_preferences.rs` |
| CI: quality gate + package matrix (win x64/i686/arm64 → NSIS+portable; linux x64/arm64 → AppImage/deb/rpm), unsigned; tag → GitHub Release | Implemented | `.github/workflows/ci.yml`, `build.yml` |
| Docs site (`docs/`, 90 files, EN+zh pairs) via GitHub Pages | Implemented | `pages.yml` |

---

## 5. Current Technical Debt (verbatim register, kept honest)

| ID | Debt | Where | Migration disposition |
|---|---|---|---|
| TD-1 | WebKitGTK compositing workarounds driven by env vars (`WEBKIT_DISABLE_DMABUF_RENDERER`, `YAQMC_LINUX_RENDERER` modes, NVIDIA/Hyprland sniffing) | `platform.rs` | **Eliminated by Electron** (WebKitGTK gone). Replaced by explicit, documented Chromium flag policy + diagnostics (§29). This is the single biggest quality win of the migration |
| TD-2 | ~19k LOC in-tree QQ protocol duplicating qm-api-rs (transport, signing, QR login, QMC, lyric decrypt) | `src-tauri/src/qqmusic/*`, `qmc.rs` | Strangler-replaced in provider phase (§17), behind the `MusicProvider` trait, feature-flag switchable, LIVE VERIFY gated |
| TD-3 | Provider DTO leaks: frontend types carry QQ-specific `mid`/`numericId`/`albumId`/`mediaId`, playlist `tid`/`dirId`, category `encArea` | `ProviderTrackReference` etc. (Rust + TS) | **Accepted for this migration** (wire-format freeze is what makes parity testable). Documented as post-migration cleanup; the `MusicProvider` trait (§16) makes reference types opaque at the *trait* boundary already |
| TD-4 | Single mega-crate `yaqmc` | `src-tauri` | Split into 4 crates (core/protocol/provider-api/provider-qqmusic) — deliberately **not** 10 (§9.3) |
| TD-5 | Linux fullscreen detection stub (desktop lyrics never auto-hide on Linux) | `lyrics_surface/linux.rs` | Carried over as-is (parity), documented in capability matrix; NEEDS ACCEPTANCE TEST for any improvement — out of scope |
| TD-6 | Poll-based account state (no push event channel for auth changes) | `account.rs`, frontend polling | Carried over (parity). Protocol reserves `account://changed` channel name for future use |
| TD-7 | Stale docs (log paths mention `Velune`, deep-link doc describes non-feature) | `docs/logging.md:123` etc. | Fixed in cleanup phase (§40 P15) |
| TD-8 | No LICENSE file in main repo while planning to link GPL-3.0-or-later qm-api-rs | repo root | **Decision required from maintainer** recorded in §17.6; plan proceeds with GPL-compatible assumption (provider crate isolation does not remove GPL obligations for distributed binaries) |
| TD-9 | Tracked generated plugin packages | `examples/plugins/packages/*.yaqmc-plugin` | Regenerated whenever plugin examples change (`npm run plugin:pack`) |
| TD-10 | `beforeDevCommand`/`beforeBuildCommand` couple frontend build to Tauri CLI | `tauri.conf.json` | Dissolved when Tauri removed; Electron scripts own orchestration (§33) |

---

## 6. Fixed Architecture Decisions

These are **final**. The executor must not re-litigate them. Rationale is recorded as mini-ADRs.

**ADR-001 — Electron is the desktop host.** Mandated. Also independently justified: removes WebKitGTK (TD-1), single rendering engine across Windows/Linux, mature multi-window + tray + shortcut APIs, first-class updater ecosystem.

**ADR-002 — Rust Core runs as a separate supervised process (no NAPI in this migration).**
- Chosen: `yaqmc-core` executable, spawned by Electron Main, stdio transport.
- Rejected: `napi-rs` in-process module. Reasons: (1) fault isolation — an audio/decoder crash must not take down the UI, and core panics become supervised restarts instead of app crashes (§14); (2) the Android constraint (§7.5) requires the core to be linkable without any Node assumption — a process boundary keeps `yaqmc-core` a plain tokio binary, and the same protocol crate can later run over JNI/UDS; (3) host replaceability (§7.4) — the core must outlive Electron; (4) no shared-memory-scale data crosses the boundary (positions at 4 Hz, snapshots on change — §3.2 measurements); (5) removes Node ABI/electron-rebuild churn from CI. `napi-rs` v3 (VERIFIED web 2026-08-16: stable, Electron-compatible via Node-API) remains available for *future* needs; nothing in this plan requires it.

**ADR-003 — stdio + 4-byte LE length-prefixed JSON frames, versioned envelope.**
- Rejected TCP localhost (port squatting, firewall prompts, any-local-process reachability), named pipes/UDS (per-platform divergence, filesystem ACL surface, lifetime cleanup), MessagePack/Protobuf (§13.6).
- stdio inherits the process lifetime (EOF = crash detection), is private to the parent/child pair (no token needed), and is identical on Windows and Linux.

**ADR-004 — Existing command/event names are the v1 protocol.** 117 methods (§37.9), 8 event channels, preserved byte-for-byte in names and payload shape. This converts the entire migration into a transport swap with a testable identity contract (§13.4, §34.3). Namespacing/renaming is explicitly deferred.

**ADR-005 — Strangler sequence: Core extraction → Client SDK on Tauri → Electron parity → Tauri removal → provider swap to qm-api-rs.** Never change host and provider in the same phase; every checkpoint ships a working app (§40).

**ADR-006 — electron-builder v27 over Electron Forge** (§31.1): AppImage/deb/rpm + NSIS parity with today's formats, mature `electron-updater` integration, better multi-arch Linux story. VERIFIED web 2026-08-16: electron-builder v27 current, actively maintained, Node ≥ 22.12 required.

**ADR-007 — Data-path parity instead of data migration** (§18): core reproduces Tauri's directory scheme for `org.yaqmc.desktop`; keyring service name unchanged; zero-copy upgrade. Fallback copy-migration is specified but expected to be dead code.

**ADR-008 — Linux runs Chromium's X11/XWayland backend by default** (§29): preserves always-on-top/click-through overlay capability on Wayland sessions; optional native-Wayland mode ships with a documented degraded matrix. Replaces TD-1's env magic with an explicit, diagnosable policy.

**ADR-009 — SMTC ownership stays in core.** The Windows SMTC attaches to an HWND provided by the Electron host in the protocol handshake (`platform_attach` message carrying the main window handle), exactly mirroring today's flow where `lib.rs` passes the Tauri window HWND into `SystemMediaIntegration`. Fallback (NEEDS ACCEPTANCE TEST): core-owned hidden message window created with the already-present `windows-sys` dependency. MPRIS needs no window and is unchanged.

**ADR-010 — Security baseline** (§28): every renderer runs `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`; all privileged access flows through typed `contextBridge` APIs; per-window preloads expose per-window API subsets (mirroring today's Tauri capability files); OAuth windows get **no preload** and session isolation; CSP is ported and tightened; `shell.openExternal` is allowlist-guarded in Main.

---

## 7. Target Architecture

### 7.1 Process topology

```
┌─ Electron Main (Node, TypeScript) ────────────────────────────────────────────┐
│  CoreSupervisor: spawn/restart yaqmc-core, handshake, health                  │
│  CoreClient (Node side): stdio framing, request/response, event fan-out       │
│  WindowManager: main / lyrics-desktop / lyrics-island / unlock ×2 / oauth     │
│  HostServices: tray, global shortcuts, dialogs, openExternal, power, single-  │
│                instance, updater, window geometry, drag regions               │
│  IpcRouter: renderer ⇆ main (invoke/event), per-window channel ACLs           │
└──────┬────────────────────────────────────────────────┬───────────────────────┘
       │ Electron IPC (contextBridge, typed)            │ stdio frames (protocol v1)
┌──────▼──────────────┐  ┌──────────────────┐    ┌──────▼───────────────────────┐
│ Renderer: main       │  │ Renderers: lyric │    │ yaqmc-core (Rust, tokio)     │
│ React app (src/)     │  │ surfaces + unlock│    │  transport server (stdio)    │
│ window.yaqmc bridge  │  │ window.yaqmc sub │    │  method registry (117)       │
│ packages/yaqmc-client│  │ -set bridges     │    │  event bus → frames          │
│ plugin Workers (blob)│  └──────────────────┘    │  PlayerService/AudioEngine   │
└──────────────────────┘                          │  Provider(QQMusic)/Storage   │
                                                  │  Plugins/LocalAPI/SMTC/MPRIS │
                                                  │  Diagnostics/Logging         │
                                                  └──────────────────────────────┘
```

### 7.2 Layer responsibilities (single-sentence contracts)

| Layer | Owns | Must never |
|---|---|---|
| React Frontend (`src/`) | All UI, stores, interpolation, plugin Worker runtime | import Electron/Tauri/Node APIs; know the transport |
| YAQMC Client API (`packages/yaqmc-client`) | Typed methods+events, `HostBridge` interface, protocol TS types, reconnect/resync semantics | contain host conditionals beyond bridge selection |
| Electron Host (`apps/desktop`) | Windows, chrome, tray, shortcuts, dialogs, external URLs, updater, core supervision, renderer ACLs | contain business logic, QQ protocol, playback state |
| Core Protocol (`crates/yaqmc-protocol`) | Envelope, framing, method/event names, version, error codes | depend on Electron, Tauri, or provider internals |
| Rust Core (`crates/yaqmc-core`) | Playback authority, providers, storage, credentials, plugins host-side, local API, SMTC/MPRIS, diagnostics | link Tauri/Electron; open windows; assume a UI exists |
| Provider (`crates/yaqmc-provider-api`, `-qqmusic`) | `MusicProvider` trait; QQ implementation over qm-api-rs | reach into player/storage internals |

### 7.3 Authority map (who is the source of truth)

| State | Authority | Distribution |
|---|---|---|
| Playback state, queue, position, volume, mode | Rust `PlayerService` | `player://snapshot` + `api://event` frames → Main → renderer(s) + SSE + SMTC/MPRIS |
| Lyrics document/projection | Rust lyrics pipeline | `lyrics://document` / `lyrics://projection` |
| Account/session/entitlement | Rust QQMusic provider | poll commands (parity; TD-6) |
| Preferences | Rust `app_preferences` (SQLite) | `preferences://changed` |
| Plugin registry/permissions/storage | Rust `ExtensionHost` | `plugin://changed` + commands |
| Window geometry/visibility, tray, shortcuts | **Electron Main** | geometry persisted via core preference commands (same app_settings keys — §22.6) |
| Update availability | Electron Main (electron-updater) | `host://update` events (new) |

### 7.4 Electron-replaceability proof obligation

The host-independence claim is enforced mechanically: `crates/yaqmc-core` builds and passes its full test suite on a machine with no Electron/Node present (pure `cargo test`), and the protocol server is exercised by a Rust-only integration harness (`yaqmc-core --stdio` driven by a test client — §34.4). Any future host (Qt, native, CLI) reuses the same binary + protocol.

### 7.5 Android constraint (architecture-level only)

Non-deliverable, but shapes decisions: core stays a tokio library-first crate (`yaqmc-core` = thin `main.rs` over `yaqmc_core::run(transport)`), no process-global state that assumes one desktop user, no `std::env` UI assumptions, transport abstracted behind `CoreTransport` trait (stdio today; JNI/UDS later), `rodio`/`cpal` isolated behind the existing `AudioEngine` trait (Android would swap in an `oboe`/AAudio engine), storage paths injected not discovered. These rules are enforced in §10.7 as review checklist items.

---

## 8. Dependency Rules

Enforced direction (violations = review-blocking):

```
src/ (React)  →  packages/yaqmc-client  →  (window.yaqmc | TauriHostBridge*)   [* deleted in P13]
apps/desktop/main  →  crates/yaqmc-protocol (types only, via generated TS mirror)
apps/desktop/main  →  yaqmc-core (spawn binary; never link)
crates/yaqmc-core  →  yaqmc-provider-api  →  (impls) yaqmc-provider-qqmusic  →  qqmusic-api (qm-api-rs)
crates/yaqmc-core  →  yaqmc-protocol
src-tauri (during co-existence only)  →  crates/yaqmc-core (lib)
```

Hard bans:
- `crates/**` must never depend on `tauri*`, `electron`, `napi`, or `node` anything. CI greps for `tauri` in `crates/` (§33.5).
- `src/**` must never import `@tauri-apps/*` or `electron` after P6 (except the single `TauriHostBridge` adapter file until P13). ESLint `no-restricted-imports` rule added in P6.
- `apps/desktop/**` must never import from `src/` internals (only serves its built output).
- `packages/yaqmc-client` must be runnable in a plain browser (fake bridge) — it is the dev-mode story.

---

## 9. Target Repository Layout

### 9.1 End-state tree (post P15)

```
YAQMC/
├── apps/
│   └── desktop/                     # Electron host (TypeScript, ESM)
│       ├── main/
│       │   ├── index.ts             # app entry: single-instance, paths, boot
│       │   ├── core/
│       │   │   ├── supervisor.ts    # spawn/restart/backoff/safe-mode
│       │   │   ├── client.ts        # stdio framing + request/event demux
│       │   │   └── frames.ts        # length-prefix encode/decode
│       │   ├── windows/
│       │   │   ├── manager.ts       # window registry & lifecycle
│       │   │   ├── main-window.ts
│       │   │   ├── lyrics-surfaces.ts  # desktop/island + unlock overlays
│       │   │   └── oauth-window.ts
│       │   ├── services/
│       │   │   ├── tray.ts
│       │   │   ├── shortcuts.ts
│       │   │   ├── dialogs.ts
│       │   │   ├── external-links.ts
│       │   │   ├── updater.ts
│       │   │   └── linux-graphics.ts   # ADR-008 flag policy
│       │   ├── ipc/
│       │   │   ├── router.ts        # renderer⇆main channels + per-window ACL
│       │   │   └── channels.ts      # channel name constants (mirror of ACL table §11.3)
│       │   └── security.ts          # webRequest/CSP/permission handlers
│       ├── preload/
│       │   ├── main.ts              # full window.yaqmc
│       │   ├── lyrics-surface.ts    # read-only + surface subset
│       │   └── unlock-overlay.ts    # minimal subset
│       ├── resources/               # icons (from src-tauri/icons), tray assets
│       ├── electron-builder.yml
│       ├── package.json             # electron, electron-builder, esbuild
│       └── tsconfig.json
├── packages/
│   └── yaqmc-client/                # host-agnostic TS SDK
│       ├── src/
│       │   ├── client.ts            # YaqmcClient (methods, events, resync)
│       │   ├── bridge.ts            # HostBridge interface
│       │   ├── bridges/
│       │   │   ├── electron.ts      # binds window.yaqmc
│       │   │   └── fake.ts          # browser dev-mode
│       │   └── protocol/
│       │       ├── methods.ts       # 117 method names + param/result types
│       │       ├── events.ts        # channel names + payload types
│       │       └── types.ts         # DTO mirror of Rust serde structs
│       └── package.json
├── crates/
│   ├── yaqmc-protocol/              # envelope, frames, method/event registry, version
│   ├── yaqmc-core/                  # lib + bin (all current src-tauri/src modules, de-Tauri'd)
│   │   └── src/ (player.rs, audio.rs, playback_session.rs, media.rs, streaming.rs,
│   │        qmc.rs, storage.rs, credentials.rs, app_preferences.rs, logging.rs,
│   │        diagnostics.rs, issue_reporter.rs, local_api.rs, system_media.rs,
│   │        platform.rs, plugin/, qqmusic/ [until P14], server/ [transport+methods],
│   │        main.rs)
│   ├── yaqmc-provider-api/          # MusicProvider trait + provider-neutral DTOs
│   └── yaqmc-provider-qqmusic/      # P14: qqmusic/* extracted + qm-api-rs backend
├── src/                             # React frontend — path unchanged on purpose
├── public/
├── scripts/                         # existing + new (perf-baseline, core-build)
├── docs/
├── .github/workflows/               # ci.yml / build.yml / pages.yml (rewritten §33)
├── Cargo.toml                       # workspace root (moved from src-tauri)
├── package.json                     # root: renderer + workspaces glue
└── YAQMC_ELECTRON_MIGRATION_PLAN.md
```

`src-tauri/` exists from P1 to P12 as a thin shim host and is deleted in P13 (§38).

### 9.2 Naming conventions

- Crates: `yaqmc-core`, `yaqmc-protocol`, `yaqmc-provider-api`, `yaqmc-provider-qqmusic` (lib names `yaqmc_core` etc.).
- npm workspaces: `@yaqmc/client` (packages/yaqmc-client), `@yaqmc/desktop` (apps/desktop). Root `package.json` gains `"workspaces": ["packages/*", "apps/*"]`.
- Protocol constants live once: Rust `yaqmc-protocol/src/registry.rs`; TS mirror `packages/yaqmc-client/src/protocol/*` (checked by contract tests, §34.3).
- Binary name: `yaqmc-core` / `yaqmc-core.exe`, shipped in Electron `resources/core/`.

### 9.3 Why exactly four crates (anti-over-engineering note, prompt §76)

The current single crate has clean *module* boundaries already. Splitting player/storage/plugins into separate crates would create cyclic-dependency pressure (player needs storage for restore; plugins need player+provider) for zero migration value. The four chosen crates each encode a *real* contract: protocol (shared with tests/hosts), provider-api (Android/provider swap seam), provider-qqmusic (GPL isolation + qm-api-rs), core (everything whose internal boundaries are already fine as modules).

---

## 10. Rust Core Architecture

### 10.1 Crate shape

`crates/yaqmc-core` is **lib-first**: `main.rs` is ~30 lines. Public surface:

```rust
// yaqmc-core/src/lib.rs (new public API)
pub struct CoreConfig {
    pub data_dir: PathBuf,        // injected; desktop: Tauri-parity paths (§18.1)
    pub cache_dir: PathBuf,
    pub log_dir: PathBuf,
    pub release_channel: String,  // from build metadata
    pub build_commit: String,
}

pub struct CoreHandle { /* owns services + shutdown */ }

/// Boot every service (same order as today's lib.rs — §10.2), then serve
/// the protocol on the given transport until shutdown or fatal error.
pub async fn run(config: CoreConfig, transport: impl CoreTransport) -> anyhow::Result<()>;
```

`CoreTransport` (in `yaqmc-protocol`) abstracts framed byte streams; the only shipped impl is `StdioTransport`. Tests use `DuplexTransport` (in-memory).

### 10.2 Boot order (preserved from `lib.rs` — FACT, keep identical)

1. `logging::init` (log dir, rotation, redaction)
2. `platform` diagnostics snapshot (now: no env mutation on Electron — §29)
3. `StorageService::initialize` (SQLite open + migrate to v5, cache dirs)
4. `PlatformCredentialStore` (keyring)
5. `ExtensionHost::initialize` (manifest scan, safe-mode journal check)
6. `QQMusicService::new` (transport, session restore from keyring, entitlement refresh spawn)
7. `RodioAudioEngine::new` (worker thread)
8. `PlayerService::new` (audio engine + resolver + storage; queue restore)
9. `LocalApiService::start` (axum bind 127.0.0.1:19532, token ensure)
10. `SystemMediaIntegration::new` (MPRIS thread on Linux immediately; SMTC deferred until `platform_attach` delivers an HWND — ADR-009)
11. Protocol server start → emit `CoreReady`

The current `lib.rs` fan-out task (§3.2) becomes `server/events.rs`: same subscription, same channel mapping, same lagged-resync logic, but emitting protocol frames instead of Tauri `emit`. SMTC feed and queue persistence stay in this task unchanged.

### 10.3 De-Tauri substitutions inside core code (complete list — from audit)

| Site | Today | Core replacement |
|---|---|---|
| `player.rs` ×4 `tauri::async_runtime::spawn` | Tauri runtime handle | `tokio::spawn` (core owns the runtime; all call sites already run inside it) |
| `qqmusic/auth.rs:1` spawn | same | `tokio::spawn` |
| `qqmusic/oauth.rs` ×2 spawn + WebviewWindow lifecycle | Tauri windows | split: URL build/callback parse/token exchange stay in core as `auth_oauth_prepare`/`auth_oauth_complete` methods (§16.4); window mechanics move to hosts |
| `system_media.rs` `AppHandle` (raise window, quit, HWND) | Tauri | `HostCommand` events on the protocol (`host://command` channel: `raise`, `quit`) + HWND via `platform_attach` (ADR-009) |
| `commands.rs` 117 `#[tauri::command]` fns | Tauri macros | `server/methods.rs` dispatch table calling the same service functions (§13.5); the service-layer code is already command-body-free |
| `command_guard.rs` main-window-only guard | window label check | per-connection/per-window ACL enforced by Electron Main's IpcRouter (§11.3) **and** re-checked in core via method metadata (`MainWindowOnly` flag carried in `platform_attach`-declared window role) — defense in depth |
| `lyrics_surface/mod.rs` window management | Tauri windows | moves to Electron Main entirely (§22); core keeps only lyric *data* (projection/document) |
| `desktop_integration.rs` tray/shortcuts | Tauri APIs | moves to Electron Main (§26); core keeps the player-control functions they call |
| dialogs (`tauri-plugin-dialog` in diagnostics export, background picker) | Rust-side dialog | dialogs move to Electron Main (`dialogs.ts`); core methods that needed "ask user for path" split into pure-IO methods taking an explicit path (§27.4) |
| opener (`tauri-plugin-opener`) | Rust plugin | `shell.openExternal` in Main with allowlist (§28.6); core never opens URLs |
| Tauri path resolver | `app.path()` | `CoreConfig` injected paths (§18.1) |
| build-time command manifest (`build.rs` `APP_COMMANDS`) | Tauri ACL generation | replaced by `yaqmc-protocol` method registry (compile-time table, §13.5); `build.rs` keeps only build metadata embedding |

**Everything else in the Rust tree compiles unmodified** — the audits confirmed player/audio/media/streaming/qmc/storage/credentials/logging/diagnostics/local_api/plugin(minus commands)/qqmusic(minus oauth windows) are already Tauri-free. FACT.

### 10.4 Runtime & threading (unchanged semantics)

- One multi-threaded tokio runtime owned by `main.rs` (today: Tauri's). All `Arc<RwLock>`, `AtomicU64`, `broadcast::channel(256)`, `spawn_blocking` patterns keep working verbatim.
- Dedicated OS threads preserved: audio worker (rodio), streaming fill thread, MPRIS server thread, SQLite is `rusqlite` behind a mutexed connection (as today).
- Shutdown: `CoreHandle::shutdown()` runs the §14.3 sequence; `run()` resolves after ACK.

### 10.5 Core-side event bus → protocol frames

`server/events.rs` maps the internal `PlayerEvent`/`LyricsEvent`/plugin/preference buses onto `CoreEvent` frames with a monotonically increasing `seq: u64` per connection. Channels (names preserved — ADR-004): `api://event`, `player://snapshot`, `lyrics://projection`, `lyrics://document`, `plugin://changed`, `preferences://changed`, plus new: `host://command` (core→host: raise/quit), `core://log` (optional debug tail), `account://changed` (reserved, unused — TD-6).

Subscription model: the single host connection receives **all** channels; Electron Main fans out to windows according to the ACL table (§11.3). This mirrors today's "emit to all windows, capability-filtered" model.

### 10.6 Local API / plugins / diagnostics inside core

Unchanged authority (§24, §20, §27). They already avoid Tauri except via commands; their command bodies become protocol methods with identical names.

### 10.7 Android-guard review checklist (apply to every core PR)

- No `#[cfg(windows)]/#[cfg(unix)]`-free platform assumption added outside `platform.rs`/`system_media.rs`.
- No new `std::env::var` reads outside `platform.rs` (config is injected).
- No blocking IO on the runtime (use `spawn_blocking` — existing convention).
- New host interactions go through protocol events, never callbacks into host code.
- `AudioEngine` trait boundary respected (no direct rodio calls outside `audio.rs`).

---

## 11. Electron Architecture

### 11.1 Main process modules (see tree §9.1)

- **`core/supervisor.ts`** — resolves the core binary (`resources/core/yaqmc-core[.exe]`; dev: `target/debug/`), spawns with `stdio: ['pipe','pipe','pipe']`, performs handshake (§13.3), monitors exit, restarts with backoff `0.5s → 2s → 8s`, max 3 restarts per 60 s window, then enters **core-safe-mode** (UI banner + "restart core" button + diagnostics shortcut). stderr → rolling in-memory ring (64 KiB) + appended to Electron host log; included in diagnostics (§27.3).
- **`core/client.ts`** — one instance; promise map `id → resolver` with per-method timeout (default 30 s; `player_*` control 10 s; long ops like `plugin_install` 120 s); event demux to `EventEmitter`; `seq` gap detection triggers resync (§14.5).
- **`windows/`** — window construction tables (§11.2), geometry persistence via core preferences (same keys as today — §22.6), close-to-tray behavior for main window (parity with `lib.rs:171-206`: hide instead of close when preference enabled + tray active).
- **`ipc/router.ts`** — `ipcMain.handle('yaqmc:invoke', ...)` single channel carrying `{method, params}` + `webContents.send('yaqmc:event', frame)` fan-out, both gated by the per-window ACL (§11.3). Host-implemented methods (window controls, dialogs, opener, updater, surface management) are intercepted here and never reach core; everything else is proxied to `CoreClient`.
- **`services/`** — tray (§26.1), shortcuts (§26.2), dialogs (§27.4), external-links allowlist (§28.6), updater (§32), linux-graphics flag policy (§29.2).
- **`security.ts`** — `session` hardening: CSP response header injection for all app windows, `setPermissionRequestHandler` (deny-all except `media` for none — deny list §28.4), `will-navigate`/`setWindowOpenHandler` guards, OAuth partition rules.

### 11.2 Window construction table

All windows: `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`, `spellcheck: false`, `backgroundThrottling: false` for surfaces + main (position clock smoothness; NEEDS ACCEPTANCE TEST for battery impact).

| Window | URL | Preload | Size/traits (parity source: `tauri.conf.json` + `lyrics_surface/mod.rs`) |
|---|---|---|---|
| `main` | `app://index.html` (prod) / `http://localhost:1420` (dev) | `preload/main.ts` | 1180×760 min 940×640, frameless (`frame:false`), transparent on Windows / opaque on Linux (parity with `tauri.linux.conf.json` — FACT), custom drag region |
| `lyrics-desktop` | `app://index.html?surface=desktop` | `preload/lyrics-surface.ts` | frameless, `transparent:true`, `alwaysOnTop:'screen-saver'`, `skipTaskbar:true`, `resizable:true`, `focusable:false` when locked, click-through via `setIgnoreMouseEvents(true,{forward:true})` |
| `lyrics-island` | `app://index.html?surface=island` | `preload/lyrics-surface.ts` | same class, compact default geometry |
| `lyrics-desktop-unlock` / `lyrics-island-unlock` | `?unlockSurface=desktop|island` | `preload/unlock-overlay.ts` | tiny always-on-top pill matching current unlock overlays |
| `qqmusic-oauth-{attemptId}` | provider URL from `auth_oauth_prepare` | **none** | 480×640, ephemeral `session.fromPartition('oauth:'+attemptId)` (non-persistent = today's incognito), nav-allowlist from prepare result, close → cancel |

`app://` is a `protocol.handle`-registered scheme serving `dist/` with correct MIME + `Content-Security-Policy` header; rationale vs `loadFile`: enables absolute URLs, service-worker-free asset serving, and a single CSP point (§28.3).

### 11.3 Renderer⇆Main ACL (ports today's per-window Tauri capabilities — FACT source: `src-tauri/capabilities/*.json` + `command_guard.rs`)

| Capability group | main | lyrics surfaces | unlock overlays |
|---|---|---|---|
| All core methods | ✅ (minus none) | subset: `player_snapshot`, `player_play/pause/toggle/next/previous`, `lyrics_projection`, `lyrics_document`, `preferences_get` | none (host-only) |
| Account/auth methods (`qqmusic_*` auth+account) | ✅ (main-window-only guard preserved) | ❌ | ❌ |
| Host: window controls (min/max/close/drag) | own window | own window (drag/resize per lock state) | own window |
| Host: surface management (`surface_show/hide/lock/unlock/set_geometry`) | ✅ | lock/unlock self | unlock action only |
| Host: dialogs, openExternal, updater | ✅ | ❌ | ❌ |
| Events | all channels | `lyrics://*`, `player://snapshot`, `preferences://changed` | `lyrics://surface-closed` only |

The ACL is a static table in `ipc/channels.ts`; router enforcement + core-side re-check (§10.3) replaces Tauri capabilities.

### 11.4 Single instance (new, one line, prevents dual-core)

`app.requestSingleInstanceLock()`; second instance → focus/show main window. Without this, two Electron instances would spawn two cores fighting over SQLite/port 19532 — today's Tauri app has the same latent bug (D5); Electron makes the fix trivial, so it is in scope.

### 11.5 Dev mode

`npm run dev:desktop`: (1) Vite dev server on 1420 (unchanged config), (2) `cargo build -p yaqmc-core` then watch via `cargo watch` (optional), (3) esbuild watch for main/preload, (4) `electron .` pointing main window at the dev server. `?provider=fake` browser mode continues to work with zero Electron (fake bridge — §12.4).

### 11.6 Electron version policy

Pin exact major at adoption time and record in `apps/desktop/package.json`; at planning time the current stable is **Electron 43.4.0** (Node 22 embedded; Electron 44 expected ~Aug 2026 — VERIFIED web 2026-08-16; Electron ships a new major ~every 8 weeks and supports the latest 3). Policy: track latest stable major, upgrade in dedicated PRs with the §46 smoke matrix; never ship an EOL major. The executor must re-verify the current stable at execution time and pin it in `PACK-01`.

---

## 12. Frontend Client/Bridge

### 12.1 `HostBridge` — the only host-facing interface

```ts
// packages/yaqmc-client/src/bridge.ts
export interface HostBridge {
  invoke<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>>;
  listen<C extends ChannelName>(channel: C, handler: (payload: ChannelPayload<C>) => void): () => void;
  readonly kind: 'electron' | 'tauri' | 'fake';
  readonly windowRole: 'main' | 'lyrics-desktop' | 'lyrics-island' | 'unlock-desktop' | 'unlock-island';
}
```

`YaqmcClient` wraps a bridge with: typed method groups (`client.player.*`, `client.catalog.*`, `client.account.*`, `client.plugins.*`, `client.host.*`), event subscription with automatic replay-on-reconnect (§14.5), and the existing seek-coalescing command adapter semantics (moved from `player-command-adapter.ts`, behavior-identical).

### 12.2 Bridge implementations

- **`bridges/electron.ts`** — thin binding to `window.yaqmc` (§12.3).
- **`TauriHostBridge`** (temporary, lives in `src/application/tauri-host-bridge.ts`, NOT in the package) — maps `invoke`→`@tauri-apps/api/core.invoke`, `listen`→`event.listen`, host methods → current Tauri equivalents (`getCurrentWindow().minimize()` etc.). This is what lets P6 land the whole frontend refactor while the app still runs on Tauri. Deleted in P13.
- **`bridges/fake.ts`** — wraps the existing `fake-music-provider.ts` + local no-op player into bridge shape; keeps `?provider=fake` browser dev working (FACT: this mode exists today and must not regress).

### 12.3 `window.yaqmc` (preload contract)

```ts
// exposed via contextBridge.exposeInMainWorld('yaqmc', ...)
interface YaqmcGlobal {
  invoke(method: string, params?: unknown): Promise<unknown>;   // routed+ACL'd in Main
  on(channel: string, cb: (payload: unknown) => void): () => void;
  windowRole: string;
  hostInfo: { electron: string; platform: 'win32'|'linux'; coreProtocol: number };
}
```

Type safety lives in `@yaqmc/client`, not in the preload (keeps preload tiny and audit-friendly; the ACL is enforced in Main regardless of renderer types — §28.2).

### 12.4 Frontend refactor scope (from the 22-file coupling audit — FACT)

| File(s) | Change |
|---|---|
| `native-player-runtime.ts` | replace `invoke/listen` with `client.player.*` / `client.on('player://snapshot')`; delete `isNativeRuntime` Tauri sniffing → `bridge.kind !== 'fake'` |
| `qq-music-provider.ts`, `account-store.ts`, `preferences-store.ts`, `lyrics-store` fetch paths, `plugin-runtime.ts` bridge calls, `local-api settings`, `diagnostics settings`, remaining bridge-only files (17 total) | mechanical `invoke(`→`client.invoke(` swap (names unchanged — ADR-004 pays off here) |
| `TopBar.tsx` | window buttons → `client.host.window.minimize()/toggleMaximize()/close()`; drag region: keep `data-tauri-drag-region` attr AND add `.yaqmc-drag` class mapped to `-webkit-app-region: drag` (both hosts work during co-existence; attr removed in P13) |
| `lyrics-presentation.ts` | fullscreen → `client.host.window.setFullscreen(bool)` |
| `external-links.ts`, `issue-reporter.ts` | `openUrl` → `client.host.shell.openExternal(url)` |
| `surfaces/LyricsSurfaceApp.tsx`, `LyricsIslandSurface.tsx` | direct invokes → client subset; drag: same dual-mechanism as TopBar |
| `main.tsx` | unchanged (query-param routing preserved; Electron loads the same URLs — §11.2) |
| Zustand stores | **no semantic changes**: snapshot merge, revision guards, interpolation, discontinuity threshold all stay |

ESLint guard (P6): `no-restricted-imports` for `@tauri-apps/*` everywhere except `tauri-host-bridge.ts`.

---

## 13. Core IPC / Protocol

### 13.1 Framing (transport layer)

```
frame := u32_le(length) ++ payload            // length = payload bytes, max 32 MiB
payload := JSON (UTF-8), one message per frame
```

Max frame 32 MiB (matches plugin package cap; diagnostics bundles stream through chunked methods instead — §27.3). Oversize → protocol error + connection considered poisoned → supervisor restart (§14.4).

### 13.2 Envelope (all messages)

```ts
type CoreMessage =
  | { kind: 'hello';  protocol: 1; core: { version: string; commit: string; channel: string } }   // core → host, first frame
  | { kind: 'attach'; protocol: 1; host: { app: string; version: string }, platform: { mainWindowHandle?: string /* hex HWND */, platformKind: 'windows'|'linux', displayBackend?: 'x11'|'wayland' } } // host → core
  | { kind: 'ready' }                                                                              // core → host, after attach applied
  | { kind: 'request';  id: number; method: string; params?: unknown }                             // host → core
  | { kind: 'response'; id: number; ok: true;  result: unknown }
  | { kind: 'response'; id: number; ok: false; error: CoreError }
  | { kind: 'event'; seq: number; channel: string; payload: unknown }                              // core → host
  | { kind: 'shutdown'; reason: 'quit'|'restart' }                                                 // host → core
  | { kind: 'shutdown-ack' };                                                                      // core → host (then exit 0)

type CoreError = { code: string; message: string; details?: unknown; retryable: boolean };
```

Rust mirror lives in `yaqmc-protocol/src/envelope.rs` with `#[serde(tag = "kind", rename_all = "camelCase")]`.

### 13.3 Handshake & version negotiation

1. Core writes `hello` immediately on start. Host validates `protocol === 1` and `core.version === app.getVersion()` (single release unit — mismatch means broken packaging → fatal dialog with diagnostics hint, no degraded mode).
2. Host sends `attach` (window handle may arrive later via `platform_attach` method if the window isn't created yet — both paths supported).
3. Core applies platform info (SMTC attach, display-backend capability flags) and sends `ready`.
4. Host marks client connected, performs initial state pull: `player_snapshot`, `lyrics_projection`, `lyrics_document`, `preferences_get`, `plugin_list` — same calls the frontend already issues on boot (FACT: bootstrap sequence in `App.tsx`/stores), so renderers stay unchanged.

Timeout: 10 s from spawn to `ready` → kill + retry per supervisor policy.

### 13.4 Methods (v1 = today's command inventory, verbatim)

All 117 registered commands become methods with identical names and identical serde payload shapes (verified counts: 117 in `generate_handler!`; 112 referenced by frontend source strings; 5 never referenced by the frontend — `system_integration_status`, `player_play`, `player_pause`, `lyrics_surface_status`, `plugin_diagnostics` — these are invoked by host-side callers such as the tray/local API or are candidates for retirement, dispositioned in PROTO-02). Window/surface/dialog-shaped methods are intercepted and implemented by Electron Main (§11.1 router interception) under the same names, so the renderer cannot tell the difference. The authoritative per-command inventory (name → owner after migration → notes) is produced mechanically in PROTO-02 and summarized in §37.9.

Two **new** core methods: `platform_attach` (late window-handle delivery / re-attach after window recreation) and `core_shutdown_prepare` (used by host before `shutdown` frame when it wants a checkpoint without exiting). One new host-only method group: `host_updater_*` (§32).

### 13.5 Method registry & dispatch (replaces `build.rs` command manifest)

`yaqmc-protocol/src/registry.rs` declares a const table: `MethodSpec { name, owner: Core|Host, main_window_only: bool, timeout_class }` for every method. `yaqmc-core/src/server/methods.rs` implements `dispatch(method, params, ctx)` with a match arm per core-owned method calling the existing service functions (the bodies of today's `commands.rs` minus Tauri types). A unit test asserts the registry covers exactly the set of dispatch arms (no drift); the TS mirror is contract-tested (§34.3).

### 13.6 Why JSON and not Protobuf/MessagePack (ADR-003 detail)

(1) Every DTO already has a stable serde camelCase JSON shape consumed by the frontend today — the wire format **already exists**; adopting it verbatim turns migration risk into a no-op. (2) Bandwidth is trivial: highest-rate message is `player.position` at 4 Hz × ~200 bytes. (3) Schema evolution via `#[serde(default)]`/optional fields matches the codebase's existing pattern. (4) Protobuf would require duplicating ~100 DTOs into .proto + codegen for two languages — large scope, new toolchain, zero measured benefit. If a future hot path needs binary framing (e.g. audio waveforms), add a new frame kind alongside JSON rather than migrating everything.

### 13.7 Error mapping

Today commands return `Result<T, String>` with human-readable errors that the frontend displays/matches (FACT; e.g. entitlement errors). To preserve behavior byte-for-byte: `CoreError.code = 'core.command_error'`, `message = <exact same string>`, plus structured `details` where the service already has typed errors internally. New infra errors: `core.unavailable` (supervisor down), `core.timeout`, `core.protocol` (framing), `host.denied` (ACL). Frontend `client` surfaces `message` exactly as `invoke` rejection strings do today, so existing catch paths keep working.

### 13.8 Event cadence & backpressure

Unchanged cadences (§3.2). stdio is reliable+ordered; if Main's consumer lags, frames buffer in the pipe; core's writer task applies the same pattern as today's Tauri emit loop (bounded internal broadcast, lagged → resync). Main-side: `seq` gap or reconnect → resync pull (§14.5), mirroring the in-core lagged handler. No frame-level ack/flow-control is added (measured rates don't justify it; the resync path covers pathological stalls).

---

## 14. Lifecycle / Process Supervision

### 14.1 Startup sequence (cold boot)

```
electron main: single-instance lock → app.whenReady
  → linux-graphics policy applied BEFORE ready (flags must precede — §29.2)
  → CoreSupervisor.spawn() ── hello/attach/ready (≤10 s)
  → create main window (hidden) → load renderer → renderer 'ready-to-show' → show
  → tray init, shortcuts init, updater init (deferred 30 s)
  → restore lyric surfaces if preference says visible (parity: lib.rs restore behavior)
```

Renderer boot does not wait for core: the client SDK queues invokes until `ready` (with 15 s cap → surfaced as `core.unavailable` banner state; parity note: today a slow backend blocks `invoke` the same way).

### 14.2 Crash / restart matrix

| Failure | Detection | Response |
|---|---|---|
| Core exits unexpectedly | child `exit` event / stdout EOF | UI event `host://core-status {down}` → non-blocking banner "Playback engine restarting…"; supervisor backoff restart; on `ready`: resync (§14.5), banner clears. Audio stops (engine lived in core) — acceptable, playback position restores from last snapshot, **paused** (never auto-resume audibly after crash) |
| Core hangs (no response) | per-request timeouts + 3 missed 5 s `core_ping`s (new lightweight method) | supervisor kills (SIGKILL/TerminateProcess) → restart path as above |
| Repeated crash (>3/60 s) | supervisor counter | core-safe-mode screen: offer restart, open logs, export diagnostics (host-side collector §27.3 still works without core), disable plugins hint (plugin safe-mode journal already covers plugin-caused crashes on next boot — FACT) |
| Renderer crash | `render-process-gone` | log + recreate window (main) / recreate surface (surfaces); core unaffected — playback continues (an improvement over Tauri single-process risk profile) |
| Main process crash | OS | app dies; core detects stdin EOF → runs §14.3 shutdown autonomously (queue+state saved) — this is why core watches stdin EOF |
| GPU process crash | Chromium auto-restarts | log only |

### 14.3 Graceful shutdown (quit path)

```
before-quit: prevent default → tray teardown, shortcuts unregister
  → CoreClient.send({kind:'shutdown', reason:'quit'})
  → core: stop position clock → persist queue snapshot + playback state
         → plugin host: mark clean exit (safe-mode journal)
         → local API: stop listener
         → storage: WAL checkpoint + close
         → keyring flush (no-op; writes are synchronous already)
         → send shutdown-ack → exit(0)
  → host waits ≤5 s for ack+exit; on timeout: SIGKILL + log 'unclean core shutdown'
  → app.exit(0)
```

Parity source: today's close-to-tray/quit handling in `lib.rs` + `Drop` impls. The explicit ack turns implicit Drop-ordering into a tested sequence (§34.6 has a shutdown test).

### 14.4 Poisoned connection

Any framing error (bad length, non-JSON, unknown `kind`) on either side is unrecoverable by definition (state unknown): host kills+restarts core; core exits(2) on malformed host frames. Restart counter shared with crash matrix.

### 14.5 Resync contract (used by reconnect, seq-gap, renderer reload)

Pull `player_snapshot` + `lyrics_projection` + `lyrics_document` + `preferences_get` + `plugin_list`, re-emit locally to stores; stores already reconcile via `session_id`/`snapshot_revision` guards (FACT: `player-store.ts` merge logic), so redundant snapshots are harmless. This is the same resync the core's lagged-consumer handler performs today — one mental model everywhere.

---

## 15. Player Migration

### 15.1 Non-negotiable invariant

**The player state model does not change.** The migration replaces only (a) how commands reach `PlayerService` and (b) how events leave it. The consistency machinery is the crown jewel of this codebase and was recently hardened (`9bd4e61 fix(player): make rapid seek session-safe` — FACT).

### 15.2 The real state model (authoritative reference for the executor — FACT, `player.rs` + `playback_session.rs`)

| Mechanism | Real identifier(s) | Purpose |
|---|---|---|
| Playback session fencing | `session_id: u64` on `PlayerCore`, bumped on every track load/source change; carried in `PlayerSnapshot.session_id` and `SeekIntent.session_id` | Any async result (seek completion, position report, prepared source) tagged with an old `session_id` is dropped |
| Snapshot ordering | `snapshot_revision: u64`, monotonically bumped on every state mutation; in every snapshot | Frontend/store rejects snapshots with `revision <= last_seen` (out-of-order delivery safe) |
| Seek ordering | `SeekMailbox { intent: Mutex<Option<SeekIntent>>, revision: AtomicU64 }` (`playback_session.rs:15-25`); `SeekIntent { session_id, revision, position_ms }`; `last_seek_revision` in snapshots | **Latest-wins**: rapid seeks overwrite the mailbox slot; the audio worker drains only the newest intent; completions for stale revisions are fenced |
| Source generation | `source_generation: u64` | distinguishes re-resolves of the same track (quality change, cache promotion) |
| Load generation | `load_generation: AtomicU64` on `PlayerService` (**not in prompt — D1**) | fences overlapping async track-load pipelines |
| Audio-side coalescing | audio worker seek mailbox (in `audio.rs`) | rodio sink rebuild is expensive; worker coalesces bursts |
| Frontend coalescing | `player-command-adapter.ts` mailbox | UI slider drags don't flood IPC |
| Position interpolation | `player-store.ts:892-899`, 250 ms discontinuity threshold | smooth UI between 4 Hz updates |

Migration rule: these names/semantics may not be "simplified", renamed, or merged during any phase. A dedicated regression suite guards them (§34.7).

### 15.3 What actually changes

| Site | Change |
|---|---|
| `tauri::async_runtime::spawn` ×4 in `player.rs` | → `tokio::spawn` (P1). Semantics identical: same runtime kind, same task shape |
| Command entry (`commands.rs` player group) | bodies move to `server/methods.rs` dispatch arms (P2); the service functions they call are untouched |
| Event exit (`lib.rs` fan-out) | becomes `server/events.rs` (P2), emitting frames; channel mapping table preserved verbatim (§3.2) |
| Queue persistence trigger (inside fan-out task) | moves with the fan-out task, unchanged |
| SMTC feed (inside fan-out task) | unchanged call, HWND source changes (ADR-009) |

`audio.rs`, `media.rs`, `streaming.rs`, `qmc.rs`, `playback_session.rs`: **zero changes** in the host migration (FACT: they are Tauri-free).

### 15.4 End-to-end command path (after migration)

```
UI slider → player-store optimistic update → client.player.seek (coalesced)
  → window.yaqmc.invoke('player_seek', {positionMs})
  → Main IpcRouter (ACL ok) → CoreClient request frame
  → core dispatch → PlayerService::seek → SeekMailbox latest-wins → audio worker
  → PlayerEvent::Seeked {session_id, seek_revision} → server/events.rs
  → event frame `api://event` + `player://snapshot` + `lyrics://projection`
  → Main fan-out (ACL) → renderer(s) → store merge (revision guards) → UI settles
```

Hop count grows by one (renderer→main). Measured budget: Electron IPC round-trip is sub-millisecond for small payloads; total added latency target < 5 ms p95, verified in §35.3. The optimistic-update + interpolation design means user-perceived latency is unchanged anyway.

### 15.5 Cadence decision

Keep 50 ms clock / 250 ms position emissions / 20 ms audio poll (FACT values). Do **not** "optimize" to event-driven-only during migration. Rationale: SSE clients (§24) and lyric surfaces depend on the cadence; changing two variables at once (host + cadence) destroys bisectability.

### 15.6 Player acceptance gates (phase exits P2, P7, P12, P13 — details §34.7)

1. Rapid-seek storm: 50 seeks in 2 s during playback → position settles at last requested ±250 ms; no stale snapshot regression (`snapshot_revision` strictly monotonic; no position jump backward after settle).
2. Seek-across-track-change race: seek issued, then `player_next` before completion → old session's seek completion is fenced (snapshot never shows old track with new position).
3. Queue mutation storm: interleaved move/remove/jump ×100 → final queue state equals a serially-computed expectation; every `entry_id` unique.
4. Kill-core-during-playback → restart → queue restored, position restored (paused), no duplicate queue entries.
5. 4-hour soak: no snapshot-revision stall, RSS drift < 10 %, no audio thread death (§35).

---

## 16. Provider Architecture

### 16.1 `MusicProvider` trait (new, `crates/yaqmc-provider-api`)

The frontend already has this interface in TS (FACT: `music-provider.ts` with QQ + fake impls). The migration mirrors it in Rust so the *core* stops knowing "QQ" at the type level. Sketch (final signatures derived from today's `QQMusicService` public API during P14-A):

```rust
#[async_trait]
pub trait MusicProvider: Send + Sync {
    fn id(&self) -> &'static str;                       // "qqmusic"
    // catalog
    async fn search_songs(&self, q: &str, page: Page) -> Result<SearchPage<Track>, ProviderError>;
    async fn search_albums(&self, q: &str, page: Page) -> Result<SearchPage<Album>, ProviderError>;
    async fn album(&self, r: &AlbumRef) -> Result<AlbumDetail, ProviderError>;
    async fn playlist(&self, r: &PlaylistRef, page: Page) -> Result<PlaylistDetail, ProviderError>;
    async fn home_feed(&self) -> Result<HomeFeed, ProviderError>;
    async fn discover(&self, section: DiscoverSection, page: Page) -> Result<DiscoverPage, ProviderError>;
    // playback
    async fn resolve_source(&self, t: &TrackRef, quality: QualityPref) -> Result<ResolvedSource, ProviderError>;
    async fn lyrics(&self, t: &TrackRef) -> Result<LyricsDocumentRaw, ProviderError>;
    // account (session-scoped)
    fn account(&self) -> Option<Arc<dyn ProviderAccount>>;   // favorites, playlists, entitlement, auth
    // artwork
    async fn artwork(&self, r: &ArtworkRef, size: ArtworkSize) -> Result<ArtworkSource, ProviderError>;
}
```

`TrackRef`/`AlbumRef`/`PlaylistRef` are **opaque provider-scoped reference structs** that serialize to the exact same JSON the frontend already uses (`ProviderTrackReference { mid, numericId, albumId, mediaId }` etc. — TD-3 wire freeze). The trait makes them opaque to the *core*; the wire format is unchanged.

### 16.2 Registry & wiring

`ProviderRegistry` holds `HashMap<&'static str, Arc<dyn MusicProvider>>`; v1 registers exactly one provider (`qqmusic`) plus the existing local-file handling which stays in `media.rs` (not a provider — parity). `PlayerService`'s `PlaybackSourceResolver` binding changes from `Arc<QQMusicService>` to `Arc<dyn MusicProvider>`-backed resolver in P14-A.

### 16.3 Strangler order inside the provider migration (P14)

- **P14-A (boundary)**: introduce trait + registry; implement `MusicProvider` for the existing in-tree `QQMusicService` (pure adapter, zero behavior change); move `qqmusic/` + `qmc.rs` into `crates/yaqmc-provider-qqmusic` via `git mv`. Gate: full parity suite green — this step must be a provable no-op.
- **P14-B (qm-api-rs backend)**: add `qqmusic-api` dependency and swap *internals* module-by-module (§17.4), behind a build-time feature `provider-qq-backend = "intree" | "qmapi"` allowing A/B binaries during verification. LIVE VERIFY gates each module swap.
- **P14-C (retire duplicates)**: delete in-tree modules fully replaced; drop `lyrics-crypto` dependency if qm-api-rs's QRC path proves equivalent (byte-identical decrypt outputs on the golden corpus — §17.4 row L).

### 16.4 OAuth ownership split (removes the last window code from provider land)

- Core/provider: `auth_oauth_prepare(providerKind)` → `{ attemptId, url, navigationAllowlist: [glob], callbackMatcher: {urlPrefix} }`; `auth_oauth_complete(attemptId, callbackUrl)` → session established (server-side exchange — same code that today runs after the Tauri window captures the callback); `auth_oauth_cancel(attemptId)`.
- Electron Main `oauth-window.ts`: ephemeral partition, no preload, `will-navigate`+`will-redirect` watching for `callbackMatcher`, allowlist enforcement, capture → `auth_oauth_complete`, close. Window closed by user → `auth_oauth_cancel` (parity with today's `on_window_event` cancel — FACT `lib.rs`).

### 16.5 Account state distribution

Unchanged poll model (TD-6). The `ProviderAccount` trait exposes the same operations today's commands call (`favorites_*`, `playlists_*`, `entitlement_snapshot`, `session_state`, mutation queue with `client_operation_id` reconciliation — semantics frozen).

---

## 17. qm-api-rs Integration

### 17.1 Verified library facts (audited @ `a7430a8`, 2026-08-16)

| Item | Finding |
|---|---|
| Repo / crate | `github.com/YAQMC/qm-api-rs` (**private** — D2); crate `qqmusic-api`, lib `qqmusic_api`, v0.1.0, **GPL-3.0-or-later**, edition 2021, `rust-version 1.85` |
| Runtime deps | tokio, reqwest (rustls), serde, thiserror, tracing — same stack as YAQMC core (no version conflicts expected; workspace dedup check in PROV-02) |
| Architecture | `Client` (cloneable handle) + `ClientContext` (device/QIMEI/credential state) + module facades: `song`, `album`, `songlist`, `search`, `top`, `lyric`, `mv`, `user`, `login`, `qmc`, `radio`, `singer` |
| Auth | QR login (QQ + WeChat) via `login::qrcode_*` + `QRCodeLoginSession` poll loop; phone login; **no graph.qq.com OAuth-popup flow** (YAQMC's OAuth window flow has no library equivalent — stays in-tree, §17.4 row F) |
| Credentials | `Credential { musicid, musickey, refresh_key, ... }` structured type + `CredentialPersist` trait for host-provided storage + auto-refresh support |
| Signing | SHA1-based `zzc_sign` for `musics.fcg` (in-tree uses MD5 `zzb` — D8); request encryption + device fingerprint (QIMEI) handled internally |
| Media | `song::get_song_urls(mids, filetype)` → vkey URLs; `MediaSource` abstraction — host decides how to consume (explicitly designed for YAQMC — doc quote: "YAQMC 等宿主自行决定如何消费 MediaSource") |
| QMC | `qmc` module: v1/v2, RC4/Map, EKey TEA unwrap — functional overlap with in-tree `qmc.rs` is total |
| Lyrics | `lyric::get_lyric` with automatic QRC decrypt (overlaps in-tree `lyrics-crypto` usage) |
| Rate limiting | built-in per-endpoint rate limiter |
| Quality flags | tests exist; hires/entitlement behavior LIVE VERIFY |

### 17.2 Dependency mechanics

`crates/yaqmc-provider-qqmusic/Cargo.toml`:

```toml
qqmusic-api = { git = "https://github.com/YAQMC/qm-api-rs.git", rev = "a7430a831a256bb15212291f11a055d801e31648" }
```

Pinned by rev (never branch). CI needs read access to the private repo: use a fine-grained PAT or deploy key exposed as `QM_API_RS_TOKEN` secret + `git config url insteadOf` rewrite in workflows (task PROV-01). Local devs need their own git credentials (documented in CONTRIBUTING update, CLEAN-04). If the repo is made public before P14, this reduces to nothing.

### 17.3 Session migration (in-tree → qm-api-rs credential model)

In-tree persists a `SessionRecord` centered on a raw cookie header (keyring `qqmusic-session` — FACT `auth.rs`). qm-api-rs wants structured `Credential` fields. P14-B ships a one-time converter: parse the stored cookie header (`uin`/`qqmusic_key`/`musickey` cookie fields — LIVE VERIFY exact names against both codebases at execution), build `Credential`, validate via a cheap authenticated call, then persist **both** formats during the A/B window (new key `qqmusic-credential-v2`), retiring the old key only in P14-C. Failed conversion → user re-login prompt (acceptable, documented in release notes; sessions expire anyway).

### 17.4 Module-by-module mapping (Duplicate / Keep / Move / Replace)

| # | In-tree module (in `yaqmc-provider-qqmusic` after P14-A) | qm-api-rs counterpart | Disposition |
|---|---|---|---|
| A | `transport.rs` (dual-endpoint, retry, redaction) | `Client` + context | **Replace** in P14-B; keep in-tree redaction wrapper around the library's HTTP layer if the library logs URLs (audit in PROV-03) |
| B | request signing (`zzb` MD5) | `zzc_sign` (SHA1) | **Replace**; LIVE VERIFY both accepted; keep in-tree code until soak passes |
| C | QR login (`auth.rs` QR flow) | `login::qrcode_*` + poll session | **Replace** |
| D | session refresh (`auth.rs`) | `Credential` refresh + `CredentialPersist` | **Replace**; persist trait implemented over YAQMC keyring |
| E | staging slot (`qqmusic-session-staging`) | none | **Keep** in-tree (YAQMC-specific safety feature) layered over `CredentialPersist` |
| F | OAuth popup flow (`oauth.rs` logic half) | none | **Keep** in-tree (§16.4) |
| G | `account.rs` favorites/playlists + mutation reconciliation | `songlist`/`user` modules (raw ops) | **Hybrid**: raw calls → library; reconciliation queue + `client_operation_id` stays in-tree (library has no equivalent) |
| H | `entitlement.rs` | `user::get_vip_info` (partial) | **Hybrid**: quality-rights derivation stays in-tree; identity/VIP fetch → library |
| I | vkey/EKey resolution (`qqmusic.rs`) | `song::get_song_urls` + `MediaSource` | **Replace**; adapter to existing `ResolvedSource` shape |
| J | `qmc.rs` decrypt | `qmc` module | **Replace**; golden corpus: decrypt N local QMC fixtures with both, byte-compare (PROV-07) |
| K | discover/home/category (`encArea` etc.) | `top`/`songlist`/partial | **Hybrid/Keep**: audit coverage per endpoint (PROV-04); anything missing stays in-tree |
| L | lyrics fetch+QRC decrypt | `lyric::get_lyric` | **Replace** if byte-identical on corpus; else Keep |
| M | caching (`provider_cache` SQLite table, artwork cache) | none | **Keep** (YAQMC-side, wraps any backend) |
| N | DTO mapping to wire types | n/a | **Keep** — the wire freeze (§16.1) means mapping code is the adapter's job forever |

### 17.5 Verification protocol for every Replace row (LIVE VERIFY discipline)

1. Golden request/response fixtures recorded from in-tree path (redacted).
2. Same operation through qm-api-rs backend; assert semantic equality (not byte equality for server data — fields the UI consumes must match).
3. A/B binary (`--features provider-qq-backend=qmapi`) soaked by maintainer with a real account ≥ 3 days incl. VIP-gated quality, favorites mutations, QR + OAuth login, lyric fetch.
4. Rollback = build with `intree` feature (kept until P14-C).

### 17.6 Licensing gate (blocking decision recorded)

qm-api-rs is GPL-3.0-or-later; linking it makes distributed YAQMC binaries GPL-covered. YAQMC currently has **no LICENSE file** (FACT). Both repos share the `YAQMC` org (same owner), so relicensing either side is available to the maintainer. **P14 entry gate: maintainer commits a LICENSE decision** (accept GPL-3.0-or-later for the app, or relicense qm-api-rs). This is the only human decision the plan cannot make; it does not block P0–P13.

---

## 18. Storage / Data Migration

### 18.1 Path parity (ADR-007) — the whole strategy

Tauri resolves directories from identifier `org.yaqmc.desktop` (FACT: `tauri.conf.json`). The core replicates them with the `dirs` crate; Electron's own `userData` is **not** used for core data at all (Electron keeps only Chromium profile data there).

| Purpose | Windows (today = target) | Linux (today = target) |
|---|---|---|
| App data (SQLite, plugins, queue) | `%APPDATA%\org.yaqmc.desktop` | `~/.local/share/org.yaqmc.desktop` |
| Cache (media/artwork cache) | `%LOCALAPPDATA%\org.yaqmc.desktop` | `~/.cache/org.yaqmc.desktop` |
| Logs | `%LOCALAPPDATA%\org.yaqmc.desktop\logs` | `~/.local/share/org.yaqmc.desktop/logs` |
| Config (preferences live in SQLite; no separate config dir used) | — | — |

**BASE-04 (P0) captures ground truth**: run the current Tauri build, export a diagnostics snapshot (it contains resolved paths — FACT `diagnostics.rs`), and commit the recorded table into `docs/migration/data-paths.md`. P4's first-boot integration test asserts the core resolves byte-identical paths. This converts an assumption into a tested fact before anything ships.

### 18.2 SQLite schema (frozen — FACT `storage.rs`)

`library.sqlite3`, WAL mode, `user_version = 5`. Tables: `tracks`, `albums`, `playlists`, `playlist_tracks`, `app_settings` (key/value JSON: `queue_snapshot`, `ui-preferences-v1`, lyric presets, surface geometry), `provider_cache` (TTL'd JSON blobs). **No schema change in the host migration.** The migration runner and version checks move unchanged. P14 may add `provider_cache` namespacing only if qm-api-rs response shapes collide (decided in PROV-04, default: no change).

### 18.3 First-boot-after-upgrade verification (defense in depth)

On every core boot: open DB → check `user_version == 5` → run `PRAGMA quick_check` (log-only on failure, never destructive) → write `app_settings['host-migration-marker'] = {host:'electron', coreVersion, firstSeen}` on first Electron boot. Diagnostics include the marker. If DB open fails: same behavior as today (error surface + diagnostics path hint) — no new auto-repair logic (parity; avoid destructive cleverness).

### 18.4 Fallback copy-migration (expected dead code, specified for completeness)

Only if execution-time testing discovers a platform where Tauri's dir differs from the `dirs`-crate result (e.g. flatpak-style overrides): core accepts `--data-dir-override`; Electron Main detects legacy dir presence (probe list from BASE-04 doc) and passes the override. **No copying, ever** — pointing at the old dir is strictly safer than duplicating a SQLite DB with WAL sidecars.

### 18.5 What Electron stores where (kept out of core data)

Chromium profile (`app.getPath('userData')` = `%APPDATA%/YAQMC` | `~/.config/YAQMC`): GPU cache, localStorage of renderers (frontend already treats localStorage as disposable UI cache — FACT), service-worker-free. Documented in §27 diagnostics so support can find both trees. Uninstall docs updated (CLEAN-04).

---

## 19. Credential Security

### 19.1 Today (FACT `credentials.rs`)

`keyring` crate, service `org.yaqmc.desktop`, entries: `qqmusic-session`, `qqmusic-session-staging`, `local-api-token`; one legacy read-migration from old service name `yaqmc`. Windows Credential Manager / libsecret (Secret Service) on Linux.

### 19.2 Decision: keep `keyring` in core; do NOT adopt Electron `safeStorage`

- Zero migration: same service/entries keep working (users stay logged in through the host swap — a headline UX win).
- `safeStorage` on Linux depends on the same Secret Service anyway (or falls back to weaker basic-text), and it would move secrets into Electron-land, violating the core-owns-credentials boundary (§7.2) and the Android constraint (no Electron on Android).
- P14-B adds `qqmusic-credential-v2` entry (structured — §17.3) under the same service.

### 19.3 Hygiene rules carried forward

Existing `zeroize` usage on secrets, transport-log redaction, diagnostics scrubbing (FACT) all live in core and move untouched. New rule: credentials never traverse the core protocol except inside the two auth-flow methods that already need them, and never reach any renderer (`window.yaqmc` has no credential method; ACL table §11.3 has no such channel). Local API token: only the rotate command returns it (parity with today's settings screen behavior — FACT `local_api.rs` token reveal flow).

---

## 20. Plugin Migration

### 20.1 Architecture is preserved (D3)

Plugin JS keeps executing in **blob-URL Workers inside the main renderer**. Rust `ExtensionHost` keeps owning packages, manifests, permissions, storage, network proxy, safe-mode journal. The 20 `plugin_*`/bridge commands become protocol methods (names unchanged). `plugin-runtime.ts` swaps `invoke` for `client.invoke` (P6) — that is the entire frontend change.

### 20.2 Electron-specific hardening (new, cheap, in scope)

- Main renderer CSP already allows `worker-src 'self' blob:` (parity port of today's CSP — FACT `tauri.conf.json`); no loosening beyond it.
- The token-gated bridge (`plugin_bridge_call(token, ...)`) is unchanged — Workers never see `window.yaqmc` (Workers have no DOM/window access by construction; verified by an added runtime test PLUG-03).
- Plugin network proxy stays in core (HTTPS-only, DNS/private-IP blocking, size caps — FACT `plugin/network.rs`); Electron's `session` proxy settings are irrelevant to it (requests originate in Rust reqwest).

### 20.3 Parity acceptance (PLUG tasks)

Install/enable/disable/uninstall of the two example plugins (`examples/plugins/*` rebuilt via `npm run plugin:pack`), permission prompt flows, storage quota enforcement, scene-provider registration (API v2), safe-mode after induced Worker crash loop, network proxy allow/deny cases — all green on Electron before P8 exits. The existing Rust plugin tests plus frontend runtime tests run unchanged.

### 20.4 Explicit non-goals (recorded so nobody "improves" mid-migration)

No utility-process/worker relocation, no plugin API v3, no permission UI redesign, no plugin store. Safe-mode + journal semantics frozen.

---

## 21. Lyrics / Scene / Composer

Pure frontend + core-data features (FACT: lyric parsing/offset in core; presentation/presets/composer in renderer + app_settings): no host coupling beyond the fullscreen call in `lyrics-presentation.ts` (→ `client.host.window.setFullscreen`, §12.4). Scene extension API v2 rides on the plugin bridge (§20). Presets/preview stores unchanged. Word/line karaoke timing derives from `lyrics://projection` events whose cadence is preserved (§15.5), so animation smoothness is untouched. Acceptance: preset CRUD, composer round-trip, scene plugin demo, offset persistence — same manual script as today's release checklist plus store unit tests (already exist — FACT).

---

## 22. Desktop Lyrics

### 22.1 Current mechanics (FACT `lyrics_surface/mod.rs` + frontend)

Separate always-on-top transparent window loading `index.html?surface=desktop`; lock state toggles click-through + focusable; a tiny unlock overlay window appears when locked; geometry persisted (350 ms debounce) to app_settings; fullscreen-app auto-hide is Windows-only (800 ms poll — `lyrics_surface/windows.rs`; Linux stub returns NotSupported — TD-5); surface visibility restored on boot; `lyrics://surface-closed` notifies the main window.

### 22.2 Electron mapping

| Concern | Electron implementation |
|---|---|
| Window creation | `windows/lyrics-surfaces.ts` construction table (§11.2) |
| Always-on-top | `win.setAlwaysOnTop(true, 'screen-saver')` (matches Tauri's above-everything intent) |
| Click-through when locked | `win.setIgnoreMouseEvents(true, { forward: true })`; unlocked: `(false)` |
| Focusable toggle | `win.setFocusable(bool)` |
| Drag when unlocked | CSS `-webkit-app-region: drag` on the surface root (dual-mechanism §12.4) |
| Resize when unlocked | `resizable: true` + standard edges; lock sets `resizable(false)` |
| Geometry persistence | `move`/`resize` events → 350 ms debounce → `preferences_set` with **the same app_settings keys** (restore path then works for both hosts during co-existence — key names recorded in BASE-04 doc) |
| Fullscreen auto-hide (Windows) | The existing Rust poller stays in core (it is pure Win32 — FACT); core emits `host://command {surfaceAutoHide: bool}` → Main hides/shows surfaces. Same 800 ms cadence |
| Unlock overlays | Two micro-windows as today; unlock button → host method → lock state change → `lyrics://surface-closed`-family events preserved |
| Multi-display | `screen` API clamping on restore: if saved geometry is off all displays, center on primary (parity: Tauri had implicit clamping; NEEDS ACCEPTANCE TEST on multi-monitor Windows) |

### 22.3 Transparency

Windows: `transparent: true` frameless windows — supported; known Electron caveats (no Mica/aero snap on transparent windows) match current Tauri behavior. Linux X11/XWayland: transparency requires a compositor; today's Tauri Linux build already runs surfaces on WebKitGTK with the main window forced opaque (FACT) — surfaces keep transparency where the compositor allows; fallback solid background style exists in the surface CSS already (FACT: island has opaque style variant).

### 22.4 Wayland reality (VERIFIED web 2026-08-16)

Native-Wayland Chromium cannot set always-on-top (protocol gap — `zwlr_layer_shell` is not exposed through Chromium/Electron), and native-Wayland `setIgnoreMouseEvents` support is only now arriving (landed in Electron 44 nightlies as of May 2026) with compositor-dependent behavior (GNOME Mutter pointer-focus quirks). **Consequence:** ADR-008 defaults Linux to X11/XWayland backend, where all of §22.2 works as on any X11 WM. In optional native-Wayland mode, surfaces degrade: not-always-on-top, no click-through guarantee → the settings UI shows a capability banner (capability flags come from `platform_attach`'s `displayBackend` + a Main-computed `SurfaceCapabilities` object — new but small, §29.3). This replaces today's undocumented degradation (Tauri surfaces on Wayland have the same protocol limits — parity is not lost; it becomes *visible*).

### 22.5 Acceptance (SURF tasks)

Lock/unlock round-trip incl. click-through (verify clicks pass to app beneath), geometry persistence across restart, boot-time restore, fullscreen auto-hide (Windows, against a fullscreen game/video), `?surface=` routing, dual-monitor restore clamp, island/desktop independence.

### 22.6 Geometry keys

Frozen as today's app_settings keys (exact names captured in BASE-04 from `app_preferences.rs`/`lyrics_surface`): the plan intentionally does not rename them so a user can roll back to the Tauri build and keep positions (§45 rollback promise).

---

## 23. Lyrics Island

Same window machinery as §22 (shared `lyrics-surfaces.ts` code path — the Rust manager already treats island as a second instance of the same surface type with its own geometry/unlock overlay — FACT). Island-specific bits preserved: compact default size, pill styling, hover-expand behavior (pure CSS/React), independent visibility preference. No separate design needed; SURF tasks parameterize over `desktop | island`.

---

## 24. Local API

Stays in core, byte-for-byte (FACT `local_api.rs`: axum on `127.0.0.1:19532`, bearer token from keyring, REST player/lyrics endpoints + SSE event stream, token rotation). Zero host coupling exists today; the only migration work is: (a) its enable/disable/rotate commands ride the protocol like everything else; (b) shutdown ordering (§14.3); (c) an Electron-side note in diagnostics that port conflicts now can also come from a zombie core (supervisor kills zombies by PID file guard — SUP-02: core writes `{data}/core.pid`, supervisor kills stale PID owning port 19532 only if the process image name matches `yaqmc-core`). SSE consumers (external tools) see identical behavior — explicitly in the §46 acceptance matrix.

---

## 25. SMTC / MPRIS

### 25.1 Windows SMTC (ADR-009 mechanics)

Today: `souvlaki` `PlatformConfig { hwnd: main Tauri window }` (FACT `system_media.rs` + `lib.rs`). Target: identical code; HWND arrives via `attach`/`platform_attach` (`mainWindowHandle` as hex string from `win.getNativeWindowHandle()`). Re-attach on window recreation (close-to-tray only hides — recreation happens only after renderer crash, §14.2). Control events (play/pause/next/prev/seek) keep dispatching into `PlayerService`; raise/quit callbacks become `host://command` events (§10.3).

Fallback (NEEDS ACCEPTANCE TEST if SMTC rejects the cross-process HWND — not expected since SMTC binds by HWND regardless of owning process, but verify): core creates its own hidden message window on a dedicated thread using the already-present `windows-sys` `Win32_UI_WindowsAndMessaging` feature (FACT: dependency exists in Cargo.toml).

Acceptance: media keys, SMTC flyout metadata + artwork, taskbar thumbnail buttons reflect state; timeline seek from flyout works (parity checklist mirrors current behavior — verified manually today per docs).

### 25.2 Linux MPRIS

`mpris-server` on its own thread, bus `org.mpris.MediaPlayer2.yaqmc` (FACT) — completely host-independent already. Only change: `Raise`/`Quit` → `host://command`. Acceptance: `playerctl` play/pause/next/position/metadata + GNOME/KDE media applets.

---

## 26. Tray / Shortcut / Notification

### 26.1 Tray (`services/tray.ts`)

Port of `desktop_integration.rs` (FACT): icon `yaqmc-tray` from `resources/`, menu = show/hide, play/pause, next, previous, settings (emits `app://open-settings` to renderer — channel preserved), quit. Menu labels re-render on player state events + locale change (i18n strings come from a small Main-side dictionary generated from the same i18next JSON — task PLAT-03; parity: today's tray is localized). Close-to-tray behavior per preference (§11.1). Left-click: toggle main window (parity).

### 26.2 Global shortcuts (`services/shortcuts.ts`)

Port the 3 fixed bindings via `globalShortcut` (FACT: play-pause/next/prev, not user-configurable). Registration failures (conflict) are logged + surfaced in diagnostics, never fatal (parity). **Wayland**: `globalShortcut` does not work on native Wayland (Chromium limitation; the XDG desktop-portal `GlobalShortcuts` route is not wired into Electron's API — VERIFIED web 2026-08-16); under ADR-008's default X11 backend shortcuts work as today except on pure-Wayland-only setups; in native-Wayland mode they are disabled with the same capability-banner mechanism as today's guard (FACT: current code already disables on native Wayland — parity preserved).

### 26.3 Notifications

**Missing today (D5) — stays out of scope.** No Electron `Notification` usage is added. Recorded as a post-migration opportunity in the follow-ups list only.

---

## 27. Logging / Diagnostics

### 27.1 Log topology (one new stream, everything else parity)

| Stream | Today | Target |
|---|---|---|
| Core Rust log | `tracing` daily rotation, 7 files, redaction (FACT `logging.rs`) | unchanged (same dir §18.1) |
| Frontend log ingestion | `log_frontend_event` command | same method, same sink |
| **Electron host log** (new) | — | `electron-log`-free hand-rolled tiny rotating file `host.log` in the same log dir (main-process events: spawn/restart, window lifecycle, updater, ACL denials, core stderr tail) — keep it dependency-light, ~100 LOC |
| Renderer console | webview devtools only | + forwarded `console.error/warn` in packaged builds → `log_frontend_event` (parity plus; behind preference; default on for error level) |

### 27.2 Correlation

Every protocol request carries `id`; core logs `method,id,duration,outcome` at debug (redaction rules apply — FACT transport redaction exists); host logs the same ids on timeout/error. Crash forensics: supervisor logs exit code/signal + last 64 KiB stderr (§11.1).

### 27.3 Diagnostics bundle (extended, format-compatible)

Core `diagnostics.rs` snapshot/ZIP stays authoritative (8 MiB cap, scrubbing — FACT). Additions: `host.json` section (Electron/Chromium/Node versions, window states, display backend + capability flags, updater state, restart counter) + `host.log` tail — Main contributes these via a new `diagnostics_host_payload` host-collected blob passed into the existing bundle method (`diagnostics_export_bundle(hostPayload)` — signature extended, backward compatible). Export flow: settings → host collects → invokes method → **save dialog now lives in Main** (`dialogs.ts`) → writes to user-chosen path (§10.3 dialog split). Issue reporter URL builder unchanged (FACT `issue_reporter.rs`), gains `host: electron/<version>` line in the environment block (DIAG-02).

### 27.4 Dialog split detail (pattern for all 3 dialog call sites — FACT audit: diagnostics export, background image picker, plugin install-from-file)

Old: Rust command opens dialog + does IO. New: renderer → `client.host.dialog.pickSave/pickFile` (Main, typed filters) → path → renderer calls the pure-IO core method with the explicit path (`diagnostics_export_bundle_to`, `preferences_set_background_from`, `plugin_install_from`). Method names get `_to`/`_from` suffixes; old names retired at P13 (matrix §37.9 tracks all three).

---

## 28. Electron Security

### 28.1 Baseline (ADR-010, applied to every `BrowserWindow`)

`sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`, `allowRunningInsecureContent: false`, `experimentalFeatures: false`. No exceptions. Preloads use only `contextBridge` + `ipcRenderer.invoke/on` (no `remote`, which no longer exists anyway).

### 28.2 Renderer compromise model

Assume a renderer can be hostile (it executes plugin-authored JS in Workers — even sandboxed, defense in depth). Consequences: ACL enforcement lives in **Main** (§11.3) and main-window-only guards re-checked in **core** (§10.3); preload exposes only `invoke/on` (no raw `ipcRenderer`); no method returns credentials (§19.3); `senderFrame` validated against the owning window per channel (router checks `event.senderFrame.url` prefix + WebContents id registry).

### 28.3 CSP

Ported from `tauri.conf.json` and adapted: `default-src 'self'; img-src 'self' data: https: app:; media-src 'self' http://127.0.0.1:19532 app:; connect-src 'self' http://127.0.0.1:19532; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'` (audit exact current directives in SEC-01 — the FACT baseline includes `worker-src 'self' blob:` and asset/ipc schemes that map to `app:`/local API here). Delivered as a response header by the `app://` protocol handler (§11.2) — headers beat meta tags (cover workers). Dev mode keeps Vite's needs (`ws:` for HMR) behind `!app.isPackaged`.

### 28.4 Permission handlers

`setPermissionRequestHandler`: deny all (no geolocation/camera/mic/notifications are used — FACT). `setDisplayMediaRequestHandler`: deny. Media playback needs no permission (rodio is in core; the renderer never plays audio — FACT: `<audio>` is unused; playback is native).

### 28.5 Navigation containment

App windows: `will-navigate` → deny non-`app://`/dev-server; `setWindowOpenHandler` → deny + route http(s) to external-links service. OAuth windows: allowlist from `auth_oauth_prepare` only; everything else denied; devtools disabled in packaged builds for oauth windows.

### 28.6 `openExternal` allowlist

Port of frontend `external-links.ts` policy + issue-reporter targets: `https://github.com/YAQMC/*`, `https://y.qq.com/*`, provider help pages, plus explicit-user-typed URLs from settings only after `https:` scheme check. Main is the single chokepoint (renderer cannot call `shell` directly). Non-allowlisted → log + deny toast event.

### 28.7 Chromium switches hygiene

No `--disable-web-security`, no `--no-sandbox` ever (CI lint SEC-03 greps packaging + source). Linux graphics flags (§29.2) are the only sanctioned switches, each with a written justification in `linux-graphics.ts`.

### 28.8 Supply chain

`electron`, `electron-builder` pinned exact; `npm ci` everywhere (already the CI norm — FACT); core binary checksummed into builder config (`extraResources` with per-build hash manifest, verified at spawn — SUP-03) so a tampered core fails closed. Renovate/dependabot cadence unchanged (none exists today — out of scope).

---

## 29. Linux Strategy

### 29.1 What dies with WebKitGTK (celebrate, then verify)

All of `platform.rs`'s env mutation (`WEBKIT_DISABLE_DMABUF_RENDERER`, NVIDIA/Hyprland sniffing, `YAQMC_LINUX_RENDERER` modes) becomes dead — FACT that it exists solely for WebKitGTK. Deleted from core in P9 (platform.rs keeps only diagnostics probes: distro, session type, portal presence, GPU strings).

### 29.2 Chromium flag policy (`services/linux-graphics.ts`)

Defaults: **no flags** (Chromium's defaults are the most-tested path). `--ozone-platform-hint=auto` is **not** set (ADR-008: default X11/XWayland). Recognized user opt-ins via settings (persisted in preferences, applied on next launch, each logged into diagnostics): `native-wayland` (`--ozone-platform=wayland` + capability degradation §22.4), `gpu-off` (`--disable-gpu`, replaces today's `software` renderer mode), `vaapi-on` (VideoDecode feature flags; NEEDS ACCEPTANCE TEST per-distro, default off). Env `YAQMC_LINUX_RENDERER` read for backward compat, mapped to the same three switches, logged deprecated.

### 29.3 Capability flags

Main computes `{ alwaysOnTop, clickThrough, globalShortcuts, transparency }` from display backend + mode; delivered to renderers via `hostInfo` and to core via `attach` (already in §13.2); settings UI renders the banner (SURF-06). This is the documented replacement for silent degradation (prompt §67 satisfied).

### 29.4 Packaging targets (parity: AppImage, deb, rpm, tar.gz — FACT ci.yml)

electron-builder targets identical list, x64 + arm64. AppImage is the updater-bearing target (§32). deb/rpm declare dependencies electron-builder computes (libgtk-3, libnss3 — standard set); no WebKitGTK deps anymore (release-notes highlight). Tray needs `libayatana-appindicator` on some distros — declared as recommends, tray failure is non-fatal (parity: tray init failure is logged-only today — FACT).

### 29.5 Linux acceptance matrix (P12)

| Environment | Must pass |
|---|---|
| Ubuntu LTS current, X11, Intel/AMD | full §46 suite |
| Ubuntu LTS current, Wayland session (XWayland backend) | full suite incl. surfaces + shortcuts |
| Fedora current, Wayland, GNOME | full suite; plus native-wayland opt-in smoke (degraded banner correct) |
| Arch + Hyprland, NVIDIA proprietary | boot, playback, surfaces best-effort (this is TD-1's historical trouble spot; regression bar = today's behavior with `YAQMC_LINUX_RENDERER` mapped) |
| KDE Plasma current (X11 + Wayland) | tray, MPRIS applet, surfaces |

---

## 30. Windows Strategy

- **Arch targets:** x64 + arm64 (parity). **i686 is dropped** — Electron does not ship 32-bit Windows builds (VERIFIED web 2026-08-16: win32/ia32 support ended; last ia32-supporting line is EOL). Recorded as an accepted platform regression in release notes; CI matrix updated accordingly (D-shaped delta called out in §36 parity matrix + §39 R-13).
- Transparent frameless main window + surfaces: supported; verify no DWM shadow artifacts (SURF acceptance).
- SMTC per §25.1; media keys arrive via SMTC (not globalShortcut) when SMTC session active — parity with souvlaki behavior today; the 3 global shortcuts remain registered (same as today — both paths coexist now, keep both).
- Long-path + unicode profile dirs: core paths go through `std::path` (parity); installer NSIS per-user default (no admin), portable zip target kept (FACT ci.yml has portable).
- Windows Defender/SmartScreen: binaries stay unsigned (parity — FACT: CI produces unsigned artifacts). electron-updater works unsigned only if `verifyUpdateCodeSignature` is disabled — explicitly configured + risk-registered (R-9); signing is a follow-up, not in scope.
- WebView2 runtime dependency disappears (Electron bundles Chromium) — installer no longer needs the WebView2 bootstrapper; startup on machines with broken WebView2 installs is a support win (release notes).

---

## 31. Packaging

### 31.1 electron-builder v27 (ADR-006 rationale record)

Forge is the Electron team's default recommendation, but the decision drivers here are: (1) target-format parity — builder natively produces NSIS + portable + AppImage + deb + rpm + tar.gz, exactly today's list; Forge's Linux story (deb/rpm makers, no first-class AppImage) is weaker; (2) `electron-updater` integrates with builder metadata (`latest.yml`/`latest-linux.yml`) out of the box incl. AppImage self-update; (3) multi-arch Linux (x64+arm64) matrix is a solved problem in builder. VERIFIED web 2026-08-16: builder v27 current (requires Node ≥ 22.12), actively maintained. Risk noted: builder is community-maintained — pinned exact version + lockfile mitigates.

### 31.2 Build pipeline (per platform)

```
1. npm run build            # Vite renderer → dist/            (unchanged config)
2. npm run build -w @yaqmc/client        # tsc → package dist
3. esbuild apps/desktop/{main,preload}   # → apps/desktop/out/
4. cargo build --release -p yaqmc-core   # → target/release/yaqmc-core[.exe]
5. node scripts/stage-core.mjs           # copy + sha256 manifest → apps/desktop/resources/core/
6. electron-builder --config apps/desktop/electron-builder.yml [--win|--linux] [--x64|--arm64]
```

`electron-builder.yml` essentials: `appId: org.yaqmc.desktop` (**must equal the Tauri identifier** — keyring + userData continuity), `productName: YAQMC`, `asar: true` with `asarUnpack` for nothing (core is in `extraResources`, not asar), `extraResources: [{from: resources/core, to: core}]`, NSIS `oneClick: false, perMachine: false`, artifact naming matched to today's release asset names where practical (BASE-05 records current names).

### 31.3 Version stamping (single release unit)

Root `package.json` version is the single source; `scripts/sync-version.mjs` (new) propagates to `apps/desktop/package.json` + workspace crates' `Cargo.toml` at release time; core embeds version + commit via existing `build.rs` env embedding (FACT: build metadata embedding exists); handshake enforces equality (§13.3). `__YAQMC_BUILD_COMMIT__`/`__YAQMC_RELEASE_CHANNEL__`/`__YAQMC_BUILD_TYPE__` Vite defines keep working (FACT vite.config.ts) — values now provided by the desktop build script too.

### 31.4 Size expectation (set honestly, measured in P11)

Installer grows from WebView2-assisted ~15–25 MB class to Electron-class ~90–110 MB per platform (Chromium payload). Accepted cost of ADR-001 (recorded for release notes; §35 tracks exact numbers).

---

## 32. Updater

New functionality (D4). Scope-minimal design:

- `electron-updater` with GitHub Releases provider (repo is public; releases already exist via `build.yml` — FACT). Channels: `latest` only (today's release channel concept: stable + nightly tags exist in metadata — nightly maps to GitHub prereleases with `allowPrerelease` bound to `__YAQMC_RELEASE_CHANNEL__`).
- Flow v1: manual "Check for updates" button in settings + check-on-launch (deferred 30 s) → notify-only banner → user clicks → download → "restart to install". **No silent auto-install** (player apps interrupting playback = hostile; also unsigned-Windows caveat §30).
- Windows: NSIS target, `verifyUpdateCodeSignature: false` (unsigned — R-9). Linux: AppImage self-update only; deb/rpm/tar.gz builds get a "new version available" notifier linking to releases (electron-updater cannot in-place-update those — standard practice).
- Core binary updates ride the installer (single release unit — no partial updates, no delta; keep it boring).
- Events: `host://update {state}` channel; settings UI section (UPD-02). Rollback: previous installer remains on GitHub Releases (standard).

---

## 33. CI / Build

### 33.1 Workflow surgery (rewrite of `ci.yml` + `build.yml`, keep `pages.yml`)

Quality job additions (all PRs): `cargo fmt/clippy/test --workspace` (now a real workspace), `npm run lint` + `tsc --noEmit` for `src/`, `packages/yaqmc-client`, `apps/desktop`, contract tests (§34.3), dependency-rule greps (§8, §28.7).

Package matrix (replaces Tauri matrix):

| OS runner | Targets |
|---|---|
| windows-latest | x64, arm64 (cross via electron-builder; core cross-compiled with `aarch64-pc-windows-msvc` toolchain — CI-03 verifies) |
| ubuntu-latest | x64 AppImage/deb/rpm/tar.gz |
| ubuntu-24.04-arm | arm64 same targets (native runner — parity with today's arm64 builds which exist in ci.yml — FACT) |

`YAQMC_PREBUILT_FRONTEND` dist-reuse optimization is preserved (build renderer once, reuse across matrix — FACT this exists; keep the same env-var contract in the new scripts).

### 33.2 Co-existence period (P4–P12)

CI builds **both hosts**: Tauri packages (existing jobs untouched) + Electron packages (new jobs, `continue-on-error: false` from P7 on). This doubles CI time; mitigated by dist-reuse + core-build sharing (`target/` cache keyed on Cargo.lock). Tauri jobs deleted in P13.

### 33.3 Private-dependency access (P14 only)

`QM_API_RS_TOKEN` secret + `git config --global url."https://x-access-token:${TOKEN}@github.com/YAQMC/qm-api-rs".insteadOf "https://github.com/YAQMC/qm-api-rs"` step gated to jobs that build the provider (PROV-01).

### 33.4 Release (`build.yml` successor)

Tag push → full matrix → checksums file → GitHub Release draft with electron-updater metadata (`latest.yml`, `latest-linux.yml`) + release-notes template noting: unsigned binaries, i686 dropped, data preserved in place, WebKitGTK troubleshooting section deleted.

### 33.5 Guard rails in CI (cheap, high-value)

- `rg -l "tauri" crates/` must return empty (from P2 on).
- `rg -l "@tauri-apps" src/ --glob '!src/application/tauri-host-bridge.ts'` empty (from P6; the exception is removed in P13).
- `rg -l "require\(|process\.env" apps/desktop/preload/` empty beyond the sanctioned bridge file (preloads stay tiny).
- Method-registry drift test (§13.5) runs in quality job.

---

## 34. Testing Strategy

### 34.1 Test inventory today (FACT baseline that must stay green)

Rust: unit/integration tests across player (incl. seek regression from `9bd4e61`), qqmusic (signing, DTO parsing, entitlement), plugin (manifest, permissions, packaging), storage (migrations), diagnostics (redaction). Frontend: Vitest suites for stores (player merge logic, interpolation), provider adapters, plugin runtime, i18n keys. CI runs both (FACT ci.yml). **Every phase exit requires: existing suites green, unmodified except where a test encodes host-specific mechanics** (each such edit is listed in the task that makes it — no silent test rewrites).

### 34.2 New: protocol unit tests (`yaqmc-protocol`)

Framing round-trip (incl. max-size, split-read, garbage), envelope serde snapshots, registry completeness (§13.5), error mapping table.

### 34.3 New: contract tests (Rust ⇄ TS, the drift killer)

`cargo test -p yaqmc-protocol --features fixtures` emits `target/contract-fixtures/*.json` — golden serialized examples of every event payload + representative method params/results (generated from the same serde structs the server uses). Vitest suite in `packages/yaqmc-client` loads the fixtures and type-checks + runtime-validates them against the TS mirror types (zod-free: hand-rolled asserts on the ~30 hot payloads; full structural typing via `tsc`). CI fails on any shape drift. Fixture regeneration is an explicit script (`npm run contracts:update`) so drift is always a reviewed diff.

### 34.4 New: core integration harness (Electron-free — §7.4 proof)

`crates/yaqmc-core/tests/protocol_e2e.rs`: spawn `yaqmc-core` binary with temp dirs, drive stdio: handshake → snapshot → enqueue fake-resolvable tracks (test fixture provider behind a `test-provider` feature gate; the fake provider pattern already exists in TS — mirrored minimally in Rust) → play/seek/next storm → assert event stream invariants (revision monotonicity, session fencing) → shutdown ack. This is the single highest-value new test asset; it runs on plain ubuntu/windows runners with no display.

### 34.5 New: Electron E2E (Playwright)

Playwright's Electron driver (VERIFIED web 2026-08-16: `_electron` API current) with the fake-provider mode (`?provider=fake` reused — no network, deterministic): boot → main window visible → play/pause/seek via UI → tray menu simulation (programmatic) → surface show/lock/unlock → geometry persist/restore → settings toggles → quit-clean (core exit 0 asserted). ~15 scenarios, Windows + Linux CI (xvfb on Linux runners for X11 path). OAuth/QQ-network flows are **not** E2E-automated (LIVE VERIFY manual scripts instead — §34.8).

### 34.6 Lifecycle tests

Supervisor unit tests (restart/backoff/safe-mode state machine with a mock child); shutdown-ack integration (kill-timeout path included); stdin-EOF autonomous shutdown test in the Rust harness.

### 34.7 Player consistency regression pack (release gate)

The §15.6 five scenarios, implemented once in the Rust harness (§34.4) + once through Playwright at the UI layer (storm via exposed test hook), plus the existing `player.rs` unit tests. Any change to `player.rs`/`playback_session.rs`/`audio.rs` in any phase triggers mandatory local run of this pack (CI runs it always).

### 34.8 Manual LIVE VERIFY scripts (checklists committed to `docs/migration/manual-tests.md`)

QR login (QQ), OAuth login (QQ + WeChat popup), VIP quality ladder incl. EKey QMC playback, favorites mutation reconciliation under flaky network, lyric fetch for QRC/LRC edge tracks, SSE external consumer, SMTC flyout on Win11, MPRIS via playerctl, the §29.5 Linux matrix, updater end-to-end against a draft release. Each with expected-result columns; maintainer signs off per phase gate that requires them.

### 34.9 Coverage philosophy

No new coverage-percentage targets. The bar is: every migrated behavior has either an automated test or a checklist line, and every §46 row names its verification method. Tests-as-spec over metrics.

---

## 35. Performance / Soak

### 35.1 Baseline capture (P0, BASE-03 — before anything changes)

`scripts/perf-baseline.mjs` + manual protocol, recorded into `docs/migration/perf-baseline.md`: cold start to first frame (3 runs, median), warm start, RSS after boot idle 60 s, RSS after 30 min playback, idle CPU % (playing, paused), CPU during rapid-seek storm, installer + installed size, per current Tauri build on the two primary dev machines (Windows + one Linux). These numbers are the regression yardstick — without them "Electron feels heavier" is unfalsifiable.

### 35.2 Budgets (Electron vs Tauri baseline; measured at P11 exit, gate at P12)

| Metric | Budget |
|---|---|
| Cold start to interactive | ≤ baseline + 1.5 s |
| Idle RSS (sum of processes) | ≤ baseline + 250 MB (Chromium tax — honest budget) |
| Playing CPU (idle UI) | ≤ baseline + 2 pp |
| Seek round-trip p95 (UI event→settled snapshot) | ≤ baseline + 5 ms |
| Position-update jitter on lyrics surface | no visible regression (manual A/B, 120 s video capture compared) |
| Installer size | ≤ 120 MB per platform |

Overrun → profile first (tracing spans exist in core; `chrome://tracing` for renderer), only then negotiate the budget in the risk register — never silently.

### 35.3 Soak

4-hour scripted playback loop (fake provider + one real-account session — two runs) on Windows + Linux: assert no RSS growth > 10 %, no handle/fd leak (snapshot counts), no snapshot-revision stall, no supervisor restarts, log error rate ~0. Runs at P7, P12, and pre-release thereafter (script SOAK-01, wired as manual-dispatch CI job on self-hosted or long-runner).

---

## 36. Feature Parity Matrix

Verification method key: **A** = automated (unit/contract/harness/E2E), **M** = manual checklist (§34.8), **L** = LIVE VERIFY (real QQ account/server). Target: parity with §4 statuses — Partial stays Partial, Missing stays Missing unless listed as new.

| Feature (from §4) | Parity target | Phase proven | Method |
|---|---|---|---|
| Playback controls, modes, volume | identical | P7 | A |
| Rapid seek + fencing invariants | identical | P2 (harness), P7 (UI) | A |
| Queue ops + persistence/restore | identical | P7 | A |
| Media resolution: vkey / QMC / local file | identical | P7 | A(local) + L(vkey/QMC) |
| Progressive cache + promotion | identical | P7 | A + M |
| Search / home / discover / album / playlist | identical | P7 | L |
| Favorites + mutation reconciliation | identical | P7 | L |
| QR login / OAuth login | identical | P8 | L |
| Session persist/staging/refresh (keyring untouched) | identical — **user stays logged in across host swap** | P8 | L |
| Entitlement/quality ladder | identical | P8 | L |
| Lyrics fetch/parse/offset | identical | P7 | A + L |
| In-app lyrics page + presets + composer + scenes | identical | P7 | A + M |
| Desktop lyrics + island (Windows) | identical incl. lock/click-through/geometry/fullscreen-hide | P9 | A(E2E) + M |
| Desktop lyrics + island (Linux X11/XWayland) | identical to today's X11 behavior | P12 | M |
| Linux native-Wayland surfaces | degraded-with-banner (documented — better than today's silent) | P12 | M |
| Plugins: lifecycle/permissions/storage/proxy/safe-mode/scenes | identical | P10 | A + M |
| Tray + close-to-tray | identical | P9 | A(E2E) + M |
| Global shortcuts (3) | identical; Wayland caveat unchanged | P9 | M |
| SMTC / MPRIS | identical | P9 | M |
| Local API + SSE + token rotate | identical (external consumers unaffected) | P9 | A + M |
| Preferences + `preferences://changed` | identical | P7 | A |
| Logging/diagnostics/issue reporter | identical + host section added | P11 | A + M |
| i18n | identical (+ tray dictionary) | P9 | A |
| CI packages: win x64/arm64, linux x64/arm64 × all formats | identical set **minus win-i686** (accepted — §30) | P11 | A |
| **New:** single instance | new | P5 | A(E2E) |
| **New:** updater (notify + install) | new | P11 | M |
| **New:** core crash resilience (UI survives, auto-restart) | new (better than today) | P5 | A |
| OS notifications / deep links / MV playback | still Missing (unchanged scope) | — | — |

---

## 37. File Migration Matrix

Legend — **Action**: KEEP (unchanged), MOVE (git mv, content unchanged), MOVE+EDIT (git mv + mechanical de-Tauri edits), REWRITE (same responsibility, new implementation), NEW, DELETE(P*n*) (deleted in phase n), SPLIT (responsibilities divided as noted).

### 37.1 Rust — `src-tauri/src/` root modules (all 24 files accounted for)

| File | Action | Destination | Notes |
|---|---|---|---|
| `lib.rs` | SPLIT | boot order → `yaqmc-core/src/lib.rs` (§10.2); event fan-out → `yaqmc-core/src/server/events.rs`; window/close-to-tray/oauth-cancel handlers → `apps/desktop/main/windows/*`; plugin registration lines → DELETE(P13) | the one file that touches everything; P1+P2 |
| `main.rs` | REWRITE | `yaqmc-core/src/main.rs` (30-line bin over `run()`); Tauri's main → stays in `src-tauri` shim until DELETE(P13) | |
| `commands.rs` (97 non-plugin commands) | MOVE+EDIT | bodies → `yaqmc-core/src/server/methods.rs` dispatch arms; `#[tauri::command]`/`State`/`Window` params dropped (services already injected) | P2; the shim keeps thin Tauri wrappers calling the same service fns until P13 |
| `command_guard.rs` | REWRITE | Main IpcRouter ACL + core method-metadata re-check (§10.3, §11.3) | DELETE(P13) of original |
| `player.rs` | MOVE+EDIT | `yaqmc-core/src/player.rs` — only the 4 spawn substitutions (§10.3) | protected invariants §15.2 |
| `playback_session.rs` | MOVE | `yaqmc-core/src/playback_session.rs` | zero edits |
| `audio.rs` | MOVE | `yaqmc-core/src/audio.rs` | zero edits |
| `media.rs` | MOVE | `yaqmc-core/src/media.rs` | zero edits |
| `streaming.rs` | MOVE | `yaqmc-core/src/streaming.rs` | zero edits |
| `qmc.rs` | MOVE | `yaqmc-core/src/qmc.rs`; P14-A → `yaqmc-provider-qqmusic`; P14-C possibly DELETE (replaced by qm-api-rs `qmc`) | |
| `storage.rs` | MOVE+EDIT | `yaqmc-core/src/storage.rs` — path injection via `CoreConfig` instead of Tauri resolver | schema frozen §18.2 |
| `credentials.rs` | MOVE | `yaqmc-core/src/credentials.rs` | service name frozen §19 |
| `app_preferences.rs` | MOVE | `yaqmc-core/src/app_preferences.rs` | keys frozen §22.6 |
| `logging.rs` | MOVE+EDIT | `yaqmc-core/src/logging.rs` — log dir injected | |
| `diagnostics.rs` | MOVE+EDIT | `yaqmc-core/src/diagnostics.rs` — host payload param (§27.3); dialog removed (§27.4) | |
| `issue_reporter.rs` | MOVE+EDIT | `yaqmc-core/src/issue_reporter.rs` — host line added | |
| `local_api.rs` | MOVE | `yaqmc-core/src/local_api.rs` | §24 |
| `system_media.rs` | MOVE+EDIT | `yaqmc-core/src/system_media.rs` — HWND via attach; raise/quit → `host://command` (§25) | |
| `platform.rs` | SPLIT | diagnostics probes → `yaqmc-core/src/platform.rs`; env-mutation workarounds → DELETE(P9) (§29.1); flag policy → NEW `apps/desktop/main/services/linux-graphics.ts` | TD-1 payoff |
| `desktop_integration.rs` | REWRITE | `apps/desktop/main/services/{tray,shortcuts}.ts` (§26); original DELETE(P13) | |
| `lyrics_surface/mod.rs` | REWRITE | `apps/desktop/main/windows/lyrics-surfaces.ts` (§22); lyric-data commands stay core | |
| `lyrics_surface/windows.rs` | MOVE+EDIT | fullscreen poller → `yaqmc-core` platform module emitting `host://command` (§22.2) | pure Win32, stays Rust |
| `lyrics_surface/linux.rs` | KEEP-as-stub | carried (TD-5) | |
| `build.rs` | MOVE+EDIT | `yaqmc-core/build.rs` — keep metadata embedding; DELETE command-manifest generation (§13.5) | |

### 37.2 Rust — `qqmusic/` (all files; move as a directory)

| File(s) | Action | Notes |
|---|---|---|
| `qqmusic.rs` + `qqmusic/` (transport, auth, account, entitlement, dto, cache, artwork modules) | MOVE (P1 into core) → MOVE again (P14-A into `yaqmc-provider-qqmusic`) | content edits only per §17.4 dispositions in P14-B/C |
| `qqmusic/oauth.rs` | SPLIT (P2) | URL-build/callback-parse/exchange → provider (`auth_oauth_prepare/complete/cancel` §16.4); WebviewWindow mechanics → `apps/desktop/main/windows/oauth-window.ts`; Tauri window code DELETE(P13) |
| `plugin/` (host, manifest, permissions, storage, network, safety, scenes) | MOVE (P1) | unchanged (§20) |
| `plugin/commands.rs` | MOVE+EDIT (P2) | 20 commands → dispatch arms; token-gate logic unchanged |

### 37.3 Rust/Tauri config & shim

| File | Action | Notes |
|---|---|---|
| `src-tauri/Cargo.toml` | SPLIT (P1) | deps partitioned: core deps → `crates/yaqmc-core/Cargo.toml`; tauri deps stay in shim; root workspace `Cargo.toml` NEW | DELETE(P13) shim |
| `tauri.conf.json`, `tauri.linux.conf.json` | KEEP until DELETE(P13) | facts already ported: CSP→§28.3, window table→§11.2, identifier→§31.2, linux-opaque→§11.2 |
| `src-tauri/capabilities/*.json` | KEEP until DELETE(P13) | ported to ACL table §11.3 |
| `src-tauri/icons/*` | MOVE (P4) | → `apps/desktop/resources/` (builder regenerates platform formats; keep originals) |

### 37.4 Frontend (from the 22-file coupling audit; 82 host-agnostic files = KEEP, listed as one row)

| File | Action | Notes |
|---|---|---|
| 82 host-agnostic files (components, stores, pages, i18n, styles, utils) | KEEP | zero edits; protected by ESLint guard |
| `application/native-player-runtime.ts` | MOVE+EDIT (P6) | → client SDK consumption (§12.4) |
| 16 further bridge-only files (`qq-music-provider.ts`, `account-store.ts`, `preferences-store.ts`, `plugin-runtime.ts`, `lyrics-surface-runtime.ts`, diagnostics/settings/local-api/issue bridge files, etc. — full list in the P6 task) | EDIT (P6) | mechanical `invoke`→`client.invoke`, `listen`→`client.on` |
| `components/TopBar.tsx` | EDIT (P6) | window controls + dual drag mechanism (§12.4); drag attr removed P13 |
| `application/lyrics-presentation.ts` | EDIT (P6) | fullscreen via host API |
| `application/external-links.ts`, `application/issue-reporter.ts` | EDIT (P6) | openExternal via host API |
| `surfaces/LyricsSurfaceApp.tsx`, island surface component | EDIT (P6) | subset client + dual drag |
| `application/player-command-adapter.ts` | MOVE (P5) | seek-coalescing logic → `packages/yaqmc-client` (imported back; no behavior change) |
| `providers/fake-music-provider.ts` | KEEP + wrap | backs `bridges/fake.ts` (§12.2) |
| `main.tsx`, `index.html` | KEEP | query routing preserved (§11.2) |
| NEW `application/tauri-host-bridge.ts` | NEW (P5) → DELETE(P13) | the co-existence adapter |

### 37.5 Build/config/tooling

| File | Action | Notes |
|---|---|---|
| `vite.config.ts` | EDIT (P4, minimal) | keep 1420 port + defines; add `base` compatibility for `app://` (build already relative — verify VITE-01) |
| root `package.json` | EDIT (P3/P4) | workspaces, new scripts (`dev:desktop`, `build:desktop`, `contracts:update`, `perf:baseline`); Tauri scripts DELETE(P13) |
| `tsconfig.json` | EDIT (P3) | project references for packages/apps |
| `.github/workflows/ci.yml`, `build.yml` | EDIT (P4 add Electron jobs) → EDIT (P13 remove Tauri jobs) | §33 |
| `scripts/*` (existing dev/plugin/docs scripts) | KEEP | plugin:pack/docs unchanged |
| NEW: `scripts/stage-core.mjs`, `scripts/sync-version.mjs`, `scripts/perf-baseline.mjs`, `apps/desktop/*` configs | NEW | §31–§35 |
| `docs/**` (90 files) | EDIT (P15) | §38.3 list |

### 37.9 Command/API disposition summary (117 registered — FACT count from `generate_handler!`)

- **Verified checksums (measured at HEAD, 2026-08-16):** 117 commands in `generate_handler!` (97 non-plugin + 20 plugin); 118 `#[tauri::command]` attribute occurrences (one command is defined but unregistered — dispositioned in PROTO-02); 112 of the 117 are referenced by frontend source strings; 5 never referenced by the frontend: `system_integration_status`, `player_play`, `player_pause`, `lyrics_surface_status`, `plugin_diagnostics` (host-side callers such as tray/shim, or retirement candidates).
- After migration: the large majority stay core-owned protocol methods with unchanged names; window/surface-shaped methods become host-implemented under the same names (window controls per window role, surface show/hide/lock/unlock/geometry ×2 surfaces, fullscreen, openExternal); the 3 dialog-coupled methods are split (host picks path via `dialogs.ts` + core does IO under new `_to`/`_from` names, old names retired P13 — §27.4); +2 new core methods (`platform_attach`, `core_shutdown_prepare`), +`core_ping`, +1 new host group (`host_updater_*`).
- The executor's P2 task PROTO-02 generates the authoritative 117-row table mechanically from `generate_handler!` + a frontend string scan, committed as `docs/migration/command-inventory.md`; every later task checks off rows there. (This plan deliberately specifies the *procedure* — the list is machine-derivable, and hand-copying 117 rows here would only invite transcription drift; the counts above are the verified checksums a correct table must reproduce.)

---

## 38. Tauri Removal Matrix

### 38.1 Preconditions (all must hold before P13 starts)

Electron parity matrix §36 rows P5–P12 all green; two consecutive nightly builds from `feat/electron-migration` used as daily driver by maintainer on Windows + one Linux env for ≥ 1 week each with zero P1 bugs; §35 budgets met; rollback tag `pre-tauri-removal` pushed.

### 38.2 Removal inventory (executed in one PR, CHECK-13)

| Item | Removal |
|---|---|
| Cargo deps: `tauri`, `tauri-build`, `tauri-plugin-dialog`, `tauri-plugin-global-shortcut`, `tauri-plugin-opener` (FACT list) | delete from workspace; `cargo tree -i tauri` must be empty |
| `src-tauri/` shim directory (remaining: Tauri main, conf files, capabilities, shim wrappers) | `git rm -r` |
| npm deps: `@tauri-apps/api`, `@tauri-apps/cli`, plugin JS packages (FACT package.json) | uninstall; lockfile regenerated |
| `src/application/tauri-host-bridge.ts` + ESLint exception | delete |
| `data-tauri-drag-region` attributes (2 files) | delete (CSS class remains) |
| `isTauri` sniffing remnants | delete (`bridge.kind` everywhere) |
| CI Tauri jobs + Tauri caching steps | delete |
| `tauri.conf.json` facts | already ported; verify checklist then delete |
| Root scripts `tauri`, `tauri:*` | delete |

### 38.3 Docs to update in P15 (from docs audit)

`README` (build instructions), `docs/development.md`, `docs/architecture*.md` (new diagram §7), `docs/logging.md` (stale path TD-7), `docs/linux-troubleshooting*.md` (WebKitGTK sections deleted, new flag policy §29.2), `docs/local-api*.md` (unchanged behavior, new port-conflict note §24), plugin docs (unchanged API statement), release/packaging docs, uninstall/data-location docs (§18.5), `docs/migration/` new artifacts (data-paths, command-inventory, perf-baseline, manual-tests).

### 38.4 Post-removal verification

Fresh-clone build on all three CI OS images; `rg -i "tauri" -g '!docs/migration/**' -g '!YAQMC_ELECTRON_MIGRATION_PLAN.md'` over the repo returns only historical changelog/docs mentions explicitly allowlisted; packaged-app smoke on both platforms; §34.4 harness green (it never knew about Tauri — that's the point).

---

## 39. Risk Register

| ID | Risk | L×I | Mitigation | Trigger → Response |
|---|---|---|---|---|
| R-1 | Seek/session regression during transport swap | M×**Critical** | §15 freeze + §34.7 pack at every gate; transport-only diffs in P2 | any pack failure → block phase, bisect within P2 commits |
| R-2 | Wayland surfaces worse than today | M×H | ADR-008 X11 default = today's capability; banner for native mode | §29.5 matrix failure → keep X11 default, document |
| R-3 | SMTC cross-process HWND rejection | L×M | ADR-009 fallback hidden window (dep already present) | acceptance test fail → switch to fallback (1-day task) |
| R-4 | qm-api-rs behavioral drift vs in-tree (signing, DTOs, entitlement) | M×H | §17.4 per-module gates, A/B feature flag, 3-day soak, golden corpus | any L-test fail → stay `intree` for that module; P14-C deferred |
| R-5 | qm-api-rs private-repo access breaks CI | M×M | pinned rev + token secret + documented local auth; option to vendor snapshot if org approves | fetch failure → vendor tarball fallback (PROV-01 alt path) |
| R-6 | GPL licensing unresolved | M×H | §17.6 gate before P14 only; P0–P13 unaffected | no decision → ship Electron migration, defer P14 (plan explicitly allows) |
| R-7 | Electron RSS/startup exceeds budgets | H×M | honest budgets §35.2; profiling playbook | overrun → profile, then budget renegotiation recorded in this doc |
| R-8 | Dual-host co-existence CI cost/flake | M×M | dist reuse, cargo cache, Tauri jobs frozen (no new work on them) | CI > 45 min → trim Tauri matrix to x64-only until P13 |
| R-9 | Unsigned Windows + updater = SmartScreen friction / downgrade-attack surface | M×M | notify-only updater, checksums file, docs; signing = follow-up | user reports → prioritize signing post-migration |
| R-10 | Keyring/Secret Service differences under Electron process (Linux) | L×H | same `keyring` crate in same-named core process; P8 L-test on GNOME+KDE | failure → investigate service naming/DBus session env pass-through (`DBUS_SESSION_BUS_ADDRESS` must be inherited — SUP-01 env passthrough list) |
| R-11 | `dirs`-crate path mismatch vs Tauri on some distro | L×H | BASE-04 ground truth + first-boot assert + §18.4 override | assert fires → ship override mapping |
| R-12 | Plugin ecosystem breakage (worker CSP/blob under Chromium) | L×M | §20 parity CSP + PLUG-03 runtime test; Chromium is *more* standard than WebKitGTK | breakage → CSP directive fix; API unchanged |
| R-13 | win-i686 users stranded | certain×L | release notes + last-Tauri-release remains downloadable | complaints → point to final Tauri release; no reversal |
| R-14 | Executor scope-creep (UI redesign, protocol "improvements") | M×H | ADR-004 freeze, §34.1 no-silent-test-rewrites, §20.4/§15.5 non-goals, review checklist §10.7 | any diff touching frozen semantics without a task ID → reject |
| R-15 | Electron major EOL mid-migration | L×L | §11.6 policy; upgrade PRs isolated | CVE in pinned major → expedite upgrade PR with smoke matrix |

---

## 40. Migration Phases

Sixteen phases, P0–P15. Every phase has the ten fixed fields. Global invariant: **at every phase exit, `main`-mergeable state = the Tauri app (until P13) still builds, packages, and passes its full suite** — the migration branch is always shippable as a Tauri app until the moment Electron replaces it.

---

### P0 — Baseline & Guardrails

- **Goal:** Freeze ground truth so every later claim is testable.
- **Preconditions:** clean `main` @ `bc55b7d`.
- **Scope (files):** new `docs/migration/*`, `scripts/perf-baseline.mjs`; branch creation.
- **Steps:** cut `feat/electron-migration`; capture perf baseline (§35.1); run current Tauri build → record real data/log paths + app_settings geometry/queue key names from a diagnostics snapshot (§18.1, §22.6); record CI release asset names; snapshot current test counts (`cargo test`/`vitest` summary) into docs.
- **Interfaces:** none.
- **Compatibility:** none (read-only phase).
- **Tests:** existing suites green (recorded).
- **Exit criteria:** `docs/migration/{perf-baseline,data-paths,release-assets,test-baseline}.md` committed; maintainer ack on baseline numbers.
- **Rollback:** delete branch.
- **Checkpoint:** `CHECK-00` tag `migration-p0`.

---

### P1 — Workspace & Core Crate Extraction (Strangler cut)

- **Goal:** `crates/yaqmc-core` exists, contains all Rust business logic, builds Tauri-free; `src-tauri` becomes a thin shim depending on it; app behavior unchanged.
- **Preconditions:** P0.
- **Scope:** root `Cargo.toml` (new workspace); `git mv src-tauri/src/<modules> crates/yaqmc-core/src/` per §37.1/§37.2 (everything except `main.rs`, `commands.rs`, `command_guard.rs`, `lib.rs` window/plugin parts, `lyrics_surface/mod.rs`, `desktop_integration.rs`, `oauth.rs` window half); shim `src-tauri/src/*` re-exports + Tauri glue.
- **Steps:** (1) workspace scaffold; (2) move Tauri-free modules verbatim (compile after each batch: player+audio+media+streaming+qmc → storage+credentials+prefs+logging → qqmusic → plugin core → local_api+system_media+diagnostics); (3) replace the 7 `tauri::async_runtime::spawn` sites with `tokio::spawn` + inject runtime `Handle` into `CoreHandle` construction; (4) `system_media` raise/quit → new internal `HostCommand` bus (shim subscribes and calls Tauri AppHandle — behavior identical); (5) `CoreConfig` path injection (shim passes Tauri-resolved paths — proves injection without changing values); (6) shim `lib.rs` keeps: plugin registration, window handlers, command wrappers importing service fns from the crate.
- **Interfaces:** `yaqmc_core::{CoreConfig, CoreHandle, bootstrap()}` (not yet `run()`); internal `HostCommand` bus.
- **Compatibility:** Tauri app fully functional; zero frontend changes.
- **Tests:** all Rust tests move with their modules and pass in the crate; shim integration compile; manual smoke (playback, login persists, surfaces, tray, plugins).
- **Exit criteria:** `cargo tree -p yaqmc-core -i tauri` empty; full suite green; smoke checklist signed.
- **Rollback:** revert the PR stack (moves are pure `git mv` + mechanical edits — cleanly revertible).
- **Checkpoint:** `CHECK-01`.

---

### P2 — Protocol Layer & Core Server

- **Goal:** `yaqmc-protocol` crate + core stdio server + `yaqmc-core` binary; the core is drivable Electron-free; command bodies live in dispatch; Tauri shim still ships.
- **Preconditions:** P1.
- **Scope:** new `crates/yaqmc-protocol`; `yaqmc-core/src/server/{transport,methods,events}.rs`, `main.rs`; `commands.rs` body moves (shim wrappers now call dispatch-shared service fns — wrappers shrink to 1-liners); oauth logic split (§16.4; shim keeps its window code calling the new prepare/complete methods); `platform_attach`, `core_ping`, `core_shutdown_prepare` methods; command-inventory doc generation.
- **Steps:** envelope/framing → registry (117 rows from PROTO-02 scan) → dispatch arms (mechanical, one commit per service group) → events fan-out port (§10.5) → bin + handshake → integration harness (§34.4) incl. the §15.6 storm scenarios → shutdown/EOF handling (§14.3).
- **Interfaces:** protocol v1 (§13); `yaqmc_core::run(config, transport)`.
- **Compatibility:** Tauri shim unchanged externally (its command wrappers call the same fns dispatch calls — one body, two entries).
- **Tests:** §34.2 protocol units; §34.4 harness incl. rapid-seek pack; existing suites green.
- **Exit criteria:** harness green on Windows + Linux CI; `docs/migration/command-inventory.md` committed with all 117 rows dispositioned; Tauri smoke unchanged.
- **Rollback:** shim never depended on the server — revert server commits only.
- **Checkpoint:** `CHECK-02`.

---

### P3 — TypeScript Client SDK

- **Goal:** `packages/yaqmc-client` with typed methods/events, protocol TS mirror, contract tests; no frontend changes yet.
- **Preconditions:** P2 (fixtures exist).
- **Scope:** new package; root workspaces config; tsconfig references; contract-test wiring (§34.3); seek-coalescing adapter moved in (import shim keeps old path re-exporting — frontend untouched).
- **Steps:** bridge interface → types mirror (seeded from existing frontend TS types — FACT they exist) → client method groups → fake bridge wrapping `fake-music-provider` → contract tests → `contracts:update` script.
- **Interfaces:** `@yaqmc/client` public API (§12.1–12.3).
- **Compatibility:** package is dead code until P5/P6 — zero runtime risk.
- **Tests:** contract suite green in CI; package unit tests.
- **Exit criteria:** CI runs contract tests; drift test proves fixture regeneration is clean.
- **Rollback:** delete package.
- **Checkpoint:** `CHECK-03`.

---

### P4 — Electron Skeleton

- **Goal:** `apps/desktop` boots: supervisor spawns core, handshake completes, main window shows the renderer in fake-provider mode, security baseline active, CI builds it.
- **Preconditions:** P2 (core bin), P3 (types).
- **Scope:** `apps/desktop/**` (main/preload/resources/builder config skeleton), `scripts/stage-core.mjs`, icons move, vite `base` check, CI Electron jobs (build-only), Electron version pin.
- **Steps:** esbuild pipeline → supervisor+client (§11.1) → `app://` protocol + CSP (§28.3) → main window (§11.2) loading `?provider=fake` → preload `window.yaqmc` full-ACL for main → security.ts (§28.4–28.7) → path-parity first-boot integration test (§18.1: spawn core with production path resolution on a scratch user profile, assert against BASE-04 table) → CI job.
- **Interfaces:** `window.yaqmc` (§12.3) live end-to-end (verified by a devtools-console invoke of `player_snapshot`).
- **Compatibility:** Tauri untouched; Electron app is a parallel artifact, renderer functional in fake mode only (expected — frontend still Tauri-bound until P6).
- **Tests:** supervisor unit tests (§34.6); handshake E2E (spawn+ready); path parity test; CI green.
- **Exit criteria:** `npm run dev:desktop` shows the UI (fake mode) on Windows + Linux dev machines; core round-trip proven from renderer console.
- **Rollback:** app dir is additive — revertible in isolation.
- **Checkpoint:** `CHECK-04`.

---

### P5 — Supervision Resilience & Host-Bridge Foundations

- **Goal:** crash/restart/resync machinery proven; single-instance; `TauriHostBridge` ready so P6 can land on both hosts.
- **Preconditions:** P4.
- **Scope:** supervisor backoff/safe-mode; resync (§14.5) in client SDK; `host://core-status` banner component (small, new, host-agnostic); single-instance; PID-file guard (SUP-02); env passthrough audit (SUP-01: `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`, locale vars — list committed); core checksum verify (SUP-03); `src/application/tauri-host-bridge.ts`.
- **Steps:** kill-core-under-load E2E (§15.6 #4) → repeated-crash safe-mode E2E → second-instance test → TauriHostBridge implementing `HostBridge` over invoke/listen + Tauri window APIs.
- **Interfaces:** `HostBridge` impls ×2 (electron, tauri) + fake.
- **Compatibility:** banner component inert on Tauri (core-status events never fire there).
- **Tests:** §34.6 suite complete; Playwright crash scenarios.
- **Exit criteria:** crash matrix §14.2 rows demonstrated; bridge unit tests green on both impls.
- **Rollback:** additive.
- **Checkpoint:** `CHECK-05`.

---

### P6 — Frontend Migration onto the Client SDK (runs on BOTH hosts)

- **Goal:** zero direct `@tauri-apps` imports outside the adapter; frontend runs identically on Tauri (daily driver) and Electron (fake→real methods now flow).
- **Preconditions:** P3, P5.
- **Scope:** the 22 coupled files (§12.4 table, §37.4); bridge auto-selection in `main.tsx` bootstrap (detect `window.yaqmc` → electron; `isTauri` → tauri adapter; else fake); ESLint restriction.
- **Steps:** one PR per group: (1) player runtime + command adapter re-import; (2) provider/account/preferences/lyrics bridge files; (3) plugin-runtime + local-api + diagnostics bridges; (4) TopBar/window-chrome + presentation + external links + surfaces (dual drag mechanism §12.4); (5) ESLint gate + dead-code sweep of `isNativeRuntime` sniffing.
- **Interfaces:** none new (consumption only).
- **Compatibility:** **the critical property:** after every PR in this phase, the Tauri app passes its full manual smoke; Electron app functionality grows PR-by-PR.
- **Tests:** Vitest suites (stores unchanged = tests unchanged — any store test edit is a red flag per R-14); Playwright fake-mode E2E now covers real UI flows under Electron; Tauri manual smoke per PR.
- **Exit criteria:** ESLint guard on; both hosts run the full UI; store test diff = zero lines.
- **Rollback:** per-PR revert (groups are independent).
- **Checkpoint:** `CHECK-06`.

---

### P7 — Electron Playback/Catalog Parity + First Soak

- **Goal:** Electron app is a *usable music player* with a real account: playback, queue, seek storms, lyrics page, search/discover/album/playlist, favorites — all real-provider.
- **Preconditions:** P6.
- **Scope:** bug-fixing phase against §36 P7 rows; no new architecture. `backgroundThrottling` verification for the position clock UI; media/artwork cache behavior under Chromium (`app://` + `http://127.0.0.1` interplay).
- **Steps:** run §36 P7 row checklists on Windows + Linux; fix; first 4-h soak (§35.3); record protocol round-trip p95 (§15.4).
- **Interfaces:** none new.
- **Compatibility:** Tauri still primary; Electron promoted to "usable beta" for maintainer.
- **Tests:** harness + E2E + LIVE VERIFY rows P7; soak report committed.
- **Exit criteria:** §36 P7 rows all green incl. L-tests; soak clean; seek p95 within budget.
- **Rollback:** n/a (stabilization).
- **Checkpoint:** `CHECK-07`.

---

### P8 — Account & Auth Parity

- **Goal:** QR login, OAuth popup logins (QQ + WeChat), session continuity from the *existing* keyring entry, staging slot, refresh, entitlement — all on Electron.
- **Preconditions:** P7.
- **Scope:** `oauth-window.ts` (§16.4 host half); auth E2E-manual scripts; keyring continuity verification (R-10) on GNOME + KDE + Windows.
- **Steps:** oauth window lifecycle (open/allowlist/capture/complete/cancel-on-close) → QR flow re-verify → upgrade-in-place test: boot Electron build on a profile where the Tauri build was logged in → assert session valid without re-login.
- **Interfaces:** none new (methods landed in P2).
- **Compatibility:** Tauri OAuth keeps working (shim window code calls same prepare/complete).
- **Tests:** §34.8 auth scripts; ACL test: auth methods rejected from surface windows (automated).
- **Exit criteria:** §36 P8 rows green; session-continuity demo recorded.
- **Rollback:** n/a.
- **Checkpoint:** `CHECK-08`.

---

### P9 — Platform Services Parity (tray, shortcuts, SMTC/MPRIS, surfaces, local API, Linux policy)

- **Goal:** every §36 P9 row green: tray+close-to-tray, 3 global shortcuts, SMTC (HWND attach), MPRIS, desktop-lyrics + island + unlock overlays + geometry + fullscreen-auto-hide(Win), local-API external-consumer parity, linux-graphics flag policy replacing `platform.rs` env mutation (deleted here).
- **Preconditions:** P7 (P8 not required — parallel OK).
- **Scope:** `services/{tray,shortcuts,linux-graphics}.ts`, `windows/lyrics-surfaces.ts`, tray i18n dictionary (PLAT-03), SMTC attach path + fallback decision (R-3), `platform.rs` split (§37.1), capability flags + banner (SURF-06, §29.3).
- **Steps:** tray → shortcuts → SMTC/MPRIS (manual matrix) → surfaces (SURF task battery §22.5) → local API SSE external smoke → Linux policy + env-magic deletion → capability banner.
- **Interfaces:** `host://command` consumption (raise/quit/surface-auto-hide); `SurfaceCapabilities`.
- **Compatibility:** Tauri surfaces keep their Rust manager until P13 (both consume the same geometry keys — §22.6 makes this safe).
- **Tests:** Playwright surface scenarios; SMTC/MPRIS manual; shortcut conflict handling; multi-monitor restore.
- **Exit criteria:** §36 P9 rows green on Windows + Ubuntu X11/XWayland.
- **Rollback:** per-service revert; SMTC fallback path pre-approved (R-3).
- **Checkpoint:** `CHECK-09`.

---

### P10 — Plugin Parity

- **Goal:** §36 plugin row green under Electron; Worker isolation verified under Chromium.
- **Preconditions:** P6 (plugin-runtime on client SDK); P7.
- **Scope:** PLUG tasks (§20.3): example-plugin battery, permission prompts, storage quota, network proxy allow/deny, safe-mode crash-loop drill, scene API v2 demo, Worker-isolation runtime test (PLUG-03).
- **Steps/Tests:** as scoped; Rust plugin tests already moved (P1) and stay green throughout.
- **Exit criteria:** full battery green both platforms; no plugin API change (diff over `plugin/` API surface = none).
- **Rollback:** n/a.
- **Checkpoint:** `CHECK-10`.

---

### P11 — Packaging, Updater, Diagnostics Completion

- **Goal:** installable artifacts on all §33.1 targets; updater notify-flow works against a draft release; diagnostics bundle includes host payload; perf numbers measured.
- **Preconditions:** P7 (P8–P10 parallelizable but all required for P12).
- **Scope:** `electron-builder.yml` full config (PACK-01 pin, §31.2), `sync-version.mjs`, NSIS/AppImage/deb/rpm/tar.gz + arm64 (CI-03), updater (§32, UPD-02 settings UI), host log + `diagnostics_host_payload` (§27), dialog-split methods live (§27.4), release workflow rewrite (§33.4), size/perf measurement (§35.2 table filled).
- **Steps:** builder config → local packages each OS → CI matrix → draft-release updater rehearsal (versioned A→B upgrade incl. core swap) → diagnostics round-trip from packaged build.
- **Interfaces:** `host_updater_*`, `host://update`, `_to/_from` dialog methods.
- **Compatibility:** Tauri packaging jobs still run (§33.2).
- **Tests:** install/uninstall/upgrade scripts per platform (§34.8 extended); updater rehearsal recorded; data survives reinstall (path parity §18).
- **Exit criteria:** all artifacts install + boot + play on clean VMs; upgrade rehearsal green; perf table complete.
- **Rollback:** packaging is additive until P13.
- **Checkpoint:** `CHECK-11`.

---

### P12 — Acceptance Hardening (the gate before the point of no return)

- **Goal:** §29.5 Linux matrix + §30 Windows checks + §35.2 budgets + §34.7 pack + second soak + 1-week daily-driver — all green; §38.1 preconditions satisfied.
- **Preconditions:** P8, P9, P10, P11 all exited.
- **Scope:** test execution + fix backlog; zero new features.
- **Exit criteria:** §36 matrix fully green (every row, both platforms); sign-off note in `docs/migration/acceptance-p12.md` with dates/environments/versions; tag `pre-tauri-removal`.
- **Rollback:** stay in P12 until green — no time-boxed override.
- **Checkpoint:** `CHECK-12`.

---

### P13 — Tauri Removal

- **Goal:** §38.2 inventory executed; Electron is the only host; repo passes §38.4 verification.
- **Preconditions:** P12 exit + §38.1.
- **Scope/Steps:** single PR per §38.2 + drag-attr cleanup + ESLint exception removal + CI Tauri-job deletion + final `rg` sweeps.
- **Compatibility:** none needed — this is the cut.
- **Tests:** full CI; fresh-clone builds; packaged smoke both platforms; §34.4 harness (unchanged by definition).
- **Exit criteria:** §38.4 all green; version bumped (minor); release-notes draft.
- **Rollback:** revert the removal PR (kept revert-clean: no other work in it) or fall back to tag `pre-tauri-removal` (§45).
- **Checkpoint:** `CHECK-13`.

---

### P14 — Provider Migration to qm-api-rs (A/B/C sub-phases, §16.3/§17)

- **Goal:** `yaqmc-provider-qqmusic` backed by qm-api-rs per the §17.4 disposition table; in-tree duplicates retired where replaced.
- **Preconditions:** P13; §17.6 license decision; PROV-01 access working.
- **Scope:** P14-A trait+registry+crate move (no-op gate); P14-B module swaps behind `provider-qq-backend` feature (order: J qmc → L lyrics → I vkey → A/B transport+signing → C/D login/session → G/H account/entitlement hybrids); P14-C retirement + `qqmusic-credential-v2` cutover (§17.3).
- **Tests:** golden corpus (PROV-07), per-module L-verification (§17.5), full §34.7 pack after A and after each B swap batch, 3-day maintainer soak before C.
- **Exit criteria:** `qmapi` backend is the default build; in-tree replaced modules deleted; parity matrix re-run green; `cargo tree` shows single reqwest/tokio versions (PROV-02).
- **Rollback:** feature-flag back to `intree` per module (kept until P14-C); P14-C itself is one revertible PR.
- **Checkpoint:** `CHECK-14` (A), `CHECK-14B`, `CHECK-14C`.

---

### P15 — Cleanup, Docs, Final Verification

- **Goal:** repo coherent for new contributors; docs true; follow-ups filed.
- **Scope:** §38.3 docs; TD-7/TD-9 fixes; CONTRIBUTING (private-dep auth, new build); README badges/instructions; delete `docs/migration/` scratch or promote to permanent docs; follow-ups filed as issues (signing R-9, notifications, deep links, native-Wayland improvements, TD-3 DTO cleanup); final full acceptance re-run (§46).
- **Exit criteria:** §47 DoD checklist 100 %; final tag `electron-migration-complete`.
- **Checkpoint:** `CHECK-15`.

---

## 41. Complete Task Catalog

Atomic tasks, grouped by phase. Columns: **Depends** (task IDs; phase-entry implies all prior-phase exit unless noted), **Verification** (what proves it done). File paths per §37. Tasks marked ⛔ are hard blockers for their phase exit; others can trail into the next phase only if explicitly noted in §43.

### P0

| ID | Task | Depends | Verification |
|---|---|---|---|
| BASE-01 ⛔ | Cut `feat/electron-migration` from `bc55b7d`; enable branch CI | — | CI green on branch |
| BASE-02 | Record test baseline (suite names + counts) → `docs/migration/test-baseline.md` | BASE-01 | doc committed |
| BASE-03 ⛔ | `scripts/perf-baseline.mjs` + run on Win/Linux → `docs/migration/perf-baseline.md` (§35.1) | BASE-01 | numbers for every §35.2 metric |
| BASE-04 ⛔ | Ground-truth data paths + app_settings keys (geometry, queue, presets) from live Tauri diagnostics → `docs/migration/data-paths.md` (§18.1, §22.6) | BASE-01 | table incl. Win+Linux paths, keyring entries, settings keys |
| BASE-05 | Record current release asset names/formats → `docs/migration/release-assets.md` | BASE-01 | doc committed |

### P1

| ID | Task | Depends | Verification |
|---|---|---|---|
| CORE-01 ⛔ | Root workspace `Cargo.toml`; empty `crates/yaqmc-core` wired; shim builds | BASE-01 | `cargo build` workspace green |
| CORE-02 ⛔ | `git mv` batch 1: player, audio, playback_session, media, streaming, qmc | CORE-01 | tests moved+green; `git log --follow` intact |
| CORE-03 ⛔ | Batch 2: storage, credentials, app_preferences, logging | CORE-02 | same |
| CORE-04 ⛔ | Batch 3: qqmusic/* (oauth window half stays in shim), diagnostics, issue_reporter, local_api, system_media, platform | CORE-03 | same |
| CORE-05 ⛔ | Batch 4: plugin/* (minus commands.rs) | CORE-04 | same |
| CORE-06 ⛔ | Replace 7 `tauri::async_runtime::spawn` → `tokio::spawn`; inject runtime `Handle` via `CoreHandle` | CORE-02..05 | `rg tauri crates/` empty; tests green |
| CORE-07 ⛔ | `HostCommand` internal bus; `system_media` raise/quit → bus; shim subscribes → AppHandle | CORE-06 | SMTC/MPRIS raise/quit manual check on Tauri |
| CORE-08 ⛔ | `CoreConfig` path injection; shim passes Tauri-resolved paths; `bootstrap()` assembles services in §10.2 order | CORE-06 | Tauri smoke: data lands in same dirs (diff vs BASE-04) |

### P2

| ID | Task | Depends | Verification |
|---|---|---|---|
| PROTO-01 ⛔ | `crates/yaqmc-protocol`: envelope, framing codec, `CoreTransport` + `StdioTransport`/`DuplexTransport`, error codes | CORE-01 | §34.2 unit tests |
| PROTO-02 ⛔ | Generate `docs/migration/command-inventory.md`: 117 rows (name, params/result type, owner-after, notes) from `generate_handler!` + frontend string scan (§37.9) | BASE-01 | row count = 117; frontend-referenced = 112; the 5 unreferenced + 1 unregistered commands dispositioned |
| PROTO-03 ⛔ | Method registry (`registry.rs`) from inventory + `MethodSpec` flags | PROTO-02 | registry-vs-dispatch drift test |
| PROTO-04 ⛔ | `server/methods.rs`: dispatch arms for all core-owned methods (bodies from `commands.rs`); shim wrappers shrink to shared-fn calls | PROTO-03, CORE-08 | Tauri full smoke; dispatch unit tests per group |
| PROTO-05 ⛔ | `server/events.rs`: port §3.2 fan-out (channel map, lagged-resync, SMTC feed, queue persist) | CORE-07 | harness observes identical event sequences vs Tauri run (recorded fixture compare) |
| PROTO-06 ⛔ | `yaqmc-core` bin: `main.rs`, handshake, `attach`/`ready`, stdin-EOF shutdown, `core_ping`, `platform_attach`, `core_shutdown_prepare` | PROTO-01,04,05 | handshake + EOF tests |
| PROTO-07 ⛔ | OAuth logic split: `auth_oauth_prepare/complete/cancel` methods; shim window code consumes them (§16.4) | PROTO-04 | Tauri OAuth login manual (QQ+WX) |
| PROTO-08 ⛔ | Integration harness `protocol_e2e.rs` + test-provider feature + §15.6 scenarios 1–4 | PROTO-06 | harness green Win+Linux CI |
| PROTO-09 | Fixture emitter (`--features fixtures`) for contract tests | PROTO-06 | fixtures generated deterministically |

### P3

| ID | Task | Depends | Verification |
|---|---|---|---|
| CLIENT-01 ⛔ | npm workspaces + tsconfig references + package scaffold | BASE-01 | `npm run build -w @yaqmc/client` |
| CLIENT-02 ⛔ | Protocol TS mirror (types/methods/events) seeded from existing frontend types | CLIENT-01, PROTO-02 | tsc strict green |
| CLIENT-03 ⛔ | `HostBridge` + `YaqmcClient` (method groups, event sub, invoke queue-until-ready) | CLIENT-02 | unit tests |
| CLIENT-04 ⛔ | Move seek-coalescing adapter into package; old path re-exports | CLIENT-03 | frontend untouched; Vitest green |
| CLIENT-05 ⛔ | Contract tests over PROTO-09 fixtures + `contracts:update` script | CLIENT-02, PROTO-09 | CI job red-on-drift demo |
| CLIENT-06 | Fake bridge wrapping `fake-music-provider` | CLIENT-03 | browser `?provider=fake` unchanged |

### P4

| ID | Task | Depends | Verification |
|---|---|---|---|
| ELEC-01 ⛔ | Scaffold `apps/desktop` (esbuild main/preload, tsconfig, Electron pinned per §11.6) | CLIENT-01 | `electron .` opens blank window |
| ELEC-02 ⛔ | `core/frames.ts` + `core/client.ts` (framing, promise map, timeouts, event demux) | ELEC-01 | unit tests w/ mock stream |
| ELEC-03 ⛔ | `core/supervisor.ts` v1 (spawn, handshake, exit detection) + `scripts/stage-core.mjs` | ELEC-02, PROTO-06 | dev boot reaches `ready` |
| ELEC-04 ⛔ | `app://` protocol + CSP header + main window per §11.2 + preload `main.ts` (`window.yaqmc`) | ELEC-03 | renderer console round-trip `player_snapshot` |
| ELEC-05 ⛔ | IpcRouter + ACL table (`channels.ts`) incl. host-method interception | ELEC-04 | ACL unit tests (denied method → `host.denied`) |
| SEC-01 ⛔ | CSP port audit vs `tauri.conf.json` (exact directive mapping doc in code comment) | ELEC-04 | CSP header matches §28.3 decision |
| SEC-02 ⛔ | `security.ts`: permission handlers, navigation containment, window-open handler (§28.4–28.5) | ELEC-04 | Playwright: nav to external URL blocked |
| SEC-03 | CI lint: forbidden Chromium switches + preload purity greps (§28.7, §33.5) | ELEC-01 | CI fails on seeded violation |
| VITE-01 | Verify Vite `base`/asset URLs under `app://`; fix if absolute | ELEC-04 | packaged renderer loads assets |
| ELEC-06 ⛔ | First-boot path-parity integration test (scratch profile vs BASE-04) | ELEC-03 | test green Win+Linux |
| ELEC-07 | Move icons → `apps/desktop/resources`; wire builder skeleton config | ELEC-01 | dev app shows icon |
| ELEC-08 ⛔ | CI: Electron build job (build-only, both OS) | ELEC-03 | CI green |
| ELEC-09 | Dev scripts: `dev:desktop` orchestration (§11.5) | ELEC-03 | one-command dev loop |

### P5

| ID | Task | Depends | Verification |
|---|---|---|---|
| SUP-01 ⛔ | Env passthrough audit + allowlist for core spawn (`DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`, locale, `HOME`, platform vars) | ELEC-03 | keyring + MPRIS work from spawned core on Linux |
| SUP-02 | PID-file guard (stale core kill, image-name check — §24) | ELEC-03 | zombie-core test |
| SUP-03 | Core binary sha256 manifest + spawn-time verify (§28.8) | ELEC-03 | tamper test fails closed |
| SUP-04 ⛔ | Backoff/restart/safe-mode state machine + `host://core-status` events + banner component + resync (§14.5) in client | ELEC-05, CLIENT-03 | §34.6 unit + Playwright kill-core E2E |
| SUP-05 ⛔ | Single instance + second-launch focus (§11.4) | ELEC-01 | E2E |
| SUP-06 ⛔ | `TauriHostBridge` (invoke/listen/window APIs) + bridge auto-selection bootstrap | CLIENT-03 | bridge unit tests on Tauri dev build |

### P6

| ID | Task | Depends | Verification |
|---|---|---|---|
| FE-01 ⛔ | Player runtime + adapter re-import onto client (§12.4 row 1) | SUP-06, CLIENT-04 | Tauri smoke + store tests unchanged |
| FE-02 ⛔ | Provider/account/preferences/lyrics bridge files (17-file group) | FE-01 | Tauri smoke; Vitest green |
| FE-03 ⛔ | Plugin-runtime, local-api settings, diagnostics bridges | FE-02 | Tauri plugin battery |
| FE-04 ⛔ | TopBar/window chrome, fullscreen, external links, surfaces (dual drag §12.4) | FE-01 | both-host window controls manual |
| FE-05 ⛔ | ESLint `no-restricted-imports` gate + `isNativeRuntime` sniff removal | FE-01..04 | lint green; grep clean (§33.5) |
| FE-06 | Playwright fake-mode suite covering main UI flows on Electron | FE-01..04, SUP-04 | ~15 scenarios green |

### P7

| ID | Task | Depends | Verification |
|---|---|---|---|
| PLAY-01 ⛔ | §36 P7 row execution (playback/queue/seek/lyrics/catalog/favorites) Win+Linux, fix backlog | FE-05 | rows green incl. L-tests |
| PLAY-02 ⛔ | Seek round-trip p95 measurement vs budget (§15.4) | PLAY-01 | number in perf doc |
| PLAY-03 | `backgroundThrottling` + occluded-window cadence verification | PLAY-01 | lyrics surface cadence unaffected |
| SOAK-01 ⛔ | Soak script + first 4-h run (§35.3) | PLAY-01 | report committed |

### P8

| ID | Task | Depends | Verification |
|---|---|---|---|
| ACCT-01 ⛔ | `oauth-window.ts` (partition, allowlist, capture, cancel-on-close) | SEC-02, PROTO-07 | QQ+WX OAuth manual green |
| ACCT-02 ⛔ | QR login + session staging/refresh re-verify on Electron | PLAY-01 | manual script green |
| ACCT-03 ⛔ | Session-continuity upgrade test (Tauri-login → Electron boot, no re-login) Win/GNOME/KDE | ACCT-02, SUP-01 | recorded demo; R-10 closed |
| ACCT-04 | ACL negative tests (auth methods from surface windows rejected) | ELEC-05 | automated |

### P9

| ID | Task | Depends | Verification |
|---|---|---|---|
| PLAT-01 ⛔ | Tray + menu + close-to-tray + left-click toggle (§26.1) | FE-05 | E2E + manual |
| PLAT-02 ⛔ | Global shortcuts ×3 + failure logging + Wayland guard (§26.2) | PLAT-01 | manual matrix |
| PLAT-03 | Tray i18n dictionary generated from i18next JSON | PLAT-01 | locale switch updates menu |
| PLAT-04 ⛔ | SMTC HWND attach via `platform_attach` (+fallback decision per R-3) | ELEC-04 | Win flyout/media keys/artwork manual |
| PLAT-05 ⛔ | MPRIS re-verify + raise/quit via `host://command` | SUP-01 | playerctl + applets |
| PLAT-06 ⛔ | Local API external-consumer parity (SSE tool smoke) + SUP-02 port note | PLAY-01 | curl/SSE script |
| PLAT-07 ⛔ | `linux-graphics.ts` policy + `platform.rs` env-magic deletion + `YAQMC_LINUX_RENDERER` compat mapping (§29.2) | PLAY-01 | modes logged in diagnostics; env deleted from core |
| SURF-01 ⛔ | `lyrics-surfaces.ts`: create/show/hide desktop+island per §11.2 | ELEC-05 | surfaces render |
| SURF-02 ⛔ | Lock/unlock: click-through, focusable, unlock overlays ×2 | SURF-01 | click-through manual (§22.5) |
| SURF-03 ⛔ | Geometry persistence (350 ms debounce, same keys) + boot restore + multi-display clamp | SURF-01 | restart-restore E2E; BASE-04 key diff = none |
| SURF-04 ⛔ | Fullscreen auto-hide: core Win32 poller → `host://command` → hide/show | SURF-01, PLAT-04 | fullscreen video manual |
| SURF-05 | Surface ACL preloads (`lyrics-surface.ts`, `unlock-overlay.ts`) | SURF-01 | ACL tests |
| SURF-06 | Capability flags + settings banner (§29.3) | PLAT-07 | native-wayland mode shows banner |

### P10

| ID | Task | Depends | Verification |
|---|---|---|---|
| PLUG-01 ⛔ | Example-plugin battery (install/enable/disable/uninstall/permissions/storage) on Electron | FE-03 | §20.3 green |
| PLUG-02 ⛔ | Network proxy allow/deny + safe-mode crash-loop drill | PLUG-01 | manual + journal check |
| PLUG-03 | Worker-isolation runtime test (no `window.yaqmc` in Worker scope) | PLUG-01 | automated |
| PLUG-04 | Scene API v2 demo plugin end-to-end | PLUG-01 | manual |

### P11

| ID | Task | Depends | Verification |
|---|---|---|---|
| PACK-01 ⛔ | Finalize `electron-builder.yml` (appId parity §31.2); re-verify+pin Electron/builder versions | ELEC-07 | local package boots |
| PACK-02 ⛔ | Windows NSIS + portable (x64, arm64) + install/upgrade/uninstall script | PACK-01, CI-03 | clean-VM matrix |
| PACK-03 ⛔ | Linux AppImage/deb/rpm/tar.gz (x64, arm64) | PACK-01, CI-03 | clean-VM matrix |
| PACK-04 | `sync-version.mjs` + build metadata defines parity (§31.3) | PACK-01 | handshake version-equality test |
| CI-01 ⛔ | Rewrite quality job (workspace clippy/test, tsc multi-project, contracts, greps) | FE-05 | CI green |
| CI-02 ⛔ | Electron package matrix jobs + dist-reuse + cargo cache | PACK-02,03 | matrix artifacts |
| CI-03 ⛔ | arm64 story: `aarch64-pc-windows-msvc` core cross-build + `ubuntu-24.04-arm` native | ELEC-08 | arm artifacts boot-tested where hardware allows |
| CI-04 | Release workflow successor (§33.4) + checksums + updater metadata | CI-02 | draft release rehearsal |
| UPD-01 ⛔ | electron-updater wiring (notify-flow, channels, unsigned config §32) | PACK-04, CI-04 | A→B upgrade rehearsal incl. core swap |
| UPD-02 | Settings UI: update section + `host://update` states | UPD-01 | manual |
| DIAG-01 ⛔ | Host log + `diagnostics_host_payload` + bundle extension (§27.3) | SUP-04 | bundle contains host.json + stderr tail |
| DIAG-02 | Issue reporter host line | DIAG-01 | URL contains electron version |
| DIAG-03 ⛔ | Dialog-split methods `_to/_from` ×3 + Main `dialogs.ts` (§27.4) | ELEC-05 | export/background/install flows manual |

### P12

| ID | Task | Depends | Verification |
|---|---|---|---|
| ACC-01 ⛔ | Linux acceptance matrix §29.5 execution + fixes | P8–P11 ⛔ tasks | signed matrix doc |
| ACC-02 ⛔ | Windows acceptance (§30 checks incl. transparency/DWM, arm64 smoke) | P8–P11 | signed |
| ACC-03 ⛔ | Perf budgets gate (§35.2) + second soak | PLAY-02, SOAK-01 | table within budgets |
| ACC-04 ⛔ | Daily-driver week ×2 platforms + bug backlog burn-down | ACC-01,02 | zero P1 bugs open |
| ACC-05 ⛔ | `pre-tauri-removal` tag + §38.1 checklist sign-off | ACC-01..04 | tag pushed |

### P13

| ID | Task | Depends | Verification |
|---|---|---|---|
| REM-01 ⛔ | Execute §38.2 removal inventory (single PR) | ACC-05 | §38.4 sweeps green |
| REM-02 ⛔ | CI Tauri-job deletion + guard-grep exception updates | REM-01 | CI green |
| REM-03 ⛔ | Fresh-clone builds ×3 OS images + packaged smoke | REM-01 | recorded |
| REM-04 | Release-notes draft (i686, size, data-in-place, WebKitGTK removal) | REM-01 | doc committed |

### P14

| ID | Task | Depends | Verification |
|---|---|---|---|
| PROV-01 ⛔ | qm-api-rs access: CI token/insteadOf (or vendor fallback); pin rev `a7430a8` | §17.6 license gate | CI builds provider crate |
| PROV-02 | Workspace dep dedup audit (reqwest/tokio single versions) | PROV-01 | `cargo tree -d` clean |
| PROV-03 | Library logging/redaction audit; wrap if it logs URLs/secrets | PROV-01 | log scan under verbose run |
| PROV-04 | Endpoint coverage audit → final Keep/Hybrid/Replace per §17.4 K rows | PROV-01 | updated table committed |
| PROV-05 ⛔ | `yaqmc-provider-api` trait + registry + core rewire (`PlaybackSourceResolver` over trait) — behavior no-op | REM-03 | full §34.7 pack + parity spot-checks |
| PROV-06 ⛔ | `git mv` qqmusic/* + qmc.rs → `yaqmc-provider-qqmusic`; adapter implements trait | PROV-05 | no-op gate: suites green |
| PROV-07 ⛔ | QMC golden corpus + `qmc` module swap (first Replace) | PROV-06 | byte-identical decrypts |
| PROV-08 ⛔ | Swap batches: lyrics → vkey → transport+signing → QR login/session (+`qqmusic-credential-v2` converter §17.3), each behind feature flag + L-verified | PROV-07 | §17.5 protocol per batch |
| PROV-09 ⛔ | Account/entitlement hybrids (raw ops via library; reconciliation in-tree) | PROV-08 | favorites L-tests |
| PROV-10 ⛔ | 3-day soak → default `qmapi` → retire replaced modules + old keyring entry | PROV-08,09 | parity matrix re-run; dead code deleted |

### P15

| ID | Task | Depends | Verification |
|---|---|---|---|
| CLEAN-01 ⛔ | §38.3 docs updates (architecture, linux, logging TD-7, local-api, README) | REM-04 | docs build (`pages.yml`) green |
| CLEAN-02 | Follow-up issues filed (signing, notifications, deep-link, native-Wayland, TD-3) | — | issue links in doc |
| CLEAN-03 ⛔ | Final full §46 re-run + §47 checklist | PROV-10 (or REM-03 if P14 deferred per R-6) | signed |
| CLEAN-04 | CONTRIBUTING/uninstall/private-dep docs | CLEAN-01 | reviewed |
| CLEAN-05 | Tag `electron-migration-complete`; archive `docs/migration/` scratch | CLEAN-03 | tag pushed |

---

## 42. Task Dependency DAG

Phase-level DAG (task-level edges are in §41's Depends columns):

```mermaid
graph LR
  P0[P0 Baseline] --> P1[P1 Core crate]
  P1 --> P2[P2 Protocol+Server]
  P2 --> P3[P3 Client SDK]
  P2 --> P4[P4 Electron skeleton]
  P3 --> P4
  P4 --> P5[P5 Supervision+Bridges]
  P3 --> P5
  P5 --> P6[P6 Frontend on SDK]
  P6 --> P7[P7 Playback parity]
  P7 --> P8[P8 Account/Auth]
  P7 --> P9[P9 Platform services]
  P7 --> P10[P10 Plugins]
  P7 --> P11[P11 Packaging/Updater]
  P8 --> P12[P12 Acceptance]
  P9 --> P12
  P10 --> P12
  P11 --> P12
  P12 --> P13[P13 Tauri removal]
  P13 --> P14[P14 qm-api-rs provider]
  P13 --> P15[P15 Cleanup/Docs]
  P14 --> P15
```

**Critical path:** P0 → P1 → P2 → P3/P4 → P5 → P6 → P7 → P12 → P13 → P14 → P15. P2 (protocol + dispatch of 117 commands) and P6 (22-file frontend refactor) are the widest work packages; P7–P11 are the parallel fan-out zone.

Key cross-phase task edges (already encoded in §41, repeated for visibility): `PROTO-02 → CLIENT-02` (inventory seeds types); `PROTO-09 → CLIENT-05` (fixtures seed contracts); `SEC-02 → ACCT-01` (nav containment before OAuth); `SUP-01 → ACCT-03/PLAT-05` (env passthrough before keyring/MPRIS verification); `ELEC-04 → PLAT-04` (window handle before SMTC); `CI-03 → PACK-02/03` (arch story before package matrix); `§17.6 license → PROV-01` (the only human gate).

---

## 43. Parallel Execution Plan (multi-subagent guidance)

Maximum useful concurrency without merge pain — lanes are disjoint by directory ownership:

| Window | Lane A (Rust) | Lane B (TypeScript app) | Lane C (Frontend) | Lane D (Infra/QA) |
|---|---|---|---|---|
| P0 | BASE-04 | — | — | BASE-01/02/03/05 |
| P1 | CORE-01..08 (serial-ish; batches 2–5 can pipeline) | — | — | CI branch care |
| P2 | PROTO-01,03..09 | — | — | PROTO-02 (scan tooling) |
| P3 ∥ P4 | harness polish | ELEC-01..09, SEC-01..03, VITE-01 | CLIENT-01..06 | ELEC-08 |
| P5 | — | SUP-01..05 | SUP-06 | — |
| P6 | bugfix support | FE-06 harness | FE-01..05 (serial groups) | — |
| P7 | PLAY fixes | PLAY-03 | PLAY-01 assist | SOAK-01, PLAY-02 |
| P8 ∥ P9 ∥ P10 ∥ P11 | PLAT-04/05, SURF-04, DIAG core side | ACCT-01, PLAT-01..03, SURF-01..06, DIAG-03, UPD-01/02 | ACCT-04, SURF banner UI, UPD-02 UI | PACK-01..04, CI-01..04, DIAG-01 |
| P12 | fix backlog | fix backlog | fix backlog | ACC-01..05 orchestration |
| P13 | REM-01 Rust side | REM-01 TS side | REM-01 frontend side | REM-02/03/04 |
| P14 | PROV-01..10 | — | — | PROV soak logistics |
| P15 | — | — | — | CLEAN-01..05 |

Rules: one lane = one subagent = one directory scope; cross-lane file touches require the lane owner's rebase-first; every ⛔ task merges only through the branch CI; LIVE VERIFY tasks are maintainer-executed (agents prepare scripts, humans hold the account).

---

## 44. Git Checkpoints

Branch model: `feat/electron-migration` (long-lived integration branch, PR'd into `main` at three points: after P2 [optional early merge — co-existence is invisible to users], after P12/P13, after P15). Task work happens in short-lived branches PR'd into the integration branch. Every checkpoint = annotated tag on the integration branch after its phase-exit CI run.

| Checkpoint | Tag | Must be true (verified by CI + scripted checks) |
|---|---|---|
| CHECK-00 | `migration-p0` | baselines committed; suites green |
| CHECK-01 | `migration-p1` | workspace builds; `cargo tree -p yaqmc-core -i tauri` empty; Tauri smoke signed |
| CHECK-02 | `migration-p2` | harness green both OS; 117-row inventory committed; Tauri smoke |
| CHECK-03 | `migration-p3` | contract tests in CI; fake mode intact |
| CHECK-04 | `migration-p4` | Electron boots fake mode both OS; path-parity test green |
| CHECK-05 | `migration-p5` | crash-matrix E2E green; single instance |
| CHECK-06 | `migration-p6` | ESLint gate on; both hosts full UI; store tests unmodified |
| CHECK-07 | `migration-p7` | §36 P7 rows + soak report |
| CHECK-08–11 | `migration-p8..11` | per-phase exits (§40) |
| CHECK-12 | `pre-tauri-removal` | §38.1 complete — **the rollback anchor** |
| CHECK-13 | `migration-p13` | §38.4 verification |
| CHECK-14/A/B/C | `migration-p14*` | per-subphase gates (§40 P14) |
| CHECK-15 | `electron-migration-complete` | §47 checklist |

Commit hygiene: `git mv` in dedicated commits (no content change in the same commit); conventional-commit style matching repo history (`feat(scope):`, `fix(player):` — FACT of existing log); every commit message referencing its task ID.

---

## 45. Rollback Strategy

| Situation | Rollback |
|---|---|
| Any task PR broken | revert PR on integration branch (all PRs revert-clean by construction: moves separated from edits) |
| Phase gate unmet | phase does not exit; no time-boxed overrides; integration branch stays pre-tag |
| Electron fundamentally blocked pre-P13 (e.g. unfixable platform issue) | integration branch still contains a fully working Tauri app at every commit (§40 invariant) — abandon = merge nothing or merge only P1–P2 refactors (which improve the codebase host-agnostically) |
| Disaster discovered post-P13 release | re-release last Tauri build (assets remain on GitHub Releases); user data untouched by design (§18 path parity + §22.6 key freeze mean the Tauri build reads everything the Electron build wrote, **except** new keyring entry `qqmusic-credential-v2` which only exists post-P14 and coexists with the legacy entry until P14-C — the rollback window narrows only at P14-C, which is why P14-C requires the 3-day soak) |
| qm-api-rs regression post-P14-C | revert P14-C PR (restores in-tree modules + dual-write); worst case: users re-login |

The single irreversible moment is deleting the legacy session entry (P14-C). Everything else is a revert or a tag checkout.

---

## 46. Final Acceptance Matrix

Consolidated release gate (P15/CLEAN-03; every row names its §34 method; platforms: **W** = Windows x64 (+arm64 smoke), **L** = Ubuntu X11 + XWayland (+§29.5 extended)):

| # | Acceptance item | Method | Platforms |
|---|---|---|---|
| 1 | Cold boot → logged-in state restored from pre-migration keyring | M/L | W, L |
| 2 | Full §36 parity matrix green | per-row | W, L |
| 3 | §15.6 player consistency pack (harness + UI layers) | A | W, L |
| 4 | §35.2 perf budgets met vs BASE-03 baselines | A/M | W, L |
| 5 | 4-h soak clean (final build) | A | W, L |
| 6 | Crash resilience: core kill → auto-restart → resync ≤ 10 s, UI survives | A | W, L |
| 7 | Clean shutdown: quit → core ack → exit 0, queue restored next boot | A | W, L |
| 8 | Packaged artifacts install/upgrade/uninstall on clean VMs; data survives upgrade in place | M | W (NSIS+portable), L (AppImage/deb/rpm) |
| 9 | Updater rehearsal A→B incl. core binary swap | M | W, L(AppImage) |
| 10 | Local API + SSE external consumer unchanged | A/M | W, L |
| 11 | SMTC/MPRIS full control surface | M | W / L |
| 12 | Surfaces: lock/click-through/geometry/restore/fullscreen-hide(W) | A/M | W, L(X11) |
| 13 | Plugins: §20.3 battery + safe-mode drill | A/M | W, L |
| 14 | Security: ACL negative tests, nav containment, permission denials, no forbidden switches, preload purity | A | W, L |
| 15 | Diagnostics bundle contains core+host sections, redaction verified | A/M | W, L |
| 16 | `rg -i tauri` sweep clean (§38.4 allowlist) | A | repo |
| 17 | qm-api-rs backend default; §17.5 per-module verifications signed (or P14 formally deferred per R-6 with plan note) | L | W, L |
| 18 | Docs truthful (§38.3 list reviewed) | M | repo |
| 19 | CI: quality + package matrix + release workflow green on final SHA | A | all |
| 20 | Fresh-clone contributor build (README steps only) succeeds | M | W, L |

---

## 47. Definition of Done

The migration is done when **all** of the following are simultaneously true on the final release SHA:

1. §46 matrix: 20/20 rows signed with dates, environments, build versions in `docs/migration/acceptance-final.md`.
2. Zero Tauri: no Tauri crates/npm packages/config/code/drag-attrs anywhere (§38.4 mechanical sweeps).
3. The four-crate workspace + `apps/desktop` + `packages/yaqmc-client` structure matches §9.1 (drift documented if any).
4. Protocol v1 frozen: registry, contract fixtures, and TS mirror agree (CI-enforced).
5. Player consistency pack green and the §15.2 mechanisms textually intact (`SeekMailbox`, `session_id`, `snapshot_revision`, `source_generation`, `load_generation` survive with semantics unchanged).
6. qm-api-rs integration complete per §17.4 dispositions **or** explicitly deferred with maintainer sign-off (R-6 path) — no silent middle state.
7. User-upgrade promise holds: a user on the last Tauri release upgrades to the first Electron release and keeps session, queue, preferences, surface geometry, plugins, and local-API token without any manual step (proven in row 1/8 of §46).
8. Rollback promise documented: last Tauri release remains downloadable; §45 table published in release notes.
9. All §41 ⛔ tasks closed; all non-⛔ tasks closed or converted to filed follow-up issues (CLEAN-02).
10. `main` contains the full history with intact `git log --follow` for every moved file.

---

## 48. GPT-5.6 Sol Ultra Execution Handoff

### 48.1 Reading order (first session)

1. This document top-to-bottom once (it is the contract).
2. Then, with code open: §15.2 against `player.rs`/`playback_session.rs` (learn the crown jewels); §3.2 against `lib.rs:208-295`; §37 against the real tree.
3. `docs/migration/*` artifacts as they appear (your predecessors' ground truth).

### 48.2 First actions

```
git checkout -b feat/electron-migration bc55b7ddd2a57cde8987c96c7c20f0b7d4a2e742
# execute BASE-01..05 (P0), then proceed strictly by §41 order + §42 edges
```

### 48.3 Decision authority

- **You decide freely:** naming inside new files, test organization, PR slicing within a task, TS/Rust idioms, esbuild/vite plumbing details.
- **You verify-then-follow:** anything tagged VERIFIED (re-check versions at execution time: Electron stable major, electron-builder current, Playwright Electron API), anything tagged NEEDS ACCEPTANCE TEST (run the named test, then take the plan's named fallback if it fails), anything tagged LIVE VERIFY (prepare scripts; the maintainer executes with a real account).
- **You never decide:** the §6 ADRs, §15.2 semantics, wire-format/name changes (ADR-004), scope additions (§20.4/§26.3-style non-goals), phase reordering across §42 edges, anything in §2's git safety rules.
- **You escalate to the maintainer:** §17.6 license gate; any budget overrun after profiling (R-7); any parity row that cannot reach green with the plan's fallbacks; credentials/accounts for LIVE VERIFY.

### 48.4 Standing execution rules

- A task is done when its Verification column is demonstrably true — paste the evidence (test output, screenshot, doc link) into the PR.
- Never modify a test to make it pass unless the task explicitly lists that test edit (R-14). Store tests changing = you broke a frozen semantic.
- Keep the §40 global invariant: every merge leaves a shippable app.
- When the code contradicts this plan, the code wins for facts and the plan wins for decisions; record every such delta in `docs/migration/plan-deltas.md` and continue — do not stall, do not silently diverge.
- When both hosts exist (P4–P12), test on Tauri after every frontend-touching merge; it is the users' daily build until P13.

### 48.5 The one-paragraph mission

Replace the host, not the soul: YAQMC's playback authority, provider behavior, plugin contract, data, and users' logged-in sessions must pass through this migration untouched, while WebKitGTK, env-var magic, and Tauri coupling leave the codebase. Every phase ships a working app; every claim has a test; every risk has a named fallback. Execute §41 in §42 order, and when in doubt, re-read §15.

---

*End of plan. 48 sections, 16 phases, 115 tasks, 16 checkpoints, 15 risks. Source SHA `bc55b7d`; plan date 2026-08-16.*
