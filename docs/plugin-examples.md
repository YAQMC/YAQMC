# Example plugins

Plugin sources, build commands and the copyable starter live in [YAQMC/yaqmc-plugins](https://github.com/YAQMC/yaqmc-plugins). Run the plugin build commands below in that repository.

> [简体中文](zh-CN/plugin-examples.md) | **English**

These are **unsigned local examples**. They are not built-in YAQMC features and are not enabled by default.
Install from Settings → Plugins → Choose file. There is no marketplace.

For a copyable standalone starting point, copy `plugins/starter` from the plugin repository. It includes
offline API docs, SDK types and a zero-dependency packer.
The starter adds optional lyrics window buttons via the [lyrics toolbar API](plugin-lyrics-api.md).

Source lives in `yaqmc-plugins/plugins/`. Packed `*.yaqmc-plugin` files are in
[`yaqmc-plugins/plugins/packages/`](https://github.com/YAQMC/yaqmc-plugins/tree/main/plugins/packages/). Rebuild them with `npm run pack`.
The Rust Provider Components have separate reproducible targets. Use `npm run provider:catalog` for the
read-only catalog and `npm run provider:platform` for the complete capability fixture.

## Downloads

| Package                                                                                                                                | What it changes                                         | APIs used                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| [Sakura](https://github.com/YAQMC/yaqmc-plugins/tree/main/plugins/packages/dev.yaqmc.example.sakura-1.0.0.yaqmc-plugin)                | Sidebar, player bar, queue, track title (pink)          | Every v1 `data-yaqmc` selector and `--yaqmc-*` token. Conflicts with Night.                                             |
| [Night](https://github.com/YAQMC/yaqmc-plugins/tree/main/plugins/packages/dev.yaqmc.example.night-1.0.0.yaqmc-plugin)                  | Same chrome, cool ink                                   | Same style API. Conflicts with Sakura.                                                                                  |
| [Lyrics scenes](https://github.com/YAQMC/yaqmc-plugins/tree/main/plugins/packages/dev.yaqmc.example.scenes-1.0.0.yaqmc-plugin)         | Adds **Aurora** and **Vinyl glow** to the lyrics picker | Scene Schema + every `data-scene-widget` / `data-scene-state` selector                                                  |
| [Session bookmark](https://github.com/YAQMC/yaqmc-plugins/tree/main/plugins/packages/dev.yaqmc.example.now-playing-1.0.0.yaqmc-plugin) | Restores seek on the same queue entry                   | `track` / `lyrics` / `player` / `theme` reads, all five events, storage, `log.*`, `player.seek`, `player.play`          |
| [Studio](https://github.com/YAQMC/yaqmc-plugins/tree/main/plugins/packages/dev.yaqmc.example.studio-1.0.0.yaqmc-plugin)                | Chrome + two scenes + bookmark script                   | Style + scene + script + every v1 permission                                                                            |
| [Ink core](https://github.com/YAQMC/yaqmc-plugins/tree/main/plugins/packages/dev.yaqmc.example.ink-core-1.0.0.yaqmc-plugin)            | Sets shared `--yaqmc-*` tokens                          | Style tokens only                                                                                                       |
| [Ink accent](https://github.com/YAQMC/yaqmc-plugins/tree/main/plugins/packages/dev.yaqmc.example.ink-accent-1.0.0.yaqmc-plugin)        | Applies those tokens to chrome                          | Style selectors. **Requires Ink core** (`dependencies`)                                                                 |
| [Read-only catalog](https://github.com/YAQMC/yaqmc-plugins/tree/main/plugins/packages/dev.yaqmc.example.catalog-1.0.0.yaqmc-plugin)    | Adds a deterministic example music platform             | API v3 `provider.catalog`; no network, account, storage, or renderer access                                             |
| [Complete platform](https://github.com/YAQMC/yaqmc-plugins/tree/main/plugins/packages/dev.yaqmc.example.platform-1.0.0.yaqmc-plugin)   | Adds a deterministic platform with playable local audio | API v3 catalog including Discover, playback, recommendations, lyrics, private storage, and a synthetic isolated account |

`player.pause`, `player.toggle`, `player.next`, and `player.previous` are on the same isolated bridge and go through
PlayerService. The examples do **not** fire them automatically; that would steal the queue. They do call `seek` and
`play` so you can hear and see a real control change (bookmark restore / resume).

## Install

1. Download a `*.yaqmc-plugin` file.
2. Open YAQMC → Settings → Plugins → Choose file.
3. Review SHA-256, permissions, and scan findings. Accept `player.control` only if you want bookmark restore.
4. Enable. Style changes apply immediately. Pick a plugin scene in Lyrics presets. Disable to revert.

Enable **Ink core** before **Ink accent**. Sakura and Night cannot be active together.

v2 example sources: `yaqmc-plugins/plugins/script-actions` (settings + context/player-bar actions) and
`yaqmc-plugins/plugins/script-network` (host-proxied `https://example.com` only). Pack with `npm run pack`.

The API v4 example `yaqmc-plugins/plugins/script-pages` registers a "Listening log" page, a sidebar entry that opens it,
and a page button that toggles a Home layout preference (radar first). See the [Plugin Pages API](plugin-pages-api.md).
Provider Component source is in `yaqmc-plugins/plugins/provider-catalog-rust` and
`yaqmc-plugins/plugins/provider-platform-rust`. Install the same package on supported Windows or Linux architectures;
neither contains a native binary. The complete example uses `accounts.example.com` only and its OAuth callback is
completed by automated tests—it is not a real account service. Its media URL/path never enters the renderer: the
Component returns a Host cache recipe and Core consumes the resulting opaque source. Hostile probes live under test
fixtures and must not be enabled as user plugins.

## Not included

Marketplace, remote updates, native modules, HTML entrypoints, raw `fetch`, real account integrations, and
verified-publisher claims.
