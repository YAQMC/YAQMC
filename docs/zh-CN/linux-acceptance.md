# Linux 验收证据

> **简体中文** | [English](../linux-acceptance.md)

本账本区分迁移前历史观测和仍需 Arch Linux 测试者执行的当前 Electron 最终 AppImage 验收。
采集完成只会生成 `verification: pending`，不能自行宣告通过。

## 2026-08-10 迁移前原生 Wayland 基线

| 字段     | 值                                                                 |
| -------- | ------------------------------------------------------------------ |
| 压缩包   | `YAQMC-linux-report-20260810T162727Z-baseline.zip`                 |
| 时间     | 2026-08-10 16:27:27 UTC                                            |
| SHA-256  | `FD8D672EA8A2D62E608B5BB1EA0AFCEAB489586E31B9454332CA38D08971DE00` |
| 系统     | Arch rolling / `7.1.6-zen1-1-zen`                                  |
| 桌面     | Hyprland / Wayland（`wayland-1`）                                  |
| 实际后端 | `wayland-native`                                                   |
| GPU      | Intel Raptor Lake-S UHD + NVIDIA RTX 4060 Max-Q                    |
| 音频     | Rodio/CPAL ALSA → PipeWire                                         |
| 时长     | 50.379 秒                                                          |

压缩包解压前验证过路径，无绝对路径、盘符、NUL 或 `..` 穿越；解压前后摘要一致。它只证明已退役宿主
当时创建了原生 Wayland 主窗并完成 MPRIS 2.2、托盘和音频初始化；不验证当前 Electron host。

它不证明旧 bundle 的精确 Git/工作流/最终 AppImage 身份，也没有分阶段记录播放、seek、性能、全屏几何
恢复或歌词锁定。旧报告的生命周期 CPU 与 RSS 不能当瞬时性能或唯一内存。

## 最终 AppImage 协议

使用 workflow 的扁平 `YAQMC-linux-x86_64` artifact，其中应包含最终 AppImage、`BUILD-IDENTITY.json`、
`SHA256SUMS`、测试说明、采集器和验证器。先执行 `sha256sum -c` 与 identity-only 验证，再依次采集：

1. `auto`，不设置 YAQMC 图形 override；
2. `native-wayland`，提供 `YAQMC_LINUX_RENDERER=native-wayland` 且必须报告 `wayland-native`；
3. `x11`，在 Wayland 会话可报告 `xwayland`；
4. 只有前面的原生图形故障才允许 `software`，并保留两份报告。

每次必须按顺序记录：`startup-idle`、`playback`、`seek-pause-resume`、`main-scroll-resize`、
`lyrics-normal`、`lyrics-focus`、`lyrics-fullscreen`、`desktop-lyrics`、`island-lyrics`、
`both-surfaces`、`shutdown`。

全屏用 Escape 退出并确认呈现层和窗口几何恢复。两个悬浮歌词窗都要先用窗口上的独立图标解锁，再锁定
并用托盘/设置恢复，证明方便路径与兜底路径都有效。Windows 软件模式不能替代任何 Linux 模式。

测试者需返回压缩包、SHA-256、发行版/内核、合成器、显示器、缩放/DPR、音频观测和可见缺陷。压缩包
完成校验并记录 verdict 后，最终验收才关闭。

Plugin API v2、Color Field、场景视频和插件 Worker 会随 Linux 编译，但在最终 AppImage 留下桌面记录之前，
不算已关闭的 Linux GUI 账本。
