# 插件平台

> **简体中文** | [English](../plugin-platform.md)

YAQMC **运行时插件**是由 `ExtensionHost` 加载的用户安装包（`*.yaqmc-plugin`）。它们不是 Tauri 框架插件，也不是
原生 `dll` / `so` 模块。

v1 以个性化为主：样式、歌词场景，以及隔离的脚本宿主。加载器、生命周期、权限和恢复模型应在后续版本增加应用功能时
保持稳定。

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

## v1 限制

压缩包 8 MiB，展开 32 MiB，最多 256 个文件，单文件 4 MiB，插件存储 64 KiB。

## 未实现（预留）

插件市场、远程更新、`network:` 权限、Provider 插件、歌词源插件、任意 UI 插槽、原生/WASM 运行时、发行方签名、云同步。
