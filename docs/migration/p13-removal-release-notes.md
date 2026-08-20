# P13 desktop-host removal release-note draft

Status: wording draft for maintainer review. It is not release approval or runtime evidence.

## User-visible changes

- YAQMC now has one desktop host: Electron. The parallel Tauri application, its JavaScript packages, Cargo member, permissions, packaging jobs, and host-specific helper scripts are removed.
- Windows x64 and arm64 remain package targets. Windows i686/32-bit packages are discontinued.
- Windows packages are NSIS and portable executables. Linux packages remain AppImage, deb, rpm, and tar.gz.
- Linux no longer needs WebKitGTK for the desktop host. Native audio and the selected packaging format can still require system packages such as ALSA development files, `rpm`, and `fakeroot`.

## Upgrade and data continuity

- Electron continues to use the `org.yaqmc.desktop` application identity and the existing Core data directory contract.
- Existing preferences, cache, database, and credential service/account names are not intentionally migrated or renamed in P13.
- This change does not claim that every historical package can upgrade in place. A packaged A→B rehearsal must verify data and keyring continuity before release.

## Compatibility and release gates

- Renderer file selection now uses private Electron dialog methods followed by explicit-path Core methods.
- The old dialog-coupled protocol methods are retired; their explicit-path continuations remain authoritative.
- Package/runtime verification, cross-architecture startup, OAuth, keyring continuity, updater behavior, and overlay acceptance are delegated to the Terra validation pass.
- Provenance remains blocked until the existing provenance ledger is closed. This draft must not be used to describe the branch as publicly releasable.
