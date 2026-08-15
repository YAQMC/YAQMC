# Plugin development

> [简体中文](zh-CN/plugin-development.md) | **English**

Write TypeScript against `@yaqmc/plugin-sdk` (`sdk/plugin`). Build to JavaScript. The production host executes
`dist/main.js` only. Raw TypeScript is recognized on import so YAQMC can explain that a build/package step is
required; it is not executed as JavaScript.

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

Read events: `track.changed`, `playback.stateChanged`, `playback.positionCommitted`, `lyrics.lineChanged`,
`theme.changed`. Position is coalesced (~4 Hz). `player.control` operations go through `PlayerService` and inherit
the session-safe seek mailbox. Plugin seeks are rate-limited.

## Settings

v1 settings are a declarative schema rendered by YAQMC. Plugins cannot inject DOM into Settings.
