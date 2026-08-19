# P12 acceptance tracker (ACC-01..04)

Opened **2026-08-20** under
[`p12-conditional-entry.md`](p12-conditional-entry.md). This is **not**
ACC-05 sign-off and **not** P11 PASS.

| Field | Value |
| --- | --- |
| Branch | `feat/electron-migration` (`main` frozen) |
| Implementation HEAD | `27d10b0964c150ba75cf60f1c3e3ae2eaea37dce` |
| Pins | Electron **43.4.0**, builder **26.15.7**, updater **6.8.6**, protocol **32 MiB** |
| P12 execution | **Allowed** (ACC-01..04) |
| P12 final exit | **Conditional** — ACC-05 blocked |
| P13 | **Blocked** |

**Current Status** is this file. Historical FAIL / oral / AUTO notes must not
override a newer maintainer **PASS-HUMAN**. Do not flatten AUTO→HUMAN.
Do not mark an entire ACC-01..04 row PASS just because a prerequisite
catalog ID passed.

Ledgers (history / evidence, not Current Status):

- Windows AUTO/LIVE: [`qa-agent-2026-08-19.md`](qa-agent-2026-08-19.md)
- Linux HUMAN oral (2026-08-19 session): [`linux-human-2026-08-19.md`](linux-human-2026-08-19.md)
- Frozen `1d6b535` snapshot: [`HANDOFF_2026-08-18.md`](HANDOFF_2026-08-18.md)

`p7-playback-checklist.md` per-cell boxes stay empty (no dated Win/Linux
tick grid). Catalog **PLAY-01** Current Status is PASS-HUMAN below. Do not
dispatch GitHub Actions.

---

## Status vocabulary (P12)

HANDOFF vocabulary still applies. Extra labels used here:

| Status | Meaning |
| --- | --- |
| **BLOCKED-EXTERNAL** | External execution blocker (Actions quota). Not an implementation FAIL. |
| **DEFERRED** | Intentionally postponed by the maintainer. Not started, not FAIL. |
| **SEEDED** | Prior HUMAN/LIVE/AUTO imported. Not a new test run. |

---

## P11 (not PASS) — preserved

| ID | Status |
| --- | --- |
| CI-01..04 live GitHub evidence | **BLOCKED-EXTERNAL** |
| UPD-01 A→B live evidence | **BLOCKED-EXTERNAL** |
| PLUG-01/02 full HUMAN battery | **DEFERRED** (install-from-file ACL path remains prior PASS-HUMAN) |
| PACK-01..03 clean-VM matrix | **DEFERRED** |
| Provenance / CLEAN | **BLOCKED** (unchanged; not this waiver) |

---

## Current Status — maintainer-confirmed HUMAN (2026-08-20)

These catalog rows are **PASS-HUMAN** on HEAD `27d10b0` unless noted. Do not
re-run them unless a later change invalidates them.

| ID / item | Current Status | History (do not use as Current Status) |
| --- | --- | --- |
| PLAY-01 (Repeat One/All/Off; EOS → Next/Previous/Pause-Resume; EOS → seek back; rapid seek) | **PASS-HUMAN** historically; **REGRESSION-SUSPECT** (retest required after clock fix) | Maintainer-signed on `27d10b0`. 2026-08-20 ACC-04 session observed a new playhead stall (`isPlaying=true`, `positionMs` frozen). That session is defect evidence, not permission to rewrite the HUMAN row. |
| PLAY-02 | **PASS-HUMAN** | Assist script still prints PENDING; no invented millisecond. Current Status is HUMAN, not the script. |
| SOAK-01 first 4h Windows + Linux | **PASS-HUMAN** | Default 10 s script ≠ this result. `soak-last.json` stays gitignored. This is the **first** soak, not the P12 second soak. |
| Desktop Lyrics | **PASS-HUMAN** | FAIL-HUMAN after `2604045`; chrome-while-locked leak on `f864482`. Fix `27d10b0`. Superseded. |
| Lyrics Island | **PASS-HUMAN** | FAIL-HUMAN after `2604045`; PASS on `f864482`; still PASS on `27d10b0`. |
| SURF-02 | **PASS-HUMAN** on `27d10b0` | FAIL-HUMAN reopened 2026-08-19. Superseded. |
| SURF-03 | **PASS-HUMAN** | Linux Wayland skip in the 2026-08-19 oral ledger is history, not Current Status. |
| PLAT-01 | **PASS-HUMAN** | Prior OS-icon NOT TESTED / Linux oral. Superseded. |
| PLAT-02 Windows | **PASS-HUMAN** | Earlier Settings-toggle FAIL. Linux Wayland remains **skip** (cannot register). |
| PLAT-04 Windows SMTC (session) | **PASS-HUMAN** | Flyout / physical media keys / artwork extras not claimed. |
| PLAT-05 | **PASS-HUMAN** | Prior dry-run / oral. Superseded. |
| PLAT-07 | **PASS-HUMAN** | Prior Linux oral. Superseded. |
| ACCT-01 QQ OAuth | **PASS-HUMAN** | Checklist boxes were empty. Superseded. |
| ACCT-01 WeChat OAuth | **PASS-HUMAN** | same |
| ACCT-02 QR | **PASS-HUMAN** | same |
| ACCT-03 Tauri → Electron continuity | **PASS-HUMAN** | R-10 / recorded demo was NOT TESTED. Superseded. |
| FE-04 host ops (min/max/close/GitHub/logs/ZIP/background) | **PASS-HUMAN** | FE-04 as a **phase** still not separately signed. |
| Volume / main playback steady-state / progress-drag / PlayerBar visual / lyrics route transitions | **PASS-HUMAN** | After `2604045`. Intermediate `eb31ba5` FAILs are history. |
| SURF-04 Windows fullscreen hide/restore (**window**) | **PASS-HUMAN** | Real fullscreen game/video overlay still not this row. |
| Plugin install-from-file past ACL | **PASS-HUMAN** | Full PLUG-01/02 battery **DEFERRED**. |
| Existing-session restore | **PASS-LIVE** | Not a substitute for ACCT-01/02; those are now PASS-HUMAN anyway. |

PLAY-02 and SOAK-01 are **not** ACC-03 **entry** blockers. ACC-03 still has
its own remaining cells (other §35.2 metrics + **second** soak).

### Playhead stall (2026-08-20) — defect, not ACC evidence

Rodio only updates `Player::get_pos()` from the mixer `periodic_access`
callback. When the CPAL stream stops pulling without firing the device-error
callback, Core still sees `playing=true`, `paused=false`, `ended=false`,
matching generations, and copies the frozen mutex into `positionMs`. Seek
writes that mutex directly (a new frozen value). `player_next` loads a new
source that then stays at 0. Transport IPC remains up. Mid-track EOS skip
correctly does **not** fire (remaining ≫ 15 s).

This was **not** a stale-Core / missing-clock issue: ACC-04 `host.log` started
`E:\cargo-target\yaqmc-electron-migration\debug\yaqmc-core.exe` and Core logged
`clock eos-gate 2026-08-18c`.

The worker now nudges `play()` and rebuilds the output stream when `get_pos()`
is frozen while logically playing. `session_id` / snapshot / seek / source /
load generations, SeekMailbox, and EOS fencing are unchanged.

AUTO coverage is in Core (`player::tests` live clock +
`qa_play01_production` fixture/QQ position-advance). **HUMAN** must still
revalidate play → clock advances, pause/resume, seek continues, next/previous,
and Repeat One EOS. Do **not** restart ACC-04 Day 1, ACC-03 playing CPU /
lyrics jitter, or the P12 second soak until that HUMAN pass.

---

## Remaining P12 cells (ACC-01..04)

None of ACC-01..04 is signed. Remaining work only:

### ACC-01 Linux §29.5 — not signed

Catalog rows above do **not** complete the distro/environment matrix.

| Remaining cell | Status | Notes |
| --- | --- | --- |
| Ubuntu LTS, X11, Intel/AMD — full §46 | **environment unavailable** on this Windows worktree | No WSL distro installed (`wsl.exe -l -v`). Not fabricated. |
| Fedora current, GNOME Wayland + native-wayland banner | **environment unavailable** | same |
| Arch + Hyprland, NVIDIA — boot/playback/surfaces best-effort | **environment unavailable** | same |
| KDE Plasma X11 + Wayland — tray, MPRIS applet, surfaces | **environment unavailable** | same |
| SURF-06 xwayland copy | **environment unavailable** | Native-wayland banner was oral on the default box; not listed in the 2026-08-20 PASS-HUMAN set. |
| PLAY-03 Linux occluded cadence vs Tauri | oral only / environment unavailable here | Cover-window 2026-08-19 oral. Not PLAY-03 signed. |
| PLAT-03 tray language | oral only / environment unavailable here | Not in the 2026-08-20 PASS-HUMAN set. |

Ubuntu Wayland (XWayland backend) feature rows for playback/surfaces/tray/MPRIS
are covered by Current Status PASS-HUMAN on the default Wayland box. That
environment is **not** a signed §29.5 cell. PLAT-02 stays **skip** on Wayland
(Windows already PASS-HUMAN). Do not retest PASS-HUMAN catalog rows there.

### ACC-02 Windows §30 — not signed

SURF-02 / Desktop Lyrics / Island / PLAY-01 / SURF-03 / ACCT-01..03 are
**not** remaining.

| Remaining cell | Status | Notes |
| --- | --- | --- |
| Transparency / DWM artifacts | AUTO CSS + screenshot; **HUMAN remaining** | Daily-driver CDP 9232: `.app-shell` `backgroundColor=rgba(0,0,0,0)`; topbar/artwork `backdrop-filter: none` / `filter: none`. Screenshot `output/acc02-dwm-daily-driver.png`. Do not auto-PASS the §30 HUMAN cell. |
| Long-path profile dirs | **PASS-AUTO under 260**; over MAX_PATH **not classified as product FAIL** | `LongPathsEnabled=0` (OS policy). §30 requires Core paths via `std::path` (parity). Distinguish environment limitation from application failure. Unicode is a separate row. |
| Unicode profile dirs | **PASS-AUTO** | Isolated `验收-日本語-프로필` APPDATA/LOCALAPPDATA; `core ready`. Not HUMAN. |
| PLAY-03 Windows occluded / minimized lyric clock | **not passed** | Fake-track E2E: clock does not advance even while visible (`positionMs` stuck). Daily-driver CDP: `document.hidden` stayed `false` on minimize; playhead already stalled (see ACC-04). Linux oral ≠ this cell. |
| Windows arm64 smoke | **BLOCKED-EXTERNAL** | CI-03 live evidence. Not executable under the Actions freeze. Do not treat a local `pack:win` arm64 unpack as CI-03. |
| SURF-04 real fullscreen game/video overlay | NOT TESTED | Window hide/restore already PASS-HUMAN. Parked extra, not the next catalog row. |

UI-PERF as a **phase** is still not accepted. Individual playback HUMAN rows
stay accepted and are not remaining cells.

### ACC-03 §35.2 + second soak — not signed

Entry is allowed: PLAY-02 and SOAK-01 first 4h are PASS-HUMAN.

| Remaining cell | Status | Notes |
| --- | --- | --- |
| Cold start to interactive vs BASE-03 + 1.5 s | Electron captured; **vs-budget PENDING** | Vite-dev median **598 ms** (3 runs) to `.app-shell` + `core ready`. Packaged cold start not this. BASE-03 still PENDING. See [`acc03-windows.md`](acc03-windows.md). |
| Idle RSS vs baseline + 250 MB | Electron captured; **vs-budget PENDING** | Electron spawn tree **597.3 MiB** after 60 s. BASE-03 still PENDING. |
| Playing CPU vs baseline + 2 pp | **INVALID** | Sample taken while the playback clock was stalled. Not acceptance evidence. Redo after the clock defect is HUMAN-closed. |
| Lyrics position-update jitter (manual A/B, 120 s) | **VACUOUS / INVALID** | maxAbsLineDelta 0 because `positionMs` did not move. Redo after the clock defect is HUMAN-closed. |
| Installer size ≤ 120 MB / platform | **not produced** (external/network) | NSIS tool fetch `ETIMEDOUT 199.59.148.9:443`. Not a product FAIL. PACK clean-VM remains **DEFERRED**. |
| P12 **second** soak (Win+Linux, fake + real-account, 4h) | **NOT STARTED** | Do not start until the playhead stall is HUMAN-closed. First SOAK-01 ≠ this soak. |

Seek p95 is Current Status **PLAY-02 PASS-HUMAN**. Do not invent a number.

### ACC-04 daily-driver week — not signed

ACCT-03 continuity PASS-HUMAN is **not** a week of daily-driver use.

| Remaining cell | Status |
| --- | --- |
| Windows day-1 through week, zero P1 | 2026-08-20 01:49 +08 session is **defect-discovery only**, not a completed Day 1. Restart Day 1 from a new timestamp only after HUMAN confirms the clock regression is gone. |
| Linux day-1 through week, zero P1 | **not started** — no Linux/WSL distro on this worktree. Not fabricated. |

HUMAN GATE. Log: [`acc04-daily-driver.md`](acc04-daily-driver.md).

---

## Shortest non-redundant sequence

1. **ACC-01** remaining §29.5 environments (Linux maintainer). Do not retest
   PLAY-01 / SURF-02 / Desktop / Island / SURF-03 / PLAT-01/05/07 / ACCT-01..03.
   Do not switch the default Wayland session to X11 only to fill PLAT-02.
2. **ACC-02** remaining §30 cells: DWM/transparency, long-path/unicode.
   Skip arm64 until CI-03 is not BLOCKED-EXTERNAL. Skip SURF-02 / PLAY-01.
3. **ACC-03** remaining §35.2 rows + P12 second soak. PLAY-02 / first SOAK-01
   are done.
4. **ACC-04** record day 1 on each platform and run the week.
5. **HARD STOP.** Do not start ACC-05 / P13.

---

## ACC-05 / P13 — hard stop

Do **not** treat this file as signed. Do **not** push tag `pre-tauri-removal`.
Do **not** start §38.1 as complete. Do **not** start P13.

Resume ACC-05 only after
[`p12-conditional-entry.md`](p12-conditional-entry.md) hard-stop items 1–4.
