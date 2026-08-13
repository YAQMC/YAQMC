# Linux 图形策略

> **简体中文** | [English](../linux-graphics.md)

Tauri 在 Linux 使用 WebKitGTK。React 调度、WebKitGTK/合成器、窗口后端和音频缓冲是不同故障域，日志
也分别记录。

## 默认策略

隐式默认 `YAQMC_LINUX_RENDERER=auto`，不设置加速变量；源码不强制 GTK 后端。最终 AppImage launcher：

1. 保留测试者显式设置的 `GDK_BACKEND`；
2. 否则当 `XDG_SESSION_TYPE=wayland` 且有 `WAYLAND_DISPLAY` 时选择 Wayland；
3. 其他情况选择 X11。

2026-08-10 Arch/Hyprland 基线报告 `wayland-native`。Linux 主窗口保持 opaque；平台 CSS 保留布局、transform、
颜色和歌词交互，同时减少高成本实时 backdrop blur、封面模糊、大阴影和未 contain 的歌词绘制。这是风险
控制，不是性能根因证明。

## 验收模式

| 模式             | 环境变化                 | 规则                     |
| ---------------- | ------------------------ | ------------------------ |
| `auto`           | 无 GTK/renderer override | 首先必跑                 |
| `native-wayland` | Wayland，清除 `DISPLAY`  | 必跑且必须报原生 Wayland |
| `x11`            | `GDK_BACKEND=x11`        | 必跑回退对照             |
| `software`       | 禁 DMABUF、软件 GL       | 仅复现原生 bug 后        |

软件模式需 `YAQMC_ALLOW_SOFTWARE=confirmed-native-failure`，必须保留翻译后的界面和定位 transform。

## 测量边界

新采集器按各操作阶段记录进程树、RSS/PSS（内核支持时）、CPU、线程、窗口状态、实际后端和图形环境。
这些仍是诊断，不是 frame-time benchmark。测试者还必须记录卡顿、空白帧、错误几何、全屏恢复、锁定/
解锁和音频中断；增加软件对照前先保留失败的原生报告。
