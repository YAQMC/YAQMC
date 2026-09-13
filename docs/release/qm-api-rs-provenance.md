# qm-api-rs provenance

Status: **PASS (SOURCE-MAPPING DELTA REVIEW)** at production revision
`d421d9898797afd59fb900b43a9871ded55ee720`.

Repository: `https://github.com/YAQMC/qm-api-rs`. The crate declares
`GPL-3.0-or-later`; YAQMC links it unconditionally and distributes matching
corresponding source for the exact pin.

The crate records an independent Rust implementation. Its QMC implementation
maps behavioral adaptations from `gongjiehong/QMCDecode` at revision
`aea76301a08678100ec677cb61a8458bc75662ec`; the applicable MIT notice and
source-to-target mappings are present in the crate and mirrored in
[THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md). `L-1124/QQMusicApi` is
recorded as a protocol and API-shape reference, not incorporated source.
Former port and extracted-client source claims were removed before this pin.

The 2026-09-13 delta review compares the six commits after the previously recorded
`7d0f6e18b1d1d89a06cc5964e9c057acb0926ea5` through the new pin. The changes add
typed web discovery/account interfaces, OAuth URL construction, credential
isolation, validation, and synthetic contract tests. No dependency, license,
third-party notice, or QMC source change appears in that range. The existing
source mappings are retained based on identical Git blobs, not on test results:

| File                     | Git blob at both revisions                 |
| ------------------------ | ------------------------------------------ |
| `LICENSE`                | `f288702d2fa16d3cdf0035b15a9fcbc552cd88e7` |
| `PROVENANCE.md`          | `5d57147c353ca3de2f6f7a8ef207499999bdd9b8` |
| `THIRD_PARTY_NOTICES.md` | `5da3af9b4161cb7324735c148dd7825a6b036753` |
| `src/qmc.rs`             | `6f6ebefba47a958702b79581cca86ee071acdb6b` |

This is a limited local source-mapping review against the crate's existing
implementation record, not a new maintainer attestation or full-history legal
audit. It does not extend an old soak waiver or authorize a release.

Immutable evidence and mappings are recorded in
[provenance-ledger.json](provenance-ledger.json), including the crate license,
history, source revisions, file mappings, notices, and reviewed blob hashes.
The release gate additionally requires the checked-out dependency revision to
match the Cargo pin and [provider readiness record](provider-readiness.json).

A build or live verification result does not substitute for provenance or
corresponding-source delivery. Any dependency-pin change requires a new review
and updated immutable evidence.
