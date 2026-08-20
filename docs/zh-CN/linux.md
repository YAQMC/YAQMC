# Linux 运行与验收

> **简体中文** | [English](../linux.md)

## 当前证据边界

当前 Linux 宿主为 Electron/Chromium，打包目标包括 AppImage、`.deb`、`.rpm`
与 portable `.tar.gz`。保留的 2026-08-10 Arch/Hyprland 采集来自已退役桌面
宿主，只能作为机器/合成器历史背景，不能验证当前 Electron 二进制、UI、
托盘、播放或图形行为。

当前 Electron Linux GUI 验收仍开放，需测试者返回已验证 workflow artifact
报告。账本见 [Linux 验收证据](linux-acceptance.md)。

## 后端与图形策略

Electron Main 在启动前应用 `apps/desktop/main/linux-graphics.ts` 的
Chromium/Ozone 白名单策略。运行时诊断同时探测已应用的 Ozone 开关和实际
客户端 socket，不仅凭 session 环境变量猜测：

| 实际客户端/后端             | 报告值           |
| --------------------------- | ---------------- |
| 原生 Wayland                | `wayland-native` |
| Wayland 会话中的 X11 客户端 | `xwayland`       |
| X11 会话                    | `x11`            |
| 无可靠观测                  | `unavailable`    |

打包采集器使用 `auto`、`native-wayland`、`x11` 和条件式 `software`。
`native-wayland` 提供 `YAQMC_LINUX_RENDERER=native-wayland`，映射为
`--ozone-platform=wayland`；`software` 映射为 `--disable-gpu`。精确表格见
[Linux 图形策略](linux-graphics.md)。

## Arch 测试流程

只使用 GitHub Actions 解压后的 `YAQMC-linux-x86_64` artifact；仓库 checkout
既不需要，也不能作为二进制身份证据。在解压目录执行：

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

只有原生模式复现对应图形故障后才能增加：

```bash
YAQMC_ALLOW_SOFTWARE=confirmed-native-failure \
  ./collect-linux-diagnostics.sh "$PWD/$appimage" software
```

采集器依次提示启动空闲、播放、seek/暂停/恢复、主窗口滚动/缩放、歌词
Normal/Focus/全屏、桌面歌词、歌词岛、两窗同时和退出。用 `Esc` 退出全屏并
确认呈现/几何精确恢复；同时验证直接解锁与设置/托盘恢复。

三种必跑模式目录齐全后：

```bash
node verify-lyrics-acceptance.mjs --platform linux \
  --root "$YAQMC_ACCEPTANCE_ROOT" \
  --build-identity "$PWD/BUILD-IDENTITY.json"
tar -C "$(dirname "$YAQMC_ACCEPTANCE_ROOT")" \
  -czf YAQMC-linux-acceptance.tar.gz \
  "$(basename "$YAQMC_ACCEPTANCE_ROOT")"
sha256sum YAQMC-linux-acceptance.tar.gz
```

缺少 FUSE 时安装发行版的兼容包，或记录使用 AppImage
`--appimage-extract-and-run`。Windows 证据不能替代 Linux gate。

## 能力边界

Windows 与 Linux X11/XWayland 已实现主窗口、歌词窗口和托盘，但仍需真实
GUI 验收。X11/XWayland 的绝对定位、置顶和点击穿透依赖合成器；原生 Wayland
不承诺这些能力。原生 Wayland 禁用 X11 全局快捷键，媒体键由 MPRIS 处理。
辅助歌词 `BrowserWindow` 仅在启用时存在，禁用后关闭。

## Plugin Platform v2 与高级场景

Linux 与 Windows 共用 Chromium 渲染器、沙箱插件 Worker、作用域 Scene CSS
和 host 代理 HTTPS 边界。Linux CSS 会关闭部分高成本实时模糊；`gpu-off`
兼容模式停止场景视频解码但保留布局与交互。Plugin Manager、Color Field、
场景和 Worker 隔离需在已验证最终 AppImage 留下记录后才算 Linux GUI 验收。
