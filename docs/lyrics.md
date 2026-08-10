# Lyrics architecture

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

The full lyrics surface uses a single diffused artwork layer plus restrained color and contrast washes. The
active line is anchored near the viewport center. Wheel or pointer interaction suspends following; the user
can resume it explicitly. Timed lines seek through the same player contract used elsewhere in the UI.

React does not reconcile the whole document on every audio poll. The native service publishes line/word boundary
changes from the actual engine position; a small visual loop only updates word-fill progress between boundaries.
The active word's fill is written to one CSS custom property through a ref. Memoized line components ignore cursor
changes that do not affect their own visual state. Reduced-motion
mode uses immediate scrolling and disables the general transition/animation system through the existing
design token fallback.

The fake provider permanently includes examples for plain text, line timing, word timing, translation and
romanization, long lines, rapid alternating vocals, instrumental gaps, and missing lyrics.

## AMLL decision

The upstream [Apple Music-like Lyrics repository](https://github.com/amll-dev/applemusic-like-lyrics) and its
published packages are currently licensed `AGPL-3.0-only`. YAQMC does not yet have a final project
license. Direct package linkage or source reuse would therefore create an unresolved strong-copyleft
distribution obligation.

No AMLL code or package is used in this repository. The renderer is an independent implementation based on
the product's required behavior and normalized data model. If the project later adopts an AGPL-compatible
license, maintainers may reassess the maintained upstream package instead of duplicating its capabilities.
