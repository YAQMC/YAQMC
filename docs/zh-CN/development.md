# 开发环境

> **简体中文** | [English](../development.md)

YAQMC 由共享的 React renderer、Rust Core 和两个原生宿主组成。Electron 使用
Main/preload 与受监管的 Core 子进程；Android 通过 JNI 在 Capacitor 宿主中嵌入
Core。浏览器开发固定使用确定性 fake provider。

## 必需工具链

- 精确使用 Node.js **26.7.0** 及其自带 npm；
- Rust **1.88.0 或更高版本**（CI 使用 1.88.0 验证 workspace）；
- Windows：MSVC 构建工具；
- Debian/Ubuntu：原生音频所需 ALSA 开发头；若生成全部 Linux 包格式，还需
  `rpm` 与 `fakeroot`。
- Android：JDK 21、Android SDK/Build Tools 36、NDK 28.2.13676358 和
  cargo-ndk 4.1.2；推荐 Android Studio 2025.2.1 或更高版本。

Node 版本同时钉在 `package.json`、`package-lock.json` 与 `.node-version`。
解释 JavaScript/TypeScript 失败前先检查 `node --version`。

## 公开检出

React renderer 与确定性 fake provider 不会构建原生生产依赖：

```powershell
npm ci
npm run dev
```

该模式可用于界面、状态管理、本地化和组件开发；它有意不提供原生音频、keyring、磁盘缓存、托盘、
系统媒体会话或真实 QQ 音乐传输。

## 原生提供器 pin

提供器 manifest 无条件声明 crate `qqmusic-api`：
`https://github.com/YAQMC/qm-api-rs.git`，精确 revision 为
`bab630d44901f80cae47dd0f09314950d0028e23`。

桌面开发启动器为 Cargo 设置 `CARGO_NET_GIT_FETCH_WITH_CLI=true`。访问辅助脚本只核对 manifest pin
与可选的相邻 checkout，不修改 Git 配置：

```powershell
node scripts/ci/qm-api-rs-access.mjs --check
```

若存在相邻的 `../qm-api-rs` 检出，该命令还会要求其 HEAD 与生产 pin 完全一致。

### 可选的本地协议开发

库的 `main` 分支包含上文的生产固定提交。使用相邻开发检出时，可选择使用已被 Git 忽略的项目级 `.cargo/config.toml`：

```toml
[patch."https://github.com/YAQMC/qm-api-rs.git"]
qqmusic-api = { path = "../qm-api-rs" }
```

相邻库检出应保持在记录的提交。普通 Cargo 命令会自动使用它，包括 `cargo build -p yaqmc-core --release --locked --offline`，无需额外 `--config` 参数或全局配置。其他检出可直接获取固定的 Git 提交，无需相邻库覆盖。本地覆盖不代替发布时的 Git 来源校验与精确版本浸泡测试。

## 完整桌面端运行

```powershell
npm ci --include=dev --workspaces --include-workspace-root
npm run dev:desktop
```

拉取依赖变更后，在仓库根目录执行上述命令。桌面开发同时需要根目录的工具（`vite`）与
桌面 workspace 的工具（`esbuild`、`electron`），且必须包含 `devDependencies`。
只安装生产依赖或单个 workspace 不足以启动桌面开发。若提示缺少工具，重新执行上面的锁定安装，
不要通过逐个添加依赖来修改清单。

`dev:desktop` 会编译 debug `yaqmc-core`、暂存完整性清单、启动 Vite、监听
Electron Main/preload 并启动 Electron。它不是 QA profile，可能使用正常应用
数据目录。
启动器会在编译 Core 前检查开发工具，并在监听构建的进程退出时停止其它进程。

## 接近发布配置的本机构建

调用 electron-builder 前必须先构建并暂存 Core：

```powershell
npm ci
cargo build -p yaqmc-core --release --locked
npm run stage-core -- --profile release
npm run ci:frontend-build
npm run build -w @yaqmc/desktop
npm run package -w @yaqmc/desktop -- --publish never
```

这只生成当前主机架构。跨架构包必须使用对应 Rust target 与 CI 打包矩阵；修改
文件名不会改变二进制架构。本机构建必须始终保留 `--publish never`。

## Android 构建

Android debug 构建同时包含 ARM64 和 x86_64 模拟器库；公开的 Release APK
仅包含 ARM64。

```powershell
npm ci
npm run android:check
npm run android:build:debug
```

Release 签名只通过 CI 的 `release-signing` Environment 注入。本地 Release
构建也必须使用同样的四个 `ANDROID_RELEASE_*` 环境变量，禁止将其写入受 Git
跟踪的 Gradle 文件。详见 [Android 指南](android.md)。

## 验证

```powershell
npm run provider:enforce
npm run provenance:enforce
npm run format:check
npm run docs:check
npm run lint
npm run typecheck
npm test
npm run ci:test-scripts
npm run ci:verify-workspace
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --all-targets --locked
npm run contracts:check
npm run android:check
```

被忽略的 Rust 测试可能连接真实服务或产生可听音频，不能在 CI 中运行，也不能
使用维护者未授权的账号/profile。Electron smoke、E2E、性能与验收必须使用仓库
QA sandbox 工具，禁止复用生产 profile。

继续阅读：[CI 与打包](ci.md)、[数据位置与卸载](data-locations.md)和
[整体架构](architecture.md)。
