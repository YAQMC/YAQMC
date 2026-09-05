# CI, caches, and downloadable artifacts

> [简体中文](zh-CN/ci.md) | **English**

This page describes the desktop and Android GitHub Actions pipelines. Ordinary CI package artifacts are not published and may be unsigned. The release workflow requires Authenticode for every Windows installer and portable executable and a persistent release certificate for Android; Linux release formats remain unsigned. None of these artifacts, by themselves, prove that a package was launched on its target hardware.

## Workflows

| Workflow      | File                                     | Trigger                                          | Result                                                                                  |
| ------------- | ---------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| CI            | `.github/workflows/ci.yml`               | pull requests, pushes to `main`, manual dispatch | quality gates plus unsigned package artifacts                                           |
| YAQMC release | `.github/workflows/electron-release.yml` | `v*` tags, manual dispatch                       | signer-gated Windows and Android packages, Linux packages, and one draft GitHub Release |

The removed legacy desktop workflow is not a supported build path. CI package artifacts are retained for 14 days.

## Gates and package matrix

Every CI run performs frontend formatting, documentation, lint, TypeScript,
Vitest and script checks; builds the Electron host on Linux and Windows; runs
Rust fmt, clippy and workspace tests; validates contracts; checks the
unconditional public `qm-api-rs` git pin; explicitly enforces provider readiness
and provenance; and scans for secrets on Linux and Windows. Cargo fetches the exact public revision directly with
`CARGO_NET_GIT_FETCH_WITH_CLI=true`.

- Pull requests package Windows x64 and Linux x64.
- Pushes to `main` package Windows x64/arm64 and Linux x64/arm64.
- Manual runs select `windows`, `linux`, or `all`, and `ci` or `production` optimization.
- Windows arm64 is cross-compiled on `windows-2025`. Linux arm64 uses `ubuntu-22.04-arm`.
- Windows i686 is not built or published.

Superseded pull-request runs are cancelled. Pushes to `main`, tag builds, and manual packaging runs are not cancelled mid-flight.

## Build and packaging flow

`frontend-build` uploads `yaqmc-frontend-dist-<sha>`. Each package job downloads that exact artifact, compiles `yaqmc-core` for its Rust target, stages the Core executable, builds Electron Main/preload code, and invokes electron-builder with publishing disabled.

Windows produces an NSIS installer and portable executable. Linux produces AppImage, `.deb`, `.rpm`, and `.tar.gz`. Package jobs install Electron packaging tools on Linux; retired Linux web-runtime packages are not host dependencies.

The Android release job builds its own `dist-android` renderer, compiles the shared Rust Core for `arm64-v8a`, synchronizes Capacitor, and assembles a minified release APK with JDK 21, SDK 36, and NDK 28.2.13676358. Android does not reuse the desktop renderer artifact because its host feature boundary is different.

Do not upload or reuse `node_modules` between jobs.

## Windows release signing

The `electron-release` package matrix uses the protected `release-signing`
environment. Its Windows jobs require these environment secrets:

- `WIN_CSC_LINK`: a base64-encoded PFX/P12 certificate or another
  electron-builder-supported certificate reference;
- `WIN_CSC_KEY_PASSWORD`: the certificate password;
- `YAQMC_WINDOWS_SIGNER_SUBJECT`: the complete expected Authenticode
  certificate Subject.

The release job layers `electron-builder.release.yml` over the normal builder
configuration. `forceCodeSigning: true` aborts the job if signing is unavailable.
Before upload, PowerShell verifies both expected EXEs with
`Get-AuthenticodeSignature`, requires `Valid` status, and compares the signer
Subject to the protected value. The updater keeps electron-updater's default
publisher-signature verification enabled. Signing credentials are available
only to the package step, not `npm ci`, artifact upload, or assembly jobs.

## Android release signing

The Android package job uses the same protected `release-signing` environment and requires:

- `ANDROID_RELEASE_KEYSTORE_BASE64`: the persistent release keystore encoded as Base64;
- `ANDROID_RELEASE_KEY_ALIAS`: the release key alias;
- `ANDROID_RELEASE_STORE_PASSWORD`: the keystore password;
- `ANDROID_RELEASE_KEY_PASSWORD`: the key password.
- `ANDROID_RELEASE_CERT_SHA256`: the expected SHA-256 digest of the release signing certificate.

The workflow decodes the keystore only into the runner's temporary directory, limits its permissions, and removes it before artifact upload. Missing signing data fails closed. After Gradle assembly, Android Build Tools `apksigner verify --print-certs` checks the APK and compares its certificate digest to the protected expected value; `sha256sum --check` then verifies the staged checksum. Keep the same signing key for every upgrade of `org.yaqmc.android`; losing it prevents users from installing an update over the existing app.

## Optimization and caches

Normal CI packages override the release profile with ThinLTO and eight codegen units:

```text
CARGO_PROFILE_RELEASE_LTO=thin
CARGO_PROFILE_RELEASE_CODEGEN_UNITS=8
```

Manual `production` runs and the release workflow use Fat LTO and one codegen
unit. Every package artifact contains a unique
`build-info-<os>-<arch>.json` recording the effective profile, LTO mode,
codegen units, Rust target, Node version, Electron version, and Git identity.
The release assembler requires that identity to match the corresponding-source
commit before flattening assets.

Cargo caches are keyed by OS, Rust target, toolchain class, `Cargo.lock`, and profile class. Pull requests may restore caches but only `main` pushes, tags, and manual runs save them. Restored caches are untrusted inputs; a cold-cache build must still succeed.

## Artifact and release names

CI uploads `YAQMC-electron-<os>-<arch>-<sha>` from the corresponding `release-electron` directory. Architectures use electron-builder labels `x64` and `arm64`.

Linux x64 package jobs also upload
`YAQMC-linux-x64-tester-<sha>`. This separate flat artifact contains the exact
AppImage, immutable build identity, checksums, current testing/acceptance
instructions, collector, and verifier. CI runs the verifier's identity-only
gate before upload; it is not mixed into draft release assets.

The release workflow fails before packaging unless the pin, provider readiness,
provenance, Windows signing, and Android signing gates pass. It checks out the exact dependency revisions,
builds revision-bound YAQMC, `qm-api-rs`, and AMLL source archives, and writes
`CORRESPONDING-SOURCE-MANIFEST.json`. Assembly verifies those archive hashes,
flattens package assets, validates the Android build identity against the same Git commit,
writes platform checksums plus `RELEASE-NOTES.md`, and keeps only x64 updater feeds as `latest.yml`
and `latest-linux.yml`. A `v*` push keeps that tag; a manual run uses
`electron-draft-<run-id>`. Both create a draft release for maintainer review.

The packaged renderer uses the AGPL-licensed AMLL packages. Assembly verifies their exact package version,
license, revision, source entry points, archive hash, and the requirements in
[the corresponding-source policy](../CORRESPONDING_SOURCE_POLICY.md).

## Build-accepted versus runtime-tested

A green package job proves compilation, package assembly, metadata generation, and artifact upload. It does not prove startup, overlay behavior, OAuth, keyring continuity, media integration, updater behavior, or native execution on every OS/CPU. Those require separate hardware acceptance evidence.

## Local commands

```powershell
npm run ci:frontend-build
npm run ci:test-scripts
npm run ci:package-metadata
npm run provider:enforce
npm run provenance:enforce
npm run package -w @yaqmc/desktop -- --publish never
```
