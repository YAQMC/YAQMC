# Plugin Platform

> [简体中文](zh-CN/plugin-platform.md) | **English**

YAQMC **runtime plugins** are user-installed `*.yaqmc-plugin` packages loaded by `ExtensionHost`. They are **not**
Tauri framework plugins, and they are not native `dll` / `so` modules.

v1 is personalization-first: styles, lyrics scenes, and an isolated script host. Plugin API v2 adds declarative
settings, read/control events, safe UI slots, optional scoped HTTPS via a host proxy, and Developer Mode. The same
loader, lifecycle, permissions, and recovery model stay in place. v1 plugins keep working.

## Package

```text
plugin.yaqmc-plugin
├── manifest.json
├── dist/main.js          # optional compiled JavaScript
├── styles/main.css       # optional
├── scenes/*.scene.json   # optional Scene Schema
└── assets/               # optional plugin-local files
```

There is no user-authored HTML entrypoint, no plugin iframe, and no arbitrary settings HTML.

## Lifecycle

Installed → Disabled / Enabling → Active → Disabling → Failed / Incompatible.

Enable and disable are reversible without restarting YAQMC. Uninstall deactivates first, then removes the installed
version(s). Plugin-private storage is removed only when the user asks.

## Storage

Managed under the application data directory:

```text
plugins/
  host.json
  journal.json
  <plugin-id>/
    state.json
    versions/<semver>/
```

The active version is stored explicitly. Symlinks are not used for active-version semantics.

## Limits

| Bound              | Value  |
| ------------------ | ------ |
| Compressed package | 8 MiB  |
| Expanded package   | 32 MiB |
| File count         | 256    |
| Individual file    | 4 MiB  |
| Plugin storage     | 64 KiB |

v1 and v2 share these package limits. Network v2 adds per-request body/response caps and origin allowlists.

## Future (not implemented)

Marketplace, remote updates, Provider plugins, lyric-source plugins, native/WASM runtimes, publisher signing, and
cloud sync remain reserved. `network:*` wildcards are rejected.

Packed example plugins that actually restyle chrome, register lyrics scenes, and exercise the isolated script bridge
are listed in [example plugins](plugin-examples.md).
