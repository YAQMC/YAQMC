# Lyrics Composer

> [简体中文](zh-CN/lyrics-composer.md) | **English**

The Lyrics Composer edits the same `LyricsScene` the immersive Lyrics page renders. Preview frames only
change the canvas size. They do not swap in a second renderer.

Custom HTML, CSS, JavaScript, video backgrounds, marketplace presets, and a sandboxed Scene Engine are
**future** work. This iteration is Composer Lite: widgets, snap, inspector, undo, and save.

## Shared scene

Resolved preset schema v2 supplies a widget graph (`background`, `artwork`, `metadata`, `lyrics`,
`transport`) in normalized 0–1 coordinates with nine-point anchors. Runtime binds PlayerStore and the
live lyric document. The editor binds an isolated preview store. Handles, guides, and the inspector
mount only in the editor.

Typography uses one formula on the scene root:

```text
fontBase = clamp(18px, 5.6cqh, 96px)
effectivePrimary = fontBase × fontScale
translation / romanization = primary × 0.42
```

`--lyrics-font-size` is set on the scene as a resolved pixel value from the scene height, so the
composer preview updates while dragging. `.lyrics-line` does not clamp again. Classic and Vinyl
preview the same cover-fill backdrop as the runtime lyrics page.

## Editing

- Click a widget to select it. Click empty canvas (letterbox) to deselect. Clicking an already
  selected widget starts a drag after a short movement threshold; it does not clear selection.
  The selection overlay is the drag surface. Runtime controls such as Follow stay clickable.
- Selected widgets show an overlay outline and resize handles in the same scene transform. Vinyl
  selection uses the inscribed visual square so the disc stays circular. Transport uses a compact
  control-sized frame, not a full-width bar leftover from the old three-column player chrome.
- Font size scales lyric **text** (`70%` is more than 2× smaller than `145%`). It does not shrink
  the lyrics viewport rectangle, and it does not change the line gap. Line spacing uses a
  scene-relative `cqh` gap, independent of `fontScale`.
- The composer shell fills most of the application viewport. The scene uses one uniform fit scale
  (`min(availableWidth / logicalWidth, availableHeight / logicalHeight)`). Zoom is presentation-only.
- Selected widgets show a persistent outline and resize handles.
- Drag and resize commit **one** undo step on pointer up. Pointer-move does not write SQLite.
- Snap to center axes, margins, and sibling edges. Alt or Ctrl bypasses snap.
- Safe-area guides are editor-only.
- Arrow keys nudge the selected widget. Inspector fields set precise values: position, width,
  height, anchor, align, follow anchor, title/artist scale, artwork renderer/opacity/radius,
  background fit/color/blur/influence/opacity, plus translation and romanization visibility.
- Layers can change z-order, lock, or hide a widget.
- **Reset widget** / **Reset position** restore that widget from the factory graph for the preset layout.

Save semantics match Settings:

- Built-in: Apply override, Save as New (optional name), or Cancel.
- Custom: Save, plus Save as New.
- Duplicate is Save as New with a generated name.
- Reset drops a built-in override. Factory definitions stay immutable.
- Plugin scenes stay immutable. **Fork to My Scene** copies schema into a custom preset and records
  `forkedFromPluginId`. Plugin assets remain linked to the source package.

## Preview data

Opening the composer paints the product-owned local sample immediately (一起听见 / YAQMC Studio).
A background read-only search may replace lyrics and artwork through `ArtworkResolver`
(`large` / `fullscreen`). Failure keeps the fixture and shows **Using local preview data**.
The composer never writes favorites, playlists, history, or the PlayerStore queue.

Preset JSON does not store the sample title, artist, artwork URL, or lyric text.

## Follow current line

Follow lives in `LyricsViewport` for both editor preview and runtime:

- `active` recenters on line transitions (not word ticks).
- A wheel event with a delta suspends follow.
- Bare pointer-down does not suspend follow.
- **Follow current line** sets `active` and always scrolls, even when the line index is unchanged.

## Logging

Committed events only: `lyrics.composer.open|drag|resize`, `lyrics.follow.resume|suspend|error`,
`lyrics.preview.hydrate|fallback`, `lyrics.preset.resolve|save`. No pointer-move or word-tick logs.
