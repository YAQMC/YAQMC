# Plugin manifest

> [简体中文](zh-CN/plugin-manifest.md) | **English**

`manifest.json` has two deliberately separate runtime shapes:

- manifest v1 / Plugin API v1-v2 composes styles, scenes, and an isolated script;
- manifest v2 / Plugin API v3 describes one sandboxed Provider Component.

The two shapes cannot be mixed in one package.

## Legacy compositional manifest

```json
{
  "manifestVersion": 1,
  "id": "dev.example.sakura",
  "name": "Sakura",
  "version": "1.0.0",
  "apiVersion": 1,
  "engines": { "yaqmc": ">=0.1.0" },
  "entrypoints": {
    "styles": ["styles/main.css"],
    "scenes": ["scenes/vinyl.scene.json"],
    "script": "dist/main.js"
  },
  "permissions": ["track.read", "lyrics.read"]
}
```

Required fields are `manifestVersion`, `id`, `name`, `version`, and `apiVersion`. Optional fields include description,
authors, homepage, repository, license, engines, platforms, architectures, entrypoints, permissions, dependencies,
conflicts, `settingsSchema`, and reserved `signatures`.

Plugin IDs use reverse DNS, for example `dev.example.plugin`. Versions are semver. `apiVersion` is independent from
the package version and `manifestVersion`. The host understands API versions `1`, `2`, and `3`. Incompatible packages
may remain installed and disabled with an explanation; they are never partially activated.

## Provider Component manifest

```json
{
  "manifestVersion": 2,
  "id": "dev.example.catalog",
  "name": "Example catalog",
  "version": "1.0.0",
  "apiVersion": 3,
  "entrypoints": { "component": "component/provider.wasm" },
  "provider": {
    "id": "dev.example.catalog",
    "name": "Example platform",
    "witVersion": "0.1.0",
    "world": "provider",
    "capabilities": ["provider.catalog"]
  },
  "permissions": ["provider.catalog"]
}
```

API v3 currently freezes `yaqmc:provider@0.1.0`. Its exported `invoke` envelope uses versioned JSON operation
schemas. The host validates and re-scopes responses before they enter Core. Provider capabilities are granted
separately:

- `provider.catalog`
- `provider.playback`
- `provider.recommendation`
- `provider.lyrics`
- `provider.account`

The complete operation inventory and error envelope are frozen in the
[Provider Component API](provider-component-api.md) and its machine-readable fixture. Unknown operations fail closed;
an operation cannot borrow authority from another declared capability.

The selected WIT world must exactly match the requested host imports:

| World                      | Host imports                                  | Required manifest permissions                                   |
| -------------------------- | --------------------------------------------- | --------------------------------------------------------------- |
| `provider`                 | none                                          | provider capabilities only                                      |
| `provider-storage`         | utilities, private KV/cache                   | `plugin.storage`                                                |
| `provider-network`         | utilities, exact-origin HTTPS proxy           | one or more `network:https://…` entries                         |
| `provider-network-storage` | utilities, private KV/cache, HTTPS proxy      | `plugin.storage` and one or more exact origins                  |
| `provider-account`         | utilities, storage, HTTPS, credential handles | `provider.account`, `plugin.storage`, and exact network origins |

Using a broader world without the corresponding permissions is rejected. Asking for storage or network while
selecting a world that cannot import it is rejected too. API v3 does not expose network wildcards, raw sockets,
filesystem paths, environment variables, native libraries, HTML, shell, or subprocess entrypoints.

## Dependencies and conflicts

`dependencies` maps plugin IDs to version ranges. YAQMC does not download missing dependencies. Activation is blocked
when a dependency is missing, too old, or part of a cycle. `conflicts` lists plugins that cannot be active together;
YAQMC reports the reason without attempting automatic resolution.

## Entrypoint paths

Paths are relative to the package root. Parent traversal, absolute paths, Windows drive prefixes, hidden components,
case-insensitive collisions, and duplicate entrypoints are rejected. Provider packages must contain exactly one
Component Model binary at the declared `.wasm` entrypoint. Core Wasm modules and PE/ELF/Mach-O/native executable
payloads are rejected.
