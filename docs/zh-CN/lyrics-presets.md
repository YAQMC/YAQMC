# 歌词预设

> **简体中文** | [English](../lyrics-presets.md)

歌词预设是沉浸歌词页与[歌词编排器](lyrics-composer.md)共用的版式 + 字体契约，不是完整 Scene Engine。

自定义 HTML / CSS / JavaScript **未实现**。视频背景和预设市场是**后续**工作。

## 内置预设

稳定 ID 标识预设，本地化名称只用于显示。schema v2 为每种内置版式保存工厂组件图。

| ID                  | 版式           | 封面渲染 | 默认图片适应 |
| ------------------- | -------------- | -------- | ------------ |
| `builtin.classic`   | 封面与歌词分栏 | 方图     | 覆盖填满     |
| `builtin.immersive` | 沉浸歌词       | 方图     | 覆盖填满     |
| `builtin.vinyl`     | 黑胶唱片       | 黑胶     | 覆盖填满     |

沉浸歌词默认覆盖填满。已有的完整显示偏好会在首次迁移时保留，不会被静默改写。

v1 文档（只有 `layout: split|full|vinyl`）会迁移进这些工厂图。畸形 layout 回退到该 id 的工厂图，并记录
`lyrics.preset.layout.malformed`。

## 用户覆盖与自定义预设

- **内置源** — 随 YAQMC 发布的不可变定义。
- **用户覆盖** — 针对同一内置 ID 的可选补丁。
- **自定义预设** — 独立的 `custom.<uuid>` 预设。

保存提供：应用到此预设、另存为新预设（可填名称）、恢复内置默认。草稿不会改写工厂内置。拖动过程不写
SQLite。

## 字体

- **歌词字号**（`fontScale`，0.70–1.45，默认 1.00）
- **歌词行距**（`lineHeight`，1.05–1.60，默认 1.16）

编辑器画布和运行时场景共用同一公式：

```text
fontBase = clamp(18px, 5.6cqh, 96px)
effectivePrimary = fontBase × fontScale
```

70% 与 145% 必须明显不同。翻译/罗马音从主字号按比例缩放。字号只改字形大小；行距改的是场景相对的
行间空隙（`cqh`），不会跟着字号用 `em` 放大。

## 组件图

归一化 0–1 场景坐标，不是编辑器像素。组件种类：`background`、`artwork`、`metadata`、`lyrics`、
`transport`。绑定是数据，而不是写死的示例字符串。

## 预览夹具

打开编排器先绘制项目自有的本地示例（一起听见 / YAQMC Studio），再尝试只读提供器搜索 +
`ArtworkResolver`。失败则保留夹具并显示离线预览。不会写入播放队列、收藏、歌单或历史。

预览画幅：**桌面 16:9** 与 **当前窗口**。

## 覆盖填满与完整显示

覆盖填满可能裁切边缘；完整显示可能留边。留边使用预设回退色（默认 `#20231C`），不是渲染器裸黑。
外观中的图片适应仍控制应用外壳；歌词舞台使用当前预设的 `background.fit`。

## 持久化

```text
lyricsPresets.schemaVersion = 2
lyricsPresets.selectedId
lyricsPresets.overrides
lyricsPresets.custom
```

偏好文档版本仍为 `2`。嵌套预设 schema 独立版本化。

## 诊断与日志

快照只包含紧凑 `lyricsPreset`：`id, kind, schemaVersion, rendererVersion`。不转储完整 JSON。

已提交日志：`lyrics.preset.*`、`lyrics.composer.open|drag|resize`、`lyrics.follow.resume|suspend`、
`lyrics.preview.hydrate|fallback`。不记录滑条拖动或逐词 tick。

## 后续 Scene Engine

后续可能增加 HTML/CSS 编写、可选沙箱 JavaScript、视频背景和预设市场。本轮均未提供。
