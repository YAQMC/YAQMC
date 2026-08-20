# Linux 图形策略

> **简体中文** | [English](../linux-graphics.md)

Linux 桌面宿主为 Electron/Chromium。React 调度、Chromium/Ozone、合成器、
窗口后端选择和音频缓冲是不同故障域，诊断会分别记录。

## 启动策略

`apps/desktop/main/linux-graphics.ts` 是 YAQMC Chromium 图形开关的唯一
来源；Main 在 Electron ready 前应用白名单结果：

| 模式                | Chromium 开关                               | 策略                                                         |
| ------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| `auto` / 未知值     | 无                                          | 默认；使用 Chromium 平台选择并探测实际后端。                 |
| `native-wayland`    | `--ozone-platform=wayland`                  | 显式选择原生 Wayland。                                       |
| `x11`               | 无                                          | 默认 X11/XWayland 路径的验收别名；采集器会拒绝其他实际后端。 |
| `gpu-off`           | `--disable-gpu`                             | 显式故障排查模式。                                           |
| `software` / `safe` | `--disable-gpu`                             | `gpu-off` 的弃用兼容别名。                                   |
| `vaapi-on`          | `--enable-features=VaapiVideoDecodeLinuxGL` | 显式 VA-API 实验，默认关闭。                                 |

`YAQMC_LINUX_RENDERER` 仅作为打包验收工具的弃用 host 兼容输入保留。
Core 不设置也不解释渲染器环境变量；旧 GTK/WebKit 图形变量不定义当前
Electron 策略。

实际显示后端由已应用的 Ozone 开关和 `/proc/self/fd` 中观测到的客户端
socket 共同判断，不能只凭 `XDG_SESSION_TYPE`。诊断值为
`wayland-native`、`xwayland`、`x11` 或 `unavailable`。

## 验收模式

Linux 打包采集器保留四个稳定证据目录名：

| 采集模式         | host 输入                                   | 用途                         |
| ---------------- | ------------------------------------------- | ---------------------------- |
| `auto`           | 无 YAQMC 图形 override                      | 第一项必跑                   |
| `native-wayland` | `YAQMC_LINUX_RENDERER=native-wayland`       | 必须报告 `wayland-native`    |
| `x11`            | `YAQMC_LINUX_RENDERER=x11` 及采集器兼容提示 | 必须报告 `x11` 或 `xwayland` |
| `software`       | `YAQMC_LINUX_RENDERER=software`             | 仅原生图形故障后的条件对照   |

`baseline` 只是 `auto` 的别名。软件对照仍需
`YAQMC_ALLOW_SOFTWARE=confirmed-native-failure`，不能替代缺失的原生结果。

Linux CSS 保留布局、transform、颜色和歌词交互，同时减少高成本实时模糊
与大阴影。`software`/`safe` 兼容模式也不解码场景视频。这些源码控制只降低
风险，不构成合成器性能证明。

## 测量边界

采集器按阶段记录进程树、CPU、RSS/PSS（可用时）、线程、窗口状态、实际
后端和图形模式，覆盖启动、播放、seek/暂停/恢复、缩放、歌词、辅助窗口和
退出。这些是诊断而非 frame-time benchmark；测试者还必须单独记录卡顿、
空白帧、几何/全屏恢复、锁定/解锁和音频中断。
