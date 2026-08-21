# P14-C readiness and retirement scope

Status: **PRODUCTION PATHS IMPLEMENTED; CUTOVER BLOCKED**. The machine-readable state
is [`p14c-readiness.json`](p14c-readiness.json); run `npm run p14c:report`.
This record does not authorize defaulting to `qmapi`, deleting fallback code,
or dropping a credential slot.

## Scope correction

P14-B produced a hybrid provider, not two interchangeable whole providers.
P14-C must therefore retire responsibilities that are fully replaced, not
delete the `qqmusic/` tree:

- J QMC is now a replacement candidate: pin `56db511` matches the in-tree
  QMCDecode Map/RC4 synthetic vectors, but the real-file golden and production
  routing change remain open.
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

| Gate                                                 | State        | Required evidence                                                                                                    |
| ---------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------- |
| P14-B LIVE/HUMAN hybrid verification                 | NEEDS RERUN  | Exact-pin rerun recorded in `p14b-live-verify.md`                                                                    |
| Responsibility-level retirement inventory            | PASS         | This document and JSON record                                                                                        |
| Sanitized qm-api-rs pin and crate provenance         | BLOCKED      | `p14-qm-api-rs-provenance.md` PASS at the final pin                                                                  |
| Production QMC library path                          | NEEDS GOLDEN | Real-file golden via `library_adapter_matches_intree_on_a_real_qmc_file`, then route `EncryptedMedia` to the adapter |
| Production credential-v2 primary path                | PASS         | `p14c-implementation.md` and restore/promotion tests                                                                 |
| Production G library calls with YAQMC reconciliation | PASS         | `p14c-implementation.md` and mutation tests                                                                          |
| Three-day real-account soak                          | NOT STARTED  | Maintainer evidence on the exact final pin and cutover candidate                                                     |

Any pin or production-path change after soak starts invalidates that soak.
Agent-only execution cannot mark the three-day LIVE_ACCOUNT gate PASS.

## Remaining gates

1. Complete the exact L-1124 source revision, file/range mappings, copyright,
   and notice evidence in qm-api-rs. QMCDecode is cleared; ASAR and `mzj3920`
   are not sources at pin `56db511`.
2. Rerun P14-B on the exact pin, including the real QMC file golden. The
   dual-path harness (`library_adapter_matches_intree_on_a_real_qmc_file`) is
   in place and env-gated on `YAQMC_QMC_SAMPLE` / `YAQMC_QMC_EKEY_FILE`; the
   production `EncryptedMedia` route stays in-tree until it passes. Then route
   production `EncryptedMedia` through the library adapter and rerun that check.
3. Build the exact cutover candidate and run the maintainer three-day soak:
   VIP quality, clear and encrypted playback, lyrics, favorites/playlists,
   restart restore, QR, OAuth, home/discover, and rollback build.

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
