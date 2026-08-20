# Plugin Scene API

> [简体中文](zh-CN/plugin-scene-api.md) | **English**

Plugin lyrics pages are **Scene Schema + CSS + optional script**. There is no HTML scene document. Scenes register
into the existing LyricsPreset / LyricsScene / Composer runtime. YAQMC does not grow a second lyrics renderer.

## Registration

On activate, each `entrypoints.scenes` JSON file is registered as
`plugin:<pluginId>:<sceneId>`. The picker shows the scene name plus “Provided by \<plugin\>”. Preferences store that
reference; they do not copy the scene into `custom[]` as if it were built-in.

On disable/uninstall, scenes unregister. If the selected scene disappears, YAQMC falls back to `builtin.classic`.

## Schema

Scene JSON is the shared lyrics scene definition (`schemaVersion` 2): `id`, `name`, `layout`, optional widget graph.
Missing layout fields are filled by the factory for that layout. Composer editing of plugin scenes is disabled in v1;
users can still select them.

## Scene CSS

Scene CSS is scoped with `@scope ([data-yaqmc-plugin-scene="<pluginId>/<sceneId>"])`. Do not use a scene entrypoint
to restyle the whole application; that requires a style entrypoint.

Stable scene selectors:

- `[data-scene-widget]` / `[data-scene-widget-id]` / `[data-scene-widget-type]`
- `[data-scene-state="active"]` / `[data-scene-state="inactive"]`
- `[data-playback-state]`
- `[data-scene-widget="lyrics"]`
- `[data-scene-widget="artwork"]`
- `[data-scene-widget="vinyl"]`
- `[data-scene-widget="transport"]`

Stable CSS variables: `--scene-progress`, `--scene-duration`, `--scene-artwork-primary`,
`--scene-artwork-secondary`, `--scene-accent`, `--scene-font-scale`.

`data-widget` remains an internal editor hook. Plugins should prefer `data-scene-widget`.

Schema v2 remains the scene document version. Extra widgets (`text`, `image`, `video`), Color Field backgrounds,
and gradient/video sources are additive. Existing Classic / Immersive / Vinyl / custom / plugin v1 scenes still
load. Plugin scenes are immutable in Composer; use **Fork to My Scene**.

On Linux, live CSS `filter: blur()` is disabled for lyric lines and scene widget blur overrides. Scene video is not
decoded in `gpu-off` / compatibility graphics modes. `@scope` requires the bundled Chromium engine; if the engine ignores it, the
sheet does not apply and does not leak into Settings.
