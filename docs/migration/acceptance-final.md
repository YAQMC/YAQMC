# P15 final acceptance tracker

Status: **PENDING-TERRA/HUMAN — 0/20 rows signed**.

This is the authoritative CLEAN-03 tracker for the final Electron migration
candidate. It does not inherit PASS state from P12, a source review, a unit
test, or an earlier build. Every row must be executed against the same pushed
commit and record the date, environment, YAQMC version, Electron version, and
evidence location before it can be signed.

## Result vocabulary

- `PASS-AUTO`: automated evidence passed on the named candidate.
- `PASS-HUMAN`: a human observed the required native/UI behavior.
- `FAIL`: the candidate did not meet the row.
- `BLOCKED-ENV`: the required platform, credential, artifact, or account was
  unavailable; this is not a pass.
- `DEFERRED`: the row was intentionally not run after a prerequisite failed.
- `PENDING`: no valid result has been recorded.

`PASS-AUTO` cannot replace a row whose method includes manual (`M`) or live
(`L`) verification. Rows that require both must retain both evidence records.

## Candidate identity

| Field               | Required value                                      | Recorded value |
| ------------------- | --------------------------------------------------- | -------------- |
| Git branch          | `feat/electron-migration`                           | PENDING        |
| Pushed commit       | immutable 40-character SHA                          | PENDING        |
| Application version | version from the tested artifact                    | PENDING        |
| Electron version    | version embedded in the tested artifact             | PENDING        |
| Windows environment | edition/build/architecture/VM or machine identity   | PENDING        |
| Linux environment   | distribution/kernel/display backend/GPU identity    | PENDING        |
| Artifact checksums  | SHA-256 evidence for every tested package           | PENDING        |
| Tester and date     | named tester plus ISO date for each evidence bundle | PENDING        |

## §46 matrix

| #   | Acceptance item                                                                                             | Method/platforms                          | Status  | Required evidence                                             |
| --- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------- | ------------------------------------------------------------- |
| 1   | Cold boot restores the logged-in state from the pre-migration keyring                                       | M/L — Windows, Linux                      | PENDING | Redacted upgrade capture; never export credential values      |
| 2   | Full §36 parity matrix is green                                                                             | Per-row — Windows, Linux                  | PENDING | Signed parity matrix with artifact identity                   |
| 3   | §15.6 player consistency pack, including UI layers                                                          | A — Windows, Linux                        | PENDING | Harness logs and UI-layer result                              |
| 4   | §35.2 performance budgets are met against BASE-03                                                           | A/M — Windows, Linux                      | PENDING | Raw measurements, three-run medians, and baseline comparison  |
| 5   | Four-hour soak is clean on the final build                                                                  | A — Windows, Linux                        | PENDING | Start/end timestamps, artifact SHA, event/error log           |
| 6   | Core kill causes automatic restart and resync within 10 seconds while UI survives                           | A — Windows, Linux                        | PENDING | Timed supervisor/E2E trace                                    |
| 7   | Quit receives Core acknowledgement, exits cleanly, and restores the queue on next boot                      | A — Windows, Linux                        | PENDING | Shutdown and next-boot trace                                  |
| 8   | Clean install, in-place upgrade, and uninstall work; user data survives the upgrade                         | M — Windows NSIS/portable; Linux packages | PENDING | Clean-VM screen/log capture and before/after data inventory   |
| 9   | Updater A→B rehearsal replaces the Core binary                                                              | M — Windows, Linux AppImage               | PENDING | Signed A/B artifact hashes and updater log                    |
| 10  | Local API and SSE external-consumer behavior is unchanged                                                   | A/M — Windows, Linux                      | PENDING | API contract run plus external-client capture                 |
| 11  | SMTC/MPRIS control surface works                                                                            | M — Windows/Linux                         | PENDING | Native control-surface capture                                |
| 12  | Lyric surfaces preserve lock, click-through, geometry, restore, and Windows fullscreen-hide behavior        | A/M — Windows, Linux X11                  | PENDING | Computer-controlled trace plus human visual sign-off          |
| 13  | Plugin battery and safe-mode drill pass                                                                     | A/M — Windows, Linux                      | PENDING | Package identities, permission/isolation result, UI capture   |
| 14  | ACL negatives, navigation containment, permission denials, forbidden-switch checks, and preload purity pass | A — Windows, Linux                        | PENDING | Security test logs                                            |
| 15  | Diagnostics contain Core and host sections and redact secrets                                               | A/M — Windows, Linux                      | PENDING | Redacted bundle hash and manual review record                 |
| 16  | The §38.4 retired-host sweep is clean under the maintained allowlist                                        | A — repository                            | PENDING | Exact command and output from a clean clone                   |
| 17  | `qm-api-rs` is the default and all §17.5 module checks are signed                                           | L — Windows, Linux                        | PENDING | Exact pin, P14-C/provenance reports, and live module evidence |
| 18  | The §38.3 documentation set is truthful                                                                     | M — repository                            | PENDING | Reviewer, date, and reviewed-file list                        |
| 19  | Quality, package matrix, and release workflow are green on the final SHA                                    | A — all CI platforms                      | PENDING | Workflow URLs and immutable run IDs                           |
| 20  | A fresh contributor clone builds using only README instructions                                             | M — Windows, Linux                        | PENDING | Clean-clone transcript with exact toolchain versions          |

## CLEAN-03 and tag gate

CLEAN-03 remains open until all 20 rows are signed and the §47 Definition of
Done is reviewed against the same pushed SHA. A `BLOCKED-ENV`, `DEFERRED`, or
unsigned row keeps the matrix open. Do not create or push
`electron-migration-complete` while this file is not 20/20.

## Final signatures

| Role                         | Name | Date | Result  |
| ---------------------------- | ---- | ---- | ------- |
| Automated verification owner |      |      | PENDING |
| Windows native/UI verifier   |      |      | PENDING |
| Linux native/UI verifier     |      |      | PENDING |
| Maintainer final acceptance  |      |      | PENDING |
