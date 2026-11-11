# Plugin Lyrics Toolbar API (API v4)

> [简体中文](zh-CN/plugin-lyrics-api.md) | **English**

Declare `ui.lyrics` with manifest v1 / API v4 to add host-rendered buttons to the main lyrics page.
Buttons are optional plugin contributions. The desktop drag strip is provided by YAQMC even without a plugin.

```js
definePlugin({
  async activate(ctx) {
    await ctx.ui.lyrics.register({ id: 'minimize', label: 'Minimize', windowAction: 'minimize' });
    await ctx.ui.lyrics.register({ id: 'details', label: 'Track details', icon: 'info' });
    return ctx.events.on('ui.action', (event) => {
      if (event.slot === 'lyrics' && event.id === 'details') void ctx.log.info('Details clicked');
    });
  },
});
```

| Method                           | Payload                               | Result         |
| -------------------------------- | ------------------------------------- | -------------- |
| `ctx.ui.lyrics.register(action)` | `{ id, label, icon?, windowAction? }` | `{ ok: true }` |
| `ctx.ui.lyrics.unregister(id)`   | Action ID                             | `{ ok: true }` |

IDs match `[A-Za-z0-9][A-Za-z0-9._-]{0,39}`. Labels contain 1–40 Unicode code points and cannot be blank.
Supported icons: `minus`, `maximize`, `close`, `settings`, `info`, `music`. No URLs or markup are accepted.
Supported `windowAction` values: `minimize`, `toggleMaximize`, `close`. The last follows the app's normal close/tray policy.
An omitted icon defaults to the window command's icon, or `music` for ordinary actions.

Window buttons run through the host's window bridge only when the user presses the button. Registration never
executes a command. Plugins do not receive a callable window bridge or a general IPC API. Window buttons are hidden
on hosts without `windowControls`; ordinary actions remain available. A window button does not also emit `ui.action`.
Ordinary buttons send `{ id, slot: 'lyrics' }` to their owning plugin only. Tooltips include the plugin name.

The host groups the layout switch and native window controls on the lyrics page. The group is transparent until hovered
or reached by keyboard focus, and stays visible on touch-only pointers. When these native controls
are available, plugin `windowAction` registrations reuse them instead of adding duplicate buttons;
ordinary plugin actions remain separate. Disabling a plugin removes its contributions, while the
host's native window controls remain available.

Each plugin may register 4 actions, with 12 actions across all plugins. Registering an existing ID updates it;
exceeding a limit rejects with `lyrics-action-limit`. Invalid payloads reject with `invalid-lyrics-action`.
Core and renderer independently validate fields, commands and permission. Existing bridge rate and size limits apply.
Unregister only removes the caller's own action. Disable, failure, uninstall, permission revocation and update retirement
remove contributions; update candidates publish staged buttons only after validation succeeds.

The toolbar follows lyrics controls' visibility and stays usable by keyboard focus. Dragging is available in the
top 40 pixels of the windowed Electron lyrics page, excluding visible buttons. Fullscreen and Android have no drag strip.

The copyable starter is generated with `npm run plugin:example:sync` into the sibling `YAQMC-plugin-example` directory.
It includes a working window-button plugin, a standalone packer, SDK types and offline API docs. See
[plugin development](plugin-development.md) and [plugin security](plugin-security.md).
