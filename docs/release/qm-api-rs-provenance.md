# qm-api-rs provenance

Status: **PASS (SOURCE-MAPPING DELTA REVIEW)** at production revision
`75f6e4d392f6d3e64608fb48e2480fb0087009e3`.

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

The first 2026-09-14 delta review compares the ten commits after the previously
recorded `7d0f6e18b1d1d89a06cc5964e9c057acb0926ea5` through
`8734353175317cf81c2180b73deff18edca8a650`. The changes add
typed web discovery/account interfaces, OAuth URL construction, credential
isolation, validation, and synthetic contract tests. The account deltas add
an explicit trusted directory binding for owned playlist responses; it rejects
conflicting playlist and directory identities and has transport contract tests.
The latest delta extends those typed reads to owned/saved playlist lists, preserving
explicit credential scope and validating page ranges and continuation flags.
Artwork URL contracts were then moved from YAQMC into the library. The final delta
adds anonymous image downloads and decoded response-byte limits to both supported
transport implementations, with synthetic and loopback contract tests.
No dependency, license,
third-party notice, or QMC source change appears in that range. The existing
source mappings are retained based on identical Git blobs, not on test results:

The next delta review compares `8734353175317cf81c2180b73deff18edca8a650` through
`61e9e3cfd69ed10efcce92f573c104aa440d74ed` and `fd38181b190c81ecb46591ae2e34dad87e1dadf2`
to the current pin `75f6e4d392f6d3e64608fb48e2480fb0087009e3`. The eight commits to `61e9e3c`
centralize the desktop OAuth wire shape and login field aliases, move the
attempt-scoped exchange into the library, take ownership of the desktop QQ QR
flow and mobile QR launch URL, publish the callback endpoint contract, and harden
parsing while binding redirects to the active login attempt. The follow-up commit
to `fd38181` sniffs desktop QR image magic bytes when `ptqrshow` omits `Content-Type`
and adds single `req` envelope key fallback. The commit to `75f6e4d` introduces
`FeedCardKind::DailySonglist` for `(500, 510)` daily mix cards and permits empty IDs
for navigation action buttons (`type < 0`) in web discovery feeds. No dependency, license,
third-party notice, or QMC source change appears in the range, and the four
reviewed blobs below are byte-identical at all revisions:

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
