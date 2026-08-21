# P14-C readiness and retirement scope

Status: **PRODUCTION PATHS IMPLEMENTED; CUTOVER BLOCKED**. The machine-readable state
is [`p14c-readiness.json`](p14c-readiness.json); run `npm run p14c:report`.
This record does not authorize defaulting to `qmapi`, deleting fallback code,
or dropping a credential slot.

## Scope correction

P14-B produced a hybrid provider, not two interchangeable whole providers.
P14-C must therefore retire responsibilities that are fully replaced, not
delete the `qqmusic/` tree:

- J QMC is a replacement candidate: pin `ffcc86c` (docs-only descendant of
  `56db511`) matches the in-tree QMCDecode Map/RC4 synthetic vectors, and the
  production route now uses the library adapter after the real-file evidence.
- A/B production `zzb`, encrypted evkey, OAuth/staging, mutation
  reconciliation, entitlement derivation, cache/artwork, wire mapping, and
  uncovered K feeds remain in-tree.
- L lyric HTTP/decrypt, clear I vkey HTTP, and H VIP HTTP are replacement
  candidates only after their fallbacks are no longer needed.
- C/D now uses the library credential as the `qmapi` production primary, with
  the legacy session retained as a synchronized migration/rollback fallback.
- G production raw mutations now use the library client while YAQMC retains
  operation IDs, cancellation, reconciliation, cache projection, and wire
  mapping. See `p14c-implementation.md` for implementation evidence.

## Readiness gates

| Gate                                                 | State  | Required evidence                                                                                                    |
| ---------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------- |
| P14-B LIVE/HUMAN hybrid verification                 | PASS   | Maintainer re-verification on the exact pin recorded in `p14b-live-verify.md`                                        |
| Responsibility-level retirement inventory            | PASS   | This document and JSON record                                                                                        |
| Sanitized qm-api-rs pin and crate provenance         | PASS   | `p14-qm-api-rs-provenance.md` at `ffcc86c`: independent-implementation record replaces the L-1124 port claims        |
| Production QMC library path                          | PASS   | Live playback on a real encrypted lossless-mflac stream through the routed library adapter; `p14b-live-verify.md` §4 |
| Production credential-v2 primary path                | PASS   | `p14c-implementation.md` and restore/promotion tests                                                                 |
| Production G library calls with YAQMC reconciliation | PASS   | `p14c-implementation.md` and mutation tests                                                                          |
| Three-day real-account soak                          | WAIVED | Maintainer waiver recorded below; exact-pin live and real-file playback evidence remains the substitute              |

Only the maintainer can pass or waive the three-day LIVE_ACCOUNT gate; the
waiver below is an explicit maintainer decision, not evidence that the soak ran.

## Maintainer waivers

- **`exact-pin-three-day-soak`** — waived by Osilvfe on 2026-08-21: no
  three-day testing window. Substitute evidence is the exact-pin live/human
  hybrid re-verification and the real encrypted-file playback recorded in
  `p14b-live-verify.md`. Accepted risk: long-run real-account regressions
  (VIP quality, restart restore, mutation reconciliation, rollback) may only
  surface after release; the pre-cutover commit and pin remain the rollback
  anchor.

The credential-primary and production G mutation slices are complete. Their
code and test evidence is recorded in `p14c-implementation.md`.

## Cutover-only changes

After every gate passes in the JSON record:

- Make the sanitized qm-api-rs integration unconditional for production and
  remove the temporary `qqmusic-qmapi` opt-in surface.
- Remove the L/I/H in-tree network fallbacks, then remove `lyrics-crypto` only
  when no production or golden-corpus code references it.
- Keep `qmapi/qmc.rs` as the provider adapter and delete the duplicated in-tree
  QMC cipher/key implementation once no golden or fallback path references it.
- Remove probe-only comparison modules after their evidence is archived.
- Stop writing `qqmusic-session` only after credential-v2 restore and rollback
  tests pass. Delete the legacy slot only after successful validated migration;
  never delete it merely because the new slot exists.

P14-C retains the in-tree modules that own Keep/Hybrid responsibilities. File
deletion must follow dead-code and call-graph proof; module names alone are not
evidence that the whole file was replaced.

## Rollback

Until cutover, the normal build remains `intree` and `qqmusic-qmapi` remains an
explicit opt-in. The final pre-cutover commit and qm-api-rs pin are the rollback
anchors. After duplicate code is removed, rollback is a Git revert/build from
that anchor, not an undocumented runtime backend toggle.

Do not commit, tag, push, dispatch Actions, or start the soak merely by updating
this readiness record.
