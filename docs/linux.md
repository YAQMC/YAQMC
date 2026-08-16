# Linux runtime and acceptance

> [简体中文](zh-CN/linux.md) | **English**

## Current evidence boundary

The x86_64 AppImage is built and finally repacked on Ubuntu by GitHub Actions. The latest Arch/Hyprland baseline,
captured on 2026-08-10 after the session-aware launcher fix, used a native Wayland main window:

| Item                        | Observed value                                                                |
| --------------------------- | ----------------------------------------------------------------------------- |
| Distribution / kernel       | Arch Linux rolling / `7.1.6-zen1-1-zen`                                       |
| Desktop / session           | Hyprland / Wayland                                                            |
| Actual YAQMC window backend | `wayland-native`, read from the raw window handle                             |
| GPU / driver                | Intel Raptor Lake-S UHD (`i915`) + NVIDIA RTX 4060 Max-Q (`nvidia` 610.57.04) |
| Host graphics packages      | GTK 3.24.52, Mesa 26.1.6, WebKitGTK 2.52.5                                    |
| YAQMC-reported WebKitGTK    | 2.50.4                                                                        |

An older pre-fix report used XWayland because its generated launcher forced `GDK_BACKEND=x11`. That result remains
historical evidence only; it is not the current baseline.

The current report confirms startup, MPRIS/tray initialization, and the audio backend. It does not establish exact
binary identity, real playback, action-specific performance, Focus/fullscreen restoration, or lyric-surface
lock/unlock. See [Linux acceptance evidence](linux-acceptance.md) for the ledger.

## Backend and graphics policy

`platform_diagnostics` reports the active raw window handle rather than inferring it from `XDG_SESSION_TYPE`:

| Session | Raw window handle | Reported backend |
| ------- | ----------------- | ---------------- |
| Wayland | Wayland           | `wayland-native` |
| Wayland | Xlib/Xcb          | `xwayland`       |
| X11     | Xlib/Xcb          | `x11`            |

YAQMC source does not force `WINIT_UNIX_BACKEND`, `DISPLAY`, or `WAYLAND_DISPLAY`. The final AppImage repack changes
Tauri's generated unconditional X11 hook into session-aware selection: an explicit `GDK_BACKEND` wins; otherwise a
Wayland session with `WAYLAND_DISPLAY` selects Wayland, and other sessions select X11.

Canonical collector modes are:

| Mode             | Launch policy                                                    | Acceptance role                  |
| ---------------- | ---------------------------------------------------------------- | -------------------------------- |
| `auto`           | clears explicit GTK/renderer overrides and follows the session   | required first run               |
| `native-wayland` | sets `GDK_BACKEND=wayland` and clears `DISPLAY`                  | required native comparison       |
| `x11`            | sets `GDK_BACKEND=x11`                                           | required X11/XWayland comparison |
| `software`       | disables DMABUF and forces software GL without changing geometry | conditional failure comparison   |

`baseline` is accepted only as an `auto` compatibility alias; it is not an XWayland label. `software` requires the
explicit `YAQMC_ALLOW_SOFTWARE=confirmed-native-failure` gate and cannot replace a failed/missing native run.

Linux CSS keeps the translated lyric surface while reducing expensive effects. Software mode may disable costly
rendering paths, but it must not remove positioning transforms or change the tested interaction surface.

References: [Tauri AppImage GTK launcher](https://github.com/tauri-apps/tauri/blob/e2e585ad1196c9572f86ef39aae01ef4c3b1a762/crates/tauri-bundler/src/bundle/linux/appimage/linuxdeploy-plugin-gtk.sh),
[Tauri change note](https://github.com/tauri-apps/tauri/blob/e2e585ad1196c9572f86ef39aae01ef4c3b1a762/.changes/appimage-respect-gdk-backend.md), and
[official Linux graphics guidance](https://v2.tauri.app/develop/debug/linux-graphics/).

## Arch tester procedure

Use only the extracted `YAQMC-linux-x86_64` GitHub Actions artifact. No repository checkout is needed. Verify its
flat bundle before launch:

```bash
sha256sum -c SHA256SUMS
node verify-lyrics-acceptance.mjs \
  --platform linux \
  --identity-only \
  --build-identity "$PWD/BUILD-IDENTITY.json"
appimage="$(node -p "require('./BUILD-IDENTITY.json').appImage.fileName")"
chmod +x "$appimage" collect-linux-diagnostics.sh
export YAQMC_ACCEPTANCE_ROOT="$PWD/YAQMC-linux-acceptance"
```

Run all required modes:

```bash
./collect-linux-diagnostics.sh "$PWD/$appimage" auto
./collect-linux-diagnostics.sh "$PWD/$appimage" native-wayland
./collect-linux-diagnostics.sh "$PWD/$appimage" x11
```

Only after a matching native graphics failure:

```bash
YAQMC_ALLOW_SOFTWARE=confirmed-native-failure \
  ./collect-linux-diagnostics.sh "$PWD/$appimage" software
```

The collector prompts for `startup-idle`, playback, seek/pause/resume, main scroll/resize, Lyrics normal, Lyrics
Focus, native fullscreen, Desktop Lyrics, Lyrics Island, both surfaces, and shutdown. Exit fullscreen with `Esc` and
verify exact presentation/geometry restoration. Lock each auxiliary surface and prove unlock recovery through
tray/Settings before closing it.

Verify and archive only after the three required mode directories are present:

```bash
node verify-lyrics-acceptance.mjs \
  --platform linux \
  --root "$YAQMC_ACCEPTANCE_ROOT" \
  --build-identity "$PWD/BUILD-IDENTITY.json"
tar -C "$(dirname "$YAQMC_ACCEPTANCE_ROOT")" \
  -czf YAQMC-linux-acceptance.tar.gz \
  "$(basename "$YAQMC_ACCEPTANCE_ROOT")"
sha256sum YAQMC-linux-acceptance.tar.gz
```

If FUSE is unavailable on Arch, install `fuse2` or use the AppImage runtime's `--appimage-extract-and-run` support;
record that deviation. Windows software/safe runs do not satisfy Linux acceptance.

## Capability matrix

| Capability                     | Windows                             | Linux X11                       | Linux XWayland                     | Native Wayland                  |
| ------------------------------ | ----------------------------------- | ------------------------------- | ---------------------------------- | ------------------------------- |
| Main window                    | implemented; GUI acceptance pending | implemented; acceptance pending | historical startup observed        | current startup observed        |
| Absolute lyric placement       | implemented                         | expected; test pending          | compositor-dependent; test pending | not promised                    |
| Reliable always-on-top overlay | implemented                         | expected; test pending          | compositor-dependent               | not promised                    |
| Click-through lyric lock       | implemented                         | expected; test pending          | compositor-dependent; test pending | exposed as unreliable           |
| Unlock recovery                | Settings + tray native path         | test pending                    | test pending                       | test pending                    |
| Global shortcuts               | implemented                         | X11 backend; test pending       | X11 backend; test pending          | disabled; MPRIS media keys only |
| System media controls          | SMTC; real test pending             | MPRIS; real control pending     | MPRIS; real control pending        | MPRIS 2.2; real control pending |
| Tray context menu              | implemented; GUI test pending       | implemented; test pending       | initialized; interaction pending   | implemented; test pending       |

Auxiliary lyric WebViews exist only while enabled and close when disabled, avoiding their steady-state WebKitGTK
cost when unused.

## Plugin Platform v2 and Advanced Scene

Linux stays on WebKitGTK 4.1. This branch does **not** change the renderer strategy. Plugin workers, Scene CSS, and
video backgrounds follow the same host as Windows, with these WebKitGTK-specific guards:

- Inactive lyric `filter: blur()` from apple-like styling is disabled on Linux. Live CSS blur can rasterize as a
  black slab.
- Plugin scene `blur` widget overrides are ignored on Linux.
- Scene and extra-widget video do not decode in Linux `software` / `safe` graphics modes, and they still honor
  reduced motion.
- Script plugins run in a blob Worker. The CSP allowlist includes `worker-src 'self' blob:` so WebKitGTK can start
  that worker. If Worker construction fails, the plugin is marked Failed and built-in Lyrics remain.
- Scene CSS stays `@scope`d. Unsupported `@scope` fails closed (the sheet does not apply) rather than restyling
  Settings or the sidebar.

Plugin Manager, declarative settings, and host-proxied HTTPS are compiled for Linux. They are **not** Linux GUI
accepted until a tester records them on a real desktop. Color Field uses radial gradients, not live backdrop-filter.
