# Linux graphics policy

> [简体中文](zh-CN/linux-graphics.md) | **English**

The Linux desktop host is Electron/Chromium. React scheduling, Chromium/Ozone,
the compositor, window-backend selection, and audio buffering are separate
failure domains and are reported separately.

## Startup policy

`apps/desktop/main/linux-graphics.ts` is the only source of YAQMC Chromium
graphics switches. Main applies its allowlisted result before Electron becomes
ready:

| Mode                | Chromium switch                             | Policy                                                                                                |
| ------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `auto` / unknown    | none                                        | Default; use Chromium's platform choice and probe the live backend.                                   |
| `native-wayland`    | `--ozone-platform=wayland`                  | Explicit native-Wayland opt-in.                                                                       |
| `x11`               | none                                        | Acceptance alias for the default X11/XWayland path; the collector rejects any other observed backend. |
| `gpu-off`           | `--disable-gpu`                             | Explicit troubleshooting mode.                                                                        |
| `software` / `safe` | `--disable-gpu`                             | Deprecated compatibility aliases for `gpu-off`.                                                       |
| `vaapi-on`          | `--enable-features=VaapiVideoDecodeLinuxGL` | Explicit VA-API experiment; off by default.                                                           |

`YAQMC_LINUX_RENDERER` remains a deprecated host-compatibility input for
packaged acceptance tools. Core neither sets nor interprets renderer variables.
Legacy GTK/WebKit graphics variables do not define the Electron policy.

The live display backend is derived from the applied Ozone switch and client
sockets observed under `/proc/self/fd`; `XDG_SESSION_TYPE` alone is not treated
as proof. Diagnostics report `wayland-native`, `xwayland`, `x11`, or
`unavailable`.

## Acceptance modes

The packaged Linux collector retains four stable evidence directory names:

| Collector mode   | Required host input                                                | Acceptance role                                        |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------------------------ |
| `auto`           | no YAQMC graphics override                                         | first run                                              |
| `native-wayland` | `YAQMC_LINUX_RENDERER=native-wayland`                              | must report `wayland-native`                           |
| `x11`            | `YAQMC_LINUX_RENDERER=x11` plus the collector's compatibility hint | must report `x11` or `xwayland`                        |
| `software`       | `YAQMC_LINUX_RENDERER=software`                                    | conditional comparison after a native graphics failure |

`baseline` is only an alias for `auto`. The conditional software run still
requires `YAQMC_ALLOW_SOFTWARE=confirmed-native-failure`; it cannot replace a
missing native run.

Linux CSS retains layout, transforms, palette, and lyric interaction while
reducing expensive live blur and large-shadow effects. The `software`/`safe`
aliases also suppress scene-video decoding. These source-level controls reduce
risk but do not prove compositor performance.

## Measurement boundary

The collector records phase-labelled process trees, CPU, RSS/PSS where
available, threads, window state, observed backend, and graphics mode for
startup, playback, seek/pause/resume, resize, lyrics, auxiliary surfaces, and
shutdown. These samples are diagnostics, not frame-time benchmarks. Testers
must separately record visible stutter, blank frames, geometry/fullscreen
restoration, lock/unlock behavior, and audio discontinuity.
