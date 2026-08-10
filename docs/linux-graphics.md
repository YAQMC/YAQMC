# Linux graphics policy

Tauri uses WebKitGTK on Linux. React scheduling and WebKitGTK/compositor behavior are treated as separate failure
domains; audio buffering is also reported separately from rendering lag.

## Default policy

`YAQMC_LINUX_RENDERER=auto` is implicit and sets no graphics environment variables. The application does not force
X11, native Wayland, software GL, disabled compositing or the legacy WebKit renderer globally.

The main Linux window is opaque (`tauri.linux.conf.json`) because a full-window transparent WebKit surface adds
compositor cost without being required by the main product shell. Linux CSS keeps the same hierarchy and palette
but removes the largest live backdrop blurs, replaces artwork blur with tint/saturation, reduces lyric-stage shadow
cost, and adds paint containment to lyric lines. Windows retains the richer visual path.

## Explicit compatibility modes

These are opt-in startup diagnostics, not automatic GPU guesses:

| `YAQMC_LINUX_RENDERER`             | Applied variables                           | Intended use             |
| ---------------------------------- | ------------------------------------------- | ------------------------ |
| `auto`                             | none                                        | default                  |
| `disable-dmabuf` / `compatibility` | `WEBKIT_DISABLE_DMABUF_RENDERER=1`          | confirmed DMABUF failure |
| `software` / `safe`                | DMABUF disabled + `LIBGL_ALWAYS_SOFTWARE=1` | last-resort safe mode    |

`WEBKIT_DISABLE_COMPOSITING_MODE=1` is intentionally not a shipped mode. The tester script can apply it for one
diagnostic run only. `__NV_DISABLE_EXPLICIT_SYNC=1` is likewise a controlled comparison, never a global default.

## Pending measurements

No Linux GUI is available on the development host. Root cause attribution and before/after FPS, CPU, GPU, RSS,
resize latency and per-WebView overhead remain pending the Arch report. The source-side changes bound known expensive
surfaces, but they are not evidence that a particular compositor/GPU regression is fixed.
