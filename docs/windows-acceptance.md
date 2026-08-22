# Windows acceptance

> [简体中文](zh-CN/windows-acceptance.md) | **English**

This protocol applies to the current packaged Electron host. A successful build
or E2E run is prerequisite evidence, not a substitute for testing the packaged
application on Windows.

## Package identity

Use the exact `YAQMC-electron-windows-<arch>-<commit>` CI artifact. Before
launching it:

1. Confirm the artifact directory name and `build-info-windows-<arch>.json`
   identify the intended 40-character commit, Rust target, package profile, and
   architecture.
2. Verify every staged installer and portable executable against
   `SHA256SUMS-electron-windows-<arch>.txt`.
3. Preserve the build-info file, checksum file, OS build, display layout, and
   test verdict with the acceptance record.

Do not rename an artifact to represent another architecture. Local unpacked
output is not release evidence.

## Automated prerequisite

On the exact tested commit, the normal quality gates must pass with the pinned
Node.js and Rust toolchains:

```powershell
npm run check
npm run stage-core
npm run build -w @yaqmc/desktop
npm run test:e2e:electron
```

Record the command results separately. Do not mark manual rows verified from
automation alone.

## Manual package protocol

Use a disposable Windows account or an explicitly isolated QA profile. Never
reuse a maintainer's production profile or real account unless that profile and
account were intentionally placed in scope.

Test both the NSIS installer and portable executable:

- cold start, single-instance behavior, close-to-tray, tray restore, and clean
  exit;
- main-window resize, maximize, Focus mode, native fullscreen, and exact
  geometry restoration;
- desktop lyrics and lyrics island show/hide, drag, lock, direct unlock, and
  tray/Settings recovery;
- pause/resume, seek, previous/next, queue continuity, output-device selection,
  and Windows media controls;
- theme, locale, reduced motion, translation, and romanization;
- diagnostics export and confirmation that logs contain no credentials or
  signed media URLs;
- installer upgrade over the previous release, uninstall, portable isolation,
  and the documented retained-data behavior.

Authenticated QQ Music login, playback, account reads, and account mutations are
separate LIVE checks. Record them only with an authorized test account and
redacted evidence.

A Windows verdict is complete only when package identity, automated
prerequisites, every applicable manual row, failures, waivers, and the exact
tested environment are recorded. Missing evidence is `pending`, not `pass`.
