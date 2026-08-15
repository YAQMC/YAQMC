# CI、缓存与可下载产物

> **简体中文** | [English](../ci.md)

本文说明 YAQMC 的 GitHub Actions。它不能代替带 tag 的 GitHub Release。

## 工作流

| 工作流   | 文件                          | 何时运行                            | 产出                                        |
| -------- | ----------------------------- | ----------------------------------- | ------------------------------------------- |
| CI       | `.github/workflows/ci.yml`    | pull request、推送 `main`、手动触发 | 质量门禁与未签名 Actions artifact           |
| 桌面包   | `.github/workflows/build.yml` | `v*` tag 与手动触发                 | 生产配置安装包；仅 `v*` 会写 GitHub Release |
| 项目网站 | `.github/workflows/pages.yml` | `main` 上文档/站点变更              | 仓库公开时的 GitHub Pages                   |

CI artifact **不是** GitHub Release，保留 **14 天**。打包成功不等于该架构已经在真机上跑过。

## 事件与矩阵

- **Pull request：** Prettier、ESLint、TypeScript、Vitest、文档、密钥扫描、Rust fmt/clippy/测试、一次前端生产构建，以及 Windows x86_64 与 Linux x86_64 安装包。
- **推送 `main`：** 同样的质量门禁，外加完整 Windows/Linux 矩阵：Windows `x86_64` / `i686` / `aarch64`，Linux `x86_64` / `aarch64`。
- **手动 `workflow_dispatch`：** 可选 `windows`、`linux` 或 `all`，以及 `ci` 或 `production` 优化配置。

过时的 pull request 运行会被取消。`main` 推送和手动打包中途不会被取消。

## 前端复用

打包任务下载 `yaqmc-frontend-dist-<sha>`。`YAQMC_PREBUILT_FRONTEND=1` 时，`scripts/ci/tauri-before-build.mjs` 在核对 `dist/yaqmc-frontend-build.json` 与当前 commit 后跳过 Vite。本地 `tauri build` 仍会正常构建前端。

不要在操作系统之间上传 `node_modules`。

## 原生编译

每个目标先 `tauri build --no-bundle` 一次，校验 PE/ELF 架构，再 `tauri bundle`。Windows 产出 NSIS、MSI 和可执行文件的便携 ZIP。Linux 产出 AppImage、`.deb`、`.rpm` 以及动态链接的二进制 tar（不是静态便携包）。x86_64 AppImage 仍会做现有的 GDK 会话感知重打包。

暂存时只使用 `src-tauri/target/<triple>/release` 根目录下的 `yaqmc` / `yaqmc.exe`，再从旁边的 `bundle` 目录复制安装包，不会误捡 payload 里的同名二进制。Linux 打包会安装 `xdg-utils`，并设置 `APPIMAGE_EXTRACT_AND_RUN=1`，以便在缺少 `/usr/bin/xdg-open` 或 FUSE 的 ARM runner 上运行 linuxdeploy。

## 优化配置

仓库里的 `[profile.release]` 仍是 Fat LTO（`lto = true`，`codegen-units = 1`），供本地 `tauri build` 和带 tag 的生产构建使用。

常规 CI 打包设置：

```
CARGO_PROFILE_RELEASE_LTO=thin
CARGO_PROFILE_RELEASE_CODEGEN_UNITS=8
```

这仍是优化过的 release（关闭 debug assertion，`opt-level = "s"`），不是 debug 包。`build-info.json` 会记录 `profile`、`lto` 和 `codegenUnits`。手动选择 `production` 时使用仓库的 Fat LTO，并写进元数据。

本机 Windows x86_64 `--release` 编译（ThinLTO 使用独立 `CARGO_TARGET_DIR`）：

- Fat LTO / `codegen-units=1`：此前完整打包时原生编译约 3 分 47 秒，`yaqmc.exe` 约 12.1 MB。之后 `cargo clean --release` 因该可执行文件被占用而失败。
- ThinLTO / `codegen-units=8`：141.7 秒，14.2 MB。这是 CI 打包的默认配置。
- 关闭 LTO / `codegen-units=8`：107.4 秒，14.4 MB。编译更快，但本仓库未对比其运行时播放质量，因此 CI 仍使用 ThinLTO。

## 缓存

Cargo 缓存按操作系统、目标三元组、工具链类别（打包用 `1.88`，质量检查用 `stable`）、`Cargo.lock` 和配置类别（`dev` / `ci-release` / `production`）分键。路径是 crates.io registry、git checkout 和 `src-tauri/target`。

打包安装 Rust **1.88**。质量检查使用当前 stable 的 `rustfmt`/`clippy`，以便与本地 `cargo fmt` / `cargo clippy` 一致。

恢复出的缓存视为不可信输入。Pull request 和其他分支的推送可以恢复这些键，但不会写回。只有 `main` 推送和手动触发会保存。冷缓存必须仍能成功。

要作废缓存，可改 `Cargo.lock` 或 `.github/actions/setup-packaging/action.yml` 里的键前缀。

## 产物命名

每个目标上传 `YAQMC-<os>-<arch>-<sha>`，内含带版本的文件、`build-info.json` 和 `SHA256SUMS-<os>-<arch>.txt`。架构名与现有发布约定一致：`x86_64`、`i686`、`aarch64`。

## Runner

- Windows x86_64 / i686：`windows-2025`
- Windows aarch64：`windows-11-arm`（原生；不得把 x64 二进制标成 ARM）
- Linux x86_64：`ubuntu-22.04`
- Linux aarch64：`ubuntu-22.04-arm`

ARM hosted runner 不可用时，该矩阵行应失败并给出 runner 错误，而不是静默发布错误架构。

## 构建通过 vs 运行时验证

CI 打包表示二进制已编译、架构检查通过、安装包已上传。这 **不** 表示已在该 OS/CPU 上启动过应用。本仓库维持运行时验证的桌面目标是 Windows x86_64。Linux 与 ARM 行在验收记录另有说明之前，只算打包检查。

## 本地命令

```powershell
npm run ci:frontend-build
npm run ci:test-scripts
npm run ci:package-metadata
```

未签名的 CI 产物不使用发行签名密钥。正式 tag 仍走 `.github/workflows/build.yml`。
