# Production provider readiness

Status: **READY (MAINTAINER SOAK WAIVER)** for the production `qmapi` backend at
exact `qm-api-rs` revision
`7d0f6e18b1d1d89a06cc5964e9c057acb0926ea5`.

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
current pin retains the typed Guess and Radar continuation requests, validated
canonical public-song-link helper, and credential-scoped daily recommendation
discovery. It adds typed mobile QR terminal outcomes and non-sensitive progress
events, and binds MQTT business events to the active QR topic without changing
the QMC implementation. Its Rust, provider-boundary, and Android compile checks
passed before the release request. On 2026-09-06, maintainer Mai-xiyu explicitly
requested the release and thereby authorized skipping the new pin's three-day
soak. This waiver does not assert that the soak or a production-account LIVE run
passed.
