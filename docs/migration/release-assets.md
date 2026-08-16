# Release assets and approved compatibility deltas

## Current Tauri package matrix

| Platform | Architectures | Artifacts |
|---|---|---|
| Windows | x64, i686, arm64 | NSIS installer, MSI installer, portable ZIP |
| Linux | x64, arm64 | AppImage, deb, rpm, portable tar.gz |

The current CI and release workflows are `.github/workflows/ci.yml` and `.github/workflows/build.yml`. Builds are unsigned and tagged releases publish staged assets and checksums to GitHub Releases.

## Approved Electron compatibility changes

The following are deliberate, approved compatibility changes; they are not accidental packaging regressions.

| Change | Decision | Rationale / user handling |
|---|---|---|
| Windows MSI | Remove after Electron packaging takes over | Electron target set is NSIS installer plus portable ZIP; release notes must call out the removed MSI channel. |
| Windows i686 | Remove | Electron ships Windows x64 and arm64, not supported 32-bit Windows builds. Keep the final Tauri i686 release downloadable and document the change in release notes. |

The intended Electron matrix is Windows x64/arm64 (NSIS + portable ZIP) and Linux x64/arm64 (AppImage, deb, rpm, tar.gz). `appId` remains `org.yaqmc.desktop` so application data and keyring identity remain continuous.
