# Example runtime plugins

These packages are **not** enabled by default and are not built-in YAQMC features.

Packed downloads: [`packages/`](packages/) · docs: [English](../../docs/plugin-examples.md) /
[简体中文](../../docs/zh-CN/plugin-examples.md)

| Directory            | Packed id                       | Changes                                                              |
| -------------------- | ------------------------------- | -------------------------------------------------------------------- |
| `style-sakura`       | `dev.yaqmc.example.sakura`      | Pink chrome via every v1 style selector/token. Conflicts with Night. |
| `style-night`        | `dev.yaqmc.example.night`       | Cool-ink chrome. Conflicts with Sakura.                              |
| `scene-pack`         | `dev.yaqmc.example.scenes`      | Aurora + Vinyl glow lyrics scenes and scene CSS.                     |
| `script-now-playing` | `dev.yaqmc.example.now-playing` | Isolated script: all read APIs, events, storage, logs, seek restore. |
| `studio`             | `dev.yaqmc.example.studio`      | Style + scenes + script + every v1 permission.                       |
| `ink-core`           | `dev.yaqmc.example.ink-core`    | Shared `--yaqmc-*` tokens.                                           |
| `ink-accent`         | `dev.yaqmc.example.ink-accent`  | Applies those tokens. Depends on Ink core.                           |

```bash
npm run plugins:pack
```

Install a `*.yaqmc-plugin` from Settings → Plugins. Enable Ink core before Ink accent.
