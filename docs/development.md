# Development

> [简体中文](zh-CN/development.md) | **English**

YAQMC has a shared React renderer and Rust Core with two native hosts. Electron
uses Main/preload plus a supervised Core process; Android embeds Core through
JNI in a Capacitor host. Browser development intentionally substitutes the
deterministic fake provider.

## Required toolchain

- Node.js **26.7.0 exactly** and the npm version bundled with it;
- Rust **1.88.0 or newer** (CI verifies the workspace on 1.88.0);
- Windows: MSVC build tools;
- Debian/Ubuntu: ALSA development headers for native audio, plus `rpm` and
  `fakeroot` when producing every Linux package format.
- Android: JDK 21, Android SDK/build tools 36, NDK 28.2.13676358, and
  cargo-ndk 4.1.2. Android Studio 2025.2.1 or newer is recommended.

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

The provider manifest declares the `qqmusic-api` crate
unconditionally from `https://github.com/YAQMC/qm-api-rs.git`, revision
`bab630d44901f80cae47dd0f09314950d0028e23`.

Cargo is run with `CARGO_NET_GIT_FETCH_WITH_CLI=true` by the desktop developer
launcher. The access helper validates the manifest pin and any sibling checkout without modifying Git config:

```powershell
node scripts/ci/qm-api-rs-access.mjs --check
```

If a sibling `../qm-api-rs` checkout exists, that command also requires its
HEAD to match the production pin.

### Optional local protocol development

The library's `main` branch contains the exact production pin above. A sibling development
checkout can optionally use an ignored, project-local `.cargo/config.toml`:

```toml
[patch."https://github.com/YAQMC/qm-api-rs.git"]
qqmusic-api = { path = "../qm-api-rs" }
```

Keep the sibling checkout at the recorded revision. Ordinary Cargo commands
use it automatically, including `cargo build -p yaqmc-core --release --locked
--offline`; no extra `--config` argument or global configuration is needed.
Other checkouts can fetch the pinned Git revision without a sibling override.
Local overrides do not satisfy the Git-source release gate or the required
exact-pin soak.

## Full desktop run

```powershell
npm ci --include=dev --workspaces --include-workspace-root
npm run dev:desktop
```

Run these commands from the repository root after pulling dependency changes. Desktop development needs
both the root tools (`vite`) and the desktop workspace tools (`esbuild` and `electron`), including
`devDependencies`. A production-only or single-workspace install is insufficient. If startup reports
missing tools, repeat the locked install above rather than adding individual packages to the manifests.

`dev:desktop` compiles a debug `yaqmc-core`, stages its integrity manifest,
starts Vite, watches Electron Main/preload, and launches Electron. It does not
enable a QA profile and may use the normal application data directories.
It checks the development tools before compiling Core and stops the other processes if a watcher exits.

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

## Android build

Android debug builds include ARM64 and an x86_64 emulator library. Published
release APKs contain ARM64 only.

```powershell
npm ci
npm run android:check
npm run android:build:debug
```

Release signing is injected only through the `release-signing` environment in
CI. A local release build must use the same four `ANDROID_RELEASE_*`
environment variables; never put those values in a tracked Gradle file. See
the [Android guide](android.md).

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
npm run android:check
```

Ignored Rust tests can contact live services or produce audible output. Do not
run them in CI or against an account/profile that the maintainer has not placed
in scope. Electron smoke, E2E, performance, and acceptance runs must use their
QA sandbox helpers and must never reuse the production profile.

See [CI and package behavior](ci.md), [data locations and uninstall](data-locations.md),
and [architecture](architecture.md).
