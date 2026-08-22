# P14-C readiness and retirement scope

Status: **CUTOVER COMPLETE; `qmapi` IS THE PRODUCTION BACKEND**. The machine-readable state
is [`p14c-readiness.json`](p14c-readiness.json); run `npm run p14c:report`.
The three-day soak was waived by the maintainer for the `ffcc86c` cutover
baseline on 2026-08-21, and the maintainer reissued that waiver for the
current pin `476b37e` on 2026-08-22 as a maintainer-authorized skip. The
legacy session slot is retained for migration/rollback and is not yet
deleted.

## Scope correction

P14-B produced a hybrid provider, not two interchangeable whole providers.
P14-C must therefore retire responsibilities that are fully replaced, not
delete the `qqmusic/` tree:

- J QMC was replaced at cutover: the `ffcc86c` path matched the in-tree
  QMCDecode Map/RC4 synthetic vectors, and production now uses the library
  adapter after the real-file evidence. Current pin `476b37e` changes only
  clear-vkey response parsing.
- A/B production `zzb`, encrypted evkey, OAuth/staging, mutation
  reconciliation, entitlement derivation, cache/artwork, wire mapping, and
  uncovered K feeds remain in-tree.
- L lyric HTTP/decrypt, clear I vkey HTTP, and H VIP HTTP now use the library
  directly in production, without tree-internal network fallbacks.
- C/D now uses the library credential as the `qmapi` production primary, with
  the legacy session retained as a synchronized migration/rollback fallback.
- G production raw mutations now use the library client while YAQMC retains
  operation IDs, cancellation, reconciliation, cache projection, and wire
  mapping. See `p14c-implementation.md` for implementation evidence.

## Readiness gates

| Gate                                                 | State  | Required evidence                                                                                                                                      |
| ---------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P14-B LIVE/HUMAN hybrid verification                 | PASS   | Cutover evidence at `ffcc86c`; affected clear-vkey/lyric rows rechecked at current pin `476b37e` in `p14b-live-verify.md`                              |
| Responsibility-level retirement inventory            | PASS   | This document and JSON record                                                                                                                          |
| Sanitized qm-api-rs pin and crate provenance         | PASS   | Independent-implementation baseline closed at `ffcc86c`; current `476b37e` history and pin-specific blob are captured in `p14-qm-api-rs-provenance.md` |
| Production QMC library path                          | PASS   | Live playback on a real encrypted lossless-mflac stream through the routed library adapter; `p14b-live-verify.md` §4                                   |
| Production credential-v2 primary path                | PASS   | `p14c-implementation.md` and restore/promotion tests                                                                                                   |
| Production G library calls with YAQMC reconciliation | PASS   | `p14c-implementation.md`, mutation tests, and the 2026-08-22 confirmed favorite remove/restore LIVE round trip                                         |
| Three-day real-account soak                      | WAIVED | Maintainer-authorized skip reissued for the current pin `476b37e` on 2026-08-22; recorded in the JSON gate and below                        |

Only the maintainer can pass or waive the three-day LIVE_ACCOUNT gate; the
waiver below is an explicit maintainer decision, not evidence that the soak ran.

## Maintainer waivers

- **`exact-pin-three-day-soak`** — waived by Osilvfe on 2026-08-21 for the
  `ffcc86c` cutover baseline, and reissued by Osilvfe on 2026-08-22 for the
  current pin `476b37e` as a maintainer-authorized skip: no three-day testing
  window at either pin. Substitute evidence for the cutover was the exact-pin
  live/human hybrid re-verification and the real encrypted-file playback
  recorded in `p14b-live-verify.md`; the affected clear-vkey/lyric rows were
  rechecked at `476b37e`, and the 2026-08-22 favorite remove/restore LIVE
  round trip plus logged-in lossless-mflac playback cover the current pin.
  Accepted risk: long-run real-account regressions
  (VIP quality, restart restore, mutation reconciliation, rollback) may only
  surface after release; the pre-cutover commit and pin remain the rollback
  anchor.

The credential-primary and production G mutation slices are complete. Their
code and test evidence is recorded in `p14c-implementation.md`.

## Completed cutover changes

After every gate passed in the JSON record, the cutover:

- Made the sanitized qm-api-rs integration unconditional for production and
  removed the temporary `qqmusic-qmapi` opt-in surface.
- Removed the L/I/H in-tree network fallbacks; remove `lyrics-crypto` only
  when no production or golden-corpus code references it.
- Kept `qmapi/qmc.rs` as the provider adapter and deleted the duplicated
  in-tree QMC cipher/key implementation once no golden or fallback path
  referenced it.
- Removed probe-only comparison modules after their evidence was archived.
- Continue writing `qqmusic-session` as the bounded migration backup. Delete
  the legacy slot only after successful validated migration across releases;
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
