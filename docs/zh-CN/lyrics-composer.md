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

`--lyrics-font-size` 写在场景根上，`.lyrics-line` 不再二次 clamp。

## 编辑

- 点击组件选中，点击空白取消选择。
- 选中后始终显示轮廓和缩放手柄。
- 拖动 / 缩放在 pointerup 时写入**一步**撤销。pointermove 不写 SQLite。
- 吸附到中轴、边距和兄弟边缘。Alt / Ctrl 可关闭吸附。
- 安全区参考线仅编辑器可见。
- 方向键微调；检查器填写精确值。
- 图层可改 z 序、锁定或隐藏。
- **重置组件** / **重置位置** 从该预设版式的工厂图恢复。

保存语义不变：内置可“应用到此预设 / 另存为新预设 / 取消”；自定义可保存并另存；复制等于带生成名称的
另存；重置只删除内置覆盖，工厂定义不可变。

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
