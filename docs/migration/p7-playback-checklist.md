# PLAY-01 Electron playback/catalog parity checklist

Source: `YAQMC_ELECTRON_MIGRATION_PLAN.md` §36 rows whose **Phase proven** is P7. Verification method key: **A** = automated, **M** = manual, **L** = LIVE VERIFY (real QQ account, maintainer-only).

This document is a checklist only. **PLAY-01 is not green.** Fake-mode assist covers in-memory **A** ops that do not need an account (`node scripts/migration/p7-fake-playback.mjs`, `packages/yaqmc-client/src/bridges/p7-fake-playback.test.ts`). Windows and Linux boxes stay empty until a maintainer runs the row on that host. **L** rows stay `LIVE VERIFY pending`.

Do not start `qm-api-rs`. Provenance remains **BLOCKED**. First 4-h soak report stays uncommitted (`PENDING`).

| Feature                                          | Method | Expected result                                                                                             | Windows                 | Linux                   |
| ------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------- |
| Playback controls, modes, volume                 | A      | Play/pause/toggle/volume/repeat/shuffle match Tauri; fake-mode play/pause/toggle already assisted           | [ ]                     | [ ]                     |
| Rapid seek + fencing invariants                  | A      | P2 harness plus P7 UI: last seek settles ±250 ms; `snapshot_revision` monotonic; no stale session apply     | [ ]                     | [ ]                     |
| Queue ops + persistence/restore                  | A      | Hydrate/play-tracks/add/remove/reorder/restore after restart match Tauri; fake hydrate/play-tracks assisted | [ ]                     | [ ]                     |
| Media resolution: local file                     | A      | Local file source resolves and plays on Electron                                                            | [ ]                     | [ ]                     |
| Media resolution: vkey / QMC                     | L      | LIVE VERIFY pending (real QQ account, maintainer-only)                                                      | [ ] LIVE VERIFY pending | [ ] LIVE VERIFY pending |
| Progressive cache + promotion                    | A      | Cache fill and promotion match Tauri under `app://` + loopback                                              | [ ]                     | [ ]                     |
| Progressive cache + promotion                    | M      | Manual: artwork/media cache behaves under Chromium                                                          | [ ]                     | [ ]                     |
| Search / home / discover / album / playlist      | L      | LIVE VERIFY pending (real QQ account, maintainer-only)                                                      | [ ] LIVE VERIFY pending | [ ] LIVE VERIFY pending |
| Favorites + mutation reconciliation              | L      | LIVE VERIFY pending (real QQ account, maintainer-only)                                                      | [ ] LIVE VERIFY pending | [ ] LIVE VERIFY pending |
| Lyrics fetch/parse/offset                        | A      | Parse/offset against fixtures; no network                                                                   | [ ]                     | [ ]                     |
| Lyrics fetch/parse/offset                        | L      | LIVE VERIFY pending (real QQ account, maintainer-only)                                                      | [ ] LIVE VERIFY pending | [ ] LIVE VERIFY pending |
| In-app lyrics page + presets + composer + scenes | A      | Page/presets/composer/scenes render from local fixtures                                                     | [ ]                     | [ ]                     |
| In-app lyrics page + presets + composer + scenes | M      | Manual: composer + scene switch matches Tauri                                                               | [ ]                     | [ ]                     |
| Preferences + `preferences://changed`            | A      | Get/set/patch emit `preferences://changed`; round-trip matches Tauri                                        | [ ]                     | [ ]                     |

Related (not PLAY-01 green):

- **PLAY-02** seek round-trip p95 vs §15.4: `node scripts/migration/play02-seek-p95.mjs` — measured cells stay **PENDING**.
- **PLAY-03** `backgroundThrottling` current settings: see [soak-p7.md](soak-p7.md). Do not treat occluded-window cadence as verified.
- **SOAK-01** script: `node scripts/soak-electron.mjs` (default 10 s). 4-h report uncommitted.
