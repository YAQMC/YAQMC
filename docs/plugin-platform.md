# Plugin Platform

> [简体中文](zh-CN/plugin-platform.md) | **English**

YAQMC **runtime plugins** are user-installed `*.yaqmc-plugin` packages loaded by `ExtensionHost`. They are **not**
Tauri framework plugins, and they are not native `dll` / `so` modules.

v1 is personalization-first: styles, lyrics scenes, and an isolated script host. The same loader, lifecycle,
permissions, and recovery model are intended to stay stable when later versions add more application functionality.

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

## Limits (v1)

| Bound              | Value  |
| ------------------ | ------ |
| Compressed package | 8 MiB  |
| Expanded package   | 32 MiB |
| File count         | 256    |
| Individual file    | 4 MiB  |
| Plugin storage     | 64 KiB |

## Future (not implemented)

Marketplace, remote updates, `network:` permissions, Provider plugins, lyric-source plugins, arbitrary UI slots,
native/WASM runtimes, publisher signing, and cloud sync are reserved. Architecture should not make them impossible.

Packed example plugins that actually restyle chrome, register lyrics scenes, and exercise the isolated script bridge
are listed in [example plugins](plugin-examples.md).
