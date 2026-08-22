# Production provider readiness

Status: **READY** for the production `qmapi` backend at exact `qm-api-rs`
revision `476b37e3135560dff132e9ba8996e068af706458`.

The machine-readable record is [provider-readiness.json](provider-readiness.json).
Run `npm run p14c:enforce` to verify the pin, provider boundary, evidence paths,
and source-retirement guards.

## Verified boundary

- `qm-api-rs` is the production implementation for clear-vkey retrieval,
  lyrics and QRC processing, and QMC decryption.
- The provider uses the `qmapi` credential envelope for production account
  operations. OAuth staging, mutation reconciliation, entitlement decisions,
  transport policy, caching, artwork mapping, and wire DTO mapping remain
  YAQMC responsibilities.
- Retired in-tree fallback implementations are guarded from production source
  and dependency graphs by the readiness checker.
- The legacy session slot remains only as a bounded compatibility and rollback
  input; it is not the primary production credential.

## Evidence decision

Authenticated provider verification covered login/session resolution, clear
and encrypted playback sources, lyrics, seek continuity, account reads, and
favorite mutation reconciliation before cutover. The crate provenance record
is maintained separately in
[qm-api-rs-provenance.md](qm-api-rs-provenance.md).

The exact-pin three-day soak is recorded as
`maintainer-authorized-skip` by Osilvfe on 2026-08-22. This is a maintainer
waiver, not evidence that an automated three-day soak ran or passed. A future
pin change must update the readiness record and repeat or explicitly reissue
the applicable decision.
