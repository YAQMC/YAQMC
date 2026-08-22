# qm-api-rs provenance

Status: **PASS** at production revision
`476b37e3135560dff132e9ba8996e068af706458`.

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

Immutable evidence and mappings are recorded in
[provenance-ledger.json](provenance-ledger.json), including the crate license,
history, source revisions, file mappings, notices, and reviewed blob hashes.
The release gate additionally requires the checked-out dependency revision to
match the Cargo pin and [provider readiness record](provider-readiness.json).

A build or live verification result does not substitute for provenance or
corresponding-source delivery. Any dependency-pin change requires a new review
and updated immutable evidence.
