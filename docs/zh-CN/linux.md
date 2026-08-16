# Linux 运行与验收

> **简体中文** | [English](../linux.md)

## 当前证据边界

x86_64 AppImage 由 GitHub Actions 在 Ubuntu 构建并最终重打包。2026-08-10 修复 session-aware launcher 后，
Arch/Hyprland 基线使用原生 Wayland 主窗口：

| 项目               | 观测值                                          |
| ------------------ | ----------------------------------------------- |
| 发行版 / 内核      | Arch rolling / `7.1.6-zen1-1-zen`               |
| 桌面 / 会话        | Hyprland / Wayland                              |
| YAQMC 实际窗口后端 | 从 raw window handle 得到 `wayland-native`      |
| GPU                | Intel Raptor Lake-S UHD + NVIDIA RTX 4060 Max-Q |
| 图形包             | GTK 3.24.52、Mesa 26.1.6、WebKitGTK 2.52.5      |

旧报告因为 AppImage launcher 强制 `GDK_BACKEND=x11` 而走 XWayland，只保留作历史对照。当前报告证明
启动、MPRIS/托盘初始化和音频后端，不证明最终二进制身份、真实播放性能、全屏恢复或歌词锁定/解锁。

## 后端策略

`platform_diagnostics` 读取实际 raw handle，不从 `XDG_SESSION_TYPE` 猜测：Wayland handle 报
`wayland-native`；Wayland 会话中的 Xlib/Xcb 报 `xwayland`；X11 会话报 `x11`。源码不强制
`WINIT_UNIX_BACKEND`、`DISPLAY` 或 `WAYLAND_DISPLAY`。重打包 launcher 优先显式 `GDK_BACKEND`，否则
Wayland 会话选择 Wayland，其余选择 X11。

| 模式             | 策略                                     | 用途                      |
| ---------------- | ---------------------------------------- | ------------------------- |
| `auto`           | 清除显式 GTK/renderer override，跟随会话 | 必跑第一项                |
| `native-wayland` | `GDK_BACKEND=wayland` 并清除 `DISPLAY`   | 原生对照，必须跑          |
| `x11`            | `GDK_BACKEND=x11`                        | X11/XWayland 对照，必须跑 |
| `software`       | 禁 DMABUF、软件 GL，不改几何             | 仅复现原生图形故障后      |

`baseline` 只是 `auto` 兼容别名，不等于 XWayland。软件模式必须设置
`YAQMC_ALLOW_SOFTWARE=confirmed-native-failure`，不能替代缺失的原生结果。

## Arch 测试流程

只使用 GitHub Actions 解压后的 `YAQMC-linux-x86_64` artifact，不需要仓库 checkout：

```bash
sha256sum -c SHA256SUMS
node verify-lyrics-acceptance.mjs --platform linux --identity-only \
  --build-identity "$PWD/BUILD-IDENTITY.json"
appimage="$(node -p "require('./BUILD-IDENTITY.json').appImage.fileName")"
chmod +x "$appimage" collect-linux-diagnostics.sh
export YAQMC_ACCEPTANCE_ROOT="$PWD/YAQMC-linux-acceptance"

./collect-linux-diagnostics.sh "$PWD/$appimage" auto
./collect-linux-diagnostics.sh "$PWD/$appimage" native-wayland
./collect-linux-diagnostics.sh "$PWD/$appimage" x11
```

只有原生模式出现相同图形故障后才能加：

```bash
YAQMC_ALLOW_SOFTWARE=confirmed-native-failure \
  ./collect-linux-diagnostics.sh "$PWD/$appimage" software
```

采集器按顺序提示启动空闲、播放、seek/暂停/恢复、主窗口滚动/缩放、歌词 Normal/Focus/原生全屏、桌面
歌词、歌词岛、两窗同时和退出。用 Escape 退出全屏并确认几何精确恢复；两个歌词窗都要验证悬浮解锁和
设置/托盘恢复。

```bash
node verify-lyrics-acceptance.mjs --platform linux \
  --root "$YAQMC_ACCEPTANCE_ROOT" \
  --build-identity "$PWD/BUILD-IDENTITY.json"
tar -C "$(dirname "$YAQMC_ACCEPTANCE_ROOT")" -czf YAQMC-linux-acceptance.tar.gz \
  "$(basename "$YAQMC_ACCEPTANCE_ROOT")"
sha256sum YAQMC-linux-acceptance.tar.gz
```

AppImage 缺 FUSE 时可安装 `fuse2` 或用 `--appimage-extract-and-run`，并记录偏差。详细证据见
[Linux 验收账本](linux-acceptance.md)，图形原理见 [Linux 图形策略](linux-graphics.md)。

## Plugin Platform v2 与高级场景

Linux 继续使用 WebKitGTK 4.1，本分支不改渲染器策略。插件 Worker、场景 CSS 和视频背景与 Windows 共用宿主，并加了
WebKitGTK 防护：

- 未激活歌词行的实时 `filter: blur()` 在 Linux 上关闭，避免大面积模糊被栅格化成黑块；
- 插件场景的 `blur` 控件覆盖在 Linux 上被忽略；
- `software` / `safe` 图形模式不解码场景视频，并仍尊重减弱动态效果；
- 脚本插件使用 blob Worker。CSP 包含 `worker-src 'self' blob:`；Worker 创建失败时插件标为 Failed，内置歌词保留；
- 场景 CSS 仍用 `@scope`。不支持时失败关闭（样式不生效），不会去改 Settings 或侧栏。

插件管理、声明式设置和宿主代理 HTTPS 会随 Linux 矩阵编译。在真实桌面留下记录之前，不宣称 Linux GUI 验收。
Color Field 使用径向渐变，而不是实时 backdrop-filter。
