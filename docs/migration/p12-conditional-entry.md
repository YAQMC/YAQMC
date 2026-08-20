# P12 conditional-entry waiver (2026-08-20)

This is a **maintainer decision**, not a P11 exit and not a product FAIL.

GitHub Actions org quota is exhausted. **CI-01..04** and **UPD-01** therefore
cannot obtain **live** GitHub evidence. That is an **external execution
blocker**. YAML, local gates, and in-tree updater wiring still exist. Do not
treat the freeze as an implementation regression, and do not idle the
migration by refusing to start P12 work that has no technical dependency on
those live rows.

Branch: `feat/electron-migration`. `main` is frozen. Electron stays
**43.4.0**. The 32 MiB protocol hard cap is unchanged. Do **not** dispatch
`ci.yml`, `build.yml`, `electron-release.yml`, or `pages.yml`. Do **not**
remediate provenance. Do **not** start P13–P15, `qm-api-rs`, `main` cutover,
or Tauri removal.

Living ACC tracker: [`acceptance-p12.md`](acceptance-p12.md). Plan overlay:
`YAQMC_ELECTRON_MIGRATION_PLAN.md` §49.4.

---

## Decision

**Start P12 now** under this waiver.

| Gate                                          | Status after this waiver                            |
| --------------------------------------------- | --------------------------------------------------- |
| P11 fully PASS                                | **No.** Do not mark P11 complete.                   |
| P12 execution (ACC-01..04)                    | **Allowed**                                         |
| P12 final exit (ACC-05 / `pre-tauri-removal`) | **Conditional — blocked** until the hard stop below |
| P13                                           | **Blocked**                                         |

## Preserved P11 statuses (do not green these)

These labels are **not** product failures:

| ID                          | Status               | Meaning                                                                                                                                                   |
| --------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI-01                       | **BLOCKED-EXTERNAL** | Quality-job YAML and local gates exist. Live GitHub Actions evidence cannot be obtained while quota is exhausted.                                         |
| CI-02                       | **BLOCKED-EXTERNAL** | Electron package-matrix YAML exists. No live matrix artifacts.                                                                                            |
| CI-03                       | **BLOCKED-EXTERNAL** | Arm64 boot-test evidence cannot be obtained from live Actions (hardware/runner path included). Docs/print scripts are not live-green.                     |
| CI-04                       | **BLOCKED-EXTERNAL** | Draft-release workflow exists on disk. Not dispatched.                                                                                                    |
| UPD-01                      | **BLOCKED-EXTERNAL** | Notify-only updater is wired. A→B incl. core swap needs a draft release / GitHub, which this freeze blocks.                                               |
| PLUG-01                     | **DEFERRED**         | Full example-plugin HUMAN battery deferred. Install-from-file ACL path remains prior **PASS-HUMAN**. PASS-AUTO battery is unchanged.                      |
| PLUG-02                     | **DEFERRED**         | Proxy / safe-mode HUMAN journal deferred. PASS-AUTO `plug02` is unchanged.                                                                                |
| PACK-01..03 clean-VM matrix | **DEFERRED**         | Builder pin and pack scripts remain in tree. Every clean-VM install/upgrade/uninstall cell stays unsigned and unrun. Local `pack:dir` is not that matrix. |

**Provenance / CLEAN** stays **BLOCKED** (license/audit gate, not this quota).
It is still not a P12-entry prerequisite and is still not a P12-exit
prerequisite. Public-distribution / P14 **PROV-01** only.

## What this waiver permits

Execute P12 acceptance that has **no technical dependency** on the
blocked/deferred gates above:

- **ACC-01** Linux matrix §29.5
- **ACC-02** Windows acceptance §30
- **ACC-03** §35.2 budgets + P12 (second) soak
- **ACC-04** dual-platform daily-driver week

Reuse the authoritative QA ledger and existing HUMAN/LIVE evidence. Do **not**
repeat HUMAN rows already accepted unless a later code change invalidates them.
Current Status lives in [`acceptance-p12.md`](acceptance-p12.md). Historical
FAIL (including post-`1d6b535` PLAY-01) must not override a newer PASS-HUMAN.

PLAY-02 and SOAK-01 first 4h are **PASS-HUMAN** and are **not** ACC-03 entry
blockers. ACC-03 still needs the rest of §35.2 and the P12 **second** soak.

Do **not** convert PASS-AUTO / PASS-LIVE / oral OK into PASS-HUMAN.
Do **not** mark an entire ACC-01..04 row PASS just because a prerequisite
catalog ID passed.

## Hard stop (unchanged)

Do **not** complete **ACC-05** / `pre-tauri-removal` / §38.1 final sign-off
and do **not** start **P13** until **all** of the following are true:

1. CI-01..04 have **real live** evidence (not YAML-only, not local substitutes
   claimed as GitHub green).
2. UPD-01 A→B has **real live** evidence (incl. core swap).
3. Intentionally deferred **PLUG-01/02** and **PACK-01..03** clean-VM
   requirements are resolved **or** explicitly waived by the maintainer.
4. All other P12 acceptance requirements are complete (ACC-01..04 signed,
   remaining HUMAN FAIL/NOT TESTED rows closed or waived).

Until then: **P12 execution = allowed**, **P12 final exit = conditional**,
**P13 = blocked**.
