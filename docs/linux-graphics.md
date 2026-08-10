# Linux graphics policy

Tauri uses WebKitGTK on Linux. React scheduling, WebKitGTK/compositor behavior and audio buffering are separate
failure domains and are logged separately.

## Default policy

`YAQMC_LINUX_RENDERER=auto` is implicit and sets no acceleration variables in YAQMC. The application source does not
force a GTK backend. The packaged AppImage is a separate layer: Tauri CLI 2.11.4 emitted an unconditional
`GDK_BACKEND=x11`, which produced XWayland on the recorded Hyprland session. The YAQMC packaging step replaces it
with session-aware selection: explicit `GDK_BACKEND` first, then native Wayland when both the session type and
Wayland display indicate Wayland, otherwise X11. This makes `baseline` follow the host while keeping explicit
`native-wayland` and `x11` comparisons.

The main Linux window is opaque because a full-window transparent WebKit surface is not required by the product
shell. Linux CSS preserves the hierarchy and palette while removing the largest live backdrop blurs, replacing the
artwork blur with tint/saturation, reducing lyric-stage shadow cost and containing lyric-line paint. Windows retains
the richer effects. These are source-level risk reductions, not measured proof of a fixed compositor regression.

## Explicit compatibility modes

These are opt-in diagnostics rather than automatic GPU guesses:

| Mode                  | Applied variables                           | Intended use                  |
| --------------------- | ------------------------------------------- | ----------------------------- |
| `baseline`            | no explicit override                        | follow active desktop session |
| `native-wayland`      | `GDK_BACKEND=wayland`                       | controlled backend comparison |
| `x11`                 | `GDK_BACKEND=x11`                           | controlled X11/XWayland path  |
| `nv-explicit-sync`    | `__NV_DISABLE_EXPLICIT_SYNC=1`              | NVIDIA-specific comparison    |
| `disable-dmabuf`      | `WEBKIT_DISABLE_DMABUF_RENDERER=1`          | confirmed DMABUF failure      |
| `software`            | DMABUF disabled + `LIBGL_ALWAYS_SOFTWARE=1` | last-resort safe mode         |
| `disable-compositing` | `WEBKIT_DISABLE_COMPOSITING_MODE=1`         | one-run diagnosis only        |

Only `auto`, `disable-dmabuf`/`compatibility` and `software`/`safe` are recognized by the application graphics policy.
The other variables are deliberately confined to the tester script.

## Recorded baseline and remaining measurements

The 2026-08-10 Arch baseline ran on XWayland with Intel i915 plus NVIDIA 610.57.04. It logged no DMABUF framebuffer,
Wayland protocol, blank-window or crash signal, so no acceleration workaround is justified by that run. The report
contains no FPS, frame-time, resize-latency or per-WebView workload markers, and its old resource sampler captured
only the main process. Consequently the root cause of the reported Linux lag and before/after performance remain
unresolved.

The revised report format aggregates the process tree and preserves per-process rows. A useful comparison still
requires the same scripted interaction sequence for main-only, Desktop Lyrics, Lyrics Island and both surfaces,
plus a verified native-Wayland run.
