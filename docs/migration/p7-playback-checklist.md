# PLAY-01 Electron playback/catalog parity checklist

> **P15 historical overlay (2026-08-22):** this checklist is preserved as P7
> evidence and no longer defines current migration status. Use
> [`acceptance-final.md`](acceptance-final.md) and
> [`p15-closeout.md`](p15-closeout.md).

Source: `YAQMC_ELECTRON_MIGRATION_PLAN.md` §36 rows whose **Phase proven** is P7. Verification method key: **A** = automated, **M** = manual, **L** = LIVE VERIFY (real QQ account, maintainer-only).

This document is a checklist only. Per-cell Win/Linux boxes stay empty (no dated
tick grid). **Current Status:** PLAY-01 **PASS-HUMAN** (2026-08-20), including
Repeat One/All/Off, EOS → Next/Previous/Pause-Resume, EOS → seek back, and
rapid seek — see [`acceptance-p12.md`](acceptance-p12.md). Do not convert
AUTO/oral into ticks. Post-`1d6b535` FAIL is history.

Do not start `qm-api-rs`. Provenance remains **BLOCKED**. SOAK-01 first 4h
Win+Linux is **PASS-HUMAN**; the P12 second soak is still open.

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

Related (PLAY-01 Current Status is PASS-HUMAN; these are other IDs):

- **PLAY-02** **PASS-HUMAN** (2026-08-20). Assist script still prints PENDING — do not invent a millisecond.
- **PLAY-03** `backgroundThrottling` + in-app clock: see [soak-p7.md](soak-p7.md). Linux cover-window oral only. Windows NOT TESTED. Not PLAY-03 signed.
- **SOAK-01** first 4h Win+Linux **PASS-HUMAN**. Default 10 s script ≠ that result. P12 second soak still open.
