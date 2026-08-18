# SOAK-01 / PLAY-03 Electron soak notes

P7 first soak and `backgroundThrottling` notes. **PLAY-01 is not green.** LIVE VERIFY (real QQ account) is maintainer-only. Do not start `qm-api-rs`. Provenance remains **BLOCKED**. The first 4-hour report stays uncommitted (`PENDING`).

## Fake-provider soak (CI/dev)

Default duration is **10 seconds** so CI and local runs stay safe:

```bash
node scripts/soak-electron.mjs
```

Override with `YAQMC_SOAK_SECONDS`. The script loops a fake player (`snapshot` + `seek`), records RSS via `process.memoryUsage().rss` when available, and writes `docs/migration/soak-last.json` (gitignored).

This is not a 4-hour soak and does not claim SOAK-01 green.

## Maintainer 4-hour run (Windows + Linux)

Plan §35.3: 4-hour scripted playback loop, fake provider **and** one real-account session (two runs) on Windows + Linux. Assert no RSS growth > 10 %, no handle/fd leak, no snapshot-revision stall, no supervisor restarts, log error rate ~0.

```bash
# 14400 seconds = 4 hours. Do not commit the report.
YAQMC_SOAK_SECONDS=14400 node scripts/soak-electron.mjs
```

On Windows PowerShell:

```powershell
$env:YAQMC_SOAK_SECONDS = '14400'
node scripts/soak-electron.mjs
```

Copy `docs/migration/soak-last.json` off to the side if you need to keep it; leave it uncommitted until a maintainer accepts the first 4-h capture. Real-account soak remains **LIVE VERIFY pending**.

## PLAY-02 seek p95

`node scripts/migration/play02-seek-p95.mjs` documents how to measure UI-event → settled-snapshot p95 against §15.4 (added latency target < 5 ms p95) and §35.2 (≤ baseline + 5 ms). The measured Windows/Linux cells stay **PENDING**. Do not invent a green number. The existing Seek round-trip p95 rows in `docs/migration/perf-baseline.md` stay PENDING.

## PLAY-03 `backgroundThrottling`

Host windows keep Chromium from throttling timers when occluded. Do not treat this table as PLAY-03 green.

| Surface                 | File                                                                          | `webPreferences.backgroundThrottling` |
| ----------------------- | ----------------------------------------------------------------------------- | ------------------------------------- |
| Main window             | `apps/desktop/main/index.ts`                                                  | `false`                               |
| Desktop + island lyrics | `apps/desktop/main/windows/lyrics-surfaces.ts` (`lyricsSurfaceCreateOptions`) | `false`                               |
| Unlock overlays         | `apps/desktop/main/windows/lyrics-unlock.ts`                                  | `false`                               |
| OAuth window            | `apps/desktop/main/windows/oauth-window.ts`                                   | `false`                               |

In-app lyrics (`src/components/lyrics-scene/LyricsViewport.tsx`) used to stop the line-boundary `setTimeout` and word `requestAnimationFrame` while `document.hidden`. That pause is removed: the clock follows `isPlaying` only, matching desktop/island `LyricsSurfaceApp` (those surfaces never checked visibility). Unit coverage is in `src/components/LyricsPanel.test.tsx` (hidden + playing keeps the timer/frame; seek while hidden moves the cursor).

Linux HUMAN cover-window on this Wayland session was **oral OK** (2026-08-19 01:58). The maintainer noted it may be platform-dependent: covering a window here may not set Page Visibility (`document.hidden` is more typical on minimize / workspace switch). Windows occlusion/minimize is **untested**. Occluded cadence vs Tauri is still unmeasured.

PLAY-03 is **not** accepted. Electron stays **43.4.0**. The 32 MiB protocol hard cap is unchanged. No Playwright.
