# Plugin Pages API (API v4)

> [简体中文](zh-CN/plugin-pages-api.md) | **English**

Plugin API v4 lets a script plugin add **pages**, add **navigation entries** that open those pages, and adjust
**host-defined layout knobs** on supported YAQMC pages. v4 extends the compositional manifest (manifest v1): everything
API v2 offers is still available, and v1, v2 and v3 packages keep working unchanged.

Plugins never provide HTML, CSS for these surfaces, images or URLs. A page is a declarative block document that YAQMC
renders with its own components, inside its own layout, with a visible "Provided by …" attribution.

## Manifest

```json
{
  "manifestVersion": 1,
  "id": "dev.example.pages",
  "name": "Listening log",
  "version": "1.0.0",
  "apiVersion": 4,
  "entrypoints": { "script": "dist/main.js" },
  "permissions": ["track.read", "ui.pages", "ui.navigation", "ui.layout"]
}
```

| Permission      | Bridge methods                                                | Sensitive |
| --------------- | ------------------------------------------------------------- | --------- |
| `ui.pages`      | `ui.pages.register`, `ui.pages.render`, `ui.pages.unregister` | no        |
| `ui.navigation` | `ui.navigation.register`, `ui.navigation.unregister`          | no        |
| `ui.layout`     | `ui.layout.set`, `ui.layout.clear`                            | no        |

These permissions are valid only with `apiVersion: 4`. Declaring them with API v1–v3 makes the manifest invalid.
A provider Component (manifest v2) cannot use API v4. A package that declares an API version this host does not
support stays installed but **Incompatible** and never activates, even if it declares permissions this host has never
heard of.

## Script API

```ts
await ctx.pages.register({ id: 'log', title: 'Listening log' });
await ctx.navigation.register({ id: 'open-log', label: 'Listening log', pageId: 'log' });
await ctx.pages.render('log', [
  { type: 'stats', items: [{ label: 'Tracks', value: '12' }] },
  { type: 'actions', items: [{ id: 'clear', label: 'Clear', variant: 'primary' }] },
]);
ctx.pages.onMount('log', () => void refresh());
ctx.events.on('ui.action', (event) => {
  // { id: 'clear', slot: 'page', pageId: 'log' }
});
await ctx.layout.set({
  target: 'home',
  order: ['radar', 'for-you'],
  hidden: ['recommended-playlists'],
});
```

Typed definitions are in `sdk/plugin/src/index.ts` (`PluginPageBlock`, `PluginHomeLayout`, `PluginPageActionEvent`).
A complete example is [`script-pages`](plugin-examples.md).

### Blocks

| Block     | Fields                                                       | Limits           |
| --------- | ------------------------------------------------------------ | ---------------- |
| `heading` | `text`                                                       | 60 characters    |
| `text`    | `text`, `tone?: 'default' \| 'secondary'`                    | 1,000 characters |
| `notice`  | `text`, `level?: 'info' \| 'warning' \| 'error'`             | 1,000 characters |
| `stats`   | `items: { label, value }[]`                                  | 8 items          |
| `list`    | `items: { id, title, subtitle?, actionId? }[]`               | 50 items         |
| `actions` | `items: { id, label, variant?: 'primary' \| 'secondary' }[]` | 4 buttons        |
| `divider` | —                                                            |                  |

A document holds at most 40 blocks; Core rejects any single page, navigation or layout call larger than 64 KiB.
Text is always rendered as text: markup-like strings are shown literally. Unknown block types, unknown fields with the
wrong type, or ids outside `[A-Za-z0-9][A-Za-z0-9._-]{0,39}` reject the whole call with a stable error code
(`invalid-page`, `invalid-page-blocks`, `invalid-navigation-entry`, `invalid-layout`, `unsupported-layout-target`)
before it reaches Core.

## Lifecycle and routing

- Pages are scoped to the plugin: `dev.example.pages/log` and another plugin's `log` are different pages. A plugin
  can only render into, unregister, or link to its **own** pages.
- Each plugin may register 4 pages and 4 navigation entries. Navigation entries appear in the sidebar's Plugins
  section and open the route `{ page: 'plugin-page', pluginId, pageId }`, which participates in back/forward history.
- `page.mounted` and `page.unmounted` are sent only to the owning plugin when its page is shown or left. Rendering
  lazily on mount is recommended.
- Disabling, updating, failing, or uninstalling a plugin removes its pages, navigation entries and layout changes
  immediately. An open plugin page then shows an "unavailable" state; navigation history keeps working.
- Unregistering a page also removes navigation entries that pointed to it.

## Layouts

Layout changes are a host-defined vocabulary, not styling. API v4 supports one target:

| Target | Sections                                    | Knobs             |
| ------ | ------------------------------------------- | ----------------- |
| `home` | `for-you`, `radar`, `recommended-playlists` | `order`, `hidden` |

If several plugins change Home, they are merged deterministically regardless of activation order. Plugins are
applied in id order, `hidden` is the union, and the first plugin (by id) that declares an `order` wins it. Sections
that a plugin does not mention keep their default relative order. Home shows which plugins changed the layout.
Adding targets or sections is an additive v4 change. Removing one requires a new API version.

## Security boundary

API v4 adds no new data access. Page content comes from data the plugin was already allowed to read (for example
with `track.read`), and actions only notify the plugin. The worker isolation, permission-checked bridge,
rate limits and package jail described in [plugin security](plugin-security.md) apply unchanged.
