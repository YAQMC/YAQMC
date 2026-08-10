# Linux runtime and acceptance

## Evidence boundary

The x86_64 AppImage is built on Ubuntu in GitHub Actions. Two Arch/Hyprland reports now exist. The latest baseline,
captured on 2026-08-10 after the session-aware launcher change, is authoritative for the current runtime boundary:

| Item                        | Observed value                                                                |
| --------------------------- | ----------------------------------------------------------------------------- |
| Distribution / kernel       | Arch Linux rolling / `7.1.6-zen1-1-zen`                                       |
| Desktop / session           | Hyprland / Wayland session                                                    |
| Actual YAQMC window backend | `wayland-native` from the raw window handle                                   |
| GPU / driver                | Intel Raptor Lake-S UHD (`i915`) + NVIDIA RTX 4060 Max-Q (`nvidia` 610.57.04) |
| Host graphics packages      | GTK 3.24.52, Mesa 26.1.6, WebKitGTK 2.52.5                                    |
| YAQMC-reported WebKitGTK    | 2.50.4                                                                        |
| Process lifetime            | 50.379 s; the archive does not record an exit status                          |

The report proves that YAQMC creates a native Wayland main window while baseline launch leaves `GDK_BACKEND` and
graphics compatibility overrides unset. MPRIS 2.2 and the tray adapter reported ready. The log contains only a
Fontconfig initialization warning and an ATK bridge signature warning; no crash or graphics-protocol error was
captured.

The revised sampler records the descendant process tree. Its final summed RSS was approximately 790 MiB and the
WebKit web process still reported roughly 50% lifetime CPU near the end of the 50-second run. `ps %CPU` remains a
lifetime average and summed RSS can double-count shared pages. Without action markers, PSS, frame timing, or a profile,
the workload cannot yet be attributed to a specific YAQMC surface.

This report did not record frame pacing, action-specific CPU, audible time-to-first-audio, `playerctl` commands,
playback/seek events, or overlay lock/unlock interaction. Those remain unaccepted. See
[Linux acceptance evidence](linux-acceptance.md) for the evidence ledger and next test sequence.

## Runtime detection and AppImage backend policy

`platform_diagnostics` records the active raw window handle, not only `XDG_SESSION_TYPE`:

| Session | Raw window handle | Reported backend |
| ------- | ----------------- | ---------------- |
| Wayland | Wayland           | `wayland-native` |
| Wayland | Xlib/Xcb          | `xwayland`       |
| X11     | Xlib/Xcb          | `x11`            |

The application source does not set `WINIT_UNIX_BACKEND`, `DISPLAY` or `WAYLAND_DISPLAY`. Tauri CLI 2.11.4 generated
an AppImage hook with an unconditional `GDK_BACKEND=x11`, which explains the observed XWayland baseline and also
prevented an external override. The YAQMC build replaces that assignment with a session-aware policy: an explicit
`GDK_BACKEND` wins; otherwise a Wayland session with `WAYLAND_DISPLAY` uses `wayland`, and every other environment
uses `x11`. This follows the host by default without pretending that XWayland is native-Wayland acceptance. Explicit
`native-wayland` and `x11` tester modes remain available for controlled comparison.

References: [Tauri AppImage GTK launcher](https://github.com/tauri-apps/tauri/blob/e2e585ad1196c9572f86ef39aae01ef4c3b1a762/crates/tauri-bundler/src/bundle/linux/appimage/linuxdeploy-plugin-gtk.sh),
[change note](https://github.com/tauri-apps/tauri/blob/e2e585ad1196c9572f86ef39aae01ef4c3b1a762/.changes/appimage-respect-gdk-backend.md), and
[Linux graphics guidance](https://v2.tauri.app/develop/debug/linux-graphics/).

The Settings diagnostics include safe display variables, desktop hint, runtime WebKitGTK version, graphics override,
DRM vendor/device/driver IDs, selected audio output, MPRIS, tray and shortcut status. They can export the same tester
script embedded in the AppImage.

## Arch tester procedure

Baseline (automatic session detection):

```bash
chmod +x YAQMC_0.1.0_amd64.AppImage collect-linux-diagnostics.sh
./collect-linux-diagnostics.sh ./YAQMC_0.1.0_amd64.AppImage baseline
```

Controlled native-Wayland comparison:

```bash
./collect-linux-diagnostics.sh ./YAQMC_0.1.0_amd64.AppImage native-wayland
```

Controlled X11/XWayland fallback:

```bash
./collect-linux-diagnostics.sh ./YAQMC_0.1.0_amd64.AppImage x11
```

The native comparison counts only if `yaqmc.log` reports `display_backend="wayland-native"`. If the AppImage runtime
reports missing FUSE, install `fuse2` on Arch or use the AppImage runtime's `--appimage-extract-and-run` fallback.

Repeat a graphics workaround only when the baseline/native run shows a relevant failure:

```bash
./collect-linux-diagnostics.sh ./YAQMC_0.1.0_amd64.AppImage nv-explicit-sync
./collect-linux-diagnostics.sh ./YAQMC_0.1.0_amd64.AppImage disable-dmabuf
./collect-linux-diagnostics.sh ./YAQMC_0.1.0_amd64.AppImage software
./collect-linux-diagnostics.sh ./YAQMC_0.1.0_amd64.AppImage disable-compositing
```

For each run, exercise startup, scrolling, resize, playback/seek, Desktop Lyrics, Lyrics Island, lock, tray unlock and
close-to-tray. Close YAQMC normally and attach the generated report directory plus concise subjective observations.

## Capability matrix

| Capability                     | Windows                             | Linux X11                       | Linux XWayland                       | Native Wayland                     |
| ------------------------------ | ----------------------------------- | ------------------------------- | ------------------------------------ | ---------------------------------- |
| Main window                    | implemented; GUI acceptance pending | implemented; runtime pending    | starts on earlier Arch/Hyprland run  | starts on latest Arch/Hyprland run |
| Absolute lyric placement       | implemented                         | expected; test pending          | expected; test pending               | not promised                       |
| Reliable always-on-top overlay | implemented                         | expected; test pending          | compositor-dependent                 | not promised                       |
| Click-through lyric lock       | implemented                         | expected; test pending          | compositor-dependent; test pending   | exposed as unreliable              |
| Unlock recovery                | Settings + tray direct native path  | same; test pending              | same; test pending                   | same; test pending                 |
| Global shortcuts               | implemented                         | X11 backend; test pending       | X11 backend; test pending            | disabled; MPRIS media keys only    |
| System media controls          | SMTC; real test pending             | MPRIS 2.2; real control pending | service starts; real control pending | MPRIS 2.2; real control pending    |
| Tray context menu              | implemented; GUI test pending       | implemented; test pending       | initializes; interaction pending     | implemented; test pending          |

Auxiliary lyric WebViews exist only while their feature is enabled and are closed when disabled, avoiding steady-state
WebKitGTK cost for unused lyric surfaces.
