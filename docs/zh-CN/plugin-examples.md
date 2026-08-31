# 示例插件

> **简体中文** | [English](../plugin-examples.md)

这些是**未签名的本地示例**，不是 YAQMC 内置功能，默认不启用。在 设置 → 插件 → 选择文件 中安装。没有插件市场。

源码在 `examples/plugins/`。已打包的 `*.yaqmc-plugin` 在
[`examples/plugins/packages/`](../../examples/plugins/packages/)。可用 `npm run plugins:pack` 重新打包。
Rust Provider Component 使用独立的可复现 target。只读目录用 `npm run plugin:pack:provider-example`；完整能力夹具用
`npm run plugin:verify:provider-platform-example` 构建、打包并运行集成验证。

## 下载

| 包                                                                                            | 实际改动                                    | 用到的 API                                                                    |
| --------------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| [Sakura](../../examples/plugins/packages/dev.yaqmc.example.sakura-1.0.0.yaqmc-plugin)         | 侧栏、播放条、队列、歌曲标题（粉色）        | 全部 v1 `data-yaqmc` 选择器与 `--yaqmc-*`。与 Night 冲突                      |
| [Night](../../examples/plugins/packages/dev.yaqmc.example.night-1.0.0.yaqmc-plugin)           | 同一套铬框，冷色                            | 同样的样式 API。与 Sakura 冲突                                                |
| [歌词场景](../../examples/plugins/packages/dev.yaqmc.example.scenes-1.0.0.yaqmc-plugin)       | 歌词预设中增加 **Aurora** 与 **Vinyl glow** | Scene Schema + 全部 `data-scene-widget` / `data-scene-state`                  |
| [会话书签](../../examples/plugins/packages/dev.yaqmc.example.now-playing-1.0.0.yaqmc-plugin)  | 同一队列条目上恢复进度                      | 曲目/歌词/播放器/主题读取、五个事件、存储、日志、`player.seek`、`player.play` |
| [Studio](../../examples/plugins/packages/dev.yaqmc.example.studio-1.0.0.yaqmc-plugin)         | 铬框 + 两个场景 + 书签脚本                  | 样式 + 场景 + 脚本 + 全部 v1 权限                                             |
| [Ink core](../../examples/plugins/packages/dev.yaqmc.example.ink-core-1.0.0.yaqmc-plugin)     | 设置共享 `--yaqmc-*`                        | 仅样式变量                                                                    |
| [Ink accent](../../examples/plugins/packages/dev.yaqmc.example.ink-accent-1.0.0.yaqmc-plugin) | 把这些变量用到铬框                          | 样式选择器。**依赖 Ink core**                                                 |
| [只读目录](../../examples/plugins/packages/dev.yaqmc.example.catalog-1.0.0.yaqmc-plugin)      | 增加确定性的示例音乐平台                    | API v3 `provider.catalog`；无网络、账号、存储或 renderer 权限                 |
| [完整平台](../../examples/plugins/packages/dev.yaqmc.example.platform-1.0.0.yaqmc-plugin)     | 增加带可播放本地音频的确定性平台            | API v3 目录（含发现页）、播放、推荐、歌词、私有存储和隔离的合成账号           |

`player.pause`、`player.toggle`、`player.next`、`player.previous` 走同一条隔离桥和 PlayerService。示例**不会自动调用**它们，以免抢走队列。它们会调用 `seek` 和 `play`，因此书签恢复/继续播放是可以听见、看见的真实控制。

## 安装

1. 下载 `*.yaqmc-plugin`。
2. 打开 YAQMC → 设置 → 插件 → 选择文件。
3. 核对 SHA-256、权限和扫描结果。只有需要恢复进度时才批准 `player.control`。
4. 启用。样式立即生效。在歌词预设中选择插件场景。停用即恢复。

先启用 **Ink core** 再启用 **Ink accent**。Sakura 与 Night 不能同时启用。

v2 示例源码在 `examples/plugins/script-actions`（设置 + 右键/播放栏）和 `examples/plugins/script-network`
（仅 `https://example.com` 的宿主代理请求）。用 `npm run plugin:pack` 打包。Provider Component 源码位于
`examples/plugins/provider-catalog-rust` 和 `examples/plugins/provider-platform-rust`，同一个包可用于受支持的
Windows/Linux 架构且不含原生二进制。完整示例只使用 `accounts.example.com`，OAuth 回调由自动测试完成，并不连接真实账号。
它返回 Host 缓存配方，由 Core 消费不透明音源；媒体 URL/路径不会进入 renderer。敌对探测夹具仅用于自动测试，不要作为
用户插件启用。

## 未包含

插件市场、远程更新、原生模块、HTML 入口、任意 `fetch`、真实账号集成和已验证发行方声明。
