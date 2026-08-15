# Plugin security

> [简体中文](zh-CN/plugin-security.md) | **English**

Runtime plugins are untrusted. The static scanner is **supplemental**. The security boundary is isolated execution,
a permission-checked bridge, package jail, and host-proxied network. Raw `fetch` stays denied.

## Isolation

Third-party script does **not** run in the main YAQMC WebView. Each script plugin gets a dedicated worker built from
YAQMC-owned bootstrap plus the plugin’s `dist/main.js`. The worker has no `document`, no `__TAURI__`, no `invoke`,
and no raw `fetch`. All privileged work goes through `plugin_bridge` with a host-bound runtime token. Plugin-supplied
`pluginId` is not authorization.

CSS and Scene Schema never execute JavaScript. Scene CSS is scoped to `[data-yaqmc-plugin-scene]`. Global styles may
only target the documented `data-yaqmc` / `--yaqmc-*` API.

## Permissions

Granted only after review:

`track.read`, `lyrics.read`, `player.read`, `player.control`, `theme.read`, `plugin.storage`, `scene.register`,
`style.register`, plus v2 `ui.contextMenu`, `ui.playerBar`, `ui.sidebar`, `ui.notify`, and scoped
`network:https://host`.

Hard-denied: `network`, `network:*`, `filesystem`, `provider`, `account`, `native`, `shell`, QQ cookies / `qm_keyst` /
`qrsig` / OAuth secrets / ekey / local HTTP bearer tokens, arbitrary Tauri commands, and native `dll`/`so` loading.

`player.control` and `network:https://…` are sensitive. Updates that expand permissions require a new approval.
The install review lists added and removed permissions when a package updates an already-installed plugin.
Network requests are host-proxied: HTTPS only, origin allowlist, DNS private-IP rejection, redirect revalidation,
no YAQMC credentials, body/response/timeout/rate limits.

## Package extraction

Archives are inspected before extract: path jail, symlink rejection, size/file-count limits, SHA-256 of the package,
staging directory, then atomic replace. Nothing executes from the ZIP.

v1 plugins are **Unsigned / local**. SHA-256 matching itself is integrity, not publisher trust. Do not show
“Verified”.

## Scanner

JS/CSS is scanned for fetch, `eval`, `__TAURI__`, remote `@import`, and similar signals (Low / Medium / High). A clean
scan does not prove safety. A high CSS remote-url finding blocks style activation.

## Safe Mode

A journal records plugin activation vs clean exit. Unclean shutdown during activation enables Safe Mode: third-party
styles, scenes, and scripts stay off; built-in lyrics presets remain; packages and settings are kept. Suspect plugins
are marked Failed so they are not reactivated in a crash loop.
