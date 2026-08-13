# 桌面歌词与歌词岛

> **简体中文** | [English](../lyrics-surfaces.md)

主应用沉浸歌词是完整体验；桌面歌词和歌词岛是轻量 Tauri WebView。两者消费同一个 Rust
`LyricSurfaceProjection` 与 `LyricDocument`，不轮询本地 HTTP API，也不拥有独立播放时钟。

## 三个独立概念

- 可见性：`enabled` 决定窗口生命周期与显示；
- 交互：`interactive` 或 `passive-locked` 决定原生输入/激活行为；
- 呈现：歌词文字、背景和临时编辑控件。

不要重新引入互相打架的 `locked`、`clickThrough`、`focusable`、hover 用户状态。

## 锁定与解锁

interactive 窗口接收指针、可拖动并在 hover 显示编辑控件；桌面歌词还可 resize。锁定前原生管理器先
执行不可聚焦、忽略指针和不可缩放。解锁按正确顺序恢复指针、focusable 和 resize，但不抢主窗口焦点。

因为完整锁定窗口不能接收点击，右上方叠加独立 42×42 解锁 WebView。内容窗口仍完全点击穿透，只有该
小控件能输入；其 capability 只有 `lyrics_surface_unlock`，不能读取播放器、账号或偏好文档。设置页保留
单窗/全部解锁，托盘保留全局恢复。

交互改变由一个串行原生命令同时更新窗口策略与规范偏好，失败时 UI 回滚。普通偏好写入保留规范交互字段，
迟到的其他窗口事件不能重新锁住刚解锁的窗。歌曲/歌词/封面/暂停事件只更新内容，不聚焦或重建窗口。

## 呈现

桌面歌词默认透明。未锁定 idle 时只显示歌词和专用文字阴影；hover 才出现编辑底板、边框、拖动、锁定、
播放控制、设置和关闭。锁定时不渲染控制/拖动属性，独立解锁按钮仍在右上角。用户明确提高背景不透明度
时，呈现背景可在 idle/锁定保留。

歌词岛的实体背景是设计的一部分。interactive hover 可展开曲目信息、下一行、控制和进度；锁定后保持
折叠、不响应 hover、无控制且点击穿透，歌词继续更新，独立解锁仍可达。没有下一句时保留刚唱完的当前行，
不显示误导性的“等待同步歌词”。

## 全屏、几何与平台限制

Windows 每 800ms 检查前台全屏；临时隐藏不会改交互状态，恢复锁定窗口前先重新应用 passive 策略。Linux
无法可靠判断时返回 unknown，不永久隐藏。位置/大小 350ms debounce 后写 SQLite；允许负物理坐标，但
恢复时至少与当前工作区重叠 80×40，否则用安全默认值。

Windows 支持两种表面及点击穿透、topmost、透明、多屏几何。Linux 共用状态/Tauri API，但 X11/Wayland
合成器的精确点击穿透、置顶、透明与焦点行为仍需真机验收。

旧的 taskbar-adjacent `lyrics-taskbar` 已完整移除。未来任务栏歌词不得使用 Explorer 注入、shell hook 或
未文档化修改。
