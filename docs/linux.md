# Linux runtime and acceptance

## Current evidence boundary

The Linux x86_64 AppImage is built in an Ubuntu GitHub Actions runner. That proves compilation and packaging only.
The current development host is Windows, so native Linux GUI, compositor, MPRIS controller and audio acceptance are
explicitly **pending an Arch Linux tester**. Do not interpret this document or a successful AppImage build as a
native-Wayland performance result.

## Runtime detection

`platform_diagnostics` records the active window handle, not only `XDG_SESSION_TYPE`:

| Session | Raw window handle | Reported backend |
| ------- | ----------------- | ---------------- |
| Wayland | Wayland           | `wayland-native` |
| Wayland | Xlib/Xcb          | `xwayland`       |
| X11     | Xlib/Xcb          | `x11`            |

The same diagnostic includes the safe display variables, desktop hint, WebKitGTK runtime version, graphics override,
DRM card vendor/device/driver IDs, selected audio output, MPRIS status, tray status and shortcut status. The Settings
page can export a directory containing this JSON and `collect-linux-diagnostics.sh`.

No source, build script or AppImage launcher sets `GDK_BACKEND`, `WINIT_UNIX_BACKEND`, `DISPLAY` or
`WAYLAND_DISPLAY`. GTK/WebKitGTK therefore selects its normal backend. Configurable global shortcuts are disabled on
an actual native-Wayland window backend; media keys remain routed through MPRIS.

## Arch tester procedure

```bash
chmod +x YAQMC_0.1.0_amd64.AppImage
./YAQMC_0.1.0_amd64.AppImage
```

If the AppImage runtime reports missing FUSE, Arch users can install `fuse2`, or use the AppImage runtime's
`--appimage-extract-and-run` fallback.

For a controlled report:

```bash
chmod +x collect-linux-diagnostics.sh
./collect-linux-diagnostics.sh ./YAQMC_0.1.0_amd64.AppImage baseline
```

Repeat only when the baseline shows a relevant NVIDIA/WebKitGTK failure:

```bash
./collect-linux-diagnostics.sh ./YAQMC_0.1.0_amd64.AppImage nv-explicit-sync
./collect-linux-diagnostics.sh ./YAQMC_0.1.0_amd64.AppImage disable-dmabuf
./collect-linux-diagnostics.sh ./YAQMC_0.1.0_amd64.AppImage software
./collect-linux-diagnostics.sh ./YAQMC_0.1.0_amd64.AppImage disable-compositing
```

For each run, exercise startup, main-page scrolling, resize, playback/seek, Desktop Lyrics, Lyrics Island, lock and
tray unlock, and close-to-tray. Close YAQMC normally. The script records safe environment/package/GPU/audio facts,
YAQMC structured logs, process CPU, RSS and elapsed samples.

## Capability matrix

| Capability                     | Windows                     | Linux X11                    | Linux XWayland               | Native Wayland                  |
| ------------------------------ | --------------------------- | ---------------------------- | ---------------------------- | ------------------------------- |
| Main window                    | implemented, Windows-tested | implemented; runtime pending | implemented; runtime pending | implemented; runtime pending    |
| Absolute lyric placement       | implemented                 | expected/requires test       | expected/requires test       | not promised                    |
| Reliable always-on-top overlay | implemented                 | expected/requires test       | compositor-dependent         | not promised                    |
| Click-through lyric lock       | implemented                 | expected/requires test       | compositor-dependent         | exposed as unreliable           |
| Unlock recovery                | Settings + tray             | Settings + tray              | Settings + tray              | Settings + tray                 |
| Global shortcuts               | implemented                 | X11 backend                  | X11 backend                  | disabled; MPRIS media keys only |
| System media controls          | SMTC                        | MPRIS 2.2                    | MPRIS 2.2                    | MPRIS 2.2                       |
| Tray context menu              | implemented                 | implemented; runtime pending | implemented; runtime pending | implemented; runtime pending    |

Auxiliary lyric WebViews are created only while their feature is enabled and are closed when disabled. This avoids
paying the steady-state WebKitGTK cost for unused lyric surfaces.
