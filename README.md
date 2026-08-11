# YAQMC

**Yet Another Q Music Client** is an unofficial Windows and Linux desktop music client built with Tauri 2,
React/TypeScript and Rust. Its playback state is owned by one native `PlayerService`; the UI, local API, MPRIS,
SMTC, tray and shortcuts are adapters over that service rather than separate players.

YAQMC currently provides QQ Music guest-catalog search, albums, playlists/toplists, legitimate public streams or
official previews, HTTP Range playback, a bounded media cache, queue persistence, QRC/LRC word-synchronized
lyrics, Desktop Lyrics, Lyrics Island, English/Simplified Chinese UI, appearance personalization, output-device
selection and an optional authenticated loopback API. A deterministic fake provider remains available for browser
development and tests.

YAQMC is not affiliated with Tencent or QQ Music. It does not bypass DRM, subscriptions or entitlement checks.

## Acknowledgements and research references

QQ Music interoperability research consulted `L-1124/QQMusicApi`, `wxuyu/QQMusicApi`,
`RethinkQAQ/allmusic-qqmusicapi`, `tlyanyu/multiPlatformMusicApi`, and `wangwalk/qqm` at the commits and
license-detection results recorded in [the QQ Music provider record](docs/qqmusic-provider.md). They were used as
protocol-behavior references; YAQMC does not copy or vendor their implementations, and the projects do not endorse
YAQMC. Account capability remains pending until the deterministic and explicit live acceptance gates pass.

## Platform status

| Area                          | Windows                       | Linux                                                            |
| ----------------------------- | ----------------------------- | ---------------------------------------------------------------- |
| Main desktop client           | implemented and locally built | AppImage starts natively on Arch/Hyprland Wayland                |
| Native audio                  | Rodio/CPAL                    | Rodio/CPAL through the host ALSA route                           |
| System media session          | SMTC                          | MPRIS 2.2                                                        |
| Tray and close-to-tray        | implemented                   | implemented; desktop-dependent presentation                      |
| Lyric overlays                | full window semantics         | runtime interaction pending; native Wayland limitations reported |
| Configurable global shortcuts | implemented                   | X11 backend only; disabled on native Wayland                     |

The Linux development work was performed from Windows. The latest Arch/Hyprland baseline proves native-Wayland
window creation and MPRIS/tray initialization. It does not prove audible playback, media-controller behavior,
overlay interaction, or action-specific performance. The evidence boundary and capability matrix are in
[docs/linux.md](docs/linux.md).

## Run locally

Prerequisites:

- Node.js 24 and npm;
- Rust 1.88 or newer;
- the [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/);
- Windows: MSVC build tools and WebView2 Runtime;
- Debian/Ubuntu: `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libasound2-dev`.

```powershell
npm ci
npm run tauri dev
```

The browser-only surface uses the fake provider because native audio, credentials, cache and QQ Music transport live
behind Tauri:

```powershell
npm run dev
```

In a native build, QQ Music guest mode is the default. Add `?provider=fake` to the application URL for deterministic
fixture testing.

## Build

```powershell
# Current platform, executable only
npm run tauri -- build --no-bundle

# Linux host
npm run tauri -- build --bundles appimage

# Windows host
npm run tauri -- build --bundles nsis
```

`.github/workflows/build.yml` performs reproducible x86_64 AppImage and Windows NSIS builds. GitHub Actions artifacts
are packaging evidence; real Linux runtime results must still be recorded separately.

## Quality checks

```powershell
npm run format:check
npm run check
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-targets
```

Four ignored Rust acceptance tests deliberately touch a live provider or audible native output. Select them only on
an appropriate host:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture
```

## Architecture highlights

- Streaming starts with a 512 KiB range, prioritizes decoder-requested segments and reads ahead three segments.
  Exact 206 validation, bounded 200/416 fallback, cancellation and one-time signed-URL recovery are covered by local
  HTTP tests. A complete sparse source is atomically promoted into the normal provider-aware cache.
- Locking a lyric overlay intentionally makes it click-through. Unlocking does not depend on clicking that window:
  Settings and the tray menu both invoke a direct native unlock path.
- Linux startup diagnostics distinguish native Wayland from XWayland using the actual window handle. The AppImage
  follows the active Wayland/X11 session unless explicitly overridden; acceleration and backend compatibility modes
  remain controlled diagnostics rather than global guesses.
- Secrets use the operating-system credential store. The loopback API is disabled by default, binds only to
  `127.0.0.1`, and requires a random bearer token for every `/v1` endpoint.
- Account login and library mutation are intentionally out of scope until an approved authorization route exists.

## Repository map

- `src/domain` — provider-independent music models;
- `src/providers` — provider contract, QQ Music adapter and fake provider;
- `src/application` — native-state projections and application coordination;
- `src/components`, `src/pages`, `src/surfaces` — desktop UI and lyric windows;
- `src-tauri/src/player.rs` — authoritative queue/playback state machine;
- `src-tauri/src/audio.rs` — native decoding/output and device switching;
- `src-tauri/src/streaming.rs` — seekable HTTP Range source;
- `src-tauri/src/system_media.rs` — MPRIS/SMTC adapters;
- `src-tauri/src/desktop_integration.rs` — tray, close behavior and shortcuts;
- `src-tauri/src/platform.rs` — backend/capability diagnostics and export;
- `scripts/collect-linux-diagnostics.sh` — privacy-bounded tester capture.

Start with [architecture](docs/architecture.md), [streaming](docs/streaming.md),
[platform integration](docs/platform-integration.md), [Linux runtime](docs/linux.md),
[Linux graphics](docs/linux-graphics.md), [playback](docs/playback.md),
[QQ Music provider](docs/qqmusic-provider.md), [lyrics surfaces](docs/lyrics-surfaces.md), and
[local API](docs/local-api.md). The original long-form product brief remains in `GPT-Read-me.md`.
