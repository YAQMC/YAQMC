# 插件场景 API

> **简体中文** | [English](../plugin-scene-api.md)

插件歌词页是 **Scene Schema + CSS + 可选脚本**，没有 HTML 场景文档。场景注册进现有的 LyricsPreset / LyricsScene /
Composer 运行时，不会再做一套歌词渲染器。

启用时，每个 `entrypoints.scenes` JSON 注册为 `plugin:<pluginId>:<sceneId>`。选择器显示场景名和“由某插件提供”。偏好
只保存引用，不会把场景复制进 `custom[]` 伪装成内置预设。

停用/卸载会注销场景。若当前选中的场景消失，回退到 `builtin.classic`。

场景 JSON 使用共享歌词场景定义（`schemaVersion` 2）：`id`、`name`、`layout`，以及可选控件图。缺失字段按该 layout 的
工厂值补齐。v1 不允许用编排器编辑插件场景，但仍可选择它们。

场景 CSS 使用 `@scope ([data-yaqmc-plugin-scene="<pluginId>/<sceneId>"])` 限定范围。不要用场景入口改整个应用；那需要样式入口。

稳定选择器：`[data-scene-widget]`、`[data-scene-widget-id]`、`[data-scene-widget-type]`、`[data-scene-state]`、
`[data-playback-state]`。稳定变量：`--scene-progress`、`--scene-duration`、`--scene-artwork-primary`、
`--scene-artwork-secondary`、`--scene-accent`、`--scene-font-scale`。

`data-widget` 仍是编辑器内部钩子，插件应优先使用 `data-scene-widget`。

场景文档仍是 schema v2。额外控件（text / image / video）、Color Field、渐变/视频背景为增量能力。现有 Classic /
Immersive / Vinyl / 用户自定义 / 插件 v1 场景继续加载。插件场景在编排器中只读，请使用「复制为我的场景」。
