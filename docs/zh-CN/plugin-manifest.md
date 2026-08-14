# 插件清单

> **简体中文** | [English](../plugin-manifest.md)

`manifest.json` 是组合式的。插件不是单一的 `"type": "style"`，可以同时提供样式、场景和/或脚本入口。

```json
{
  "manifestVersion": 1,
  "id": "dev.example.sakura",
  "name": "Sakura",
  "version": "1.0.0",
  "apiVersion": 1,
  "engines": { "yaqmc": ">=0.1.0" },
  "entrypoints": {
    "styles": ["styles/main.css"],
    "scenes": ["scenes/vinyl.scene.json"],
    "script": "dist/main.js"
  },
  "permissions": ["track.read", "lyrics.read"]
}
```

必填：`manifestVersion`、`id`、`name`、`version`、`apiVersion`。

可选：描述、作者、主页、仓库、许可证、engines、platforms、architectures、entrypoints、permissions、dependencies、
conflicts、`settingsSchema`，以及预留的 `signatures`。

插件 ID 使用反向域名，例如 `dev.example.plugin`。版本号为 semver。`apiVersion` 与包版本独立。v1 只理解 API 版本
`1`。不兼容的包可以保持安装并停用，且附带原因；不会部分激活。

`dependencies` 不会自动从网络下载。依赖缺失、过旧或成环时阻止启用。`conflicts` 只说明原因，不做自动化解。

入口路径相对于包根目录。`..`、绝对路径、Windows 盘符、隐藏路径分量和重复入口都会被拒绝。
