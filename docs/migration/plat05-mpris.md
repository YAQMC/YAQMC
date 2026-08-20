# PLAT-05: MPRIS re-verify (playerctl + Raise/Quit)

Maintainer script: `node scripts/migration/plat05-mpris-playerctl.mjs`

Linux MPRIS already lives in Core (`mpris-server`, bus
`org.mpris.MediaPlayer2.yaqmc`). Raise/Quit publish `HostCommand` and serialize
on `host://command` as `{"command":"raise"}` / `{"command":"quit"}`. Electron
subscribes those and focuses or quits the main window. **PLAT-05 is not green.**
This checkpoint does not claim `playerctl`, GNOME/KDE applets, or SMTC flyout.

Default is **dry-run** (prints commands, exits 0). `--execute` runs a short
subset (`status`, `metadata`, `Raise`) and is **Linux-only**. This Windows
host cannot talk to a session bus.

```bash
playerctl -p yaqmc status
playerctl -p yaqmc metadata
playerctl -p yaqmc play
playerctl -p yaqmc pause
playerctl -p yaqmc next
playerctl -p yaqmc previous
playerctl -p yaqmc position
dbus-send --print-reply --dest=org.mpris.MediaPlayer2.yaqmc /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Raise
dbus-send --print-reply --dest=org.mpris.MediaPlayer2.yaqmc /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Quit
```

`Raise` must show/focus the Electron main window. `Quit` must quit the app
(after the host sets `stopping`). Do not treat media-key / applet clicks as
green until a maintainer ticks the LIVE VERIFY rows.

## LIVE VERIFY

**Pending.** LIVE VERIFY pending. CI covers the dry-run script (`scripts/ci/plat05-mpris-playerctl.test.mjs`,
`npm run ci:test-scripts`). A maintainer run on Ubuntu X11/XWayland (and GNOME

- KDE applets) is still required.

## Checkpoint

The 32 MiB protocol hard cap is unchanged. Provenance remains **BLOCKED**.
Electron stays **43.4.0**. No `qm-api-rs`.
