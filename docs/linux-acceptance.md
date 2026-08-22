# Linux acceptance evidence

> [简体中文](zh-CN/linux-acceptance.md) | **English**

This ledger separates pre-migration observations from current Electron final-AppImage acceptance, which still
requires an Arch Linux tester. A collection run produces evidence with `verification: pending`; it does not declare
a pass.

## 2026-08-10 pre-migration native-Wayland baseline

| Field                       | Value                                                                           |
| --------------------------- | ------------------------------------------------------------------------------- |
| Archive                     | `YAQMC-linux-report-20260810T162727Z-baseline.zip`                              |
| Captured                    | 2026-08-10 16:27:27 UTC                                                         |
| SHA-256                     | `FD8D672EA8A2D62E608B5BB1EA0AFCEAB489586E31B9454332CA38D08971DE00`              |
| Distribution / kernel       | Arch Linux rolling / `7.1.6-zen1-1-zen`                                         |
| Desktop / session           | Hyprland / Wayland (`WAYLAND_DISPLAY=wayland-1`)                                |
| Actual YAQMC window backend | `wayland-native`, derived from the raw window handle                            |
| Explicit override           | none                                                                            |
| GPU / driver                | Intel Raptor Lake-S UHD (`i915`) and NVIDIA RTX 4060 Max-Q (`nvidia` 610.57.04) |
| Audio                       | Rodio/CPAL ALSA route to PipeWire Sound Server                                  |
| Runtime duration            | 50.379 seconds                                                                  |

This capture was native Wayland for the retired desktop host. It does not describe the current Electron host and
cannot satisfy current native-Wayland acceptance. An even earlier launcher capture used XWayland.

The archive was checked before extraction: all entries normalized below the destination directory and none used an
absolute path, drive prefix, NUL byte, or `..` traversal segment. Its digest matched before and after extraction.

### What it proves

- The retired host created a native Wayland main window without an explicit renderer override.
- MPRIS 2.2, the tray adapter, and Rodio/CPAL initialization completed.
- The log contained no panic, application `ERROR`, Wayland protocol error, DMABUF failure, or crash signature.

### What it does not prove

- The old bundle lacks a Git commit/tree, workflow run identity, and embedded AppImage digest. Its binary identity is
  therefore not cryptographically established.
- Playback, seek continuity, media controls, frame pacing, Focus/fullscreen geometry restoration, and lyric-surface
  lock/unlock were not phase-marked.
- Summed lifetime `%CPU` and RSS are not instantaneous utilization or unique memory. The old report had no PSS and
  cannot attribute its sustained renderer work to a specific surface.

## Required final-AppImage protocol

Use the flat `YAQMC-linux-x64-tester-<commit>` Electron workflow artifact. It
contains the final AppImage, `BUILD-IDENTITY.json`, `SHA256SUMS`, `TESTING.md`,
`ACCEPTANCE.md`, the collector, and the verifier. A repository checkout is
neither required nor accepted as binary identity evidence.

Before launch, from the extracted bundle directory:

```bash
sha256sum -c SHA256SUMS
node verify-lyrics-acceptance.mjs \
  --platform linux \
  --identity-only \
  --build-identity "$PWD/BUILD-IDENTITY.json"
```

Collect into one root, in this order:

1. `auto` with no YAQMC graphics override.
2. `native-wayland`, which supplies `YAQMC_LINUX_RENDERER=native-wayland` and must log
   `display_backend="wayland-native"`.
3. `x11`, which may report `x11` in an X11 session or `xwayland` in a Wayland session.
4. `software` only when a preceding native run reproduces a graphics failure; retain both reports.

`baseline` is only a compatibility alias for `auto`. It never means XWayland.

Every required run records these ordered phases:

1. `startup-idle`
2. `playback`
3. `seek-pause-resume`
4. `main-scroll-resize`
5. `lyrics-normal`
6. `lyrics-focus`
7. `lyrics-fullscreen`
8. `desktop-lyrics`
9. `island-lyrics`
10. `both-surfaces`
11. `shutdown`

During `lyrics-fullscreen`, exit with `Esc` and confirm the previous normal/Focus state and window geometry restore.
For both auxiliary lyric surfaces, lock them, use the directly overlaid unlock icon, lock them again, recover through
tray/Settings, then close them. This proves both the convenient path and the fallback path. Windows software/safe-mode
evidence cannot substitute for any Linux mode.

After `auto`, `native-wayland`, and `x11` directories exist:

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

Return the archive and digest with distribution/kernel, compositor, monitor, scale/DPR, audio observations, and any
visible defect. Final acceptance closes only after the archive is verified and a verdict is recorded.

Plugin API v2, Color Field, scene video, and plugin Worker isolation are compiled for Linux. They are not part of
the closed Linux GUI ledger until a tester records them on a final AppImage.
