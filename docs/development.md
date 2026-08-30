# Development

> [简体中文](zh-CN/development.md) | **English**

YAQMC has three build layers: the React renderer, the Electron Main/preload
host, and the Rust Core process. Native development builds all three; browser
development intentionally substitutes the deterministic fake provider.

## Required toolchain

- Node.js **26.7.0 exactly** and the npm version bundled with it;
- Rust **1.88.0 or newer** (CI verifies the workspace on 1.88.0);
- Windows: MSVC build tools;
- Debian/Ubuntu: ALSA development headers for native audio, plus `rpm` and
  `fakeroot` when producing every Linux package format.

The repository pins Node in `package.json`, `package-lock.json`, and
`.node-version`. Check `node --version` before interpreting JavaScript or
TypeScript failures.

## Public checkout

The React renderer and its deterministic fake provider do not build the native production dependency:

```powershell
npm ci
npm run dev
```

This mode supports UI, state-management, localization, and component work. It intentionally has no native audio,
keyring, disk cache, tray, media session, or real QQ Music transport.

## Native provider pin

The production provider links the public `qqmusic-api` crate
unconditionally from `https://github.com/YAQMC/qm-api-rs.git`, revision
`2ef9182732e02db23788175dbe5b7d9d937e328f`.

Cargo is run with `CARGO_NET_GIT_FETCH_WITH_CLI=true` by the desktop developer
launcher. The access helper validates the manifest pin and any sibling checkout without modifying Git config:

```powershell
node scripts/ci/qm-api-rs-access.mjs --check
```

If a sibling `../qm-api-rs` checkout exists, that command also requires its
HEAD to match the production pin.

## Full desktop run

```powershell
npm ci
npm run dev:desktop
```

`dev:desktop` compiles a debug `yaqmc-core`, stages its integrity manifest,
starts Vite, watches Electron Main/preload, and launches Electron. It does not
enable a QA profile and may use the normal application data directories.

## Release-shaped local build

Build and stage Core before invoking electron-builder:

```powershell
npm ci
cargo build -p yaqmc-core --release --locked
npm run stage-core -- --profile release
npm run ci:frontend-build
npm run build -w @yaqmc/desktop
npm run package -w @yaqmc/desktop -- --publish never
```

This produces only the current host architecture. Cross-architecture packages
must use the matching Rust target and the CI packaging matrix; renaming an
artifact does not change its architecture. Local builds must always keep
`--publish never`.

## Verification

```powershell
npm run provider:enforce
npm run provenance:enforce
npm run format:check
npm run docs:check
npm run lint
npm run typecheck
npm test
npm run ci:test-scripts
npm run ci:verify-workspace
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --all-targets --locked
npm run contracts:check
```

Ignored Rust tests can contact live services or produce audible output. Do not
run them in CI or against an account/profile that the maintainer has not placed
in scope. Electron smoke, E2E, performance, and acceptance runs must use their
QA sandbox helpers and must never reuse the production profile.

See [CI and package behavior](ci.md), [data locations and uninstall](data-locations.md),
and [architecture](architecture.md).
