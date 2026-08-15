# Plugin manifest

> [简体中文](zh-CN/plugin-manifest.md) | **English**

`manifest.json` is compositional. A plugin is not a single `"type": "style"`. It may expose styles, scenes, and/or a
script entrypoint together.

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

## Required vs optional

Required: `manifestVersion`, `id`, `name`, `version`, `apiVersion`.

Optional: description, authors, homepage, repository, license, engines, platforms, architectures, entrypoints,
permissions, dependencies, conflicts, `settingsSchema`, reserved `signatures`.

Plugin IDs are reverse-DNS, for example `dev.example.plugin`. Versions are semver (`1.0.0` or `0.0.0-local`).

`apiVersion` is independent from the package version. v1 understands API version `1` only. Incompatible packages may
remain installed and disabled with an explanation; they are never partially activated.

## Dependencies and conflicts

`dependencies` maps plugin IDs to a version range (`^1.2.0` or `>=1.2.0`). v1 does not download missing plugins.
Activation is blocked when a dependency is missing, too old, or part of a cycle.

`conflicts` lists plugin IDs that cannot be active together. YAQMC reports the reason; it does not try to solve
conflicts automatically.

## Entrypoint paths

Paths are relative to the package root. `..`, absolute paths, Windows drive prefixes, hidden components, and duplicate
entrypoints are rejected.
