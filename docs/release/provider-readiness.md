# Production provider readiness

Status: **BLOCKED (EXACT-PIN SOAK NOT STARTED)** for the production `qmapi` backend at
exact `qm-api-rs` revision
`d421d9898797afd59fb900b43a9871ded55ee720`.

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

Historical authenticated provider verification covered login/session resolution, clear
and encrypted playback sources, lyrics, seek continuity, account reads, and
favorite mutation reconciliation before cutover. The crate provenance record
is maintained separately in
[qm-api-rs-provenance.md](qm-api-rs-provenance.md).

The previous exact-pin waiver applied only to revision
`7d0f6e18b1d1d89a06cc5964e9c057acb0926ea5`; it is not carried forward.
The new pin adds typed discovery/account boundaries and OAuth URL construction,
credential isolation, and response validation. The QMC implementation is unchanged;
the limited source-evidence comparison is recorded in the provenance document.

The original cutover remains authorized; its non-soak gates describe the historical
cutover, not a new LIVE run for this pin. Local synthetic tests do not establish
production-account, Android-device, or soak acceptance. The new exact-pin three-day
soak has not started, and no new waiver or release has been requested. Consequently
`npm run provider:enforce` must exit nonzero until new evidence is recorded. A normal
code push must not turn this record into READY.
