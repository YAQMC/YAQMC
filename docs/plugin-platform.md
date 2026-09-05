# Plugin Platform

> [简体中文](zh-CN/plugin-platform.md) | **English**

YAQMC runtime plugins are user-installed `*.yaqmc-plugin` packages loaded by `ExtensionHost`. They are not Electron
extensions and never load native `dll` / `so` modules.

Plugin API v1 provides styles, lyrics scenes, and an isolated script host. API v2 adds declarative settings,
read/control events, safe UI slots, optional scoped HTTPS through a Host proxy, and Developer Mode. API v3 adds local,
unsigned music-provider plugins as WebAssembly Components hosted by Wasmtime. Existing v1 and v2 plugins continue to
work unchanged.

## Package shapes

```text
legacy-plugin.yaqmc-plugin
├── manifest.json
├── dist/main.js          # optional compiled JavaScript
├── styles/main.css       # optional
├── scenes/*.scene.json   # optional Scene Schema
└── assets/               # optional plugin-local files

provider-plugin.yaqmc-plugin
├── manifest.json
└── component/provider.wasm
```

There is no user-authored HTML entrypoint, plugin iframe, native library, or arbitrary settings page.

## Lifecycle and persistence

Installed → Disabled / Enabling → Active → Disabling → Failed / Incompatible.

Enable and disable are reversible without restarting YAQMC. The active version is recorded explicitly; symlinks are
not used. API v3 private KV, managed cache, and credential-handle indexes use hashed namespaces, and Components never
receive their host paths.

Enabling preserves existing permission grants. If a disabled plugin requests sensitive permissions that have not
been approved, the manager requires explicit review before activation; cancelling keeps it disabled. Safe Mode
blocks activation. Reload failures are shown in the manager, and open details refresh after a successful reload.

Disabling a Provider plugin cancels calls, revokes its Host context, and unregisters the provider. Re-enabling creates
a new context. Uninstalling deactivates first and removes private data only when the user selects that option. An
unclean activation enters safe mode on the next launch.

Queue entries and catalog routes retain their `providerId`. If that provider is disabled or removed, Core refuses its
source, automatic traversal skips it, and the renderer shows a deterministic unavailable state instead of sending the
track ID to another platform. Queue removal/reordering remains available. Re-enabling the same provider restores
links, playback eligibility, and provider-scoped account state without rewriting the queue.

## Limits

| Bound              | API v1-v2 | API v3 Provider Component |
| ------------------ | --------- | ------------------------- |
| Compressed package | 8 MiB     | 32 MiB                    |
| Expanded package   | 32 MiB    | 96 MiB                    |
| File count         | 256       | 512                       |
| Individual file    | 4 MiB     | 32 MiB Component          |
| Private KV         | 64 KiB    | 4 MiB                     |
| Managed cache      | —         | 64 MiB                    |
| Component memory   | —         | 64 MiB                    |
| Concurrent calls   | —         | 4                         |
| Request/response   | per API   | 4 MiB                     |
| Operation deadline | per API   | 15 seconds                |

API v3 also uses CPU fuel and epoch interruption. Three consecutive sandbox faults open a per-session circuit
breaker until the plugin is explicitly re-enabled.

## Provider sandbox

Provider Components use the frozen `yaqmc:provider@0.1.0` WIT package and WASI 0.2 Component Model. A Component has no
ambient filesystem, environment, process, shell, raw socket, host credential, renderer IPC, or HTML access. The
manifest selects a WIT world whose imports must exactly match the user's grants:

- exact-origin HTTPS is pinned to DNS addresses validated by Core; redirects repeat origin, DNS, and private-address
  checks;
- KV and cache are quota-bounded, private, and pathless from the guest's perspective;
- credential creation returns an opaque, write-only handle. Only an account world can attach that handle to a Host
  request for the same origin; the secret is never returned to WebAssembly or the renderer;
- clocks, random bytes, and logs are bounded; potentially sensitive log shapes are replaced with a redaction marker.

See the exact capability/world mapping in [the manifest reference](plugin-manifest.md).

The `provider.playback` result is either an exact-origin HTTPS recipe or a key in the Host-managed cache. Core resolves
and streams that opaque source; signed URLs, request headers, credentials, and host paths are not serialized into the
renderer protocol. `provider.account` is bound to the declaring provider instance and its hashed storage namespace,
so it cannot inspect or overwrite the built-in QQ Music account.

## Deliberately not implemented

Marketplace, remote updates, verified-publisher signing, native modules, arbitrary settings HTML, and cloud sync are
not part of this release. `network:*` wildcards are rejected. Packed legacy examples plus read-only and complete Rust
Provider Components are listed in [example plugins](plugin-examples.md).
