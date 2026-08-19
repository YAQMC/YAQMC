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
| PLAY-01 (Repeat One/All/Off; EOS → Next/Previous/Pause-Resume; EOS → seek back; rapid seek) | **PASS-HUMAN** | Windows FAIL-HUMAN after `1d6b535` (stuck player). Later AUTO/Linux oral. Superseded. |
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

---

## Remaining P12 cells (ACC-01..04)

None of ACC-01..04 is signed. Remaining work only:

### ACC-01 Linux §29.5 — not signed

Catalog rows above do **not** complete the distro/environment matrix.

| Remaining cell | Status | Notes |
| --- | --- | --- |
| Ubuntu LTS, X11, Intel/AMD — full §46 | NOT TESTED | Do not move the default Wayland session to X11 only to fill PLAT-02. |
| Fedora current, GNOME Wayland + native-wayland banner | NOT TESTED | SURF-06 native-wayland was the maintainer box, not Fedora. |
| Arch + Hyprland, NVIDIA — boot/playback/surfaces best-effort | NOT TESTED | |
| KDE Plasma X11 + Wayland — tray, MPRIS applet, surfaces | NOT TESTED | PLAT-05 PASS-HUMAN does not auto-sign this environment cell. |
| SURF-06 xwayland copy | NOT TESTED | Native-wayland banner was oral on the default box; not listed in the 2026-08-20 PASS-HUMAN set. |
| PLAY-03 Linux occluded cadence vs Tauri | oral only | Cover-window 2026-08-19 oral. Not PLAY-03 signed. |
| PLAT-03 tray language | oral only | Not in the 2026-08-20 PASS-HUMAN set. |

Ubuntu Wayland (XWayland backend) feature rows for playback/surfaces/tray/MPRIS
are covered by Current Status PASS-HUMAN on the default Wayland box. That
environment is **not** a signed §29.5 cell. PLAT-02 stays **skip** on Wayland
(Windows already PASS-HUMAN). Do not retest PASS-HUMAN catalog rows there.

### ACC-02 Windows §30 — not signed

SURF-02 / Desktop Lyrics / Island / PLAY-01 / SURF-03 / ACCT-01..03 are
**not** remaining.

| Remaining cell | Status | Notes |
| --- | --- | --- |
| Transparency / DWM artifacts | NOT TESTED as a signed §30 cell | Do not re-run already-accepted playback FPS HUMAN rows to fill this. |
| Long-path + unicode profile dirs | NOT TESTED | Named in §30; no HUMAN record. |
| PLAY-03 Windows occluded / minimized lyric clock | NOT TESTED | Linux oral ≠ Windows. |
| Windows arm64 smoke | **BLOCKED-EXTERNAL** | CI-03 live evidence. Not executable under the Actions freeze. |
| SURF-04 real fullscreen game/video overlay | NOT TESTED | Window hide/restore already PASS-HUMAN. Parked extra, not the next catalog row. |

UI-PERF as a **phase** is still not accepted. Individual playback HUMAN rows
stay accepted and are not remaining cells.

### ACC-03 §35.2 + second soak — not signed

Entry is allowed: PLAY-02 and SOAK-01 first 4h are PASS-HUMAN.

| Remaining cell | Status | Notes |
| --- | --- | --- |
| Cold start to interactive vs BASE-03 + 1.5 s | PENDING | BASE-03 Tauri live cells were still PENDING in `perf-baseline.md`. PLAY-02 PASS does not fill this. |
| Idle RSS vs baseline + 250 MB | PENDING | same |
| Playing CPU vs baseline + 2 pp | PENDING | same |
| Lyrics position-update jitter (manual A/B, 120 s) | NOT TESTED as ACC-03 | PLAY-01 lyrics PASS-HUMAN is not this capture. |
| Installer size ≤ 120 MB / platform | PENDING | No ACC-03 artifact capture. PACK clean-VM remains **DEFERRED**. |
| P12 **second** soak (Win+Linux, fake + real-account, 4h) | NOT TESTED | SOAK-01 first 4h PASS-HUMAN does not complete ACC-03's second soak. Do not run 4h in an agent. |

Seek p95 is Current Status **PLAY-02 PASS-HUMAN**. Do not invent a number.

### ACC-04 daily-driver week — not signed

ACCT-03 continuity PASS-HUMAN is **not** a week of daily-driver use.

| Remaining cell | Status |
| --- | --- |
| Windows day-1 through week, zero P1 | awaiting maintainer day 1 |
| Linux day-1 through week, zero P1 | awaiting maintainer day 1 |

HUMAN GATE. Log opened 2026-08-20.

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
