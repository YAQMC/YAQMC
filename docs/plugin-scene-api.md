# Plugin Scene API

> [简体中文](zh-CN/plugin-scene-api.md) | **English**

Plugin lyrics pages are **Scene Schema + CSS + optional script**. There is no HTML scene document. Scenes register
into the existing LyricsPreset / LyricsScene / Composer runtime. YAQMC does not grow a second lyrics renderer.

## Registration

Scenes may include an optional `portraitScene` with the same widget schema as `scene`. It takes precedence on portrait
displays; otherwise the host derives a stacked layout without rewriting the saved landscape coordinates. Font scale
remains user-controlled, with the font base bounded by both scene height and available lyric width.

`scene.lyrics.wordAnimation` (also available in `portraitScene.lyrics`) customizes timed word motion:

```json
{
  "easing": "ease-in-out",
  "keyframes": [
    { "offset": 0, "y": 0, "scale": 1, "rotate": 0 },
    { "offset": 0.45, "y": -0.12, "scale": 1.08, "rotate": -3, "glow": 0.12 },
    { "offset": 1, "y": 0, "scale": 1, "rotate": 0 }
  ]
}
```

Use 2–8 strictly increasing offsets, starting at 0 and ending at 1. `y` is bounded to ±0.5 em, `scale` to 0.5–1.5,
`rotate` to ±30 degrees and `glow` to 0–0.5 em. Missing values default to 0 (scale defaults to 1). Easing supports
`linear`, `ease-out` and `ease-in-out`. Invalid timelines fall back to the default motion. No new permission is required.
The host retains the lyric clock, fill masks, pause and seek; disabling word jump or enabling reduced motion disables
custom motion. Android scenes with custom motion use the shared web lyric renderer. See the source example
`examples/plugins/scene-pack/scenes/vinyl-glow.scene.json` and the SDK type `PluginLyricWordAnimation`.

The custom-motion viewport exposes `[data-yaqmc="lyrics-viewport"]`; its timed word nodes expose
`[data-yaqmc="lyric-word"]`. Generated AMLL class names remain unsupported. Disabling a plugin removes its scene and
restores the active scene's normal animation behavior.

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

## Plugin-owned background canvas

A scene may set `scene.background.source` to `"plugin"`. The active scene's script can then register one host-owned
background surface:

```ts
ctx.scenes.background.register('vinyl', {
  mount(surface) {
    const context = surface.canvas.getContext('2d');
    if (!context) return;
    if (surface.artwork) context.drawImage(surface.artwork, 0, 0, surface.width, surface.height);
  },
  update(state) {
    // Update animation state or freeze when state.isPlaying is false.
  },
  unmount() {
    // Stop timers and release plugin-owned resources.
  },
});
```

The host creates an `OffscreenCanvas`, transfers it to the isolated plugin Worker once, and owns its position,
size, z-order and accessibility. `mount` receives the current artwork as an `ImageBitmap` when the browser can
decode it, plus a dominant-color fallback. Subsequent messages carry only dimensions, artwork changes and playback/
visibility state; the host never sends per-frame draw commands or audio samples. The plugin may run its own
`requestAnimationFrame` loop inside the Worker, and must stop it in `unmount` or when reduced motion is requested.
When `update` reports new `pixelWidth` or `pixelHeight`, resize the retained `OffscreenCanvas` before drawing.

The surface is available only while the matching plugin scene is active. Switching scenes, disabling the plugin or
entering safe mode unmounts it. Registration remains subject to `scene.register`; invalid scene IDs and stale scene
instances are ignored. Canvas support is optional: when `OffscreenCanvas` or artwork decoding is unavailable, the
scene falls back to its normal color/artwork background.
