<p align="center">
  <img src="assets/yaqmc-logo.png" width="168" alt="YAQMC 标志">
</p>

<h1 align="center">YAQMC</h1>

<p align="center">
  <strong>Yet Another Q Music Client</strong><br>
  一个适用于 Windows 和 Linux 的非官方 QQ 音乐桌面客户端。
</p>

<p align="center">
  <strong>简体中文</strong> · <a href="README-EN.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/YAQMC/YAQMC/actions/workflows/build.yml"><img src="https://github.com/YAQMC/YAQMC/actions/workflows/build.yml/badge.svg" alt="构建状态"></a>
  <img src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white" alt="Tauri 2">
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=111" alt="React 19">
</p>

> [!IMPORTANT]
> YAQMC 与腾讯或 QQ 音乐没有从属或合作关系。项目不会绕过会员、地区限制或歌曲权限。对于服务端已按
> 当前账号权益下发 URL 与 ekey 的加密音频，YAQMC 只在本地内存中解密播放，不获取未授权内容。

## 先看这里

如果你只是想安装软件，不需要阅读整份文档。

1. 打开 [Releases](https://github.com/YAQMC/YAQMC/releases)。
2. 按照自己的系统和处理器下载对应安装包。
3. 安装后直接使用访客模式，或者在左下角登录 QQ 音乐账号。

当前版本仍是测试版。Windows 已完成本地原生验证；Linux 安装包由 GitHub Actions 构建，仍需在真实
Linux 桌面环境中继续验收。

### 我应该下载哪个文件？

Windows 用户：

- 大多数 Intel/AMD 电脑：选择名字中带 `windows-x86_64` 的 `.exe`。
- 32 位旧电脑：选择 `windows-i686`。
- Windows ARM 电脑：选择 `windows-aarch64`。
- 不想安装：选择对应架构的 `portable.zip`。

Linux 用户：

- 大多数 Intel/AMD 电脑：选择 `linux-x86_64` 的 AppImage。
- ARM64 电脑：选择 `linux-aarch64`。
- Debian、Ubuntu 可以使用 `.deb`；Fedora、openSUSE 等系统可以使用 `.rpm`。
- AppImage 不需要安装，添加可执行权限后即可运行。

`AMD64` 和 `x86_64` 是同一种架构。Windows 中常说的“x32”对应这里的 `x86` / `i686`。

## 它能做什么？

### 听歌

- 浏览 QQ 音乐首页、搜索结果、专辑和歌单。
- 使用原生音频引擎播放、暂停、拖动进度和管理队列。
- 根据访客或账号实际拥有的权限选择音质，不伪造会员能力。
- 可以在播放器右侧的音符菜单中临时切换当前歌曲音质；设置页仍负责之后歌曲的默认音质。
- 支持账号已获授权的 QQ Music `mflac` 流式解密、边下边播和随机拖动；磁盘缓存只保存密文。
- 支持媒体快捷键、系统媒体面板、托盘和可选的本地控制 API。

### 登录与账号

- 支持内嵌的 QQ 和微信官方 OAuth 登录页面。
- 显示 QQ 音乐昵称、头像和已确认的会员信息。
- 支持收藏、账号歌单和最近播放等账号页面。
- 登录凭据保存在操作系统安全存储中，不写入项目文件或普通配置文件。

### 歌词

- 支持逐行歌词、逐字歌词、翻译和罗马音。
- 支持全屏歌词、桌面歌词和顶部的 Lyrics Island。
- 桌面歌词与 Lyrics Island 锁定后，会在悬浮窗上保留一个独立的解锁按钮。
- 两句歌词之间或歌曲末尾没有新歌词时，会继续显示刚刚唱完的那一句。

### 外观

- 支持浅色、深色和跟随系统主题。
- 可以分别设置主色与副色，应用内标志会自动跟随这两种颜色。
- 托盘、任务栏和安装包使用固定的 YAQMC 原生标志。
- 支持自定义背景、字体和歌词样式。
- 可从[示例插件](docs/zh-CN/plugin-examples.md)安装本地 `*.yaqmc-plugin`（样式、歌词场景、隔离脚本）。默认不启用。

## 第一次使用

启动后会先以访客模式加载公开音乐目录。

需要账号内容时，点击左下角的用户区域，再选择 QQ 或微信登录。登录过程发生在受限制的腾讯页面
窗口中；YAQMC 不会读取你输入的密码。

登录成功后，左下角会显示 QQ 音乐昵称、头像和会员状态。如果网络暂时失败，应用不会擅自删除已经
保存在系统安全存储中的会话。

## 歌词锁定与解锁

锁定桌面歌词或 Lyrics Island 后，主歌词窗口会忽略鼠标点击，避免挡住桌面操作。

此时可以直接点击悬浮窗右上方的小解锁图标。设置页和系统托盘中的“解锁全部歌词窗口”仍然保留，
作为额外的恢复入口。

## 常见问题

### 为什么显示“音乐暂时不可用”？

先确认网络能够访问 QQ 音乐。访客目录和账号恢复是两条独立路径：即使没有登录，公开目录也应该
能够加载。如果持续失败，推荐通过 **设置 → 关于 → 报告问题** 打开内置的 Issue Reporter：
应用会自动预填技术信息，并可选生成脱敏诊断包 ZIP，你只需在浏览器里核对并提交 GitHub Issue。
详细流程见 [GitHub Issue 报告文档](docs/zh-CN/issue-reporting.md)。不要公开上传 Cookie 或账号凭据。

### 为什么登录后没有头像或昵称？

当前版本已经修复账号恢复状态不同步与 QQ 头像域名过滤问题。若旧进程仍显示“正在恢复”，请完全
退出旧版本后再启动新版；不需要手动清除安全存储。

### Linux Wayland 下为什么有些功能受限？

Wayland 不允许普通应用随意控制其他窗口。全局快捷键、悬浮窗定位和点击穿透能力会受到桌面环境与
合成器限制。X11 / XWayland 的兼容性通常更完整，具体说明见
[Linux 使用与测试指南](docs/zh-CN/linux.md)。

### AppImage 打不开怎么办？

```bash
chmod +x YAQMC*.AppImage
./YAQMC*.AppImage
```

如果仍然失败，请运行安装包附带的 `collect-linux-diagnostics.sh`，并将生成的压缩包交给开发者分析。

## 安全与隐私

- 账号命令只允许主窗口调用，歌词窗口没有账号权限。
- OAuth 窗口只允许经过审核的腾讯域名和回调地址。
- 跨域重定向会移除认证信息；写操作不会自动重试。
- 日志与诊断包在写入磁盘前就会脱敏 Cookie、token、签名 URL 与账号秘密；导出诊断包时还会
  再扫一次。详见 [安全与隐私](docs/zh-CN/security.md)。
- 报告问题走内置 Reporter，仅在浏览器打开预填的 GitHub Issue；YAQMC 不索要令牌，也不会自动
  提交（[GitHub Issue 报告](docs/zh-CN/issue-reporting.md)）。
- 本地 API 默认关闭，并且只绑定 `127.0.0.1`。

## 项目状态

访客目录、原生播放、歌词窗口、账号恢复、用户资料和登录后的首页目录已经有自动化测试与 Windows
本地验证。

QMC/MFLAC 解密与随机拖动已经通过外部样本验证。线上“臻品”取源仍以 QQ 音乐实际按当前账号权益
返回 URL 与 ekey 为前提；本项目不实现或伪造 QQ 音乐客户端的 VMP 签名，因此不把未完成的会员线上
取源验收写成已验证。

收藏与歌单写操作虽然已经实现，但在合适账号完成真实写入、回读和恢复测试之前，发布说明会继续把
这部分标为“等待账号所有者验收”。Linux 原生 Wayland 验收也仍然是待完成项。

<details>
<summary><strong>开发者：本地运行、构建与验证</strong></summary>

### 环境

- Node.js 24 与 npm
- Rust 1.88 或更高版本
- [Tauri 2 平台依赖](https://v2.tauri.app/start/prerequisites/)
- Windows：MSVC 构建工具与 WebView2 Runtime
- Debian / Ubuntu：`libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libasound2-dev`

### 运行

```powershell
npm ci
npm run tauri dev
```

浏览器开发模式使用确定性的假数据提供器；账号、安全存储、缓存和原生音频只存在于 Tauri 环境：

```powershell
npm run dev
```

### 构建

```powershell
# 只构建当前平台的可执行文件，不生成安装包
npm run tauri -- build --no-bundle

# Windows 安装包
npm run tauri -- build --bundles nsis,msi

# Linux 安装包
npm run tauri -- build --bundles appimage,deb,rpm
```

### 验证

release 配置的 `generate_context!` 要求 `dist/` 存在，直接运行 cargo 命令前请先执行一次
`npm run build`（或 `npm run check`）。

```powershell
npm run format:check
npm run check
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-targets
```

四个被忽略的 Rust 测试会连接真实服务或播放声音，只应在合适的测试环境中主动运行：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture
```

### 进一步阅读

- [中文文档总目录](docs/zh-CN/README.md)
- [架构](docs/zh-CN/architecture.md)
- [播放](docs/zh-CN/playback.md)
- [流式传输](docs/zh-CN/streaming.md)
- [平台集成](docs/zh-CN/platform-integration.md)
- [Linux 运行环境](docs/zh-CN/linux.md)
- [QQ 音乐提供器](docs/zh-CN/qqmusic-provider.md)
- [登录与安全存储](docs/zh-CN/authentication.md)
- [账号资料库](docs/zh-CN/account-library.md)
- [歌词窗口](docs/zh-CN/lyrics-surfaces.md)
- [歌词预设](docs/zh-CN/lyrics-presets.md)
- [插件平台](docs/zh-CN/plugin-platform.md)
- [示例插件下载](docs/zh-CN/plugin-examples.md)
- [歌词编排器](docs/zh-CN/lyrics-composer.md)
- [本地 API](docs/zh-CN/local-api.md)
- [日志系统](docs/zh-CN/logging.md)与[诊断快照与诊断包](docs/zh-CN/diagnostics.md)
- [CI、缓存与可下载产物](docs/zh-CN/ci.md)
- [GitHub Issue 报告](docs/zh-CN/issue-reporting.md)
- [第三方许可证](THIRD_PARTY_NOTICES.md)与[鸣谢](ACKNOWLEDGEMENTS.md)
- [官方客户端互操作证据](docs/zh-CN/qqmusic-official-interoperability.md)、
  [音质分类](docs/zh-CN/audio-quality.md)与[外部 URI 安全](docs/zh-CN/deep-link.md)

</details>

## 参与、支持与鸣谢

- [参与贡献](CONTRIBUTING.md)
- [问题与使用支持](SUPPORT.md)
- [安全策略](SECURITY.md)
- [社区行为准则](CODE_OF_CONDUCT.md)
- [更新记录](CHANGELOG.md)
- [鸣谢](ACKNOWLEDGEMENTS.md)与[第三方许可证](THIRD_PARTY_NOTICES.md)

特别感谢 Flechazo 提供 QMC/MFLAC、臻品音质与流式解密链路的公开研究思路，也感谢
OpenAI Codex / GPT-5.6 Sol 在工程实现、测试、审查、文档和发布流程中的协助。精确研究来源、许可证
边界和“未复制无许可证源码”的说明均集中在[鸣谢](ACKNOWLEDGEMENTS.md)与
[QQ 音乐提供器文档](docs/zh-CN/qqmusic-provider.md)。

> [!NOTE]
> YAQMC 采用 [GPL-3.0-or-later](LICENSE) 许可证；二进制发布的对应源码按
> [对应源代码交付政策](CORRESPONDING_SOURCE_POLICY.md)提供。
