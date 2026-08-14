# Lyrics architecture

> [简体中文](zh-CN/lyrics.md) | **English**

The lyrics pipeline keeps provider formats out of presentation code:

```text
encrypted QQ QRC / LRC / fixture document
                 |
      provider decrypt/parser/normalizer -> LyricDocument
                                                |
Rodio-backed PlayerService position -------------+
                                                |
                                  React renderer / local API
```

`LyricDocument` supports unsynchronized, line-synchronized, and word-synchronized content. A line may
carry translation, romanization, vocalist identity, explicit start/end boundaries, and independently timed
words or syllables. Provider-specific QRC/LRC payloads must be parsed before crossing the provider boundary.

The QQ Music provider decrypts QRC in Rust, extracts XML `LyricContent` when present, preserves literal
parentheses around timed words, decodes entities, and aligns translation/romanization by timestamp. Legacy LRC is
the fallback. Normalized cache keys carry a parser revision so fixes invalidate old documents.

## Renderer

The lyrics page is a full-window immersive surface over a cover-derived background. The immersive page and
the [Lyrics Composer](lyrics-composer.md) share one `LyricsScene`. The top bar cycles every resolved preset
grouped by layout: split customs after Classic, full customs after Immersive, vinyl customs after Vinyl.
That only changes `selectedId`. Desktop Lyrics and Lyrics Island keep their own surface typography.

Cover layouts persist through the lyric preferences and as the selected [lyrics preset](lyrics-presets.md).

The blurred background for Classic and Vinyl is produced once per artwork by an offscreen canvas
using `stackblur-canvas`, then shown at full opacity behind a dark wash—the same cover fill used
before the composer. Live CSS `filter: blur()` is avoided because WebKitGTK can rasterize large
blurred layers as black. Immersive factory blur is 0 so the raw cover fills the stage. Appearance
color/image modes still override that fill.

Line emphasis uses a cover-aware ink color: controls, progress, word fill, and sung text use pure ink, while
the active line mixes the artwork color with ink so light covers stay readable. Non-active lines share one
default dimmed color; only the singing line stands out. Primary size is `clamp(18px, 5.6cqh, 96px) × fontScale`
on the scene root. Font size changes glyph size. Line spacing is a scene-relative `cqh` gap, so enlarging
type does not inflate the space between lines.

The active line is anchored at 35% of the viewport (`followAnchor`, overridable per lyrics widget) and tracks
playback through a damped spring animation on a transform-based scroll layer, which avoids per-frame text
repaint. A wheel gesture with a delta suspends following. Bare pointer-down does not. **Follow current line**
always scrolls to the current line, even when the line index did not change. Clicking a timed line seeks and
resumes following. Word highlight is independent and does not recenter.

React does not reconcile the whole document on every audio poll. The native service publishes line/word boundary
changes from the actual engine position; a small visual loop only updates word-fill progress between boundaries.
The active word's fill is written to one CSS custom property through a ref. Memoized line components ignore cursor
changes that do not affect their own visual state. Reduced-motion
mode uses immediate scrolling and disables the general transition/animation system through the existing
design token fallback.

Long instrumental gaps (>= 4 s between timed lines) surface an instrumental badge while the last sung line
stays dimmed; short gaps between lines never trigger it.

The fake provider permanently includes examples for plain text, line timing, word timing, translation and
romanization, long lines, rapid alternating vocals, instrumental gaps, and missing lyrics.

## Presentation and fullscreen behavior

Lyrics has three presentation layers over one renderer:

- Normal keeps application navigation and PlayerBar visible.
- Focus collapses navigation and expands both Lyrics and PlayerBar across the viewport.
- Native fullscreen asks the main Tauri window to enter OS fullscreen and mounts the centered transport.

The request path is asynchronous and recoverable. Lyrics remains visible while a native transition is pending or
when it fails, so the user can retry or exit. UI buttons and F11 use the same serialized native request boundary.
Escape unwinds one layer at a time: native fullscreen, then Focus, then Lyrics. Native fullscreen changes made
outside React are reconciled from the window event stream without treating an old snapshot as newer state.

The fullscreen transport reads the shared player store, not a duplicate timeline. It hides after 2400 ms of
playing inactivity, reveals on pointer movement or track change, remains pinned while it owns focus, and exposes
Previous, Play/Pause, and Next through the same player commands as PlayerBar.

Fullscreen removes the redundant on-screen fullscreen icon: F11 enters/exits and Escape unwinds. Top chrome is
shown only at entry, by keyboard interaction, or when the pointer reaches the top 56 px, then follows the same
2400 ms grace. A track transition invalidates old document and cursor generations independently, so a slower
initial auxiliary-window snapshot cannot overwrite the event for the automatically advanced song.

Artwork entering an immersive lyric surface passes through the shared safe-artwork resolver. Local/same-origin
sources and validated image data URIs may render directly. Only exact HTTPS hosts `y.gtimg.cn` and
`qpic.y.qq.com` may cross the native cache boundary; redirects, credentials, non-443 ports, `music.tc.qq.com`
variants, other origins, non-image MIME types, and malformed/non-base64 IPC results resolve to no image.

The Windows local visual and interaction checkpoint is recorded in
[Windows acceptance](windows-acceptance.md). It covers the Normal/Focus/native-fullscreen matrix, exact geometry
restoration, reduced motion, Follow and seek behavior, secondary lyrics, transport behavior, and external native
fullscreen reconciliation. It does not close the final NSIS release checkpoint.

## AMLL decision

The upstream [Apple Music-like Lyrics repository](https://github.com/amll-dev/applemusic-like-lyrics) and its
published packages are currently licensed `AGPL-3.0-only`. YAQMC does not yet have a final project
license. Direct package linkage or source reuse would therefore create an unresolved strong-copyleft
distribution obligation.

No AMLL code or package is used in this repository. The renderer is an independent implementation based on
the product's required behavior and normalized data model. If the project later adopts an AGPL-compatible
license, maintainers may reassess the maintained upstream package instead of duplicating its capabilities.
