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

Scene CSS is scoped with `@scope ([data-yaqmc-plugin-scene="<pluginId>"])`. Do not use a scene entrypoint to restyle
the whole application; that requires a style entrypoint.

Stable scene selectors:

- `[data-scene-widget="lyrics"]`
- `[data-scene-widget="artwork"]`
- `[data-scene-widget="vinyl"]` (artwork renderer still uses `artwork`)
- `[data-scene-widget="transport"]`
- `[data-scene-state="active-line"]`

`data-widget` remains an internal editor hook. Plugins should prefer `data-scene-widget`.
