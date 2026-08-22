# P14-A in-tree provider boundary

Status: **historical CHECK-14A record; superseded by the completed P14-C
cutover**. P14-A's no-op boundary was verified before P14-B/P14-C. Current
production state is recorded in [`p14c-readiness.md`](p14c-readiness.md).

## Result at CHECK-14A

- `yaqmc-provider-api` owns the frozen provider/account DTOs, credential and
  storage host boundaries, playback-source/media contracts, `MusicProvider`,
  `ProviderAccount`, and the immutable `ProviderRegistry`.
- `yaqmc-provider-qqmusic` owned the existing QQ Music implementation, account
  state machine, endpoint compatibility code, QRC parsing, and QMC encrypted
  media material. Its default feature was `intree` at this checkpoint.
- Core constructs the in-tree provider at the composition root, stores it as
  `Arc<dyn MusicProvider>`, resolves playback through `ProviderRegistry`, and
  dispatches catalog/account/OAuth operations through the contracts.
- Core continues to own SQLite, file and artwork cache storage, local/ranged
  media preparation, the audio engine, queue state, and the Electron protocol.

## Compatibility invariants

The extraction deliberately preserves these existing boundaries and values:

- active credential account: `qqmusic-session`;
- staged credential account: `qqmusic-session-staging`;
- OS credential service: `org.yaqmc.desktop` with the existing
  `dev.music-client.desktop` legacy read/migration path;
- `provider_cache` schema and account-cache transaction behavior;
- artwork cache and data-URI behavior;
- wire JSON field names, enum representations, and command names;
- OAuth native window ownership in Electron Main, with
  prepare/complete/cancel implemented by the provider;
- local and cached file preparation in `crates/yaqmc-core/src/media.rs`;
- existing QMC decryptor construction timing and seek-offset semantics.

## Explicitly deferred at CHECK-14A

- The optional `qqmusic-api` git pin was allowed only behind feature `qmapi`.
  Default production remained `intree` at CHECK-14A. See
  [P14-B qmapi backend](p14b-qmapi-backend.md) and
  [P14 entry gates](p14-entry-gates.md) for the later transition.
- No upstream transport, endpoint, QMC, QRC, account, entitlement, cache, or DTO
  implementation has been selected as the default.
- P14-B replacement candidates, provenance evidence, real-account comparison,
  and the three-day soak were separate later gates.

## Historical verification state

At CHECK-14A, the implementing agent used Rust formatting plus offline Cargo
metadata and lockfile resolution as non-executing structural checks. It had not
yet run a compile, package, LIVE-account flow, or HUMAN UI check. Later P14
verification superseded that checkpoint state: P14-C removed the backend
feature split, made the pinned `qqmusic-api` dependency unconditional, and
routed the replaced production responsibilities through `qmapi`.

This historical record is therefore not the current backend-status or final
acceptance source. Use [`p14c-readiness.md`](p14c-readiness.md) for P14-C and
[`acceptance-final.md`](acceptance-final.md) for the unsigned P15 matrix.
