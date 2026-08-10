# Appearance and personalization

Appearance is a versioned, serializable preference domain rather than arbitrary CSS. The stored model separates
color mode, palette/colors, background, surface material, lyric presentation, and independent lyric-window
settings. This keeps a future import/export format possible without accepting user-supplied CSS or JavaScript.

## Theme token generation

`src/application/theme-tokens.ts` accepts the resolved light/dark mode, primary color, secondary color, surface
opacity, and material mode. It validates 3- and 6-digit hex values and derives:

- primary hover, active, selection, and focus colors;
- secondary and muted-secondary colors;
- readable dark or light accent foreground text by relative contrast;
- base, raised, sidebar, player, hover, and pressed surface alpha tokens.

Components consume tokens such as `--accent-primary`, `--accent-ink`, `--surface`, and `--focus`; they do not
patch selected colors into individual controls. Surface opacity is clamped to 85–100% and changes only surface
background alpha, so text, icons, and artwork remain crisp. The system color mode subscribes to
`prefers-color-scheme` changes.

The built-in palette set is deliberately small: Default, Apple Red, Ocean, Violet, Sakura, Mint, Monochrome, and
Custom. Selecting a preset updates both theme colors. Direct picker and hex input changes select Custom and apply
immediately. Invalid input is rejected without replacing the last valid color; Reset Appearance restores only the
appearance section.

## Background model

The supported modes are:

- Default: the normal tokenized application background.
- Album Artwork: the current normalized artwork source behind a controlled tint; artwork influence changes the
  wash while retaining readable surfaces.
- Custom Color: a validated local color behind the same surface system.
- Custom Image: one managed local image with Cover or Contain fit.

The image path never enters the web layer. A native system picker accepts PNG, JPEG, WebP, BMP, or GIF up to
24 MiB; Rust verifies file magic, copies the image to the application data `backgrounds` directory, and persists
only a constrained relative reference. The renderer receives a data URI through a narrow command. A missing or
invalid managed file produces a recoverable Settings notice and can be replaced through the picker.

Background images are rendered once behind the application and fade on source changes. The foreground tint and
tokenized panels prevent raw images from becoming the text surface. No synchronous color extraction or expensive
per-render filtering is performed.

## Transparency and platform behavior

`Opaque` uses the configured surface alpha directly. `Translucent` lowers only surface alpha within the safe
clamp and enables a restrained CSS backdrop fallback. The Tauri main window is transparent so Windows WebView2
can composite the background; the current implementation does not require Acrylic, private shell APIs, or a
native blur plugin. Linux uses the same CSS/token fallback because compositor behavior differs across X11 and
Wayland. Resizing stability takes priority over a platform-specific material effect.

The synchronous local cache provides flash-free startup. In native mode the full preference object is persisted
under `ui-preferences-v1` in SQLite and broadcast to all application windows. The storage migration marker is
schema version 3.
