# CI, caches, and downloadable artifacts

> [简体中文](zh-CN/ci.md) | **English**

This page describes the Electron-only GitHub Actions pipeline. Actions artifacts and draft releases are unsigned and do not, by themselves, prove that a package was launched on its target hardware.

## Workflows

| Workflow         | File                                     | Trigger                                          | Result                                                 |
| ---------------- | ---------------------------------------- | ------------------------------------------------ | ------------------------------------------------------ |
| CI               | `.github/workflows/ci.yml`               | pull requests, pushes to `main`, manual dispatch | quality gates plus unsigned package artifacts          |
| Electron release | `.github/workflows/electron-release.yml` | `v*` tags, manual dispatch                       | production-profile packages and a draft GitHub Release |

The removed legacy desktop workflow is not a supported build path. CI package artifacts are retained for 14 days.

## Gates and package matrix

Every CI run performs frontend formatting, documentation, lint, TypeScript,
Vitest and script checks; builds the Electron host on Linux and Windows; runs
Rust fmt, clippy and workspace tests; validates contracts; checks the
unconditional private `qm-api-rs` git pin; explicitly enforces provider readiness
and provenance; and scans for secrets on Linux and Windows. `rust-quality` and
package jobs may rewrite Git `insteadOf` for `github.com/YAQMC/qm-api-rs` when
`QM_API_RS_TOKEN` is present (`CARGO_NET_GIT_FETCH_WITH_CLI=true`). A missing
token skips the rewrite; a build that needs and cannot fetch the private
dependency fails.

- Pull requests package Windows x64 and Linux x64.
- Pushes to `main` package Windows x64/arm64 and Linux x64/arm64.
- Manual runs select `windows`, `linux`, or `all`, and `ci` or `production` optimization.
- Windows arm64 is cross-compiled on `windows-2025`. Linux arm64 uses `ubuntu-22.04-arm`.
- Windows i686 is not built or published.

Superseded pull-request runs are cancelled. Pushes to `main`, tag builds, and manual packaging runs are not cancelled mid-flight.

## Build and packaging flow

`frontend-build` uploads `yaqmc-frontend-dist-<sha>`. Each package job downloads that exact artifact, compiles `yaqmc-core` for its Rust target, stages the Core executable, builds Electron Main/preload code, and invokes electron-builder with publishing disabled.

Windows produces an NSIS installer and portable executable. Linux produces AppImage, `.deb`, `.rpm`, and `.tar.gz`. Package jobs install Electron packaging tools on Linux; retired Linux web-runtime packages are not host dependencies.

Do not upload or reuse `node_modules` between jobs.

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

The release workflow fails before packaging unless the pin, provider readiness, and
provenance gates pass. It checks out the exact private dependency revision,
builds revision-bound YAQMC and `qm-api-rs` source archives, and writes
`CORRESPONDING-SOURCE-MANIFEST.json`. Assembly verifies those archive hashes,
flattens package assets, writes `SHA256SUMS-electron.txt` and
`RELEASE-NOTES-ELECTRON.md`, and keeps only x64 updater feeds as `latest.yml`
and `latest-linux.yml`. A `v*` push keeps that tag; a manual run uses
`electron-draft-<run-id>`. Both create a draft release for maintainer review.

## Build-accepted versus runtime-tested

A green package job proves compilation, package assembly, metadata generation, and artifact upload. It does not prove startup, overlay behavior, OAuth, keyring continuity, media integration, updater behavior, or native execution on every OS/CPU. Those require separate hardware acceptance evidence.

## Local commands

```powershell
npm run ci:frontend-build
npm run ci:test-scripts
npm run ci:package-metadata
npm run p14c:enforce
npm run provenance:enforce
npm run package -w @yaqmc/desktop -- --publish never
```
