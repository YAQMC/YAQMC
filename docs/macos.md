# macOS

> [简体中文](zh-CN/macos.md) | **English**

YAQMC builds macOS packages for **Apple silicon (arm64)** and **Intel (x64)** from the same commit as the Windows and
Linux packages. macOS 12 Monterey or newer is required (Electron 43's minimum). There is no universal build: pick
`YAQMC-macos-arm64.dmg` on Apple silicon and `YAQMC-macos-x64.dmg` on Intel Macs. Each package also has a `.zip`
containing the same `.app`.

## Installing and Gatekeeper

How Gatekeeper treats the app depends on how the release was built, and the release notes state which mode was used:

| Release mode                 | Signature                                             | First launch                                                                            |
| ---------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Default (no Apple account)   | ad-hoc, no hardened runtime                           | Blocked once. Open **System Settings → Privacy & Security** and choose **Open Anyway**. |
| Opted-in signing (see below) | Developer ID, hardened runtime, notarized and stapled | Opens normally after the usual download prompt.                                         |

Ad-hoc signing is not a publisher identity. It exists only because Apple silicon refuses to run code without any
signature. Compare the published SHA-256 checksums before opening an ad-hoc build.

## Data locations

| Purpose         | Path                                                  |
| --------------- | ----------------------------------------------------- |
| Data and config | `~/Library/Application Support/org.yaqmc.desktop`     |
| Cache           | `~/Library/Caches/org.yaqmc.desktop`                  |
| Logs            | `~/Library/Logs/org.yaqmc.desktop`                    |
| Credentials     | macOS Keychain, service namespace `org.yaqmc.desktop` |

XDG variables are ignored on macOS. See [data locations](data-locations.md) for the other platforms.

## Platform behavior

- The window uses the native traffic-light buttons (hidden-inset title bar) instead of YAQMC's own window controls.
  The top bar and the strip above the sidebar drag the window.
- The menu-bar (tray) icon is scaled to the menu bar. Clicking the Dock icon shows a window hidden by close-to-tray.
- Audio plays through CoreAudio in the Core sidecar. Credentials use the Keychain.

## Known limitations

- **No in-app updates.** macOS packages report `unsupported-package` to the updater; download a new release instead.
  In-place updates require a signed app and a macOS-specific replacement path that is not implemented.
- **No Now Playing / media-key integration yet.** Core's system-media adapters cover MPRIS (Linux) and SMTC (Windows).
  macOS `MPNowPlayingInfoCenter` needs an `NSApplication` run loop that the headless Core sidecar does not have.
- **Global shortcuts for media keys** may require granting YAQMC Accessibility access in System Settings.
- Desktop Lyrics and Lyrics Island overlays use the same Electron window APIs as the other platforms, but their
  click-through and always-on-top behavior has **not been validated on macOS hardware**.

## Building locally

On a Mac with Xcode Command Line Tools, Node.js 26.7.0 and Rust 1.88:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm ci
node scripts/ci/package-electron.mjs --os macos --arch arm64 --target aarch64-apple-darwin
```

Use `--arch x64 --target x86_64-apple-darwin` for an Intel package; it cross-compiles on Apple silicon. Without
`--require-signing true` the script produces an ad-hoc signed app with hardened runtime and notarization off, which
matches the default release mode. Verify the result with:

```sh
node scripts/ci/verify-macos-package.mjs --dir release-electron/YAQMC-electron-macos-arm64 --arch arm64 --signed false
```

## Release signing and notarization (maintainers)

Signing is opt-in so that the project keeps shipping without an Apple Developer account. To enable it:

1. Set the repository variable `YAQMC_MACOS_SIGNING` to `true`.
2. Add these secrets to the protected `release-signing` environment:

   | Secret                    | Content                                                                             |
   | ------------------------- | ----------------------------------------------------------------------------------- |
   | `MAC_CSC_LINK`            | Base64 of the **Developer ID Application** certificate `.p12`                       |
   | `MAC_CSC_KEY_PASSWORD`    | Password of that `.p12`                                                             |
   | `APPLE_API_KEY_P8_BASE64` | Base64 of an App Store Connect API key (`AuthKey_XXXX.p8`) with notarization access |
   | `APPLE_API_KEY_ID`        | The key's ID                                                                        |
   | `APPLE_API_ISSUER`        | The issuer ID of the App Store Connect team                                         |

With the variable enabled, `release-preflight.mjs` fails the release if any of these is missing; it never silently
falls back to ad-hoc. The package job layers `electron-builder.release.yml`, which sets `forceCodeSigning`, hardened
runtime and `notarize: true`. `verify-macos-package.mjs` then requires a Developer ID signature with a Team ID,
hardened runtime, `spctl` acceptance and a stapled notarization ticket.

Entitlements are deliberately minimal and live in `apps/desktop/resources/macos/`:

- the app gets `com.apple.security.cs.allow-jit` (V8);
- nested executables additionally get `com.apple.security.cs.allow-unsigned-executable-memory`, because the Core
  sidecar's Wasmtime compiles plugin WebAssembly at runtime.

No microphone, camera, Apple Events or library-validation exceptions are requested.

CI builds on Intel to avoid ARM runner capacity failures; arm64 packages are cross-compiled.
This does not provide native Apple silicon runtime validation.

## Verification status

| Item                                                                       | Status                                                     |
| -------------------------------------------------------------------------- | ---------------------------------------------------------- |
| electron-builder configuration and entitlements                            | Schema-validated; not yet packaged on macOS by this change |
| CI: Core build and unit tests on `macos-15-intel` (x64), arm64 cross-check | Configured; runs on the next CI execution                  |
| Ad-hoc package build and verification                                      | Configured in CI and release; not yet run                  |
| Developer ID signing and notarization                                      | **Untested** — requires Apple credentials                  |
| Runtime behavior on macOS hardware (audio, Keychain, overlays)             | **Not validated**                                          |
