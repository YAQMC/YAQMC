# P14-C production-path implementation evidence

Status: **IMPLEMENTED; CUTOVER NOT AUTHORIZED** at qm-api-rs pin
`56db511cfc98d2f860e48da4805d878ec3c2061e` on 2026-08-21.

This record closes the two code prerequisites in `p14c-readiness.json`. It does
not clear crate provenance, start or complete the exact-pin three-day soak,
change the default backend, or authorize deletion of fallback code.

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
- YAQMC retains `client_operation_id`, account-epoch checks, safe-read
  reconciliation, cache projection, and typed wire results.

The in-tree fixture transport remains active under Rust tests so the established
reconciliation suite stays deterministic. Dedicated library-client tests verify
the raw writer request shape, login context, cancellation, and write retry class;
the production branch is compile-checked outside `cfg(test)`.

## Verification

The implementation passed these automatic checks at the recorded pin:

```text
cargo check -p yaqmc-provider-qqmusic --no-default-features --features qmapi
cargo test -p yaqmc-provider-qqmusic --all-features
```

The full provider run reported 233 passed and 9 ignored tests; the external
loopback integration boundary reported 1 passed test. Ignored LIVE_ACCOUNT tests
are maintainer-only and are not evidence for the three-day soak. The full run
also includes row J's byte-identical in-tree/library Map and RC4 synthetic gate.

The remaining P14-C blockers are the exact-pin P14-B rerun, `crate-provenance`,
and `exact-pin-three-day-soak`. The production QMC library path passed on
2026-08-21: `qmapi` builds hard-route `EncryptedMedia` to the library adapter,
and live playback of a real encrypted `lossless-mflac` stream decrypted,
decoded, and seeked through it. Until the remaining gates pass, `intree`
remains the default, `qqmusic-api` remains optional, and the rollback slots and
network fallbacks stay present.

The real-file QMC golden harness is now in place as the ignored, env-gated test
`library_adapter_matches_intree_on_a_real_qmc_file`; see
`p14b-live-verify.md` for the run command. It requires a real encrypted sample
plus its ekey and remains an optional extra check beyond the live playback
evidence that closed the gate.
