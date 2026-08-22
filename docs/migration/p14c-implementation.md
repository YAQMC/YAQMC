# P14-C production-path implementation evidence

Status: **CUTOVER COMPLETE** at qm-api-rs pin
`ffcc86cec2993b79ccf34faf25c1eba6c0d995ca` on 2026-08-21. The current pin is
`476b37e3135560dff132e9ba8996e068af706458`, an affected-row clear-vkey parsing
fix verified on 2026-08-22.

This record closes the two code prerequisites in `p14c-readiness.json`. The
three-day soak at the `ffcc86c` cutover baseline was waived by the maintainer;
that waiver was not reissued for `476b37e`. The provider feature split and
`qqmusic-qmapi` opt-in were removed, and `qqmusic-api` is now the unconditional
production dependency.

## Credential-v2 primary

- `qmapi/credential.rs` stores a versioned host envelope containing the library
  credential-store JSON and an opaque account-cache scope. It also accepts the
  earlier plain library-store JSON for migration.
- A `qmapi` restore loads credential-v2 first, refreshes an expired credential
  when refresh material is present, validates the reconstructed session online,
  and only then falls back to a valid legacy `qqmusic-session`.
- A valid legacy fallback rebuilds credential-v2. A valid credential-v2 restore
  synchronizes the legacy rollback slot.
- Promotion requires credential-v2 persistence and readback before publish.
  Any later failure restores both credential slots to their exact prior values.
- Logout and forced reauthentication clear both slots and report storage
  failures.

Deterministic coverage includes primary restore, legacy migration, malformed-v2
fallback, refresh persistence, promotion readback failure, two-slot rollback,
logout, and reauthentication cleanup.

## Account mutation hybrid

- In a non-test `qmapi` build, favorite writes and playlist create, rename,
  collect/uncollect, add/remove-track, and delete operations route raw CGI calls
  through `qqmusic-api::Client::request_cgi`.
- Library requests require a login credential, preserve boolean values, carry
  the account cancellation token, and use `RetryClass::Write`. Offline and
  timeout write failures become `OutcomeUnknown`.
- Account writes override the library's read-oriented Web `comm` with the
  previously live-validated mobile identity envelope (`ct/cv/v`, account
  identity, login type, and `g_tk`). The values come from the in-memory library
  credential and are never logged. Without that override, a live
  `DelSonglist` returned `80105` while its nested `retCode` was `0`.
- The known no-change code `80092` remains a typed rejection. The contradictory
  `80105` shape and successful replies without an acceptance marker remain
  `OutcomeUnknown`, so YAQMC performs its existing bounded safe-read
  reconciliation instead of claiming success or reporting schema drift.
- YAQMC retains `client_operation_id`, account-epoch checks, safe-read
  reconciliation, cache projection, and typed wire results.

The in-tree fixture transport remains active under Rust tests so the established
reconciliation suite stays deterministic. Dedicated library-client tests verify
the raw writer request shape, login context, cancellation, and write retry class;
the production branch is compile-checked outside `cfg(test)`.

## Verification

The implementation passed these automatic checks at the recorded pin:

```text
cargo check -p yaqmc-provider-qqmusic
cargo test -p yaqmc-provider-qqmusic
```

The full provider run reported 236 passed and 7 ignored tests; the external
loopback integration boundary reported 1 passed test. Ignored LIVE_ACCOUNT tests
are maintainer-only and are not evidence for the three-day soak. The full run
also includes row J's byte-identical in-tree/library Map and RC4 synthetic gate.

All P14-C gates were clear at `ffcc86c`: the P14-B hybrid set was re-verified,
the production QMC library path decrypted, decoded, and seeked a real encrypted
`lossless-mflac` stream, and the maintainer waived the three-day soak on
2026-08-21. The cutover then made `qmapi` unconditional and retained the legacy
session slot only as a bounded migration/rollback fallback.

The 2026-08-22 affected-row recheck at `476b37e` resolved guest clear-vkey,
parsed live lyrics, restored an authenticated session after online validation,
confirmed a favorite remove/restore round trip, and played and sought within
encrypted lossless RC4 and map streams through the desktop client. See
`p14b-live-verify.md`; the removed dual-path QMC harness remains in Git history
rather than as a runtime fallback.
