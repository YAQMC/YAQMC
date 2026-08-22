# Desktop platform integration

> [简体中文](zh-CN/platform-integration.md) | **English**

All platform controls are thin adapters over the authoritative Rust `PlayerService`. Electron IPC, local HTTP,
tray actions, shortcuts, MPRIS and SMTC do not own independent queue or playback state.

The native MPRIS/SMTC integration is Core-owned. Electron Main injects an opaque optional Win32 HWND and its Tokio
runtime handle, and subscribes to the closed Core `HostCommand` bus before native callbacks are enabled. The Core
dependency closure has no desktop-framework, renderer, raw-window-handle, provider, Node, Electron, or N-API edge.

## Linux MPRIS 2.2

The Linux adapter uses `mpris-server`/zbus at `/org/mpris/MediaPlayer2`. It exposes the standard root and Player
interfaces, with Play, Pause, PlayPause, Stop, Next, Previous, Seek, SetPosition, volume, repeat and shuffle setters.
Metadata contains a stable hashed D-Bus TrackId, title, artist list, album, duration and safe artwork URL; signed
playback URLs are never exported. CanGoNext/Previous/Play/Pause/Seek are projected from the real queue. Property
changes are emitted by the server implementation, and an explicit player seek emits `Seeked` in microseconds.

MPRIS `Raise` and `Quit` publish closed `HostCommand` values; the already-subscribed Electron host shows/focuses the
main window or exits. Media keys handled by the desktop environment reach the same service. The 2026-08-10
Arch/XWayland baseline proves that the MPRIS 2.2 service starts; no `playerctl` or desktop-shell command result was
captured, so real controller acceptance remains a HUMAN/platform gate.

## Windows SMTC

The Windows adapter receives the real main HWND as an opaque numeric host input. Play/pause/toggle/next/previous,
stop, relative seek, absolute position and volume callbacks use the injected Tokio runtime handle to invoke
`PlayerService`; `Raise`/`Quit` publish the same closed host commands as MPRIS. Track metadata, duration, artwork,
playback state and position are projected back to Windows. Position projection remains throttled to avoid a
high-frequency system signal stream. Actual SMTC hardware interaction remains a HUMAN/platform gate.

## Tray and close behavior

The tray context menu provides Show, Play/Pause, Previous, Next, **Unlock lyric surfaces**, and Quit. Linux uses the
context menu as the portable activation path. Windows double-click shows the window.

Closing the main window defaults to hide-to-tray; Settings can switch to full quit. Auxiliary lyric windows keep
their own close lifecycle. Locking an overlay makes its content window intentionally click-through while a tiny,
separately permissioned unlock control remains overlaid at the upper-right. Settings has per-surface/all-surface
recovery and the tray retains an out-of-window escape hatch. The Rust interaction transition reverses cursor
ignoring before focusability/resizing and never steals focus.

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

`SystemDefault` is a policy, not a cached device identity. Every initial open and recovery asks CPAL for the current
native default again, then opens that exact device through Rodio's device sink builder. Diagnostics therefore report
both the persisted selection kind and the currently resolved device/driver/host. Recovery retries five times at
two-second intervals and retains the last output error rather than falsely publishing a healthy silent state.
