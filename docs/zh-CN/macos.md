# macOS

> **简体中文** | [English](../macos.md)

YAQMC 从与 Windows、Linux 相同的提交构建 **Apple 芯片（arm64）** 与 **Intel（x64）** 的 macOS 安装包。需要 macOS 12
Monterey 或更高版本（Electron 43 的最低要求）。不提供通用（universal）包：Apple 芯片请下载 `YAQMC-macos-arm64.dmg`，
Intel Mac 请下载 `YAQMC-macos-x64.dmg`。每个架构另有内容相同的 `.zip`。

## 安装与 Gatekeeper

Gatekeeper 的表现取决于发布时的构建模式，发布说明会写明本次使用的模式：

| 发布模式                    | 签名                                        | 首次打开                                                              |
| --------------------------- | ------------------------------------------- | --------------------------------------------------------------------- |
| 默认（无 Apple 开发者账号） | 临时（ad-hoc）签名，未启用强化运行时        | 首次会被阻止。请打开 **系统设置 → 隐私与安全性**，选择 **仍要打开**。 |
| 启用签名（见下文）          | Developer ID 签名、强化运行时、已公证并装订 | 仅出现常规的下载提示，可正常打开。                                    |

临时签名不代表发布者身份，只是因为 Apple 芯片拒绝运行完全未签名的代码。打开临时签名版本前，请核对公布的 SHA-256 校验值。

## 数据位置

| 用途       | 路径                                              |
| ---------- | ------------------------------------------------- |
| 数据与配置 | `~/Library/Application Support/org.yaqmc.desktop` |
| 缓存       | `~/Library/Caches/org.yaqmc.desktop`              |
| 日志       | `~/Library/Logs/org.yaqmc.desktop`                |
| 凭据       | macOS 钥匙串，服务命名空间 `org.yaqmc.desktop`    |

macOS 上不读取 XDG 变量。其他平台见[数据位置](data-locations.md)。

## 平台行为

- 窗口使用系统原生的红绿灯按钮（隐藏式标题栏），不显示 YAQMC 自绘的窗口控制按钮。顶部栏和侧栏上方区域可拖动窗口。
- 菜单栏（托盘）图标会缩放到菜单栏尺寸；点击 Dock 图标可显示被“关闭到托盘”隐藏的窗口。
- 音频由 Core 进程通过 CoreAudio 播放；凭据保存在钥匙串中。

## 已知限制

- **不支持应用内更新。** macOS 安装包会向更新器报告 `unsupported-package`，请下载新版本。原地更新需要已签名的应用以及尚未实现的 macOS 专用替换流程。
- **尚未接入“正在播放”与媒体键。** Core 的系统媒体适配仅覆盖 MPRIS（Linux）与 SMTC（Windows）；macOS 的
  `MPNowPlayingInfoCenter` 需要 `NSApplication` 运行循环，而无界面的 Core 进程没有。
- **媒体键全局快捷键**可能需要在系统设置中为 YAQMC 授予“辅助功能”权限。
- 桌面歌词与歌词岛使用与其他平台相同的 Electron 窗口 API，但其鼠标穿透与置顶行为**尚未在 macOS 实机上验证**。

## 本地构建

在已安装 Xcode 命令行工具、Node.js 26.7.0 与 Rust 1.88 的 Mac 上：

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm ci
node scripts/ci/package-electron.mjs --os macos --arch arm64 --target aarch64-apple-darwin
```

Intel 安装包使用 `--arch x64 --target x86_64-apple-darwin`，可在 Apple 芯片上交叉编译。不传 `--require-signing true`
时，脚本生成临时签名、关闭强化运行时与公证的应用，与默认发布模式一致。可用以下命令验证产物：

```sh
node scripts/ci/verify-macos-package.mjs --dir release-electron/YAQMC-electron-macos-arm64 --arch arm64 --signed false
```

## 发布签名与公证（维护者）

签名为可选项，使项目在没有 Apple 开发者账号时仍能发布。启用方法：

1. 将仓库变量 `YAQMC_MACOS_SIGNING` 设为 `true`。
2. 在受保护的 `release-signing` 环境中添加以下 Secret：

   | Secret                    | 内容                                                                    |
   | ------------------------- | ----------------------------------------------------------------------- |
   | `MAC_CSC_LINK`            | **Developer ID Application** 证书 `.p12` 的 Base64                      |
   | `MAC_CSC_KEY_PASSWORD`    | 该 `.p12` 的密码                                                        |
   | `APPLE_API_KEY_P8_BASE64` | 具备公证权限的 App Store Connect API 密钥（`AuthKey_XXXX.p8`）的 Base64 |
   | `APPLE_API_KEY_ID`        | 该密钥的 ID                                                             |
   | `APPLE_API_ISSUER`        | App Store Connect 团队的 Issuer ID                                      |

启用后，若缺少任一项，`release-preflight.mjs` 会直接使发布失败，绝不会静默退回临时签名。打包任务会叠加
`electron-builder.release.yml`（启用 `forceCodeSigning`、强化运行时与 `notarize: true`）。随后
`verify-macos-package.mjs` 要求带 Team ID 的 Developer ID 签名、强化运行时、`spctl` 评估通过以及已装订的公证票据。

授权（entitlements）刻意保持最小，位于 `apps/desktop/resources/macos/`：

- 应用本身仅有 `com.apple.security.cs.allow-jit`（V8 需要）；
- 嵌套可执行文件另有 `com.apple.security.cs.allow-unsigned-executable-memory`，因为 Core 中的 Wasmtime 会在运行时编译插件 WebAssembly。

不申请麦克风、摄像头、Apple Events 或关闭库验证等权限。

CI 使用 Intel runner 绕开 ARM runner 容量故障，arm64 安装包通过交叉编译生成。
这条路径不提供 Apple 芯片原生运行验证。

## 验证状态

在 `ac461dd`，[Build artifacts 运行 41862322797](https://github.com/YAQMC/YAQMC/actions/runs/41862322797)
已完成 macOS 两种架构的打包与签名校验。x64 任务因 GitHub 未分配 runner 失败后重跑通过。
[macOS Core 任务](https://github.com/YAQMC/YAQMC/actions/runs/41862299187/job/127046601224)
通过 arm64 编译检查、387 项 x64 Core 测试和 5 项更新助手测试。

独立下载核验确认 arm64 ZIP 内的 17 个 Mach-O 二进制均为 arm64；DMG 内的主程序、Electron 框架、Core
和更新助手与 ZIP 内对应文件逐字节一致。Intel runner 表示构建宿主架构，不代表安装包架构。

| 项目                                                              | 状态                                    |
| ----------------------------------------------------------------- | --------------------------------------- |
| electron-builder 配置与授权文件                                   | 两种架构均已在 macOS 打包并通过签名校验 |
| CI：`macos-15-intel` 上的 x64 Core 构建与单元测试、arm64 交叉检查 | `ac461dd` 已通过                        |
| 临时签名安装包的构建与验证                                        | `ac461dd` 的 arm64 与 x64 均已通过      |
| Developer ID 签名与公证                                           | **未测试**——需要 Apple 凭据             |
| macOS 实机运行（音频、钥匙串、悬浮窗）                            | **未验证**                              |
