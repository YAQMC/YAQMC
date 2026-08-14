# Lyrics presets

> [简体中文](zh-CN/lyrics-presets.md) | **English**

This iteration introduces a **Lyrics Preset** foundation. It is not the full Scene Engine.
Users start from the three existing lyrics presentations, then customize lyric typography
without losing the shipped built-in definitions.

Custom HTML, CSS, or JavaScript execution is **not** implemented.

## Built-in presets

Stable IDs identify presets. Localized names are display-only.

| ID                  | Layout                | Artwork | Default image fit |
| ------------------- | --------------------- | ------- | ----------------- |
| `builtin.classic`   | Split cover + lyrics  | Square  | Cover             |
| `builtin.immersive` | Full immersive lyrics | Square  | Cover             |
| `builtin.vinyl`     | Vinyl disc            | Vinyl   | Cover             |

Immersive lyrics default to Cover so the visual viewport fills. An existing user Contain
preference is preserved on first migration and is not silently overwritten.

## User overrides and custom presets

- **Built-in source** — immutable canonical definition shipped with YAQMC.
- **User override** — optional patch stored against the same built-in ID.
- **Custom preset** — a new independent preset with a `custom.<uuid>` ID.

Save offers:

- **Apply to this preset** — write the override (or update a custom preset).
- **Save as new preset** — copy the current draft into a new custom ID.
- **Reset to built-in default** — drop the override for that built-in slot. Custom presets stay.

## Typography

The first customization controls are:

- **Lyrics font size** (`fontScale`, 0.70–1.45, default 1.00)
- **Lyrics line spacing** (`lineHeight`, 1.05–1.60, default 1.16)

The editor updates the preview immediately from in-memory draft CSS variables. Persistence
happens only when the user saves. Translation and romanization scale with the same factor.
The renderer does not reparse QRC when typography changes.

## Preview fixture

The editor uses a local design fixture, not the real queue:

- Title: 多远都要在一起
- Artist: G.E.M. 邓紫棋
- Artwork: `/artwork/gem-together.svg` (geometric stand-in, not official album art)
- Timed lines with word timing, translation, and romanization

Play / pause / seek drive an isolated preview timeline. Opening the editor does not replace
the PlayerService queue, favorites, playlists, or account history. No network request is
required to open the editor.

Preview frames: **Desktop 16:9** and **Current window**. Ultrawide is reserved in the type
union only.

## Cover vs Contain

Cover fills the target area and may crop edges. Contain shows the entire image and may
letterbox. Letterboxing is intentional. Unused space uses the preset fallback color
(`#20231C` by default), not a raw WebView black region.

Appearance → Image fit still controls the application shell. Lyrics stages use the selected
preset's `background.fit`.

## Persistence

Preset state is stored with the existing Settings / SQLite preferences document:

```text
lyricsPresets.schemaVersion = 1
lyricsPresets.selectedId
lyricsPresets.overrides
lyricsPresets.custom
```

Preferences document version remains `2`. The nested preset schema is independently versioned
so a later Scene Engine migration can add background widgets, layout, and bindings without
flattening every property into a monolithic Settings row.

## Diagnostics and logging

Snapshots may include a compact `lyricsPreset` object:

```text
id, kind (built-in | custom), schemaVersion
```

They do not dump the full preset JSON or local asset paths.

Committed log targets:

```text
lyrics.preset.select
lyrics.preset.edit
lyrics.preset.save
lyrics.preset.reset
lyrics.preview.play
lyrics.preview.error
```

Slider movement is not logged.

## Future Scene Engine

Later work may extend presets toward:

- draggable widgets and arbitrary layout
- image / video background and Color Field
- custom HTML / CSS
- optional sandboxed JavaScript

None of that is available in this iteration.
