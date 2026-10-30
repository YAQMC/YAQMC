# CI、缓存与可下载产物

> **简体中文** | [English](../ci.md)

本文说明桌面端与 Android 的 GitHub Actions 流水线。Windows 与 Linux 正式版不做代码签名，Android 使用长期保存的正式证书签名。任何这类产物都不能单独证明安装包已在目标硬件上启动。

## 工作流

| 工作流          | 文件                                      | 触发条件                            | 结果                                                             |
| --------------- | ----------------------------------------- | ----------------------------------- | ---------------------------------------------------------------- |
| CI              | `.github/workflows/ci.yml`                | pull request、推送 `main`、手动触发 | 质量门禁与未签名安装包 artifact                                  |
| Build artifacts | `.github/workflows/package-artifacts.yml` | 仅手动触发                          | 未签名 Windows/Linux 包与 Android debug APK，仅上传 Actions 产物 |
| YAQMC 发布      | `.github/workflows/electron-release.yml`  | `v*` tag、手动触发                  | 正式版、beta/nightly Release；手动分支构建为源码构建草稿         |

已删除的旧桌面工作流不再是受支持的构建路径。CI 安装包 artifact 保留 14 天。

## 手动打包与下载

推送代码后，打开 **Actions → Build artifacts → Run workflow**，选择分支，以及 `all`、
`windows`、`linux` 或 `android`。完成后在该次运行的 **Artifacts** 区域下载安装包，保留 14 天。
这个独立工作流不会因推送自动启动，也不会创建或发布 GitHub Release。

桌面打包复用现有 x64/arm64 矩阵与脚本；`ci` 使用 ThinLTO 和八个 codegen unit，
`production` 使用 Fat LTO 和一个 codegen unit。Windows 产物包含安装版与便携 EXE；
Linux 产物包含 AppImage、deb、rpm、tar.gz。Android 单独构建自己的前端与 arm64-v8a、x86_64
测试 APK，使用 debug 签名，不依赖正式签名密钥；不能覆盖由其他密钥签名的 APK。

## 门禁与打包矩阵

每次 CI 都执行前端格式、文档、lint、TypeScript、Vitest 与脚本检查；在 Linux 和 Windows 构建 Electron 宿主；执行 Rust fmt、clippy、workspace 测试与协议契约检查；核验无条件链接的公开 `qm-api-rs` 精确 git pin，使用合成夹具测试 readiness 与 provenance 校验器，并在 Linux/Windows 扫描密钥。实际私有报告不进入 CI。Cargo 使用 `CARGO_NET_GIT_FETCH_WITH_CLI=true` 直接获取精确的公开 revision。

- Pull request 打包 Windows x64 与 Linux x64。
- 推送 `main` 打包 Windows x64/arm64 与 Linux x64/arm64。
- 手动运行可选 `windows`、`linux` 或 `all`，以及 `ci` 或 `production` 优化配置。
- Windows arm64 在 `windows-2025` 交叉编译；Linux arm64 使用 `ubuntu-22.04-arm`。
- 不再构建或发布 Windows i686。

过时的 pull request 运行会被取消；推送 `main`、tag 和手动打包不会中途取消。

## 构建与打包流程

`frontend-build` 上传 `yaqmc-frontend-dist-<sha>`。每个打包任务下载该精确产物，按目标三元组编译 `yaqmc-core`，暂存 Core 可执行文件，构建 Electron Main/预加载代码，再以禁止发布模式调用 electron-builder。

Windows 产出 NSIS 安装器与 portable 可执行文件。Linux 产出 AppImage、`.deb`、`.rpm` 与 `.tar.gz`。Linux 任务只安装 Electron 打包工具；已退役 Linux web runtime 包不再是宿主依赖。

Android 发布任务会单独构建 `dist-android` renderer，将共享 Rust Core 编译为 `arm64-v8a`，同步 Capacitor，并使用 JDK 21、SDK 36 与 NDK 28.2.13676358 组装压缩后的正式 APK。Android 不复用桌面 renderer artifact，因为两种宿主的功能边界不同。

不要在任务间上传或复用 `node_modules`。

## Windows 发布签名

当前批准的发布策略是未签名 Windows 安装器与 portable EXE，不需要 Windows 证书 secrets。
工作流关闭证书自动发现，上传前检查两个 EXE 均为 `NotSigned`。
未签名打包关闭更新器的发行者签名校验；仅从 YAQMC 官方发布页下载。
SHA-256 校验和能检测损坏，但不能独立证明发行者身份。
Windows 可能提示未知发布者或 SmartScreen 警告。

显式本地 `--require-signing true` 仍使用独立的 `electron-builder.release.yml`
强制签名配置，但这不是当前远端发布工作流的策略。

## Android 发布签名

在已安装 `keytool` 的 Windows 上，执行 `pwsh -File scripts/new-android-release-key.ps1 -Destination <仓库外的私有目录>` 可生成新密钥。脚本拒绝覆盖已有目录，限制目录权限，并输出五个 Secret 值文件、PKCS12 keystore 和公开证书。进入仓库 **Settings → Environments → release-signing → Environment secrets**，以每个文本文件去掉 `.txt` 的文件名作为名称，以全文作为值；不是 Dependabot secrets 或 Actions variables。另做加密离线备份，禁止提交这些文件。新密钥不能直接覆盖升级使用其他旧密钥签名的安装。

Android 打包任务使用同一个受保护的 `release-signing` environment，并要求配置：

- `ANDROID_RELEASE_KEYSTORE_BASE64`：Base64 编码的长期正式 keystore；
- `ANDROID_RELEASE_KEY_ALIAS`：正式密钥 alias；
- `ANDROID_RELEASE_STORE_PASSWORD`：keystore 密码；
- `ANDROID_RELEASE_KEY_PASSWORD`：密钥密码。
- `ANDROID_RELEASE_CERT_SHA256`：正式签名证书的预期 SHA-256 指纹。

工作流只把 keystore 解码到 runner 临时目录，限制文件权限，并在上传 artifact 前删除。缺少任一签名项都会失败关闭。Gradle 组装后，工作流用 Android Build Tools 的 `apksigner verify --print-certs` 检查 APK，并将证书 SHA-256 指纹与受保护的预期值比较；随后用 `sha256sum --check` 校验 staging 生成的 checksum。`org.yaqmc.android` 的所有后续升级必须使用同一把签名密钥；密钥丢失后用户将无法覆盖安装更新。

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

发布工作流先检查精确 SHA 在 `main` 上的最新 CI 成功、`release-signing` 已配置 Required reviewers，并要求在 `workflow_dispatch` 中勾选 `private_gates_confirmed`，确认维护者已对该 SHA 执行本地私有门禁；直接推送 tag 会被阻断。pin 和 Android 签名配置也在打包前检查。Actions 不读取私有报告。它检出依赖的精确 revision，生成 YAQMC、`qm-api-rs` 与 AMLL 对应源码归档及 schema v3 的 `CORRESPONDING-SOURCE-MANIFEST.json`；清单只记录公开源码身份、许可证和归档 hash，不含报告或报告 hash。组装核对源码和安装包 identity，并生成分平台 checksum 和基于 commit 的概述。x64 兼容更新源 `latest.yml` / `latest-linux.yml` 与 Windows 各架构专用元数据一起保留。

版本 tag 只通过受保护的手动发布工作流组装；确认本地门禁后，稳定版标记 latest，预发布标记 prerelease 且不标记 latest。手动运行选择合法版本 tag 时沿用该 tag，默认保留草稿，开启 `publish` 才发布。手动分支运行使用 `electron-draft-<run-id>`，始终保留为源码构建草稿。重跑不会覆盖已有 Release 或资产；审核后发布已有草稿，内容变更则递增版本。

签名配置在安装工具链及构建前端之前检查；缺失项只输出名称，不输出值。正式 tag 必须包含 Windows/Linux 的 x64、arm64 完整矩阵、Windows 安装器和便携 EXE、Linux 四种格式、x64 更新源，以及 arm64-v8a Android APK。手动 Windows/Linux 演练可缩小桌面目标，但仍包含 Android。签名凭据未配置时不要创建正式 tag。历史 Release 和 tag 单独核对名称后清理，CI 不会自动删除发布历史。

打包后的 renderer 使用 AGPL 许可的 AMLL 包。组装器会核对精确包版本、许可证、revision、源码入口、
归档 hash 以及[对应源代码交付政策](../../CORRESPONDING_SOURCE_POLICY.md)中的要求。

## 发布 beta 或 nightly

需要应用内更新的预发布版使用 **YAQMC 发布**。推送 CI 和 **Build artifacts** 用于开发候选验证，即使选择 `production` 优化，包仍标记为源码构建；直接把它们复制到 Release 不会获得官方自更新身份。

1. 在 **Settings → Environments → release-signing** 设置 **Required reviewers**，并配置上述五个 Android 签名 secret。审核人批准前必须本地核验精确 SHA，详见[发布要求](../release/README.md)。
2. 将根 `package.json` 版本改为例如 `0.1.2-beta.1`，执行：

   ```sh
   npm run sync-version
   npm install --package-lock-only --ignore-scripts
   cargo update --workspace
   node scripts/sync-version.mjs --check
   ```

   检查 lockfile 差异，保留无关依赖的固定版本。提交版本变更并推送 `main`，等待**该精确 SHA 的 CI**全部成功；最新 CI 失败或仍在运行都会阻止发布。

3. 在该干净提交上保留本地私有资料并执行：

   ```sh
   npm run release:check:local -- --commit <FULL_SHA> --tag v0.1.2-beta.1
   ```

   门禁阻塞时不能发布，不应编造证据或直接批准。

4. 在该 SHA 创建 `v0.1.2-beta.1` tag，然后手动运行 `YAQMC release`，选择该 tag，按需勾选 `publish` 与 `private_gates_confirmed`。在 Actions 核对 deployment SHA 后批准 `release-signing`，正文自动列出提交。

nightly 使用 `0.1.2-nightly.1`，每次发布递增序号。统一桌面/Android 发布支持 `alpha.n`、`beta.n`、`nightly.n`、`rc.n`，其中 `n` 为 0–999；`nightly.20261028` 这类日期序号会超出 Android versionCode 范围。SemVer 按渠道标识的字母顺序比较，因此同一基础版本下 `nightly.1` 高于 `beta.999`，切回该版本线的 beta 不会触发升级。对应正式版使用 `0.1.2`。

手动构建已有版本 tag 的草稿时，在 **Run workflow** 选择该 tag，保持 `targets=all`、`publish=false`；准备发布后再启用 `publish`。分支构建始终为源码构建草稿。不要移动已发布 tag 或覆盖资产；即使只变更 commit，也需递增版本。历史 Release 不改写。

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
