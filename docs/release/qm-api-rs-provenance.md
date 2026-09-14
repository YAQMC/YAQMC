# qm-api-rs provenance

Status: **PASS (SOURCE-MAPPING DELTA REVIEW)** at production revision
`61e9e3cfd69ed10efcce92f573c104aa440d74ed`.

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

The next delta review compares `8734353175317cf81c2180b73deff18edca8a650` with the
current pin `61e9e3cfd69ed10efcce92f573c104aa440d74ed`. The eight-commit range
changes `docs/modules.md`, adds `src/auth.rs`, `tests/oauth_exchange_contract.rs`
and `tests/desktop_qr_contract.rs`, and updates `src/lib.rs` plus
`src/modules/login.rs`. It first centralizes the desktop OAuth wire shape and
login field aliases, then moves the actual bounded, attempt-scoped HTTP exchange,
Cookie processing and response validation into the library, and makes the
lower-level payload builder and decoder crate-private so consumers cannot bypass
the complete exchange API. It then takes ownership of the desktop QQ QR login
flow (`ptqrshow`/`ptqrlogin`, `check_sig`, the `oauth2.0/authorize` redirect and
the `g_tk`/`ptqrtoken` derivations) with a synthetic end-to-end contract, and
then owns the mobile QR launch URL plus its identifier encoding and bounds. It
publishes the callback endpoint contract (host, path, `login_type`, `surl`) so
the host validates callbacks without duplicating the wire string. The final two
commits harden response-size, Cookie, duplicate-header, exact-endpoint,
`ptuiCB` grammar and redirect-query validation, and bind every redirect to the
active login attempt. No dependency, license, third-party notice, or QMC source
change appears in the range, and the four reviewed blobs below are
byte-identical at both revisions:

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
