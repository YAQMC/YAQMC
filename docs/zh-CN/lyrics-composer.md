# 歌词编排器

> **简体中文** | [English](../lyrics-composer.md)

歌词编排器编辑的就是沉浸歌词页使用的同一个 `LyricsScene`。预览画幅只改变画布尺寸，不会换成另一套
渲染器。

自定义 HTML / CSS / JavaScript、视频背景、预设市场和沙箱 Scene Engine 都是**后续**工作。这一轮是
Composer Lite：组件、吸附、检查器、撤销和保存。

## 共享场景

解析后的预设 schema v2 提供组件图（`background`、`artwork`、`metadata`、`lyrics`、`transport`），
使用 0–1 归一化坐标和九点锚点。运行时绑定 PlayerStore 与当前歌词文档；编辑器绑定隔离的预览 store。
手柄、参考线和检查器只在编辑器中出现。

字号公式在场景根上计算一次：

```text
fontBase = clamp(18px, 5.6cqh, 96px)
effectivePrimary = fontBase × fontScale
翻译 / 罗马音 = 主字号 × 0.42
```

`--lyrics-font-size` 按场景高度解析成像素写在场景根上，编排器拖动字号时预览立刻变。`.lyrics-line`
不再二次 clamp。经典 / 黑胶预览与运行时歌词页一样用封面铺满背景。

## 编辑

- 点击组件选中；点击画布留白（信箱边）取消选择。再次按下已选中组件会在超过位移阈值后拖动，不会取消选择。
  选中框本身就是拖动面；Follow 等运行时控件仍可点击。
- 选中框与手柄和场景共用同一套均匀缩放。黑胶选中框使用内接视觉正方形，唱片保持圆形。播放控件使用紧凑
  控制条尺寸，而不是旧三列播放条留下的通栏宽框。
- 字号只缩放**歌词文字**（70% 大约是 145% 的一半），不会缩小歌词视口红框，也不会改行距。行距使用
  场景相对的 `cqh` 间距，与 `fontScale` 无关。
- 编排器窗口占满大部分应用视口。场景使用单一均匀缩放，缩放不写入预设坐标。
- 选中后始终显示轮廓和缩放手柄。
- 拖动 / 缩放在 pointerup 时写入**一步**撤销。pointermove 不写 SQLite。
- 吸附到中轴、边距和兄弟边缘。Alt / Ctrl 可关闭吸附。
- 安全区参考线仅编辑器可见。
- 方向键微调；检查器填写精确值：位置、宽高、锚点、对齐、跟随锚点、标题/艺人缩放、封面样式/
  不透明度/圆角、背景适配/颜色/模糊/影响/不透明度，以及译文和罗马音可见性。
- 图层可改 z 序、锁定或隐藏。
- **重置组件** / **重置位置** 从该预设版式的工厂图恢复。

保存语义不变：内置可“应用到此预设 / 另存为新预设 / 取消”；自定义可保存并另存；复制等于带生成名称的
另存；重置只删除内置覆盖，工厂定义不可变。插件场景只读，使用「复制为我的场景」拷贝 schema，并记录
`forkedFromPluginId`；插件资源仍依赖原插件包。

## 预览数据

打开编排器立即绘制本地 G.E.M. 设计夹具（多远都要在一起 / G.E.M. 邓紫棋）。后台只读搜索可通过
`ArtworkResolver`（`large` / `fullscreen`）替换歌词与封面。失败则保留夹具并显示**离线预览**。
编排器不会写入收藏、歌单、历史或 PlayerStore 队列。

预设 JSON 不保存 G.E.M. 的标题、艺人、封面 URL 或歌词正文。

## 跟随当前行

跟随状态机在 `LyricsViewport` 中，编辑器预览与运行时共用：

- `active` 只在换行时回中，不因换词回中。
- 带位移的滚轮会暂停跟随。
- 单纯按下指针不会暂停跟随。
- **跟随当前行** 设为 `active` 并强制滚动，即使行号没变。

## 日志

只记录已提交事件：`lyrics.composer.open|drag|resize`、`lyrics.follow.resume|suspend|error`、
`lyrics.preview.hydrate|fallback`、`lyrics.preset.resolve|save`。不记录 pointermove 或逐词 tick。
