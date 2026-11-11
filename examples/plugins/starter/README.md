# YAQMC 插件 example

此目录可以单独复制、改名和分发，不依赖 YAQMC 仓库、npm 安装或 TypeScript 编译器。
需要包含 `ui.lyrics` API 的 YAQMC 构建；旧版宿主无法识别这个新增权限。

1. 修改 `manifest.json` 的 `id`、名称和版本。发布自己的插件时请使用自己的反向域名 ID。
2. 编辑 `main.js`。它是宿主 `definePlugin` 执行的普通 JavaScript，不能使用 ESM import/export。
3. 安装 Node.js 26.7 或更新版本，在此目录执行 `npm run pack`（也可直接 `node pack.mjs`）。
4. 在 YAQMC 设置 → 插件中导入 `dist/*.yaqmc-plugin`，核对权限并启用。
5. 打开歌词页，顶部将出现最小化、最大化/还原、关闭与歌曲信息按钮。

窗口操作只在用户点击后执行，关闭遵循应用本身的托盘设置。不支持窗口控制的宿主隐藏窗口按钮。
禁用插件后按钮自动清理。顶部拖动区域由应用提供，不依赖插件。

从 [API.md](API.md) 查阅 API 总览、权限与全部 SDK 类型。详细离线文档位于 `api/docs/`，
中文入口为 [插件开发](api/docs/zh-CN/plugin-development.md)和
[歌词工具栏 API](api/docs/zh-CN/plugin-lyrics-api.md)。`api/sdk.ts` 可提供编辑器类型提示。

在 YAQMC 仓库执行 `npm run plugin:example:sync` 会更新本目录的生成文档，并将示例导出到仓库旁的
`YAQMC-plugin-example`。`npm run plugin:example:check` 与 CI 会检查文档、SDK 和 API 契约是否同步。
`npm run plugin:build` 也会刷新生成文件，并同步已存在的受管理外部示例。

外部示例中的自行修改文件会保留；同步遇到冲突会报告文件路径。需要全新的示例时，可在仓库运行
`node scripts/sync-plugin-example.mjs --export --out <新目录>`。`api/` 是生成文档，应在仓库原文档中维护。

示例插件代码采用本目录的 MIT 许可。`api/` 中复制的 YAQMC SDK、WIT 与文档遵循 YAQMC 原许可，
见 `api/YAQMC-LICENSE`（GPL-3.0-or-later）。
