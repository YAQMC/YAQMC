# Linux runtime and acceptance

> [简体中文](zh-CN/linux.md) | **English**

## Current evidence boundary

The current Linux host is Electron/Chromium and is packaged as AppImage,
`.deb`, `.rpm`, and portable `.tar.gz`. The retained 2026-08-10
Arch/Hyprland capture came from the retired desktop host. It is useful only as
historical machine/compositor context and does not validate the current
Electron binary, UI, tray, playback, or graphics behavior.

Current Electron Linux GUI acceptance remains open until a tester returns a
verified workflow artifact report. See [Linux acceptance evidence](linux-acceptance.md).

## Backend and graphics policy

Electron Main applies the allowlisted Chromium/Ozone policy from
`apps/desktop/main/linux-graphics.ts` before startup. Runtime diagnostics probe
the applied Ozone switch and live client sockets rather than inferring the
window backend from the session variable alone:

| Observed client/backend         | Reported value   |
| ------------------------------- | ---------------- |
| Native Wayland                  | `wayland-native` |
| X11 client in a Wayland session | `xwayland`       |
| X11 session                     | `x11`            |
| No reliable observation         | `unavailable`    |

The packaged collector uses `auto`, `native-wayland`, `x11`, and conditional
`software` modes. `native-wayland` supplies
`YAQMC_LINUX_RENDERER=native-wayland`, which maps to
`--ozone-platform=wayland`; `software` maps to `--disable-gpu`. See
[Linux graphics policy](linux-graphics.md) for the exact table.

## Arch tester procedure

Use only the extracted `YAQMC-linux-x64-tester-<commit>` GitHub Actions artifact. A
repository checkout is neither needed nor accepted as binary identity
evidence. From the extracted bundle directory:

```bash
sha256sum -c SHA256SUMS
node verify-lyrics-acceptance.mjs \
  --platform linux \
  --identity-only \
  --build-identity "$PWD/BUILD-IDENTITY.json"
appimage="$(node -p "require('./BUILD-IDENTITY.json').appImage.fileName")"
chmod +x "$appimage" collect-linux-diagnostics.sh
export YAQMC_ACCEPTANCE_ROOT="$PWD/YAQMC-linux-acceptance"

./collect-linux-diagnostics.sh "$PWD/$appimage" auto
./collect-linux-diagnostics.sh "$PWD/$appimage" native-wayland
./collect-linux-diagnostics.sh "$PWD/$appimage" x11
```

Only after a matching native graphics failure:

```bash
YAQMC_ALLOW_SOFTWARE=confirmed-native-failure \
  ./collect-linux-diagnostics.sh "$PWD/$appimage" software
```

The collector prompts for startup idle, playback, seek/pause/resume, main
scroll/resize, Lyrics normal/Focus/fullscreen, Desktop Lyrics, Lyrics Island,
both surfaces, and shutdown. Exit fullscreen with `Esc`, verify exact
presentation/geometry restoration, and prove both direct and Settings/tray
unlock recovery.

After the three required mode directories exist:

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

If FUSE is unavailable, install the distribution's FUSE compatibility package
or record use of the AppImage runtime's `--appimage-extract-and-run` path.
Windows evidence cannot satisfy this Linux gate.

## Capability matrix

| Capability                                  | Windows                             | Linux X11/XWayland                 | Native Wayland                  |
| ------------------------------------------- | ----------------------------------- | ---------------------------------- | ------------------------------- |
| Main window                                 | implemented; GUI acceptance pending | implemented; acceptance pending    | implemented; acceptance pending |
| Absolute lyric placement / reliable topmost | implemented                         | compositor-dependent; test pending | not promised                    |
| Click-through lyric lock                    | implemented                         | compositor-dependent; test pending | exposed as unreliable           |
| Unlock recovery                             | Settings + tray path                | test pending                       | test pending                    |
| Global shortcuts                            | implemented                         | X11 backend; test pending          | disabled; use MPRIS media keys  |
| System media controls                       | SMTC; real test pending             | MPRIS; real control pending        | MPRIS; real control pending     |
| Tray context menu                           | implemented; GUI test pending       | implemented; test pending          | implemented; test pending       |

Auxiliary lyric `BrowserWindow` renderers exist only while enabled and close
when disabled.

## Plugin Platform v2 and Advanced Scene

Linux uses the same Chromium renderer, sandboxed plugin workers, scoped Scene
CSS, and host-proxied HTTPS boundary as Windows. Linux CSS disables selected
high-cost live blur effects, and `gpu-off` compatibility modes suppress scene
video decoding while preserving layout and interaction. Plugin Manager, Color
Field, scenes, and worker isolation are not Linux-GUI accepted until recorded
on a verified final AppImage.
