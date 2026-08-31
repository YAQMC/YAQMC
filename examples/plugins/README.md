# Example runtime plugins

These packages are **not** enabled by default and are not built-in YAQMC features.

Packed downloads: [`packages/`](packages/) · docs: [English](../../docs/plugin-examples.md) /
[简体中文](../../docs/zh-CN/plugin-examples.md)

| Directory                | Packed id                       | Changes                                                                                            |
| ------------------------ | ------------------------------- | -------------------------------------------------------------------------------------------------- |
| `style-sakura`           | `dev.yaqmc.example.sakura`      | Pink chrome via every v1 style selector/token. Conflicts with Night.                               |
| `style-night`            | `dev.yaqmc.example.night`       | Cool-ink chrome. Conflicts with Sakura.                                                            |
| `scene-pack`             | `dev.yaqmc.example.scenes`      | Aurora + Vinyl glow lyrics scenes and scene CSS.                                                   |
| `script-now-playing`     | `dev.yaqmc.example.now-playing` | Isolated script: all read APIs, events, storage, logs, seek restore.                               |
| `script-actions`         | `dev.yaqmc.example.actions`     | v2 settings, track context menu, player bar, notify.                                               |
| `script-network`         | `dev.yaqmc.example.network`     | Host-proxied HTTPS to example.com only.                                                            |
| `studio`                 | `dev.yaqmc.example.studio`      | Style + scenes + script + Color Field demo.                                                        |
| `ink-core`               | `dev.yaqmc.example.ink-core`    | Shared `--yaqmc-*` tokens.                                                                         |
| `ink-accent`             | `dev.yaqmc.example.ink-accent`  | Applies those tokens. Depends on Ink core.                                                         |
| `provider-catalog-rust`  | `dev.yaqmc.example.catalog`     | API v3 Rust Component: read-only catalog, no ambient authority.                                    |
| `provider-platform-rust` | `dev.yaqmc.example.platform`    | API v3 Rust Component: catalog, playback, recommendations, lyrics, and isolated synthetic account. |

```bash
npm run plugins:pack
```

The Provider Component has a separate reproducible build because it targets
`wasm32-wasip2`:

```bash
rustup target add wasm32-wasip2
npm run plugin:build:provider-example
npm run plugin:pack:provider-example
npm run plugin:verify:provider-platform-example
```

The complete platform example uses only `accounts.example.com` and deterministic local data. Its OAuth flow is a
Host-bound test fixture, not a real account. Install a `*.yaqmc-plugin` from Settings → Plugins. Enable Ink core
before Ink accent.
