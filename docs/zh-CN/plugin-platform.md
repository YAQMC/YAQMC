# 插件平台

> **简体中文** | [English](../plugin-platform.md)

YAQMC **运行时插件**是由 `ExtensionHost` 加载的用户安装包（`*.yaqmc-plugin`）。它们不是 Electron 扩展，也不是
原生 `dll` / `so` 模块。

v1 以个性化为主：样式、歌词场景，以及隔离的脚本宿主。Plugin API v2 增加声明式设置、读写事件、安全 UI 插槽、可选的
宿主代理 HTTPS，以及开发者模式。同一套加载器、生命周期、权限和恢复模型保持不变。v1 插件继续可用。

## 包格式

```text
plugin.yaqmc-plugin
├── manifest.json
├── dist/main.js
├── styles/main.css
├── scenes/*.scene.json
└── assets/
```

没有用户编写的 HTML 入口、插件 iframe，或任意设置页 HTML。

## 生命周期

已安装 → 停用 / 正在启用 → 活动 → 正在停用 → 失败 / 不兼容。

启用和停用无需重启。卸载会先停用再删除已安装版本。插件私有存储仅在用户确认后删除。

## 存储

位于应用数据目录：

```text
plugins/
  host.json
  journal.json
  <plugin-id>/
    state.json
    versions/<semver>/
```

活动版本显式记录，不使用符号链接表示当前版本。

## 限制

压缩包 8 MiB，展开 32 MiB，最多 256 个文件，单文件 4 MiB，插件存储 64 KiB。v1 与 v2 共用这些限制。网络 v2 另有请求体/
响应体上限和来源白名单。

## 未实现（预留）

插件市场、远程更新、Provider 插件、歌词源插件、原生/WASM 运行时、发行方签名、云同步。`network:*` 通配被拒绝。

会真正改界面与播放会话的打包示例见[示例插件](plugin-examples.md)。
