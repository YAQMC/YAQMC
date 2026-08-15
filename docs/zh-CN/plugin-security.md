# 插件安全

> **简体中文** | [English](../plugin-security.md)

运行时插件不可信。静态扫描只是辅助。真正边界是隔离运行、带权限的桥、包隔离，以及宿主代理网络。原始 `fetch` 仍然不可用。

第三方脚本**不会**在主 WebView 中执行。每个脚本插件使用 YAQMC 自有 bootstrap 加上 `dist/main.js` 的独立 worker。
worker 没有 `document`、`__TAURI__`、`invoke` 或原始 `fetch`。特权操作必须经过绑定了运行时令牌的 `plugin_bridge`。插件自行声称的
`pluginId` 不能作为授权依据。

CSS 与 Scene Schema 不执行 JavaScript。场景 CSS 限定在 `[data-yaqmc-plugin-scene]`。全局样式只能使用文档化的
`data-yaqmc` / `--yaqmc-*` API。

可授予：`track.read`、`lyrics.read`、`player.read`、`player.control`、`theme.read`、`plugin.storage`、
`scene.register`、`style.register`，以及 v2 的 `ui.contextMenu`、`ui.playerBar`、`ui.sidebar`、`ui.notify` 和
`network:https://host`。

明确拒绝：`network`、`network:*`、`filesystem`、`provider`、`account`、`native`、`shell`，以及 QQ cookie / `qm_keyst` / `qrsig` /
OAuth 密钥 / ekey / 本地 HTTP bearer、任意 Tauri 命令、原生 `dll`/`so`。

`player.control` 与 `network:https://…` 属于敏感权限。权限扩张必须重新批准。更新已安装插件时，审核界面会列出新增和移除的权限。网络请求由宿主代理：仅 HTTPS、来源白名单、
拒绝解析到私网 IP、重定向逐跳校验、不附带 YAQMC 凭据，并限制体积/超时/速率。

安装前会检查路径越狱、符号链接、体积与文件数、包 SHA-256，先解压到暂存目录再原子替换。ZIP 内的代码不会被执行。

v1 插件标记为**未签名 / 本地插件**。SHA-256 只表示完整性，不表示发行方可信，界面不得显示“已验证”。

扫描器会标记 fetch、`eval`、`__TAURI__`、远程 `@import` 等（低/中/高）。扫描通过不等于安全。高风险远程 CSS 会阻止样式激活。

启动日志会记录插件激活与是否干净退出。激活期间异常退出会进入安全模式：第三方样式/场景/脚本关闭，内置歌词预设保留，包与设置保留。可疑插件标记为失败，避免崩溃循环。
