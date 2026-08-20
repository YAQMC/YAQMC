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
  <a href="https://github.com/YAQMC/YAQMC/actions/workflows/ci.yml"><img src="https://github.com/YAQMC/YAQMC/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <img src="https://img.shields.io/badge/Electron-43-47848F?logo=electron&logoColor=white" alt="Electron 43">
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
- Restricted, embedded Tencent OAuth for QQ and WeChat. Passwords and OAuth-window cookies are never copied into the
  application; durable credentials stay in the operating-system secure store.
- Desktop Lyrics and Lyrics Island with word timing, translation/romanization, click-through lock mode, and a
  dedicated on-surface unlock control.
- English and Simplified Chinese UI, light/dark themes, configurable primary and secondary colors, custom
  backgrounds, native output-device selection, and optional local [example plugins](docs/plugin-examples.md).
- Seekable HTTP Range streaming, bounded cache, queue persistence, one-time signed-URL recovery, and an optional
  authenticated loopback API bound to `127.0.0.1`.
- A current-track quality menu in PlayerBar, with Settings remaining the default for later tracks. Account-entitled
  QQ Music `mflac` is decrypted as a seekable stream; only encrypted bytes are retained in the disk cache.

## Downloads

Tagged releases publish the package formats that each supported runner can build natively:

| Platform | Architectures         | Packages                                                |
| -------- | --------------------- | ------------------------------------------------------- |
| Windows  | x64 / AMD64, ARM64    | NSIS `.exe`, portable `.exe`                            |
| Linux    | x86_64 / AMD64, ARM64 | AppImage, Debian `.deb`, RPM `.rpm`, portable `.tar.gz` |

AMD64, x86_64, and the release label x64 name the same architecture. Windows i686/x86 packages are no longer published.
Release artifacts include SHA-256 checksums. Linux runtime acceptance remains host-specific—especially on native
Wayland—so the x86_64 AppImage also ships with the diagnostics and acceptance bundle described in
[the Linux guide](docs/linux.md).

## Current status

The guest catalog, native playback, lyric surfaces, account session restore, profile projection, and authenticated
home catalog have deterministic coverage and local native validation. Account reads and mutations are implemented;
live favorite/playlist acceptance is recorded separately from deterministic coverage.

QMC/MFLAC decryption and random seeking have passed an external-sample acceptance test. Live Master-source
resolution still requires QQ Music to issue a URL and ekey for the active account. YAQMC does not implement or
forge the proprietary QQ Music client VMP signer, so that uncompleted entitled-account gate is not reported as
verified.

| Area                            | Windows                                    | Linux                                                      |
| ------------------------------- | ------------------------------------------ | ---------------------------------------------------------- |
| Desktop client and native audio | Implemented (Electron/Chromium, CPAL)      | Implemented (Electron/Chromium, ALSA/CPAL)                 |
| Media session                   | SMTC                                       | MPRIS 2.2                                                  |
| Tray and close-to-tray          | Implemented                                | Implemented; presentation depends on desktop environment   |
| Lyric overlays                  | Full positioning and interaction semantics | X11/XWayland supported; native Wayland reports limitations |
| Global shortcuts                | Implemented                                | X11 only; disabled on native Wayland                       |

## Install prerequisites

- Node.js 24.19.0 and npm
- Rust 1.88 or newer
- Windows: MSVC build tools
- Debian/Ubuntu: ALSA development files for native audio; `rpm` and `fakeroot` when producing RPM bundles

## Development

```powershell
npm ci
npm run dev:desktop
```

Browser development intentionally uses the deterministic fake provider because credentials, native audio, cache,
and QQ Music transport live behind the Electron desktop host:

```powershell
npm run dev
```

In a native build, QQ Music guest mode is the default. Add `?provider=fake` to the application URL when recording
deterministic UI evidence.

## Build locally

```powershell
# Build frontend assets, Electron Main, and preload scripts
npm run ci:frontend-build
npm run build -w @yaqmc/desktop

# Package the current platform without publishing
npm run package -w @yaqmc/desktop -- --publish never
```

Cross-architecture installer builds should use the corresponding Rust target or a native hosted runner; changing an
artifact filename does not change its architecture.

## Verification

```powershell
npm run format:check
npm run check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --all-targets --locked
```

Four ignored Rust tests deliberately contact a live provider or audible native output. Run them only on a suitable
host:

```powershell
cargo test --workspace -- --ignored --nocapture
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

Security-sensitive account commands are available only to the main renderer through the Electron Main IPC ACL and
are checked again by Core. OAuth windows have a Tencent-only navigation allowlist, reject popups, disable
autofill/devtools, validate an
unpredictable state value, and accept only the registered QQ Music callback. Lyric unlock controls use a separate,
single-command capability and cannot access account or player state.

## Repository map

- `src/domain` — provider-independent music models
- `src/providers` — provider contract, QQ Music adapter, and fake provider
- `src/application` — native-state projections and application coordination
- `src/components`, `src/pages`, `src/surfaces` — desktop UI and lyric windows
- `crates/yaqmc-core/src/player.rs` — authoritative queue/playback state machine
- `crates/yaqmc-core/src/audio.rs` — native decoding/output and device switching
- `crates/yaqmc-core/src/streaming.rs` — seekable HTTP Range source
- `crates/yaqmc-core/src/system_media.rs` — Core-owned MPRIS/SMTC adapters
- `apps/desktop/main` — Electron windows, tray, shortcuts, updater, dialogs, and Core process supervision
- `apps/desktop/preload` — context-isolated renderer bridge
- `scripts/collect-linux-diagnostics.sh` — privacy-bounded tester capture

Start with [architecture](docs/architecture.md), [playback](docs/playback.md),
[streaming](docs/streaming.md), [platform integration](docs/platform-integration.md),
[Linux runtime](docs/linux.md), [QQ Music provider](docs/qqmusic-provider.md),
[authentication](docs/authentication.md), [account library](docs/account-library.md),
[entitlement](docs/entitlement.md), [lyrics surfaces](docs/lyrics-surfaces.md),
[lyrics presets](docs/lyrics-presets.md),
[lyrics composer](docs/lyrics-composer.md),
[plugin platform](docs/plugin-platform.md),
[example plugins](docs/plugin-examples.md),
[local API](docs/local-api.md), [logging](docs/logging.md),
[diagnostics](docs/diagnostics.md), [Issue reporting](docs/issue-reporting.md),
[security & privacy](docs/security.md), and [CI](docs/ci.md), or the complete
[English documentation index](docs/README.md). Community guidance is
in [CONTRIBUTING-EN.md](CONTRIBUTING-EN.md), [SUPPORT-EN.md](SUPPORT-EN.md),
[SECURITY-EN.md](SECURITY-EN.md), and [CODE_OF_CONDUCT-EN.md](CODE_OF_CONDUCT-EN.md). Third-party copyright and
license texts are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The public engineering notes include [official-client interoperability evidence](docs/qqmusic-official-interoperability.md),
[audio-quality classification](docs/audio-quality.md), and [external URI security](docs/deep-link.md).

## Acknowledgements and project policy

Special thanks to Flechazo for public QMC/MFLAC, Master-quality, and seekable-decryption research ideas, and to
OpenAI Codex / GPT-5.6 Sol for engineering, testing, review, documentation, and release-workflow assistance. The
complete, carefully scoped credits—including the no-source-reuse boundary for unlicensed references—are in
[ACKNOWLEDGEMENTS-EN.md](ACKNOWLEDGEMENTS-EN.md) and the
[provider ledger](docs/qqmusic-provider.md). Reused copyright and license texts remain in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

> [!NOTE]
> YAQMC is licensed under [GPL-3.0-or-later](LICENSE). Binary releases include corresponding source as described in
> the [corresponding-source policy](CORRESPONDING_SOURCE_POLICY.md).
