# Release assets and approved compatibility deltas

> **P15 historical-evidence overlay:** the matrices below capture the
> coexistence and removal plan at their original checkpoints. The Tauri release
> path is retired. Use [`../ci.md`](../ci.md) for the current Electron package
> and corresponding-source workflow.

## Current Tauri package matrix

| Platform | Architectures         | Artifacts                                   |
| -------- | --------------------- | ------------------------------------------- |
| Windows  | x86_64, i686, aarch64 | NSIS installer, MSI installer, portable ZIP |
| Linux    | x86_64, aarch64       | AppImage, deb, rpm, portable tar.gz         |

The current CI and release workflows are `.github/workflows/ci.yml` and `.github/workflows/build.yml`. Builds are unsigned and tagged releases publish staged assets and checksums to GitHub Releases.

## Current filename contracts

The tagged-release workflow preserves Tauri's generated basename for Linux packages and prefixes the generated Windows installer basename. The names that the workflow itself fixes are:

| Platform                    | Artifact                | Filename or pattern                            |
| --------------------------- | ----------------------- | ---------------------------------------------- |
| Windows x86_64/i686/aarch64 | NSIS/MSI                | `YAQMC-windows-{arch}-{tauri-bundle-filename}` |
| Windows x86_64/i686/aarch64 | Portable archive        | `YAQMC-windows-{arch}-portable.zip`            |
| Windows x86_64/i686/aarch64 | Checksums               | `SHA256SUMS-windows-{arch}.txt`                |
| Linux x86_64/aarch64        | AppImage/deb/rpm        | `{tauri-bundle-filename}`                      |
| Linux x86_64/aarch64        | Portable binary archive | `YAQMC-linux-{arch}-portable.tar.gz`           |
| Linux x86_64 only           | Tester archive          | `YAQMC-linux-x86_64-tester.tar.gz`             |
| Linux x86_64/aarch64        | Checksums               | `SHA256SUMS-linux-{arch}.txt`                  |

`scripts/ci/stage-artifacts.mjs`, used by CI rather than tagged releases, normalizes package names with the prefix `YAQMC-{version}-{os}-{arch}-{shortSha}` and adds `README-binary.txt` on Linux plus `build-info.json`. Its complete name-pattern inventory is generated into `docs/migration/perf-baseline.md`.

## Approved Electron compatibility changes

The following are deliberate, approved compatibility changes; they are not accidental packaging regressions.

| Change       | Decision                                   | Rationale / user handling                                                                                                                                           |
| ------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows MSI  | Remove after Electron packaging takes over | Electron target set is NSIS installer plus portable ZIP; release notes must call out the removed MSI channel.                                                       |
| Windows i686 | Remove                                     | Electron ships Windows x64 and arm64, not supported 32-bit Windows builds. Keep the final Tauri i686 release downloadable and document the change in release notes. |

The intended Electron matrix is Windows x64/arm64 (NSIS + portable ZIP) and Linux x64/arm64 (AppImage, deb, rpm, tar.gz). `appId` remains `org.yaqmc.desktop` so application data and keyring identity remain continuous.
