# Lyrics surfaces

> [简体中文](zh-CN/lyrics-surfaces.md) | **English**

The immersive in-app view remains the full lyrics experience. Desktop Lyrics and Lyrics Island are dedicated,
lightweight Tauri WebViews. Both consume the same Rust `LyricSurfaceProjection` and normalized `LyricDocument`;
neither polls the local HTTP API or owns a playback clock.

```text
PlayerService + one native audio clock
                 |
        LyricSurfaceProjection
                 |
       lyrics://projection events
             /          \
    Desktop Lyrics   Lyrics Island
```

## Three independent concepts

Visibility, interaction, and presentation are deliberately separate:

```text
Desktop Lyrics
  visible:       true / false
  interaction:   interactive / passive-locked
  presentation:  transparent lyrics, with optional configured background

Lyrics Island
  visible:       true / false
  interaction:   interactive / passive-locked
  presentation:  intentional compact island body
```

`enabled` controls lifecycle and visibility. `interaction` controls native input and activation behavior. Visual
presentation controls the lyric text, intentional background, and temporary editing chrome. Do not reintroduce
independent `locked`, `clickThrough`, `focusable`, and hover booleans as user-facing state.

## Interaction contract

An interactive surface accepts pointer input, may be dragged, and reveals its editing controls on hover. An
interactive Desktop Lyrics window is resizable. The hover state is presentation-only and does not recreate the
WebView.

A `passive-locked` surface is a desktop overlay, not an application window awaiting input. Before it is shown,
the native manager applies:

```text
set_focusable(false)
set_ignore_cursor_events(true)
set_resizable(false)
```

Unlocking restores cursor events and focusability (plus Desktop Lyrics resizing) without calling `set_focus`.
Because the passive surface itself cannot receive a pointer event, the native manager overlays a separate 42×42
single-purpose unlock WebView at its upper-right corner. The lyric window remains fully click-through; only this
small control accepts input. Its Tauri capability exposes only `lyrics_surface_unlock` and cannot read player,
account, or preference-document state. Settings still provides per-surface **Unlock** and **Unlock all** actions,
and the tray keeps the global recovery action.

Interaction changes use one serialized command that updates the native window policy and the canonical persisted
preference together. The UI rolls back if that command fails, and ordinary preference writes preserve the
canonical interaction fields, so a delayed event from another WebView cannot re-lock a surface that was just
unlocked. Track, line, word, artwork, pause, and resume events only update WebView state and never focus or
recreate a surface.

Windows currently satisfies the no-activate contract through Tauri/Wry's focusability and cursor-event APIs; no
custom window procedure, system hook, Explorer injection, or shell modification is installed. The auxiliary
windows remain undecorated, shadowless, skipped in the taskbar, initially unfocused, and initially hidden. A
restored locked window is constructed non-focusable, configured for click-through, and only then shown. The unlock
control is independently skipped in the taskbar and hidden whenever its surface is interactive, disabled, closed,
or hidden for fullscreen.

## Desktop Lyrics presentation

The default presentation background is transparent. In unlocked idle state only the lyric text and its dedicated
text shadow are visible. Pointer entry reveals a low-alpha editing backdrop, subtle container outline, drag
affordance, lock action, playback controls, Settings, and close. Pointer leave hides that chrome after a short
hysteresis delay. Locked mode never renders controls or drag attributes and native input passes through the full
window bounds; the separately overlaid unlock control remains visible at the upper-right.

The text shadow/outline is always a lyric-readability treatment. The editing container outline is separate and is
visible only during interactive hover. If the user explicitly raises Desktop Lyrics background opacity, that
presentation background may remain visible while idle or locked.

## Lyrics Island presentation

The island body is intentional presentation and remains visible when locked. Interactive hover may expand the
island to show track details, a next line, playback controls, and progress. A locked island stays collapsed,
does not react to hover, exposes no controls or drag region, and remains click-through while lyric content keeps
updating. Its separate unlock control remains directly reachable.

## Fullscreen, geometry, and displays

The Windows foreground-fullscreen watcher runs at an 800 ms cadence. Hiding does not alter interaction state.
Before a locked surface is shown again, the passive native policy is reapplied, so fullscreen restoration cannot
transiently make it focusable. Linux returns an unknown fullscreen state rather than hiding a window permanently.

Position and size are saved in SQLite after a 350 ms debounce. Physical coordinates may be negative. A saved
window must overlap a current monitor work area by at least 80×40 pixels; otherwise a safe default is calculated.
Locking does not move a window. Settings exposes an explicit position reset for each remaining surface.

## Removed taskbar-adjacent overlay

The previous `lyrics-taskbar` work-area overlay has been removed. It was positioned near the Windows taskbar but
was not part of the taskbar experience. Its toggle, WebView route, lifecycle, geometry, styles, translations, and
capability entry no longer exist. SQLite migration v4 removes its saved geometry, and preference schema v2 drops
the legacy configuration while safely accepting old documents during migration.

Taskbar Lyrics is unsupported. A future implementation must use a robust, non-invasive Windows mechanism; this
project will not use Explorer injection, shell hooks, or undocumented taskbar modification.

## Platform limits

- Windows supports both surfaces, click-through, focusability, always-on-top, transparent windows, fullscreen
  detection, and multi-monitor geometry restoration.
- Linux shares the state model and Tauri APIs. Exact click-through, topmost, transparency, and focus behavior may
  vary by X11/Wayland compositor. Linux runtime acceptance has not been performed and is not claimed.

Each renderer interpolates active-word fill with `requestAnimationFrame` only while playback is active. Paused
views update once and sleep. Surface memory is primarily the fixed cost of each WebView rather than duplicated
lyrics or playback engines.
