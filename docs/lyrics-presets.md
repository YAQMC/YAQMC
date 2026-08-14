# Lyrics presets

> [简体中文](zh-CN/lyrics-presets.md) | **English**

Lyrics presets are a versioned layout + typography contract for the immersive Lyrics page and the
[Lyrics Composer](lyrics-composer.md). They are not the full Scene Engine.

Custom HTML, CSS, or JavaScript execution is **not** implemented. Video backgrounds and a preset
marketplace are **future**.

## Built-in presets

Stable IDs identify presets. Localized names are display-only. Schema v2 stores a factory widget
graph for each built-in layout.

| ID                  | Layout                | Artwork renderer | Default image fit |
| ------------------- | --------------------- | ---------------- | ----------------- |
| `builtin.classic`   | Split cover + lyrics  | Square           | Cover             |
| `builtin.immersive` | Full immersive lyrics | Square           | Cover             |
| `builtin.vinyl`     | Vinyl disc            | Vinyl            | Cover             |

Immersive lyrics default to Cover so the visual viewport fills. An existing user Contain preference
is preserved on first migration and is not silently overwritten.

v1 documents (`layout: split|full|vinyl` without a scene) migrate into these factory graphs. A
malformed scene falls back to the factory for that preset id and logs `lyrics.preset.layout.malformed`.

## User overrides and custom presets

- **Built-in source** — immutable canonical definition shipped with YAQMC.
- **User override** — optional patch stored against the same built-in ID.
- **Custom preset** — a new independent preset with a `custom.<uuid>` ID.

Save offers:

- **Apply to this preset** — write the override (or update a custom preset).
- **Save as new preset** — copy the current draft into a new custom ID (optional name).
- **Reset to built-in default** — drop the override for that built-in slot. Custom presets stay.

Draft edits never mutate factory builtins. Pointer-move does not write SQLite.

## Typography

Controls:

- **Lyrics font size** (`fontScale`, 0.70–1.45, default 1.00)
- **Lyrics line spacing** (`lineHeight`, 1.05–1.60, default 1.16)

One formula is shared by the editor canvas and the runtime scene:

```text
fontBase = clamp(18px, 5.6cqh, 96px)
effectivePrimary = fontBase × fontScale
```

70% and 145% must read as obviously different sizes. Translation and romanization scale from the
primary size. Font size changes glyph size only. Line spacing changes the scene-relative gap between
lines (`cqh`), not the font size. The renderer does not reparse QRC when typography changes.

## Widget graph

Normalized 0–1 scene coordinates, not editor pixels:

- Widgets: `background`, `artwork`, `metadata`, `lyrics`, `transport`
- Per widget: `id`, `x`, `y`, `width`, `height`, `anchor` (nine-point), `zIndex`, `visible`, `locked`
- Artwork extras: `renderer` (`square` | `rounded` | `vinyl`), opacity, radius
- Lyrics extras: `align`, `followAnchor` (default 0.35)
- Metadata extras: `align`, title/artist scale
- Background: `source` (`color` | `artwork` | `image`), fit, fallback color, opacity, influence, blur

Bindings are data, not stored G.E.M. strings: artwork = current track artwork, lyrics = current
track lyrics, transport = playback.

## Preview fixture

The editor uses a local design fixture first, then may hydrate read-only QQ search results:

- Title: 多远都要在一起
- Artist: G.E.M. 邓紫棋
- Artwork: `/artwork/gem-together.svg` until hydrate succeeds through ArtworkResolver
- Timed lines with word timing, translation, and romanization

Play / pause / seek drive an isolated preview timeline. Opening the editor does not replace the
PlayerService queue, favorites, playlists, or account history.

Preview frames: **Desktop 16:9** and **Current window**. Ultrawide is reserved in the type union only.

## Cover vs Contain

Cover fills the target area and may crop edges. Contain shows the entire image and may letterbox.
Letterboxing is intentional. Unused space uses the preset fallback color (`#20231C` by default),
not a raw WebView black region.

Appearance → Image fit still controls the application shell. Lyrics stages use the selected preset's
`background.fit`.

## Persistence

Preset state is stored with the existing Settings / SQLite preferences document:

```text
lyricsPresets.schemaVersion = 2
lyricsPresets.selectedId
lyricsPresets.overrides
lyricsPresets.custom
```

Preferences document version remains `2`. The nested preset schema is independently versioned.

## Diagnostics and logging

Snapshots may include a compact `lyricsPreset` object:

```text
id, kind (built-in | custom), schemaVersion, rendererVersion
```

They do not dump the full preset JSON or local asset paths.

Committed log targets:

```text
lyrics.preset.select
lyrics.preset.save
lyrics.preset.reset
lyrics.composer.open
lyrics.composer.drag
lyrics.composer.resize
lyrics.follow.resume
lyrics.follow.suspend
lyrics.preview.play
lyrics.preview.hydrate
lyrics.preview.fallback
lyrics.preview.error
```

Slider movement and word ticks are not logged.

## Future Scene Engine

Later work may extend presets toward:

- HTML / CSS authoring
- optional sandboxed JavaScript
- image / video background and Color Field
- marketplace distribution

None of that is available in this iteration.
