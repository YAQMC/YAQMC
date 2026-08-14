# Example runtime plugins

These packages are development fixtures. They are **not** enabled by default and are not built-in YAQMC features.

- `style-sakura` — style-only CSS using the public `data-yaqmc` API
- `scene-vinyl` — lyrics Scene Schema + scoped CSS
- `script-now-playing` — isolated script using `definePlugin` / `track.read`

Package them as `*.yaqmc-plugin` (zip of `manifest.json` plus entrypoints) and install from Settings → Plugins.
