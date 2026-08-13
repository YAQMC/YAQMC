<p align="center">
  <img src="assets/yaqmc-logo.png" width="168" alt="YAQMC logo">
</p>

<p align="center">
  <a href="README.md">简体中文</a> · <strong>English</strong>
</p>

<h1 align="center">YAQMC</h1>

<p align="center">
  <strong>Yet Another Q Music Client</strong><br>
  A native, unofficial QQ Music desktop client for Windows and Linux.
</p>

<p align="center">
  <a href="https://github.com/YAQMC/YAQMC/actions/workflows/build.yml"><img src="https://github.com/YAQMC/YAQMC/actions/workflows/build.yml/badge.svg" alt="Desktop build status"></a>
  <img src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white" alt="Tauri 2">
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=111" alt="React 19">
  <img src="https://img.shields.io/badge/Rust-1.88%2B-000?logo=rust&logoColor=white" alt="Rust 1.88 or newer">
</p>

> [!IMPORTANT]
> YAQMC is not affiliated with Tencent or QQ Music. It does not bypass subscriptions, regional restrictions, or
> entitlement checks. For encrypted media whose URL and ekey were issued by the service for the active account,
> YAQMC decrypts only the authorized stream locally; it does not obtain unentitled content.

## Highlights

- Native playback owned by one Rust `PlayerService`; React, MPRIS/SMTC, tray controls, shortcuts, and the local API
  are projections over the same state machine.
- QQ Music discovery, search, albums, playlists/toplists, normalized QRC/LRC lyrics, and account-aware playback
  quality.
- Restricted, embedded Tencent OAuth for QQ and WeChat. Passwords and WebView cookies are never copied into the
  application; durable credentials stay in the operating-system secure store.
- Desktop Lyrics and Lyrics Island with word timing, translation/romanization, click-through lock mode, and a
  dedicated on-surface unlock control.
- English and Simplified Chinese UI, light/dark themes, configurable primary and secondary colors, custom
  backgrounds, and native output-device selection.
- Seekable HTTP Range streaming, bounded cache, queue persistence, one-time signed-URL recovery, and an optional
  authenticated loopback API bound to `127.0.0.1`.
- A current-track quality menu in PlayerBar, with Settings remaining the default for later tracks. Account-entitled
  QQ Music `mflac` is decrypted as a seekable stream; only encrypted bytes are retained in the disk cache.

## Downloads

Tagged releases publish the package formats that each supported runner can build natively:

| Platform | Architectures                     | Packages                                                |
| -------- | --------------------------------- | ------------------------------------------------------- |
| Windows  | x86_64 / AMD64, x86 / i686, ARM64 | NSIS `.exe`, WiX `.msi`, portable `.zip`                |
| Linux    | x86_64 / AMD64, ARM64             | AppImage, Debian `.deb`, RPM `.rpm`, portable `.tar.gz` |

AMD64 and x86_64 are two names for the same architecture; Windows “x32” is published as the i686/x86 build.
Release artifacts include SHA-256 checksums. Linux runtime acceptance remains host-specific—especially on native
Wayland—so the x86_64 AppImage also ships with the diagnostics and acceptance bundle described in
[the Linux guide](docs/linux.md).

## Current status

The guest catalog, native playback, lyric surfaces, account session restore, profile projection, and authenticated
home catalog have deterministic coverage and local native validation. Account reads and mutations are implemented,
but release notes must keep live favorite/playlist acceptance explicitly pending until the owner-controlled gate has
been run against an appropriate account.

QMC/MFLAC decryption and random seeking have passed an external-sample acceptance test. Live Master-source
resolution still requires QQ Music to issue a URL and ekey for the active account. YAQMC does not implement or
forge the proprietary QQ Music client VMP signer, so that uncompleted entitled-account gate is not reported as
verified.

| Area                            | Windows                                    | Linux                                                      |
| ------------------------------- | ------------------------------------------ | ---------------------------------------------------------- |
| Desktop client and native audio | Implemented (WebView2, CPAL)               | Implemented (WebKitGTK, host ALSA route)                   |
| Media session                   | SMTC                                       | MPRIS 2.2                                                  |
| Tray and close-to-tray          | Implemented                                | Implemented; presentation depends on desktop environment   |
| Lyric overlays                  | Full positioning and interaction semantics | X11/XWayland supported; native Wayland reports limitations |
| Global shortcuts                | Implemented                                | X11 only; disabled on native Wayland                       |

## Install prerequisites

- Node.js 24 and npm
- Rust 1.88 or newer
- [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/)
- Windows: MSVC build tools and WebView2 Runtime
- Debian/Ubuntu: `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libasound2-dev`

## Development

```powershell
npm ci
npm run tauri dev
```

Browser development intentionally uses the deterministic fake provider because credentials, native audio, cache,
and QQ Music transport live behind Tauri:

```powershell
npm run dev
```

In a native build, QQ Music guest mode is the default. Add `?provider=fake` to the application URL when recording
deterministic UI evidence.

## Build locally

```powershell
# Executable only; no installer
npm run tauri -- build --no-bundle

# Windows host
npm run tauri -- build --bundles nsis,msi

# Linux host
npm run tauri -- build --bundles appimage,deb,rpm
```

Cross-architecture installer builds should use the corresponding Rust target or a native hosted runner; changing an
artifact filename does not change its architecture.

## Verification

```powershell
npm run format:check
npm run check
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-targets
```

Four ignored Rust tests deliberately contact a live provider or audible native output. Run them only on a suitable
host:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture
```

## Architecture

```text
React UI / lyric surfaces / local API / tray / media sessions
                         │
                         ▼
               authoritative PlayerService
                         │
          ┌──────────────┴──────────────┐
          ▼                             ▼
  QQ Music provider              native audio engine
  transport + cache              Rodio / CPAL
```

Security-sensitive account commands are available only to the exact `main` WebView label and are checked again in
Rust. OAuth windows have a Tencent-only navigation allowlist, reject popups, disable autofill/devtools, validate an
unpredictable state value, and accept only the registered QQ Music callback. Lyric unlock controls use a separate,
single-command capability and cannot access account or player state.

## Repository map

- `src/domain` — provider-independent music models
- `src/providers` — provider contract, QQ Music adapter, and fake provider
- `src/application` — native-state projections and application coordination
- `src/components`, `src/pages`, `src/surfaces` — desktop UI and lyric windows
- `src-tauri/src/player.rs` — authoritative queue/playback state machine
- `src-tauri/src/audio.rs` — native decoding/output and device switching
- `src-tauri/src/streaming.rs` — seekable HTTP Range source
- `src-tauri/src/system_media.rs` — MPRIS/SMTC adapters
- `src-tauri/src/desktop_integration.rs` — tray, close behavior, and shortcuts
- `src-tauri/src/platform.rs` — backend/capability diagnostics and export
- `scripts/collect-linux-diagnostics.sh` — privacy-bounded tester capture

Start with [architecture](docs/architecture.md), [playback](docs/playback.md),
[streaming](docs/streaming.md), [platform integration](docs/platform-integration.md),
[Linux runtime](docs/linux.md), [QQ Music provider](docs/qqmusic-provider.md),
[authentication](docs/authentication.md), [account library](docs/account-library.md),
[entitlement](docs/entitlement.md), [lyrics surfaces](docs/lyrics-surfaces.md), and
[local API](docs/local-api.md), or the complete [English documentation index](docs/README.md). Community guidance is
in [CONTRIBUTING-EN.md](CONTRIBUTING-EN.md), [SUPPORT-EN.md](SUPPORT-EN.md),
[SECURITY-EN.md](SECURITY-EN.md), and [CODE_OF_CONDUCT-EN.md](CODE_OF_CONDUCT-EN.md). Third-party copyright and
license texts are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Acknowledgements and project policy

Special thanks to Flechazo for public QMC/MFLAC, Master-quality, and seekable-decryption research ideas, and to
OpenAI Codex / GPT-5.6 Sol for engineering, testing, review, documentation, and release-workflow assistance. The
complete, carefully scoped credits—including the no-source-reuse boundary for unlicensed references—are in
[ACKNOWLEDGEMENTS-EN.md](ACKNOWLEDGEMENTS-EN.md) and the
[provider ledger](docs/qqmusic-provider.md). Reused copyright and license texts remain in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

> [!NOTE]
> The repository does not yet have a project license. Public source visibility does not itself grant permission to
> copy, modify, or redistribute the project. The maintainer must choose a license before the public launch and
> before accepting outside contributions.
