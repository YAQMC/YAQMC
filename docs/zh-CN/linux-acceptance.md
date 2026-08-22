# Linux 验收

> **简体中文** | [English](../linux-acceptance.md)

本协议只适用于当前已打包的 Electron AppImage。编译和打包通过不能证明
Linux 原生运行、合成器集成或多窗口行为。

## 测试包

使用 workflow 的扁平
`YAQMC-linux-x64-tester-<commit>` artifact，其中包含精确 AppImage、
`BUILD-IDENTITY.json`、`SHA256SUMS`、测试说明、采集器和验证器。
仓库 checkout 不能替代二进制身份。

从解压目录启动前执行：

```bash
sha256sum -c SHA256SUMS
node verify-lyrics-acceptance.mjs \
  --platform linux \
  --identity-only \
  --build-identity "$PWD/BUILD-IDENTITY.json"
```

## 必需模式

按顺序采集到同一个绝对路径 `YAQMC_ACCEPTANCE_ROOT`：

1. `auto`，不设置 YAQMC 图形 override；
2. `native-wayland`，必须报告 `display_backend="wayland-native"`；
3. `x11`，在 X11 会话可报告 `x11`，在 Wayland 会话可报告 `xwayland`；
4. 仅当前面的原生模式复现图形故障时才运行 `software`，并保留两份报告。

每次必需运行均按顺序记录：

1. `startup-idle`
2. `playback`
3. `seek-pause-resume`
4. `main-scroll-resize`
5. `lyrics-normal`
6. `lyrics-focus`
7. `lyrics-fullscreen`
8. `desktop-lyrics`
9. `island-lyrics`
10. `both-surfaces`
11. `shutdown`

全屏阶段用 `Esc` 退出，并确认之前的呈现状态和窗口几何恢复。两个悬浮歌词
窗口都要检查锁定后的直接解锁，以及托盘/设置恢复路径。另需记录托盘、
MPRIS、音频输出、显示器缩放/DPR 和所有可见渲染缺陷。

必需模式目录齐全后执行：

```bash
node verify-lyrics-acceptance.mjs \
  --platform linux \
  --root "$YAQMC_ACCEPTANCE_ROOT" \
  --build-identity "$PWD/BUILD-IDENTITY.json"
tar -C "$(dirname "$YAQMC_ACCEPTANCE_ROOT")" \
  -czf YAQMC-linux-acceptance.tar.gz \
  "$(basename "$YAQMC_ACCEPTANCE_ROOT")"
sha256sum YAQMC-linux-acceptance.tar.gz
```

QQ 音乐账号操作属于独立 LIVE 检查，必须使用获授权账号和已脱敏证据。
只有返回压缩包、摘要、精确安装包身份、环境和 verdict 均完成复核，最终验收
才关闭。采集器输出 `verification: pending` 不能算通过。
