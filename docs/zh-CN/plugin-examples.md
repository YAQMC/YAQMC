# 示例插件

> **简体中文** | [English](../plugin-examples.md)

这些是**未签名的本地示例**，不是 YAQMC 内置功能，默认不启用。在 设置 → 插件 → 选择文件 中安装。没有插件市场。

源码在 `examples/plugins/`。已打包的 `*.yaqmc-plugin` 在
[`examples/plugins/packages/`](../../examples/plugins/packages/)。可用 `npm run plugins:pack` 重新打包。

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

`player.pause`、`player.toggle`、`player.next`、`player.previous` 走同一条隔离桥和 PlayerService。示例**不会自动调用**它们，以免抢走队列。它们会调用 `seek` 和 `play`，因此书签恢复/继续播放是可以听见、看见的真实控制。

## 安装

1. 下载 `*.yaqmc-plugin`。
2. 打开 YAQMC → 设置 → 插件 → 选择文件。
3. 核对 SHA-256、权限和扫描结果。只有需要恢复进度时才批准 `player.control`。
4. 启用。样式立即生效。在歌词预设中选择插件场景。停用即恢复。

先启用 **Ink core** 再启用 **Ink accent**。Sakura 与 Night 不能同时启用。

## v1 未包含

网络、文件系统、凭据、原生模块、HTML 入口、插件市场。
