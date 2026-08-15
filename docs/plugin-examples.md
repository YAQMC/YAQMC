# Example plugins

> [简体中文](zh-CN/plugin-examples.md) | **English**

These are **unsigned local examples**. They are not built-in YAQMC features and are not enabled by default.
Install from Settings → Plugins → Choose file. There is no marketplace.

Source lives in `examples/plugins/`. Packed `*.yaqmc-plugin` files are in
[`examples/plugins/packages/`](../examples/plugins/packages/). Rebuild them with `npm run plugins:pack`.

## Downloads

| Package                                                                                           | What it changes                                         | APIs used                                                                                                      |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [Sakura](../examples/plugins/packages/dev.yaqmc.example.sakura-1.0.0.yaqmc-plugin)                | Sidebar, player bar, queue, track title (pink)          | Every v1 `data-yaqmc` selector and `--yaqmc-*` token. Conflicts with Night.                                    |
| [Night](../examples/plugins/packages/dev.yaqmc.example.night-1.0.0.yaqmc-plugin)                  | Same chrome, cool ink                                   | Same style API. Conflicts with Sakura.                                                                         |
| [Lyrics scenes](../examples/plugins/packages/dev.yaqmc.example.scenes-1.0.0.yaqmc-plugin)         | Adds **Aurora** and **Vinyl glow** to the lyrics picker | Scene Schema + every `data-scene-widget` / `data-scene-state` selector                                         |
| [Session bookmark](../examples/plugins/packages/dev.yaqmc.example.now-playing-1.0.0.yaqmc-plugin) | Restores seek on the same queue entry                   | `track` / `lyrics` / `player` / `theme` reads, all five events, storage, `log.*`, `player.seek`, `player.play` |
| [Studio](../examples/plugins/packages/dev.yaqmc.example.studio-1.0.0.yaqmc-plugin)                | Chrome + two scenes + bookmark script                   | Style + scene + script + every v1 permission                                                                   |
| [Ink core](../examples/plugins/packages/dev.yaqmc.example.ink-core-1.0.0.yaqmc-plugin)            | Sets shared `--yaqmc-*` tokens                          | Style tokens only                                                                                              |
| [Ink accent](../examples/plugins/packages/dev.yaqmc.example.ink-accent-1.0.0.yaqmc-plugin)        | Applies those tokens to chrome                          | Style selectors. **Requires Ink core** (`dependencies`)                                                        |

`player.pause`, `player.toggle`, `player.next`, and `player.previous` are on the same isolated bridge and go through
PlayerService. The examples do **not** fire them automatically; that would steal the queue. They do call `seek` and
`play` so you can hear and see a real control change (bookmark restore / resume).

## Install

1. Download a `*.yaqmc-plugin` file.
2. Open YAQMC → Settings → Plugins → Choose file.
3. Review SHA-256, permissions, and scan findings. Accept `player.control` only if you want bookmark restore.
4. Enable. Style changes apply immediately. Pick a plugin scene in Lyrics presets. Disable to revert.

Enable **Ink core** before **Ink accent**. Sakura and Night cannot be active together.

v2 example sources: `examples/plugins/script-actions` (settings + context/player-bar actions) and
`examples/plugins/script-network` (host-proxied `https://example.com` only). Pack with `npm run plugin:pack`.
The hostile probe lives in `tests/fixtures/plugins/hostile` and must not be enabled as a user plugin.

## Not included

Marketplace, remote updates, Provider plugins, native modules, HTML entrypoints, and raw `fetch`.
