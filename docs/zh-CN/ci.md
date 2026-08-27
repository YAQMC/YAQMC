# CI、缓存与可下载产物

> **简体中文** | [English](../ci.md)

本文说明仅使用 Electron 的 GitHub Actions 流水线。普通 CI 安装包不会发布，且可能未签名；发布工作流要求每个 Windows 安装器与 portable EXE 都经过 Authenticode 签名，Linux 发布格式仍不做代码签名。任何这类产物都不能单独证明安装包已在目标硬件上启动。

## 工作流

| 工作流        | 文件                                     | 触发条件                            | 结果                                                     |
| ------------- | ---------------------------------------- | ----------------------------------- | -------------------------------------------------------- |
| CI            | `.github/workflows/ci.yml`               | pull request、推送 `main`、手动触发 | 质量门禁与未签名安装包 artifact                          |
| Electron 发布 | `.github/workflows/electron-release.yml` | `v*` tag、手动触发                  | 经过签名门禁的 Windows 包、Linux 包与草稿 GitHub Release |

已删除的旧桌面工作流不再是受支持的构建路径。CI 安装包 artifact 保留 14 天。

## 门禁与打包矩阵

每次 CI 都执行前端格式、文档、lint、TypeScript、Vitest 与脚本检查；在 Linux 和 Windows 构建 Electron 宿主；执行 Rust fmt、clippy、workspace 测试与协议契约检查；核验无条件链接的公开 `qm-api-rs` 精确 git pin，显式执行提供器 readiness 与 provenance 门禁，并在 Linux/Windows 扫描密钥。Cargo 使用 `CARGO_NET_GIT_FETCH_WITH_CLI=true` 直接获取精确的公开 revision。

- Pull request 打包 Windows x64 与 Linux x64。
- 推送 `main` 打包 Windows x64/arm64 与 Linux x64/arm64。
- 手动运行可选 `windows`、`linux` 或 `all`，以及 `ci` 或 `production` 优化配置。
- Windows arm64 在 `windows-2025` 交叉编译；Linux arm64 使用 `ubuntu-22.04-arm`。
- 不再构建或发布 Windows i686。

过时的 pull request 运行会被取消；推送 `main`、tag 和手动打包不会中途取消。

## 构建与打包流程

`frontend-build` 上传 `yaqmc-frontend-dist-<sha>`。每个打包任务下载该精确产物，按目标三元组编译 `yaqmc-core`，暂存 Core 可执行文件，构建 Electron Main/预加载代码，再以禁止发布模式调用 electron-builder。

Windows 产出 NSIS 安装器与 portable 可执行文件。Linux 产出 AppImage、`.deb`、`.rpm` 与 `.tar.gz`。Linux 任务只安装 Electron 打包工具；已退役 Linux web runtime 包不再是宿主依赖。

不要在任务间上传或复用 `node_modules`。

## Windows 发布签名

`electron-release` 打包矩阵使用受保护的 `release-signing` environment。
Windows 任务要求其中配置以下 environment secrets：

- `WIN_CSC_LINK`：Base64 编码的 PFX/P12 证书，或 electron-builder 支持的其他证书引用；
- `WIN_CSC_KEY_PASSWORD`：证书密码；
- `YAQMC_WINDOWS_SIGNER_SUBJECT`：预期 Authenticode 证书的完整 Subject。

发布任务会把 `electron-builder.release.yml` 叠加到普通构建配置上；
`forceCodeSigning: true` 会在无法签名时直接终止任务。上传前，PowerShell
通过 `Get-AuthenticodeSignature` 检查两个预期 EXE，要求状态为 `Valid`，并将
签名者 Subject 与受保护值比较。更新器保留 electron-updater 默认的发行者签名
校验。签名凭据只注入打包步骤，不提供给 `npm ci`、artifact 上传或组装任务。

## 优化与缓存

常规 CI 包覆盖 release 配置，使用 ThinLTO 与八个 codegen unit：

```text
CARGO_PROFILE_RELEASE_LTO=thin
CARGO_PROFILE_RELEASE_CODEGEN_UNITS=8
```

手动 `production` 与发布工作流使用 Fat LTO 和一个 codegen unit。每个打包
artifact 都包含唯一的 `build-info-<os>-<arch>.json`，记录有效配置、LTO、
codegen unit、Rust 目标、Node/Electron 版本与 Git 身份。Release 组装器在摊平
资产前要求该 identity 与对应源码 commit 一致。

Cargo 缓存按操作系统、Rust 目标、工具链类别、`Cargo.lock` 和配置类别分键。Pull request 可以恢复缓存，但只有 `main` 推送、tag 和手动运行会保存。恢复出的缓存是不可信输入，冷缓存构建仍必须成功。

## 产物与发布名

CI 从对应 `release-electron` 目录上传 `YAQMC-electron-<os>-<arch>-<sha>`，架构名使用 electron-builder 的 `x64` / `arm64`。

Linux x64 打包任务还会上传独立的扁平 artifact
`YAQMC-linux-x64-tester-<sha>`，其中包含精确 AppImage、不可变 build
identity、checksums、当前测试/验收说明、采集器和验证器。上传前 CI 会执行
identity-only 校验；该测试包不会混入 Release 草稿资产。

发布工作流在打包前强制通过 pin、提供器 readiness、provenance 与 Windows 签名门禁。它检出依赖的精确 revision，生成绑定 revision 的 YAQMC、`qm-api-rs` 与 AMLL 对应源码归档及 `CORRESPONDING-SOURCE-MANIFEST.json`。组装步骤先核对归档 hash，再摊平安装包，生成 `SHA256SUMS-electron.txt` 与 `RELEASE-NOTES-ELECTRON.md`，且只保留 x64 更新源 `latest.yml` / `latest-linux.yml`。`v*` 推送沿用原 tag；手动运行使用 `electron-draft-<run-id>`。两者都创建供维护者复核的草稿 Release。

打包后的 renderer 使用 AGPL 许可的 AMLL 包。组装器会核对精确包版本、许可证、revision、源码入口、
归档 hash 以及[对应源代码交付政策](../../CORRESPONDING_SOURCE_POLICY.md)中的要求。

## 构建通过与运行时验收

打包任务成功仅证明编译、安装包组装、元数据生成与上传完成；不证明启动、歌词悬浮窗、OAuth、keyring 连续性、媒体集成、更新器或各 OS/CPU 真机执行。后者必须有单独的硬件验收证据。

## 本地命令

```powershell
npm run ci:frontend-build
npm run ci:test-scripts
npm run ci:package-metadata
npm run provider:enforce
npm run provenance:enforce
npm run package -w @yaqmc/desktop -- --publish never
```
