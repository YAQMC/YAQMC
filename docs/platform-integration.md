# Desktop platform integration

All platform controls are thin adapters over the authoritative Rust `PlayerService`. Tauri commands, local HTTP,
tray actions, shortcuts, MPRIS and SMTC do not own independent queue or playback state.

## Linux MPRIS 2.2

The Linux adapter uses `mpris-server`/zbus at `/org/mpris/MediaPlayer2`. It exposes the standard root and Player
interfaces, with Play, Pause, PlayPause, Stop, Next, Previous, Seek, SetPosition, volume, repeat and shuffle setters.
Metadata contains a stable hashed D-Bus TrackId, title, artist list, album, duration and safe artwork URL; signed
playback URLs are never exported. CanGoNext/Previous/Play/Pause/Seek are projected from the real queue. Property
changes are emitted by the server implementation, and an explicit player seek emits `Seeked` in microseconds.

MPRIS `Raise` shows/focuses the main window and `Quit` exits. Media keys handled by the desktop environment reach
the same service. The 2026-08-10 Arch/XWayland baseline proves that the MPRIS 2.2 service starts; no `playerctl` or
desktop-shell command result was captured, so real controller acceptance remains pending.

## Windows SMTC

The Windows adapter binds System Media Transport Controls to the real main HWND. Play/pause/toggle/next/previous,
stop, relative seek, absolute position and volume callbacks invoke `PlayerService`. Track metadata, duration,
artwork, playback state and position are projected back to Windows. Position projection is throttled to avoid a
high-frequency system signal stream.

## Tray and close behavior

The tray context menu provides Show, Play/Pause, Previous, Next, **Unlock lyric surfaces**, and Quit. Linux relies
on the context menu because Tauri does not provide Linux tray click events. Windows double-click shows the window.

Closing the main window defaults to hide-to-tray; Settings can switch to full quit. Auxiliary lyric windows keep
their own close lifecycle. Locking an overlay makes it intentionally click-through, so unlock does not depend on
clicking that surface: Settings has per-surface/all-surface recovery and the tray exposes an out-of-window escape
hatch. The Rust interaction transition reverses cursor ignoring before focusability/resizing and never steals focus.

## Global shortcuts and output devices

Optional shortcuts are disabled by default:

- `Ctrl+Alt+Space`: play/pause;
- `Ctrl+Alt+Left`: previous;
- `Ctrl+Alt+Right`: next.

Registration is transactional; any conflict removes the partial registration and surfaces an error. The underlying
Linux backend is X11-only, so it is not advertised on an actual native-Wayland window backend. MPRIS remains the
media-key path there.

Output devices use stable hashed IDs rather than display names. Switching opens the replacement sink first, reloads
the prepared source, restores actual position/volume/play-pause state, and swaps only on success. Disappearing
devices trigger a bounded retry to the system default, while the persisted preference remains available for a
future session.
