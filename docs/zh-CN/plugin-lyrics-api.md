# 歌词工具栏插件 API（API v4）

> **简体中文** | [English](../plugin-lyrics-api.md)

在 manifest v1 / API v4 清单中声明 `ui.lyrics`，即可向主歌词页面添加由宿主绘制的按钮。
窗口拖动区由 YAQMC 自带；窗口按钮按需安装插件提供。

```js
definePlugin({
  async activate(ctx) {
    await ctx.ui.lyrics.register({ id: 'minimize', label: '最小化', windowAction: 'minimize' });
    await ctx.ui.lyrics.register({ id: 'details', label: '歌曲信息', icon: 'info' });
    return ctx.events.on('ui.action', (event) => {
      if (event.slot === 'lyrics' && event.id === 'details') void ctx.log.info('点击了歌曲信息');
    });
  },
});
```

| 方法                             | 参数                                  | 返回值         |
| -------------------------------- | ------------------------------------- | -------------- |
| `ctx.ui.lyrics.register(action)` | `{ id, label, icon?, windowAction? }` | `{ ok: true }` |
| `ctx.ui.lyrics.unregister(id)`   | 动作 ID                               | `{ ok: true }` |

ID 格式为 `[A-Za-z0-9][A-Za-z0-9._-]{0,39}`。标签长度为 1–40 个 Unicode 码点，不能全为空白。
图标仅支持 `minus`、`maximize`、`close`、`settings`、`info`、`music`，不接受 URL 或 HTML。
`windowAction` 仅支持 `minimize`、`toggleMaximize`、`close`；关闭行为遵循应用现有的关闭/托盘设置。
省略图标时，窗口按钮使用对应操作图标，普通动作使用 `music`。

窗口操作仅在用户点击按钮后通过宿主窗口桥执行，注册本身不触发操作。插件不获得可调用的窗口桥或通用 IPC。
不支持 `windowControls` 的宿主隐藏窗口按钮，普通动作仍可使用。窗口按钮不额外发送 `ui.action`；
普通按钮仅向所属插件发送 `{ id, slot: 'lyrics' }`。按钮提示包含插件名称。

宿主将歌词布局切换按钮与内置窗口控件组成一组，默认透明，悬停或键盘聚焦时整组显示；仅支持触控的指针下保持可见。
内置控件可用时，插件的 `windowAction` 注册复用该组窗口控件，避免重复按钮；普通插件动作单独显示。
禁用插件会移除其贡献，宿主窗口控件仍可使用。

每个插件最多 4 个动作，全部插件共最多 12 个。重复注册同一 ID 会更新按钮；超过上限返回
`lyrics-action-limit`，参数无效返回 `invalid-lyrics-action`。Core 与 renderer 分别核验参数、命令和权限，
沿用已有桥调用频率与负载大小限制。注销只影响本插件的动作。禁用、失败、卸载、撤权或更新退役会清理按钮；
候选更新的按钮经过校验后才会显示。

按钮跟随歌词控制栏显示，并可通过键盘焦点操作。Electron 窗口模式歌词页顶部 40 像素保留不可见拖动区，
可见按钮排除在拖动区之外。全屏与 Android 不添加拖动区。

运行 `npm run plugin:example:sync` 会在仓库旁的 `YAQMC-plugin-example` 创建可直接复制的独立示例，
包含可用的窗口按钮插件、无第三方依赖的打包器、SDK 类型与离线 API 文档。另见
[插件开发](plugin-development.md)和[插件安全](plugin-security.md)。
