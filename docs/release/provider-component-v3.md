# Provider Component v3 automatic closure

> English | [简体中文](#简体中文)

The machine-readable record is [provider-component-v3.json](provider-component-v3.json).

## Decision

- Automatic implementation: **PASS** at commit
  `c04f7ce5d4ba494f1d41367f4bee8f3b249b308c`.
- Release readiness: **BLOCKED** because the exact-pin three-day provider soak is
  `not-started`.
- GUI, LIVE, real-account, final packaging, and HUMAN acceptance: **NOT RUN**,
  pending a separate maintainer decision.

This result closes the roadmap's automatic P4-P6 implementation gates. It is
not a release authorization or a replacement for the outstanding provider soak.

## Verified scope

- Provider Component API v3 is frozen as `yaqmc:provider@0.1.0`, with a golden
  protocol fixture, a read-only catalog example, and a complete platform example.
- Catalog, playback source, account, recommendation, Discover, and lyrics
  capabilities run behind the Core-owned Wasmtime host boundary.
- Capability grants, credentials, HTTPS mediation, storage quotas, cancellation,
  deadlines, circuit breaking, package limits, and lifecycle recovery have
  deterministic automated coverage.
- Release and QA builds are separate. The production renderer starts only the
  native application, Electron packaging excludes `harness/**`, and the release
  bundle scanner rejects fake data, test entry points, Playwright harnesses,
  fixtures, and QA markers.
- Node 26.7.0, npm 11.19.0, Rust 1.88.0 MSRV, and the `wasm32-wasip2` component
  target passed the local Windows automatic matrix.
- Native GitHub runners passed the Linux Rust/Node matrix and the Windows Electron
  build and secret scan in [CI run 33404019843](https://github.com/YAQMC/YAQMC/actions/runs/33404019843).
  Packaging jobs were intentionally skipped on the normal push workflow.

The main test suites reported 706 renderer tests, 21 client tests, 356 passing
desktop tests with 2 explicitly skipped cases, and 198 CI-script tests. Rust
format, workspace check, Clippy with warnings denied, and workspace all-target
tests passed on the exact 1.88.0 MSRV toolchain. LIVE-marked Rust tests remained
ignored by design.

## Frozen example packages

| Package                                         |   Bytes | SHA-256                                                            |
| ----------------------------------------------- | ------: | ------------------------------------------------------------------ |
| `dev.yaqmc.example.catalog-1.0.0.yaqmc-plugin`  |  24,248 | `c2c4d4ed24385c29be270f5de9790f04b4c81ec5a52e5c810607e55b1456aea2` |
| `dev.yaqmc.example.platform-1.0.0.yaqmc-plugin` | 241,889 | `01297f93fab5356c8d95bf52a7167d810f50939b797c46703a3c993e88fe2480` |

The packages are stored under `examples/plugins/packages/`. Rebuild them with
`npm run plugin:pack:provider-example` and
`npm run plugin:pack:provider-platform-example`, then compare size and SHA-256
with the machine-readable record.

## Reproduction boundary

The local automatic closure used `npm run format:check`, `npm run docs:check`,
`npm run lint`, `npm run typecheck`, all three Node test matrices,
`npm run ci:test-scripts`, both production builds,
`npm run release:bundle:check`, `npm run contracts:check`,
`npm run provenance:enforce`, both secret-scanner self-tests and scans, and the
Rust 1.88.0 workspace format/check/Clippy/test matrix. Exact commands and results
are preserved in the JSON record.

`npm run provider:readiness` remains report-only in normal CI. The release-only
`npm run provider:enforce` gate must remain blocked until the exact-pin three-day
soak is completed or the maintainer records a new explicit waiver.

## 简体中文

机器可读记录见 [provider-component-v3.json](provider-component-v3.json)。

### 结论

- 自动实现：提交 `c04f7ce5d4ba494f1d41367f4bee8f3b249b308c` **通过**。
- 发布就绪：由于精确依赖固定的三日 soak 仍为 `not-started`，当前为
  **阻断**。
- GUI、LIVE、真实账号、最终打包和 HUMAN 签收：均**未执行**，等待维护者另行决定。

该结论只关闭路线图 P4-P6 的自动实现门禁，不构成发布授权，也不替代尚未完成的
Provider soak。

### 已验证范围

- Provider Component API v3 已冻结为 `yaqmc:provider@0.1.0`，包含 golden
  协议夹具、只读目录示例和完整平台示例。
- catalog、音源、账号、推荐、发现和歌词能力均位于 Core 持有的 Wasmtime
  Host 边界之后。
- 能力授权、凭据隔离、HTTPS 中介、存储配额、取消、deadline、熔断、包上限和
  生命周期恢复均有确定性自动测试。
- Release 与 QA 构建已正式分离。生产 renderer 只启动原生应用，Electron 打包排除
  `harness/**`，release bundle 扫描器拒绝 fake 数据、测试入口、Playwright harness、
  fixture 和 QA 标记。
- 本机 Windows 使用 Node 26.7.0、npm 11.19.0、Rust 1.88.0 MSRV 和
  `wasm32-wasip2` 完成自动矩阵；GitHub 原生 runner 完成 Linux Rust/Node 矩阵及
  Windows Electron 构建和 secret scan。正常 push 工作流按约定跳过打包任务。

主测试矩阵为 renderer 706 项、client 21 项、desktop 356 项通过及 2 项显式跳过、
CI 脚本 198 项。Rust 1.88.0 下的格式、workspace check、`-D warnings` Clippy 和
workspace all-target tests 全部通过；标记为 LIVE 的 Rust 测试按设计保持 ignored。

示例包的体积、SHA-256 和完整命令记录在同目录 JSON 中。`npm run provider:readiness`
在常规 CI 中仍只报告状态；在三日 soak 完成或维护者记录新的明确 waiver 前，发布专用
`npm run provider:enforce` 必须继续阻断。
