# P14-C readiness and retirement scope

Status: **CUTOVER COMPLETE; `qmapi` IS THE PRODUCTION BACKEND**. The machine-readable state
is [`p14c-readiness.json`](p14c-readiness.json); run `npm run p14c:report`.
The three-day soak was waived by the maintainer; the legacy session slot is
retained for migration/rollback and is not yet deleted.

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

The pre-cutover commit and qm-api-rs pin `ffcc86c` are the rollback anchors.
Rollback after the duplicate in-tree code was removed is a Git revert/build
from that anchor, not an undocumented runtime backend toggle.

The cutover-only changes are complete: the provider feature split and
`qqmusic-qmapi` opt-in were removed, `qqmusic-api` is an unconditional pinned
dependency, production routes QMC/lyric/vkey/VIP/account writes through the
library, and the in-tree QMC implementation plus probe-only modules were
deleted. The legacy `qqmusic-session` slot is still written as the bounded
migration/rollback fallback until validated migration allows its retirement.
