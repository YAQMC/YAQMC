# Plugin development

> [简体中文](zh-CN/plugin-development.md) | **English**

Legacy API v1-v2 plugins are written in TypeScript against `@yaqmc/plugin-sdk` (`sdk/plugin`) and built to JavaScript.
The legacy production host executes `dist/main.js` only. Raw TypeScript is recognized on import so YAQMC can explain
that a build/package step is required; it is not executed as JavaScript. API v3 music providers are a separate
WebAssembly Component shape and never execute in the renderer Worker.

```ts
import { definePlugin } from '@yaqmc/plugin-sdk';

export default definePlugin({
  activate(ctx) {
    const unsubscribe = ctx.events.on('track.changed', (track) => {
      void ctx.log.info(String((track as { title?: string }).title ?? 'none'));
    });
    return () => unsubscribe();
  },
});
```

Bundle that file to classic `dist/main.js` that calls `definePlugin({...})` (the worker is not an ESM app bundle).
Ship it in a `*.yaqmc-plugin` zip with `manifest.json`.

## Import workflow

| File            | Behavior                                                                |
| --------------- | ----------------------------------------------------------------------- |
| `.yaqmc-plugin` | Inspect, validate, permission review, install                           |
| `.css`          | Wrap as a local style plugin (`local.css.*`)                            |
| `.js`           | Wrap as a local script plugin after scan; remains disabled until enable |
| `.ts`           | Identify as TypeScript source; require SDK build                        |

Developer Mode (Settings → Plugins, not on by default) is for authors: unpacked folders and extra validation. Do not
enable it for ordinary users unless they are developing a plugin.

Examples live in `examples/plugins/` and are **not** enabled by default. Packed downloads:
[example plugins](plugin-examples.md).

## Events and control

Read events: `track.changed`, `playback.stateChanged`, `playback.position`, `playback.positionCommitted`,
`playback.modeChanged`, `queue.changed`, `lyrics.documentChanged`, `lyrics.lineChanged`, `theme.changed`,
`scene.changed`, `settings.changed`, `ui.action`. Position is coalesced (~4 Hz). `player.control` operations go
through `PlayerService` and inherit the session-safe seek mailbox. Plugin seeks are rate-limited (4/s).

Build legacy examples with `npm run plugin:build`, validate with `npm run plugin:validate`, and pack with
`npm run plugin:pack` (or `npm run plugins:pack` after a build).

## Provider Components

Provider plugins target the frozen `yaqmc:provider@0.1.0` WIT package as a `wasm32-wasip2` `cdylib`. The manifest
declares exactly one Component entrypoint, capability permissions, and a WIT world whose imports match those grants.
Use the read-only [`provider-catalog-rust`](../examples/plugins/provider-catalog-rust/) example for the smallest
starting point. The complete [`provider-platform-rust`](../examples/plugins/provider-platform-rust/) example shows
catalog, playback, recommendations, Discover, lyrics, private storage, and an isolated synthetic account.

```text
rustup target add wasm32-wasip2
npm run plugin:pack:provider-example
npm run plugin:verify:provider-platform-example
```

The complete example uses pinned guest dependencies and produces one architecture-neutral package. Playback returns
a Host request/cache recipe, never a filesystem path or signed URL to React. Account code receives only opaque,
plugin-scoped credential handles. Adding a capability, storage, account access, or a network origin to an update
requires the user to approve the new permissions before activation. See [manifest](plugin-manifest.md),
[platform](plugin-platform.md), and [security](plugin-security.md) for the frozen contract and limits.

## Settings

Settings are a declarative schema rendered by YAQMC. Plugins cannot inject DOM into Settings. Password fields stay
out of diagnostics. UI slots (`ui.contextMenu.track`, Player Bar, sidebar) are declarative; YAQMC renders them.
