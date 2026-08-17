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

Current settings (do not edit these files in this checkpoint; SURF-03 owns lyrics surfaces):

| Surface                 | File                                                                          | `webPreferences.backgroundThrottling` |
| ----------------------- | ----------------------------------------------------------------------------- | ------------------------------------- |
| Main window             | `apps/desktop/main/index.ts`                                                  | `false`                               |
| Desktop + island lyrics | `apps/desktop/main/windows/lyrics-surfaces.ts` (`lyricsSurfaceCreateOptions`) | `false`                               |
| Unlock overlays         | `apps/desktop/main/windows/lyrics-unlock.ts`                                  | `false`                               |

Lyrics surfaces already set `backgroundThrottling: false`. Occluded-window cadence vs Tauri is **not** verified here (PLAY-03 still open). Electron stays **43.4.0**. The 32 MiB protocol hard cap is unchanged. No Playwright.
