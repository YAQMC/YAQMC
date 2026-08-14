# 插件开发

> **简体中文** | [English](../plugin-development.md)

使用 `@yaqmc/plugin-sdk`（`sdk/plugin`）编写 TypeScript，再构建为 JavaScript。生产环境只执行 `dist/main.js`。导入
`.ts` 时 YAQMC 会识别并说明需要先构建/打包，不会把 TypeScript 当作 JavaScript 执行。

```ts
import { definePlugin } from '@yaqmc/plugin-sdk';

export default definePlugin({
  activate(ctx) {
    const unsubscribe = ctx.events.on('track.changed', (track) => {
      void ctx.log.info(String((track as { title?: string }).title ?? 'none'));
    });
    return () => unsubscribe();
  },
});
```

请打包成调用 `definePlugin({...})` 的经典 `dist/main.js`（worker 不是 ESM 应用包），放入带 `manifest.json` 的
`*.yaqmc-plugin` zip。

| 文件            | 行为                                  |
| --------------- | ------------------------------------- |
| `.yaqmc-plugin` | 检查、校验、权限核对、安装            |
| `.css`          | 包装为本地样式插件                    |
| `.js`           | 扫描后包装为本地脚本插件，需再启用    |
| `.ts`           | 识别为 TypeScript 源码，要求 SDK 构建 |

开发者模式面向插件作者，默认不对普通用户打开。示例位于 `examples/plugins/`，默认不启用。打包下载见
[示例插件](plugin-examples.md)。

可读事件：`track.changed`、`playback.stateChanged`、`playback.positionCommitted`、`lyrics.lineChanged`、
`theme.changed`。进度事件会合并（约 4 Hz）。`player.control` 走 `PlayerService`，沿用会话安全的 seek 邮箱，并有速率限制。

v1 设置使用声明式 schema，由 YAQMC 渲染。插件不能向设置页注入 DOM。
