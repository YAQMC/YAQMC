# 插件开发

> **简体中文** | [English](../plugin-development.md)

旧版 API v1-v2 插件使用 `@yaqmc/plugin-sdk`（`sdk/plugin`）编写 TypeScript，再构建为 JavaScript。旧版生产宿主只执行
`dist/main.js`。导入 `.ts` 时 YAQMC 会识别并说明需要先构建/打包，不会把 TypeScript 当作 JavaScript 执行。API v3
音乐 Provider 是另一种 WebAssembly Component 包形状，不在 renderer Worker 内执行。

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

可读事件：`track.changed`、`playback.stateChanged`、`playback.position`、`playback.positionCommitted`、
`playback.modeChanged`、`queue.changed`、`lyrics.documentChanged`、`lyrics.lineChanged`、`theme.changed`、
`scene.changed`、`settings.changed`、`ui.action`。进度事件会合并（约 4 Hz）。`player.control` 走 `PlayerService`，
沿用会话安全的 seek 邮箱，插件 seek 限制为每秒 4 次。

旧版示例的构建命令是 `npm run plugin:build`，校验命令是 `npm run plugin:validate`，打包命令是
`npm run plugin:pack`。

## Provider Component

Provider 插件以 `wasm32-wasip2` `cdylib` 为目标，使用冻结的 `yaqmc:provider@0.1.0` WIT。清单只能声明一个
Component 入口、逐项能力权限，以及与授权 import 精确匹配的 WIT world。最小起点见只读
[`provider-catalog-rust`](../../examples/plugins/provider-catalog-rust/)；完整
[`provider-platform-rust`](../../examples/plugins/provider-platform-rust/) 展示目录、播放、推荐、发现、歌词、私有存储和
隔离的合成账号。

```text
rustup target add wasm32-wasip2
npm run plugin:pack:provider-example
npm run plugin:verify:provider-platform-example
```

完整示例固定 guest 依赖并生成一个与 CPU 架构无关的包。播放只返回 Host 请求/缓存配方，不把文件路径或签名 URL 交给
React；账号代码只能使用插件私有的不透明凭据句柄。更新时新增能力、存储、账号访问或网络 origin，必须由用户重新批准后
才能激活。冻结契约与限制见[清单](plugin-manifest.md)、[平台](plugin-platform.md)和[安全](plugin-security.md)。

设置使用声明式 schema，由 YAQMC 渲染。插件不能向设置页注入 DOM。密码字段不会进入诊断。UI 插槽由 YAQMC 渲染。
