# Parked LIVE VERIFY / hardware / provenance (2026-08-18; amended 2026-08-20)

> **P15 historical overlay (2026-08-22):** this file preserves an earlier
> execution snapshot; its phase gates and “Current Status” statements are not
> current. Use [`acceptance-final.md`](acceptance-final.md) for the final
> acceptance ledger and [`p15-closeout.md`](p15-closeout.md) for closeout state.

This is the handoff for a later, higher-capability pass. **Do not tick these green
from YAML, scripts, or checklists.** Code and dry-run docs already exist; the
rows below are still empty **or** explicitly **BLOCKED-EXTERNAL** / **DEFERRED**.

Branch: `feat/electron-migration`. Do **not** cut a new branch. `main` is frozen.
Electron stays **43.4.0**. The 32 MiB protocol hard cap is unchanged.

P12 ACC-01..04 **started** under
[`p12-conditional-entry.md`](p12-conditional-entry.md). Tracker:
[`acceptance-p12.md`](acceptance-p12.md). Do **not** complete ACC-05 / tag
`pre-tauri-removal`. Do **not** start P13 Tauri removal or P14 `qm-api-rs`.

## GitHub Actions freeze (**BLOCKED-EXTERNAL**, not a product FAIL)

YAQMC org Actions quota (**2000** minutes) is exhausted. 2026-08-17 GitHub had a
global outage. **Do not dispatch** `ci.yml`, `build.yml`, `electron-release.yml`,
or `pages.yml`. CI-01..04 jobs exist on disk only; they are **BLOCKED-EXTERNAL**,
not implementation FAIL. UPD-01 A→B is **BLOCKED-EXTERNAL** for the same reason.

Local `npm test`, `npm run test -w @yaqmc/desktop`, `npm run typecheck`, and
`node --test scripts/ci/*.test.mjs` are fine. Do not run a 4-hour soak in an
agent. PLAY-02 Current Status is maintainer **PASS-HUMAN** (do not invent a
millisecond). SOAK-01 first 4h Win+Linux is **PASS-HUMAN**; the P12 second
soak is still open.

## Parked rows

Current Status for PLAY-01 / PLAY-02 / SOAK-01 first 4h / PLAT-05 / SURF-02 /
Desktop / Island / SURF-03 / ACCT-01..03 is **PASS-HUMAN** in
[`acceptance-p12.md`](acceptance-p12.md). They are not in this table.

| Item                                   | Catalog ID   | Code / docs landed                                                 | Still not green                                 | How to finish (later)                                                                                                                         |
| -------------------------------------- | ------------ | ------------------------------------------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| SMTC flyout / media keys / artwork     | PLAT-04      | HWND `platform_attach`; Windows SMTC session **PASS-HUMAN**        | Flyout, media keys, artwork extras              | R-3 fallback only after flyout rejects the HWND.                                                                                              |
| Clean-VM install / upgrade / uninstall | PACK-01..03  | NSIS/portable + AppImage/deb/rpm/tar.gz scripts and empty matrices | **DEFERRED**. Every clean-VM cell               | Unsigned (R-9). Do not silent-install. Data must survive under `org.yaqmc.desktop`.                                                           |
| Example-plugin HUMAN battery           | PLUG-01 / 02 | PASS-AUTO battery; install-from-file ACL **PASS-HUMAN**            | **DEFERRED** full HUMAN battery / journal       | Maintainer in-app picker + crash-loop journal.                                                                                                |
| P12 second 4-hour soak                 | ACC-03       | First 4h Win+Linux already **PASS-HUMAN**                          | Second soak not run                             | `YAQMC_SOAK_SECONDS=14400`. Do not run 4h in an agent.                                                                                        |
| Live GitHub quality / pack / release   | CI-01..04    | YAML + local gates                                                 | **BLOCKED-EXTERNAL** (quota)                    | Resume when minutes exist. Do not dispatch against empty quota. Do not call local gates live-CI.                                              |
| Updater A→B incl. core swap            | UPD-01       | notify-only `electron-updater` wired                               | **BLOCKED-EXTERNAL** (needs GitHub draft)       | After CI-04 can actually produce a draft.                                                                                                     |
| Provenance release / P14 gate          | P0 / CLEAN   | `docs/migration/provenance-audit.md`, `provenance-ledger.json`     | YAQMC tree **PASS**; `qm-api-rs` still unlinked | In-tree `npm run provenance:enforce` is green. Cargo-linking `qqmusic-api` remains a separate crate-level gate. Not a P12-entry prerequisite. |

## P12 entry vs provenance vs this waiver

In-tree provenance / CLEAN now **PASS**es `npm run provenance:enforce`. Public
distribution of this tree is no longer blocked by that ledger. Linking
`qm-api-rs` for P14 **PROV-01** (plan §17.6; R-6: before P14 only) still needs
a separate crate-level pass. It is **not** a prerequisite to **begin** P12.

The 2026-08-20 waiver **does** begin ACC-01..04 even though CI-01..04 and
UPD-01 are **BLOCKED-EXTERNAL** and PLUG/PACK clean-VM are **DEFERRED**. That
is not a silent skip of those ⛔ tasks: P11 stays not PASS, and P12 **final
exit** (ACC-05) stays blocked until they have live evidence or an explicit
maintainer waiver.

Authoritative P12+ edges from §41, as applied after the waiver:

- ACC-01 / ACC-02 **execution** may proceed; they do **not** count as phase-signed while P11 ⛔ live/deferred rows remain, and catalog PASS-HUMAN does not auto-sign the ACC row
- ACC-03 **entry** is allowed: PLAY-02 and SOAK-01 first 4h are PASS-HUMAN. Closing ACC-03 still needs remaining §35.2 cells and the P12 second soak
- ACC-04 depends on ACC-01,02 for **sign-off**; daily-driver log may open now; ACCT-03 PASS-HUMAN is not the week
- ACC-05 depends on ACC-01..04 **and** the waiver hard stop
- P13 depends on ACC-05
- P14 PROV-01 depends on the §17.6 license/provenance gate

Do not tick §41 ACC-01..05 verification columns green from this file.
Do not start P13, P14, or `qm-api-rs`.

Related parked (same later pass, not this overlay's headline list):

- PLAY-02 Current Status **PASS-HUMAN**; assist script still prints PENDING — do not invent a millisecond.
- PLAY-03 occluded-window cadence vs Tauri (Linux cover-window oral only; Windows NOT TESTED).
- ACCT-01 QQ/WeChat OAuth, ACCT-02 QR, ACCT-03 Tauri→Electron: **PASS-HUMAN** (2026-08-20).
- SURF-02 / Desktop Lyrics / Lyrics Island / SURF-03: **PASS-HUMAN** on `27d10b0`.
- SURF-04 real fullscreen game/video overlay (window hide already PASS-HUMAN).

## Plan book

Canonical overlay: `YAQMC_ELECTRON_MIGRATION_PLAN.md` §49 (incl. §49.4 waiver).
Deltas: `docs/migration/plan-deltas.md` heading `P12 overlay: conditional-entry waiver (Actions quota)`.
§41 catalog IDs and verification columns are unchanged (not silently greened).
