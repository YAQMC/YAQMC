# Windows 验收

> **简体中文** | [English](../windows-acceptance.md)

> 仅作为迁移前历史证据保留，不验证当前 Electron host。

## 本机歌词 Checkpoint C

Checkpoint C 已在 `tauri-no-bundle` 原始 Windows 二进制通过。这只是本机视觉/交互检查：
`releasePass=false`、`releaseArtifact=null`，不能代替最终 NSIS 安装与卸载 checkpoint K。

忽略目录 `output/visual-acceptance/lyrics-focus-fullscreen/windows/` 保存证据；验证器接受完整目录，十张原生
客户端截图均人工检查为非空 YAQMC 内容、正确呈现/外观/crop 且没有桌面污染。

### 构建身份

| 字段               | 值                                                                 |
| ------------------ | ------------------------------------------------------------------ |
| 时间               | `2026-08-11T06:27:33.9230588Z`                                     |
| Git commit         | `e2854d316f3273b46eef7a5eef19df56a6e25975`                         |
| Git tree           | `c543c5cef94d2446cab762e282a569958e10bc33`                         |
| 类型               | `tauri-no-bundle`                                                  |
| exe SHA-256        | `bdddecd60c3c9d31e196872c724252bd834c941b3d891fd5bf85bf9e0aa002f2` |
| Windows / WebView2 | `10.0.26200.0` / `151.0.4129.72`                                   |
| 显示器 / DPR       | `DISPLAY1` / `1.5`                                                 |
| 提供器 / fixture   | `fake` / `quiet-light`                                             |

### 覆盖矩阵

W01–W09 覆盖 1280×800、1000×700、1000×1000 的 Normal/Focus/原生全屏，浅/深色，中/英文，默认、
封面、图片、颜色背景以及减少动画；S01 覆盖最小 1000×680 smoke。三组全屏都捕获 2560×1600 物理区域，
退出后逻辑和物理几何精确恢复。减少动画用例记录最大 transition、animation 和当前词 rAF 写入为 0。

真实 CDP 输入验证：手动滚动与 Follow、点击第 4 行 seek 到 74–89 秒、PlayerBar 暂停/恢复、Focus 宽度、
全屏 transport 的 2400ms 隐藏/指针显示/焦点固定、上下首 fixture 切换、Escape 逐层退出，以及翻译与罗马音。
独立外部 native API probe 验证主窗口 `true -> false` 全屏、store 协调和精确几何恢复。

## 复现

```powershell
npm run check
npm run stage-core
npm run build -w @yaqmc/desktop
npm run test:e2e:electron
npm run perf:windows-gpu
```

旧宿主专用采集器已退出支持。请单独记录 Electron 截图、窗口状态证据和被测 commit；本地未打包输出不得作为发布包分发。
