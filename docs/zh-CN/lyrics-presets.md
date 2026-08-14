# 歌词预设

> **简体中文** | [English](../lyrics-presets.md)

本迭代引入 **歌词预设** 基础，不是完整 Scene Engine。用户从现有三种歌词版式出发，
自定义歌词字体与行距，且不会破坏随应用分发的内置定义。

自定义 HTML / CSS / JavaScript 执行 **尚未实现**。

## 内置预设

稳定 ID 才是标识；本地化名称只用于显示。

| ID                  | 版式           | 封面 | 默认图片适应 |
| ------------------- | -------------- | ---- | ------------ |
| `builtin.classic`   | 封面与歌词分栏 | 方形 | 覆盖填满     |
| `builtin.immersive` | 沉浸歌词       | 方形 | 覆盖填满     |
| `builtin.vinyl`     | 黑胶唱片       | 黑胶 | 覆盖填满     |

沉浸歌词默认使用覆盖填满，以铺满可视区域。用户已经选择的“完整显示”会在首次迁移时保留，不会被静默覆盖。

## 覆盖与自定义

- **内置源**：随 YAQMC 分发的不可变定义。
- **用户覆盖**：保存在同一内置 ID 上的可选补丁。
- **自定义预设**：独立预设，ID 形如 `custom.<uuid>`。

保存时可以：

- **应用到此预设**：写入覆盖（或更新自定义预设）。
- **另存为新预设**：把当前草稿复制为新的自定义 ID。
- **恢复内置默认**：删除该内置槽位的覆盖。自定义预设保留。

## 字体

第一批可编辑控件：

- **歌词字号**（`fontScale`，0.70–1.45，默认 1.00）
- **歌词行距**（`lineHeight`，1.05–1.60，默认 1.16）

编辑器通过内存中的 CSS 变量即时预览；只有保存才会持久化。翻译和罗马音使用同一缩放。
字号变化不会重新解析 QRC。

## 预览曲目

编辑器使用本地设计夹具，不使用真实播放队列：

- 曲名：多远都要在一起
- 歌手：G.E.M. 邓紫棋
- 封面：`/artwork/gem-together.svg`（几何替代图，不是官方专辑封面）
- 带词级时间、翻译和罗马音的歌词行

播放 / 暂停 / 跳转驱动隔离预览时间轴。打开编辑器不会替换 PlayerService 队列、收藏、歌单或账号历史。打开编辑器不需要网络请求。

预览画幅：**桌面 16:9** 与 **当前窗口**。超宽仅在类型中预留。

## 覆盖填满与完整显示

覆盖填满会铺满目标区域，可能裁切边缘。完整显示会保留整张图片，可能留边。留边是预期行为。
未覆盖区域使用预设回退色（默认 `#20231C`），而不是 WebView 的裸黑色。

外观中的图片适应仍控制应用外壳。歌词舞台使用当前预设的 `background.fit`。

## 持久化

预设状态保存在现有 Settings / SQLite 偏好文档中：

```text
lyricsPresets.schemaVersion = 1
lyricsPresets.selectedId
lyricsPresets.overrides
lyricsPresets.custom
```

偏好文档版本仍为 `2`。预设 schema 独立版本化，便于以后迁到 Scene Engine，而不把每个属性摊进单行设置。

## 诊断与日志

快照可包含紧凑的 `lyricsPreset`：

```text
id、kind（built-in | custom）、schemaVersion
```

默认不导出完整预设 JSON，也不暴露本地资源路径。

已提交的日志 target：

```text
lyrics.preset.select
lyrics.preset.edit
lyrics.preset.save
lyrics.preset.reset
lyrics.preview.play
lyrics.preview.error
```

滑块拖动不会记日志。

## 后续 Scene Engine

以后可能扩展为：

- 可拖拽组件与任意布局
- 图片 / 视频背景与 Color Field
- 自定义 HTML / CSS
- 可选的沙箱 JavaScript

这些都尚未实现。
