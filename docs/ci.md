# CI, caches, and downloadable artifacts

> [简体中文](zh-CN/ci.md) | **English**

This page describes GitHub Actions for YAQMC. It is not a substitute for a tagged GitHub Release.

## Workflows

| Workflow              | File                                     | When it runs                                     | What it produces                                                                                       |
| --------------------- | ---------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| CI                    | `.github/workflows/ci.yml`               | pull requests, pushes to `main`, manual dispatch | quality gates plus unsigned Actions artifacts                                                          |
| Build desktop bundles | `.github/workflows/build.yml`            | `v*` tags and manual dispatch                    | production-profile Tauri installers; tagged GitHub Releases only on `v*`                               |
| Electron release      | `.github/workflows/electron-release.yml` | `v*` tags and manual dispatch                    | production-profile Electron installers; **draft** GitHub Release on `electron-v*` / `electron-draft-*` |
| Project website       | `.github/workflows/pages.yml`            | documentation/site changes on `main`             | GitHub Pages when the repository is public                                                             |

CI artifacts are **not** GitHub Releases. Retention is **14 days**. Do not treat a green packaging job as native runtime proof for every architecture.

## Events and matrix

- **Pull request:** Prettier, ESLint, TypeScript, Vitest, docs, secret scan, Rust fmt/clippy/tests, one frontend production build, an Electron host build-only job on Ubuntu and Windows, Windows x86_64 and Linux x86_64 Tauri packages, and Electron NSIS/portable plus AppImage/deb/rpm/tar.gz for Windows x64 and Linux x64.
- **Push to `main`:** the same quality gates plus the full Tauri Windows/Linux matrix (`x86_64`, `i686`, `aarch64` on Windows; `x86_64` and `aarch64` on Linux) and the Electron matrix (Windows x64, Windows arm64 cross on `windows-2025`, Linux x64, Linux arm64 on `ubuntu-22.04-arm`). Electron does not pack Windows i686.
- **Manual `workflow_dispatch`:** choose `windows`, `linux`, or `all`, and `ci` or `production` optimization. Both Tauri and Electron package jobs honor the OS filter.

Superseded pull-request runs are cancelled. Pushes to `main` and manual packaging runs are not cancelled mid-flight.

## Frontend reuse

Packaging jobs download `yaqmc-frontend-dist-<sha>`. `YAQMC_PREBUILT_FRONTEND=1` makes `scripts/ci/tauri-before-build.mjs` skip Vite after checking `dist/yaqmc-frontend-build.json` against the current commit, and makes `scripts/ci/package-electron.mjs` reuse that same dist (no second Vite build). Local `tauri build` still runs a normal frontend build. Electron packs need a populated `dist/` (CI downloads it; locally run `npm run ci:frontend-build` first).

Do not upload `node_modules` between jobs.

## Native compile

Each Tauri packaging target runs `tauri build --no-bundle` once, verifies PE/ELF architecture, then `tauri bundle` for the requested formats. Windows publishes NSIS, MSI, and a portable ZIP of the executable. Linux publishes AppImage, `.deb`, `.rpm`, and a dynamically linked binary tarball (not a static portable). The x86_64 AppImage still receives the existing GDK session-aware repack.

Each Electron packaging target compiles `yaqmc-core` for the rust triple, stages it with `scripts/stage-core.mjs --rust-target`, builds `@yaqmc/desktop`, then runs electron-builder with `--publish never`. Windows publishes NSIS and a portable exe. Linux publishes AppImage, `.deb`, `.rpm`, and `.tar.gz`. Electron jobs install `rpm`/`fakeroot` on Linux and do not install WebKitGTK.

For Tauri, staging copies installers from `target/<triple>/release/bundle` next to the release-root `yaqmc` / `yaqmc.exe`. It does not search nested payload copies of that binary. Linux packaging installs `xdg-utils` and sets `APPIMAGE_EXTRACT_AND_RUN=1` so linuxdeploy can run on ARM runners that lack `/usr/bin/xdg-open` or FUSE.

## Optimization profiles

The Cargo `[profile.release]` in the repository remains Fat LTO (`lto = true`, `codegen-units = 1`) for local `tauri build` and tagged production builds.

Normal CI packages set:

```
CARGO_PROFILE_RELEASE_LTO=thin
CARGO_PROFILE_RELEASE_CODEGEN_UNITS=8
```

That is still an optimized release build (debug assertions off, `opt-level = "s"`). It is not a debug artifact. `build-info.json` records `profile`, `lto`, and `codegenUnits`. Manual dispatch `production` uses the repository Fat LTO settings and names that in metadata.

Measured local Windows x86_64 `--release` compile (same machine; ThinLTO used an isolated `CARGO_TARGET_DIR`):

- Fat LTO / `codegen-units=1`: about 3 minutes 47 seconds native compile during a previous full package; `yaqmc.exe` was about 12.1 MB. A later `cargo clean --release` failed because that executable was locked.
- ThinLTO / `codegen-units=8`: 141.7 seconds, 14.2 MB (`output/lto-bench/thin.json`). This is the default CI package profile.
- LTO off / `codegen-units=8`: 107.4 seconds, 14.4 MB. Faster to compile, but this repository did not measure runtime playback quality against ThinLTO, so CI keeps ThinLTO.

## Caches

Cargo caches are keyed by OS, target triple, toolchain class (`1.88` for packaging, `stable` for rust-quality), `Cargo.lock`, and profile class (`dev`, `ci-release`, `production`). Paths are the crates.io registry, git checkouts, and root-workspace `target`.

Packaging installs Rust **1.88**. Quality jobs use the current stable `rustfmt`/`clippy` so they match local `cargo fmt` / `cargo clippy`.

Restored caches are untrusted build inputs. Pull requests and pushes to other branches may restore those keys but do not save onto them. Saves happen on `main` pushes and manual dispatch. A cold cache must still succeed.

To invalidate a cache, change `Cargo.lock` or the key prefix in `.github/actions/setup-packaging/action.yml`.

## Artifact names

Each target uploads `YAQMC-<os>-<arch>-<sha>` containing versioned files plus `build-info.json` and `SHA256SUMS-<os>-<arch>.txt`. Architecture labels follow existing release naming: `x86_64`, `i686`, `aarch64`.

Electron targets upload `YAQMC-electron-<os>-<arch>-<sha>` from `release-electron/YAQMC-electron-<os>-<arch>/`. Architecture labels follow electron-builder: `x64`, `arm64`. Those artifacts are unsigned Actions blobs, not GitHub Releases.

## Runners

- Windows x86_64 / i686: `windows-2025`
- Windows aarch64 (Tauri): `windows-11-arm` (native; never cross-label an x64 binary)
- Windows arm64 (Electron): `windows-2025` with `cargo --target aarch64-pc-windows-msvc` (cross; CI-03 boot-test pending)
- Linux x86_64: `ubuntu-22.04`
- Linux aarch64: `ubuntu-22.04-arm`

If an ARM hosted runner is unavailable, that matrix row fails with a runner error. It must not silently publish the wrong architecture.

## Build-accepted vs runtime-tested

CI packaging means the binary compiled, architecture checks passed, and bundles were uploaded. It does **not** mean the artifact was launched on that OS/CPU. Windows x86_64 is the maintained runtime-tested desktop target in this repository. Linux and ARM rows are package-inspected unless a later acceptance record says otherwise.

## Local commands

```powershell
npm run ci:frontend-build
npm run ci:test-scripts
npm run ci:package-metadata
```

Unsigned CI artifacts do not use release signing secrets. Formal Tauri tags still go through `.github/workflows/build.yml`. Electron drafts go through `.github/workflows/electron-release.yml` on `electron-v*` / `electron-draft-*` and stay unpublished until a maintainer promotes them.
