# 参与贡献

> **简体中文** | [English](CONTRIBUTING-EN.md)

感谢你帮助改进 YAQMC。提交前请先搜索现有 Issue 和 Pull Request，避免重复工作。小型修复可以直接提交；
大范围架构、兼容协议、账号写操作或 UI 重构请先开 Issue 说明边界和验收方法。

## 开发环境

- Node.js 24 与 npm；
- Rust 1.88 或更高版本；
- [Tauri 2 平台依赖](https://v2.tauri.app/start/prerequisites/)；
- Windows 使用 MSVC/WebView2；Linux 使用 WebKitGTK 4.1、AppIndicator、ALSA 等构建依赖。

```powershell
npm ci
npm run tauri dev
```

浏览器开发使用确定性 fake provider：

```powershell
npm run dev
```

## 提交流程

1. 从 `main` 创建短生命周期分支。
2. 保持改动聚焦，不混入生成物、账号数据、诊断压缩包或无关格式化。
3. 行为修改需补可复现测试；修复竞态时应先有能稳定失败的回归用例。
4. 更新对应中文与英文文档/文案。协议精确表仍以英文账本为单一事实源。
5. 运行：

```powershell
npm run docs:check
npm run format:check
npm run check
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-targets
```

Pull Request 应说明问题、方案、风险/回退、测试证据和界面截图（如适用）。不要把本机凭据或真实账号数据
放入测试 fixture。

CI（`.github/workflows/ci.yml`）会在 pull request 上构建 Windows x86_64 与 Linux x86_64 安装包，在
`main` 推送和手动触发时构建完整 Windows/Linux 矩阵，并以 Actions artifact 保留 14 天。CI 使用 ThinLTO；
带 tag 的生产包仍由 `build.yml` 使用仓库里的 Fat LTO。事件、缓存、产物命名与“构建通过 vs 运行时验证”
见 [CI 文档](docs/zh-CN/ci.md)。也可以在 Actions 里对当前分支手动运行 **CI**。

## 安全与协议边界

- 不提交 Cookie、OAuth code、token、vkey/ekey、真实账号资料、签名媒体 URL 或播放日志原文。
- 不实现会员/地区/版权绕过，不伪造 QQ 音乐 VMP 签名或账号权益。
- 网络兼容层必须精确校验 HTTPS host/path、重定向、响应类型和大小。
- 账号命令只允许主 WebView；歌词/OAuth WebView 不得扩权。
- 发现漏洞请按 [安全策略](SECURITY.md)私下报告，不要开公开 Issue。

## 提交信息

建议使用简短命令式前缀，如 `fix:`、`feat:`、`docs:`、`test:`、`refactor:`。一个提交应能独立解释，
且不破坏编译或测试。

当前仓库未附带项目许可证；公开可见不等于自动授予复制、修改或分发权。
