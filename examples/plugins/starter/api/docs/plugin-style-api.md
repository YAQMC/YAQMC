# Plugin Style API

> [简体中文](zh-CN/plugin-style-api.md) | **English**

Stable CSS personalization uses `data-yaqmc` attributes and `--yaqmc-*` custom properties. Internal generated class
names are **unsupported**. Frontend refactors may change those classes without a plugin API bump.

## Selectors (v1)

| Selector                     | Target                          |
| ---------------------------- | ------------------------------- |
| `[data-yaqmc="sidebar"]`     | Primary navigation              |
| `[data-yaqmc="player-bar"]`  | Bottom player                   |
| `[data-yaqmc="queue"]`       | Queue panel                     |
| `[data-yaqmc="track-title"]` | Current title in the player bar |

## Custom properties (v1)

`--yaqmc-primary`, `--yaqmc-secondary`, `--yaqmc-radius-card`, `--yaqmc-player-height`, `--yaqmc-surface-alpha`.

These alias application tokens. Prefer them over undocumented `--accent` internals when writing a plugin.

## Cascade

Enabled style plugins are injected in a persisted `style_order` (activation order). Later entries win. Styles are
wrapped in `@layer yaqmc-plugin-style.<id>`. Disable removes the stylesheet immediately.

## CSS security

Remote `@import`, remote `url(http…)`, and `url(file:…)` are blocked. Plugin-local assets must stay inside the
installed package and are resolved by the host. v1 has no network fonts.

CSS can still hide controls or spoof chrome. Style plugins participate in Safe Mode.
