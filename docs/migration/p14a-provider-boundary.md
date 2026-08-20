# P14-A in-tree provider boundary

Status: **implemented, verification pending**. This is a code-boundary record,
not an acceptance sign-off.

## Result

- `yaqmc-provider-api` owns the frozen provider/account DTOs, credential and
  storage host boundaries, playback-source/media contracts, `MusicProvider`,
  `ProviderAccount`, and the immutable `ProviderRegistry`.
- `yaqmc-provider-qqmusic` owns the existing QQ Music implementation, account
  state machine, endpoint compatibility code, QRC parsing, and QMC encrypted
  media material. Its default and currently required feature is `intree`.
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

## Explicitly deferred

- No `qqmusic-api` dependency or private `qm-api-rs` revision is linked.
- No upstream transport, endpoint, QMC, QRC, account, entitlement, cache, or DTO
  implementation has been selected as the default.
- P14-B replacement candidates, provenance evidence, real-account comparison,
  and the three-day soak remain separate gates. P14-C is not started.

## Verification state

The implementing agent used Rust formatting plus offline Cargo metadata and
lockfile resolution as non-executing structural checks. It did not run a test,
compile, build, package, LIVE-account flow, or HUMAN UI check. Terra must run the
automated and computer-controlled regression prompt supplied with the handoff
before this record can be promoted beyond **verification pending**.
