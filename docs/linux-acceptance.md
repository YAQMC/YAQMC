# Linux acceptance evidence

This document separates observations from the Arch Linux diagnostic bundle from behavior that still needs a
scripted physical test. The original archive is intentionally not committed because it contains machine-specific
diagnostics.

## Latest report

| Field                              | Value                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| Archive                            | `YAQMC-linux-report-20260810T162727Z-baseline.zip`                              |
| Captured                           | 2026-08-10 16:27:27 UTC                                                         |
| SHA-256                            | `FD8D672EA8A2D62E608B5BB1EA0AFCEAB489586E31B9454332CA38D08971DE00`              |
| Distribution / kernel              | Arch Linux rolling / `7.1.6-zen1-1-zen`                                         |
| Desktop / session                  | Hyprland / Wayland (`WAYLAND_DISPLAY=wayland-1`)                                |
| Actual YAQMC window backend        | `wayland-native` from the raw Wayland window handle                             |
| Explicit backend/renderer override | none recorded                                                                   |
| GPU / driver                       | Intel Raptor Lake-S UHD (`i915`) and NVIDIA RTX 4060 Max-Q (`nvidia` 610.57.04) |
| Audio stack                        | Rodio/CPAL ALSA route to PipeWire Sound Server; host PipeWire 1.6.8             |
| Runtime duration                   | 50.379 seconds                                                                  |

The archive was checked before extraction: all 13 entries normalize below the destination directory and none use an
absolute path, drive prefix, NUL byte, or `..` traversal segment. Hashing before and after extraction produced the
same digest.

## What the report proves

- The tested process created a native Wayland main window. `yaqmc.log` records
  `display_backend="wayland-native"`; this value is produced from the raw window handle rather than inferred from
  `XDG_SESSION_TYPE`.
- Baseline launch followed the Wayland session without an explicit `GDK_BACKEND` or YAQMC graphics override.
- MPRIS 2.2 and the tray adapter initialized.
- The application initialized Rodio 0.22/CPAL 0.17 and selected the PipeWire Sound Server output exposed through the
  ALSA host route.
- The captured log has no panic, application `ERROR`, Wayland protocol error, DMABUF failure, or crash signature.

## What the report does not prove

- The bundle has no Git SHA, application build ID, or embedded AppImage digest. Its timestamp and behavior are
  consistent with commit `0e299f1`, but exact binary identity is not cryptographically established.
- No playback/seek markers, HTTP range events, `playerctl` transcript, or active audio-stream snapshot were captured.
  Audible playback, media controls, seek continuity, and time-to-first-audio remain unaccepted.
- No Desktop Lyrics or Lyrics Island action was recorded. Creation, placement, lock, click-through, tray unlock, and
  close behavior remain unaccepted on this host.
- No frame-time or action labels were collected. Smoothness during scroll, resize, lyrics animation, and fullscreen
  cannot be inferred.

## Resource evidence

The sampler reports the sum of descendant-process lifetime CPU percentages and RSS values. Lifetime `%CPU` is not an
instantaneous utilization sample, and summed RSS can count shared pages more than once.

Across 48 usable process-tree samples, the summed lifetime CPU ranged from 62.2% to 99.7% (mean 67.9%; final ten
mean 65.6%). Summed RSS ranged from approximately 679.5 MiB to 818.6 MiB (mean 775.3 MiB; final ten mean 798.3 MiB).
At the final sample, the main process was approximately 327.9 MiB RSS, the network process 69.6 MiB, and the WebKit
web process 392.6 MiB. The web process still reported roughly 50% lifetime CPU after 48 seconds.

This is actionable evidence of sustained work, but it is not a root-cause attribution because the report has no
interaction markers, per-thread profile, PSS, frame timing, or CPU-core count. The next report must label the test
phase so main-window idle, playback, scrolling, Focus mode, fullscreen, and auxiliary lyric surfaces can be compared.

## Remaining Arch acceptance

The next AppImage should be exercised in this order:

1. Launch in `baseline` mode and confirm the log still reports `wayland-native`.
2. Record idle resource samples with no auxiliary lyric surfaces.
3. Start a real playable track, seek twice, pause/resume, and capture an active PipeWire stream plus `playerctl`
   state/commands.
4. Scroll/resize the main window, then enter Lyrics Focus and native fullscreen; leave fullscreen with `Esc` and
   verify the previous window layout returns.
5. Enable Desktop Lyrics and Lyrics Island separately, lock each surface, recover interaction from tray/Settings,
   and close each surface.
6. Close YAQMC normally and include the new report plus concise subjective observations.

Do not apply software-rendering or DMABUF workarounds unless the baseline records a matching graphics failure.
