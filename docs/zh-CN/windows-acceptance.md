# Windows 验收

> **简体中文** | [English](../windows-acceptance.md)

本协议只适用于当前已打包的 Electron 宿主。构建或 E2E 通过是前置证据，
不能代替 Windows 安装包的真实运行验收。

## 安装包身份

使用 CI 生成的精确
`YAQMC-electron-windows-<arch>-<commit>` artifact。启动前：

1. 核对 artifact 目录名及 `build-info-windows-<arch>.json` 中的
   40 位 commit、Rust target、打包 profile 与架构；
2. 按 `SHA256SUMS-electron-windows-<arch>.txt` 核验安装包和
   portable 可执行文件；
3. 随验收记录保存 build-info、校验和、Windows 版本、显示器布局和 verdict。

不能通过重命名伪造其他架构；本地 unpacked 输出不是发布证据。

## 自动化前置

在被测 commit 上用仓库钉定的 Node.js 与 Rust 工具链通过：

```powershell
npm run check
npm run stage-core
npm run build -w @yaqmc/desktop
npm run test:e2e:electron
```

命令结果应单独记录，不能据此自动把人工项目写成已验证。

## 人工安装包协议

使用一次性 Windows 账号或明确隔离的 QA profile。除非维护者明确把生产
profile 和真实账号放入范围，否则不得复用。

NSIS 与 portable 两种形态都要检查：

- 冷启动、单实例、关闭到托盘、托盘恢复与干净退出；
- 主窗口缩放、最大化、Focus、原生全屏及精确几何恢复；
- 桌面歌词和歌词岛的显示/隐藏、拖动、锁定、直接解锁及托盘/设置恢复；
- 暂停/继续、seek、上下首、队列连续性、输出设备与 Windows 媒体控制；
- 主题、语言、减少动画、翻译和罗马音；
- 诊断导出，并确认日志不含凭据或签名媒体 URL；
- 覆盖升级、卸载、portable 隔离和文档声明的数据保留行为。

QQ 音乐登录、播放、账号读取和账号写操作属于独立 LIVE 检查，只能使用
获授权测试账号和已脱敏证据。

只有安装包身份、自动化前置、所有适用人工项目、失败、豁免和精确环境均已
记录，Windows verdict 才完整。缺少证据必须写 `pending`，不能写 `pass`。
