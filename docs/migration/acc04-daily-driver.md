# ACC-04 dual-platform daily-driver log

Opened **2026-08-20** under [`acceptance-p12.md`](acceptance-p12.md).
This is a **HUMAN GATE**. Do not fabricate missed days. Agent-observed
minutes are not a completed calendar day. The 2026-08-20 01:49 +08 Windows
run is **defect-discovery only** (playhead stall, later closed on `e7a6c06`).
It must not count as completed Day 1. Clock is HUMAN-closed; **do not**
restart Day 1 while **UI-PERF Windows Lyrics = FAIL-HUMAN** (pause can
probabilistically stall fullscreen Lyrics FPS). GPU-on Pause A/B hang after
vinyl was a **perf harness hang** (unbounded rAF/CDP wait); a watchdog GPU-on
probe then completed 38 Pause cycles at ~200 FPS. That is not HUMAN closure.
That session’s performance numbers are untrusted.

Electron **43.4.0**. Docs HEAD `230c5d59d82f3a235bb11fb71d9ab0d8a89b95d8`
(implementation `27d10b0`). Vite-dev + debug Core. Do not install PACK
artifacts into this profile. Do not dispatch Actions.

| Platform | Day | Date (local) | Started | Duration recorded | Profile | Issues |
| --- | --- | --- | --- | --- | --- | --- |
| Windows | 1 | 2026-08-20 | 2026-08-20 01:49:29 +08 | still running at 2026-08-20 02:11 +08 (~21 min agent-observed; **not** a completed day) | `%APPDATA%\org.yaqmc.desktop`, CDP `9232`, Vite `127.0.0.1:1420`, `YAQMC_CORE_BIN` debug `yaqmc-core.exe` | Playhead stall: `playbackState=playing` / `isPlaying=true` but `positionMs` does not advance. Seek updates the stored position. `player_next` changes track (`一点点…` → `Fall In Love`) then new track stays at `0`. Pause/resume toggles state only. FPS overlay was live (~218 FPS). Not a signed PLAY-01 retest. |
| Linux | 1 | — | **not started** | — | — | This Windows worktree has no WSL distro (`wsl.exe -l -v` reports none installed). Not fabricated. |

Zero P1 required to sign the week. ACC-04 is **not** signed from day 1.
Keep the Windows session running; do not count this row as a finished day.
