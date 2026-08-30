# Production provider readiness

Status: **READY-AUTO / SOAK PENDING** for the production `qmapi` backend at
exact `qm-api-rs` revision
`2ef9182732e02db23788175dbe5b7d9d937e328f`.

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

The previous exact-pin waiver applied only to revision
`827233cb799bede84ee5033ec16450dc1d5e2587`; it is not carried forward. The
current pin adds typed Guess and Radar continuation requests without changing
the QMC implementation. Its automatic Rust and provider-boundary checks must
pass before the implementation checkpoint, while the three-day soak remains
`not-started`. Live-service verification and any new waiver require an explicit
maintainer decision after the implementation report.
