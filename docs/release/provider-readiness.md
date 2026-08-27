# Production provider readiness

Status: **READY** for the production `qmapi` backend at exact `qm-api-rs`
revision `827233cb799bede84ee5033ec16450dc1d5e2587`.

The machine-readable record is [provider-readiness.json](provider-readiness.json).
Run `npm run provider:enforce` to verify the pin, provider boundary, evidence paths,
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
`maintainer-authorized-skip` by Osilvfe on 2026-08-24 for this security
hardening pin. This is a maintainer waiver, not evidence that an automated
three-day soak ran or passed. The pin was checked against YAQMC's Provider
boundary with a clean compile and its offline qmapi test suite; live-service
verification remains a separate release responsibility.
