# Linux acceptance

> [简体中文](zh-CN/linux-acceptance.md) | **English**

This protocol applies to the current packaged Electron AppImage. Compilation
and package assembly do not prove native execution, compositor integration, or
multi-window behavior on Linux.

## Tester artifact

Use the flat `YAQMC-linux-x64-tester-<commit>` workflow artifact. It contains
the exact AppImage, `BUILD-IDENTITY.json`, `SHA256SUMS`, testing instructions,
the collector, and the verifier. A repository checkout is not accepted as
binary identity evidence.

Before launch, from the extracted artifact directory:

```bash
sha256sum -c SHA256SUMS
node verify-lyrics-acceptance.mjs \
  --platform linux \
  --identity-only \
  --build-identity "$PWD/BUILD-IDENTITY.json"
```

## Required modes

Collect into one absolute `YAQMC_ACCEPTANCE_ROOT`, in order:

1. `auto`, with no YAQMC graphics override;
2. `native-wayland`, which must report `display_backend="wayland-native"`;
3. `x11`, which may report `x11` in an X11 session or `xwayland` in a
   Wayland session;
4. `software` only when a preceding native run reproduces a graphics failure;
   retain both reports.

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

During fullscreen, exit with `Esc` and confirm that the previous presentation
state and window geometry are restored. For both auxiliary lyric windows, test
direct unlock and tray/Settings recovery after locking. Record tray and MPRIS
behavior, audio output, monitor scale/DPR, and any visible rendering defect.

After the required mode directories exist:

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

Authenticated QQ Music operations are separate LIVE checks and require an
authorized account plus redacted evidence. Final acceptance closes only after
the returned archive, digest, exact package identity, environment, and verdict
are reviewed. A collector output with `verification: pending` is not a pass.
