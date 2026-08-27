# 开发环境

> **简体中文** | [English](../development.md)

YAQMC 包含三层构建：React renderer、Electron Main/preload 宿主，以及独立的
Rust Core 进程。原生开发会构建三层；浏览器开发固定使用确定性 fake provider。

## 必需工具链

- 精确使用 Node.js **26.7.0** 及其自带 npm；
- Rust **1.88.0 或更高版本**（CI 使用 1.88.0 验证 workspace）；
- Windows：MSVC 构建工具；
- Debian/Ubuntu：原生音频所需 ALSA 开发头；若生成全部 Linux 包格式，还需
  `rpm` 与 `fakeroot`。

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

生产提供器无条件链接公开 crate `qqmusic-api`：
`https://github.com/YAQMC/qm-api-rs.git`，精确 revision 为
`827233cb799bede84ee5033ec16450dc1d5e2587`。

桌面开发启动器为 Cargo 设置 `CARGO_NET_GIT_FETCH_WITH_CLI=true`。访问辅助脚本只核对 manifest pin
与可选的相邻 checkout，不修改 Git 配置：

```powershell
node scripts/ci/qm-api-rs-access.mjs --check
```

若存在相邻的 `../qm-api-rs` 检出，该命令还会要求其 HEAD 与生产 pin 完全一致。

## 完整桌面端运行

```powershell
npm ci
npm run dev:desktop
```

`dev:desktop` 会编译 debug `yaqmc-core`、暂存完整性清单、启动 Vite、监听
Electron Main/preload 并启动 Electron。它不是 QA profile，可能使用正常应用
数据目录。

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
```

被忽略的 Rust 测试可能连接真实服务或产生可听音频，不能在 CI 中运行，也不能
使用维护者未授权的账号/profile。Electron smoke、E2E、性能与验收必须使用仓库
QA sandbox 工具，禁止复用生产 profile。

继续阅读：[CI 与打包](ci.md)、[数据位置与卸载](data-locations.md)和
[整体架构](architecture.md)。
