# Linux graphics policy

> [简体中文](zh-CN/linux-graphics.md) | **English**

Tauri uses WebKitGTK on Linux. React scheduling, WebKitGTK/compositor behavior, window-backend selection, and audio
buffering are separate failure domains and are logged separately.

## Default policy

`YAQMC_LINUX_RENDERER=auto` is implicit and sets no acceleration variables. YAQMC source does not force a GTK
backend. Auto mode applies two targeted compatibility rules:

1. When an NVIDIA driver is detected and the tester has not set `__NV_DISABLE_EXPLICIT_SYNC` themselves, YAQMC
   disables driver-level explicit sync so WebKitGTK falls back to implicit-sync DMA-BUF and keeps hardware
   acceleration, avoiding the WebKit bug 317089 protocol-error disconnect on Hyprland/KWin.
2. When Hyprland is detected without NVIDIA and the tester has not set `WEBKIT_DISABLE_DMABUF_RENDERER`, YAQMC
   disables WebKitGTK's DMA-BUF renderer to avoid the same protocol error.

The final AppImage repack replaces
Tauri's generated unconditional `GDK_BACKEND=x11` assignment with this session-aware policy:

1. Preserve an explicit `GDK_BACKEND` chosen by the tester.
2. Otherwise select Wayland when `XDG_SESSION_TYPE=wayland` and `WAYLAND_DISPLAY` is present.
3. Otherwise select X11.

The 2026-08-10 current Arch/Hyprland baseline followed that policy and reported `wayland-native`. An earlier
pre-fix build reported XWayland; it is historical comparison evidence, not the current baseline.

The Linux main window remains opaque. Platform CSS preserves layout, transforms, palette, and lyric interaction
while reducing high-cost live backdrop blur, artwork blur, large shadows, and uncontained lyric-line paint. These
source-level reductions are risk controls, not proof of a compositor performance fix. Plugin API v2 keeps that
policy: inactive-line `filter: blur()` and scene widget blur are disabled on Linux; scene video is not decoded in
`software` / `safe` modes. The WebKitGTK renderer strategy itself is unchanged.

## Acceptance modes

| Mode              | Environment change                                                  | Rule                                                |
| ----------------- | ------------------------------------------------------------------- | --------------------------------------------------- |
| `auto`            | NVIDIA: driver explicit sync off, DMABUF kept; Hyprland: DMABUF off | required first                                      |
| `dmabuf`          | removes the DMABUF disable, forcing the native path                 | comparison mode; known-crash combos may still crash |
| `native-wayland`  | `GDK_BACKEND=wayland`; `DISPLAY` cleared                            | required; must report `wayland-native`              |
| `x11`             | `GDK_BACKEND=x11`                                                   | required controlled fallback comparison             |
| `compositing-off` | disables WebKitGTK accelerated compositing                          | optional rendering comparison                       |
| `software`        | `YAQMC_LINUX_RENDERER=software`, DMABUF off, software GL enabled    | conditional after a reproduced native bug           |

`baseline` is only a compatibility alias for `auto`, never a claim that the window is XWayland. Legacy one-off
variables such as NVIDIA explicit-sync or compositing toggles are not canonical acceptance modes and cannot replace
`auto`, `native-wayland`, or `x11` evidence.

Software mode is deliberately gated by `YAQMC_ALLOW_SOFTWARE=confirmed-native-failure`. It disables costly graphics
paths but must preserve the translated UI surface and positioning transforms. A Windows software/safe run cannot
satisfy this Linux gate.

## Measurement boundary

The old baseline's lifetime CPU and summed RSS cannot identify a rendering root cause: lifetime `%CPU` is not an
instantaneous sample, RSS can double-count shared pages, and the report lacked phase labels and PSS. The new
collector records per-phase process-tree rows, RSS/PSS where the kernel exposes it, CPU, threads, window state,
reported backend, and graphics environment for:

`startup-idle`, `playback`, `seek-pause-resume`, `main-scroll-resize`, `lyrics-normal`, `lyrics-focus`,
`lyrics-fullscreen`, `desktop-lyrics`, `island-lyrics`, `both-surfaces`, and `shutdown`.

Even those samples are diagnostics, not a frame-time benchmark. The tester must also report visible stutter, blank
frames, incorrect geometry, fullscreen restore failures, lock/unlock behavior, and audio discontinuity. Preserve a
failed native report before adding the conditional software comparison.
