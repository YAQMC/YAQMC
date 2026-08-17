# Parked LIVE VERIFY / hardware / provenance (2026-08-18)

This is the handoff for a later, higher-capability pass. **Do not tick these green
from YAML, scripts, or checklists.** Code and dry-run docs already exist; the
rows below are still empty.

Branch: `feat/electron-migration`. Do **not** cut a new branch. `main` is frozen.
Do **not** start P12 ACC, P13 Tauri removal, or P14 `qm-api-rs`. Electron stays
**43.4.0**. The 32 MiB protocol hard cap is unchanged.

## GitHub Actions freeze

YAQMC org Actions quota (**2000** minutes) is exhausted. 2026-08-17 GitHub had a
global outage. **Do not dispatch** `ci.yml`, `build.yml`, `electron-release.yml`,
or `pages.yml`. CI-02 / CI-04 jobs exist on disk only; they are not live-green.

Local `npm test`, `npm run test -w @yaqmc/desktop`, `npm run typecheck`, and
`node --test scripts/ci/*.test.mjs` are fine. Do not run a 4-hour soak in an
agent. Do not invent PLAY-02 p95.

## Parked rows

| Item                                   | Catalog ID       | Code / docs landed                                                                              | Still not green                                           | How to finish (later)                                                                                                   |
| -------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Playback / catalog / lyrics L-rows     | PLAY-01          | `docs/migration/p7-playback-checklist.md`; fake assist `scripts/migration/p7-fake-playback.mjs` | Windows/Linux boxes empty; **L** rows LIVE VERIFY pending | Maintainer fills the checklist on Win+Linux with a real QQ account. Do not invent ticks.                                |
| SMTC flyout / media keys / artwork     | PLAT-04          | `platform_attach` HWND from Electron Main; Core applies HWND                                    | Flyout, media keys, artwork, timeline seek                | Win11 live SMTC. Fallback is ADR-009 hidden message window (R-3) only after flyout rejects the HWND.                    |
| MPRIS playerctl / applets              | PLAT-05          | `scripts/migration/plat05-mpris-playerctl.mjs` dry-run; Core Raise/Quit on `host://command`     | `playerctl --execute`, GNOME/KDE applets                  | Linux only. Default stays dry-run. `--execute` still does not tick applet rows by itself.                               |
| Clean-VM install / upgrade / uninstall | PACK-02, PACK-03 | NSIS/portable + AppImage/deb/rpm/tar.gz scripts and empty matrices                              | Every clean-VM cell                                       | Unsigned (R-9). Do not silent-install. Data must survive under `org.yaqmc.desktop`.                                     |
| 4-hour soak                            | SOAK-01          | `scripts/soak-electron.mjs` default **10 s**; `docs/migration/soak-p7.md`                       | 4-h report uncommitted                                    | `YAQMC_SOAK_SECONDS=14400`. Fake + one real-account run on Win+Linux. Leave `soak-last.json` gitignored until accepted. |
| Provenance release gate                | P0 / CLEAN       | `docs/migration/provenance-audit.md`, `provenance-ledger.json`                                  | **BLOCKED**                                               | `npm run provenance:enforce` stays non-zero until every blocker has typed evidence. Do not claim green.                 |

Related parked (same later pass, not this overlay's headline list):

- PLAY-02 seek p95: script prints PENDING; do not invent a number.
- PLAY-03 occluded-window cadence vs Tauri.
- ACCT-02 / ACCT-03 live QQ + WeChat + R-10.
- SURF-04 real fullscreen auto-hide.
- UPD-01 A→B against a draft release (needs GitHub; blocked by the Actions freeze).
- CI-03 arm64 boot-test; CI-02/CI-04 live matrix/draft.

## Plan book

Canonical overlay: `YAQMC_ELECTRON_MIGRATION_PLAN.md` §49.
Deltas: `docs/migration/plan-deltas.md` heading `P11 overlay: parked LIVE VERIFY and Actions freeze`.
