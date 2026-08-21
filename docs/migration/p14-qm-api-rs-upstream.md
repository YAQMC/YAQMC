# qm-api-rs 上游工作单（P14-B 前置）

Status: **landed** in sibling at `93fc0a621df13c46adde7653d387b15ef6b490f2`
(2026-08-21 `ApiTransport`). Current YAQMC optional pin is
`ffcc86cec2993b79ccf34faf25c1eba6c0d995ca` (docs-only descendant of
`56db511`: independent-implementation record drops the L-1124 port claims).
Feature `qmapi` is still not default. Crate provenance is closed at this pin.

下面保留对照基线 `a7430a831a256bb15212291f11a055d801e31648` 的历史工作单，
不要当未完成清单再改一遍上游。crate 名 `qqmusic-api`，lib `qqmusic_api`，
GPL-3.0-or-later。

本单**不**授权 P14-B 模块替换、不签署 provenance、不要求把 reqwest 升到 0.13。

## 为什么必须改上游

YAQMC 绑定修正（`docs/migration/plan-amendment-2026-08-16.md`）要求：在 pin
之前必须有可注入的 **`ApiTransport`**。YAQMC **不得**只用 logging wrapper 补
timeout / allowlist / cancel / retry / redirect。

`reqwest 0.12` 出现在公开类型上，和 YAQMC 的 `reqwest 0.13.4` 是真实 ABI 边界，
不是 resolver 细节。

## 现状（对照 `a7430a8`，改的时候请再核对）

| 项             | 事实                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MSRV           | `Cargo.toml` **没有** `rust-version`。在 Rust 1.88 上 `check` / `--all-features` 能过，但元数据未声明、CI 未钉死。                                                                                                                                                                                                                                                  |
| HTTP 构造      | `ApiContext::new_with_proxy` 内部 `reqwest::Client::builder().gzip().brotli().cookie_store(true)`，可选 proxy。无 connect timeout、无总 timeout、无 redirect policy、无 host allowlist。                                                                                                                                                                            |
| 每请求 timeout | 仅 `HttpOptions.timeout: Option<Duration>`，CGI / QIMEI / `request_http_bytes` 默认都不设。                                                                                                                                                                                                                                                                         |
| 公开 reqwest   | `ApiContext.http: pub reqwest::Client`；`HttpOptions.headers: reqwest::header::HeaderMap`；`Client::request_http(method: reqwest::Method, …)`；`login.rs` / `search.rs` 使用 `reqwest::Method` / `HeaderMap` / `HeaderValue`；`helper_utils.rs` 持有 `&reqwest::Client`；`login.rs` `extract_cookie(&reqwest::Response)`；`impl From<reqwest::Error> for QmError`。 |
| 上下文类型     | `ApiContext`（不是计划里的 `ClientContext`）。默认平台 **Android**。无 `radio`。无 `tracing`。                                                                                                                                                                                                                                                                      |
| 限流           | 全局 `TokenBucket`，默认 10 rps / burst 50，挂在 `ApiContext` 上，不是 per-endpoint。                                                                                                                                                                                                                                                                               |
| mock           | 测试改 `cgi_base_url` / `qimei_url` 指向本地 axum。allowlist 必须放行**已配置的 base**，不能只写死生产域名。                                                                                                                                                                                                                                                        |
| MQTT           | `mqtt.rs` 走 `tokio-tungstenite`（`wss://mu.y.qq.com`），**不是** reqwest。本单不要求把 MQTT 塞进 `ApiTransport`；HTTP 登录轮询仍要走新 transport。                                                                                                                                                                                                                 |

YAQMC in-tree 对照（不要抄进 qm-api-rs 当公开 API，只说明消费者期望）：

- connect 5s / 总超时 15s
- 默认 redirect：校验后最多 3 跳；封面下载 `Policy::none`
- host allowlist + 取消令牌 + 按 `RetryClass` 重试（写操作不盲目重试）

qm-api-rs 实际还会打到 in-tree allowlist 之外的主机，allowlist **由上游自己维护**，至少覆盖：

- `u.y.qq.com`（CGI）
- `c.y.qq.com` / `c6.y.qq.com`
- `api.tencentmusic.com`（QIMEI）
- `ssl.ptlogin2.qq.com` / `ssl.ptlogin2.graph.qq.com` / `xui.ptlogin2.qq.com`
- `graph.qq.com` / `y.qq.com`
- `open.weixin.qq.com` / `lp.open.weixin.qq.com`

## 必须做的三件事

### 1. `ApiTransport`（硬门）

新增可注入的 HTTP 传输，让 `ApiContext` **不再把 `reqwest::Client` 当作唯一且公开的发送路径**。

能力清单（缺一不可）：

1. **Injection** — `Client::new` / `ApiContext::new` 仍可用默认实现；另提供
   `new_with_transport`（或等价 builder）注入 `Arc<dyn ApiTransport>`。
   默认实现内部可以继续用 reqwest **0.12**。
2. **Timeout** — 默认 connect + 总超时（建议 5s / 15s，可配置）。CGI、QIMEI、
   `request_http`、`request_http_bytes` 都要走同一套，不能只给 `HttpOptions`
   开一个可选字段。
3. **Allowlist** — 发送前检查 host。生产名单见上。`cgi_base_url` / `qimei_url`
   指向 mock 时必须放行该 host。拒绝时返回库自己的错误类型，不要 panic。
4. **Cancellation** — 每个请求可取消。不要依赖调用方 `tokio::time::timeout`
   包一层就算完成。可用 `tokio-util::sync::CancellationToken`、`oneshot` 或
   等价 abort；选一种并在文档写死。
5. **Retry** — 传输层或与 `QmError::is_retryable` 对齐的**可控**重试：安全读
   可重试网络抖动；登录写 / 状态改变不要默认重试。次数与间隔可配置。
6. **Redirect** — 可配置：禁止跟随 / 校验后跟随（建议默认最多 3 跳）。
   跳转目标也要过 allowlist。二维码 / cookie 交换等需要读 30x 的调用，用
   “返回响应、不跟随”模式，不要全局 `follow`。

公开请求/响应类型**不要**使用 `reqwest::{Client, Method, Url, header::*, Error, Response}`。
用库自己的 `HttpMethod` 枚举、普通 header 列表、`url::Url` 或 `String`。

`reqwest` 只留在默认 transport 的 **private** 模块。`impl From<reqwest::Error>`
改为 `pub(crate)` 或删掉，改成默认 transport 内部映射到 `QmError::Network`。

改完后这些公开表面必须消失：

- `pub http: reqwest::Client`（改为 `pub(crate)` 或换成 `Arc<dyn ApiTransport>`）
- `HttpOptions.headers: reqwest::header::HeaderMap`
- `Client::request_http(reqwest::Method, …)` / `Client::http(reqwest::Method, …)`
- 模块里对外可见的 `reqwest::Method` / `HeaderMap` / `&reqwest::Client` /
  `&reqwest::Response`

内部模块（`login.rs`、`search.rs`、`helper_utils.rs`、`qimei.rs`）全部改走
`ApiContext` 的 transport，禁止再拿 `context.http` 直接 `.get()/.post()`。

### 2. 钉 MSRV

在 `Cargo.toml` 的 `[package]` 增加例如：

```toml
rust-version = "1.88.0"
```

1.88.0 与 YAQMC workspace 对齐。若要声明更低 MSRV，必须有 CI job 用那个
toolchain 跑 `cargo test --all-features`，并且 YAQMC 1.88 仍能编过。

不要只写字段不测。

### 3. 文档

更新 `docs/architecture.md`：图里把 `reqwest::Client` 换成 `ApiTransport`；
写清默认实现、如何注入、timeout / allowlist / redirect / cancel 默认值。
`docs/error-handling.md` 若仍写 `QmError::Network(String)` 而代码已是
`NetworkError`，一并改到与源码一致。

## 不要做

- 不要为了对齐 YAQMC 而把 reqwest 升到 0.13。升 0.13 是**独立**的、全量回归
  之后才允许的事。
- 不要加 `tracing` 来“继承” YAQMC 脱敏。库继续用自己的 `QmError` 脱敏。
- 不要加 `radio`、不要改 `zzc_sign`、不要改默认 Android 平台、不要改 10 rps /
  burst 50，除非为 transport 注入所必需。
- 不要在 YAQMC 里先 pin、先加 feature `qmapi`、先改 `LICENSING_CONSENT.md`。
- MQTT WebSocket 重定向（`mqtt.rs` 最多 5 跳）本单不动。

## 建议实现顺序

1. 定义 `ApiTransport` + 库内 HTTP 类型 + `TransportError` → `QmError`。
2. 默认 `ReqwestApiTransport`（reqwest 0.12，cookie_store 保留，登录依赖它）。
3. `ApiContext` 持有 `Arc<dyn ApiTransport>`；`new_with_proxy` 变成“默认
   transport + proxy 配置”。
4. 把 `request_cgi` / QIMEI / `request_http` / `request_http_bytes` 和
   `helper_utils` 切过去。
5. 从公开 API 抹掉 reqwest 类型；修 `login.rs` / `search.rs`。
6. 单测：mock base URL 放行、未知 host 拒绝、timeout、redirect 0 跳 vs 3 跳、
   取消、写请求不重试。现有 axum envelope 契约测试必须仍绿。
7. 写 `rust-version` 和架构文档。

## 完成标准（你改完用这个打勾）

- [ ] `cargo test --all-features` 绿（Rust 1.88，以及你声明的 MSRV）。
- [ ] 下游 crate **不**写 `reqwest` 也能 `use qqmusic_api::{Client, ApiTransport, …}`
      编过（用一个最小 consumer 或 `#[deny]` 公开 API 检查证明）。
- [ ] `rg 'pub.*reqwest' src` 无公开泄漏；`ApiContext.http` 不再是 `pub`。
- [ ] 默认 Client 对生产 host 有 timeout + allowlist + 有限 redirect。
- [ ] 测试可把 `cgi_base_url` 指到 127.0.0.1 且仍能发请求。
- [ ] `docs/architecture.md` 已改。
- [ ] 把新 SHA 告诉 YAQMC。pin 更新是**另一次**、已授权的 YAQMC 改动。

## 改完之后 YAQMC 才会做（本单范围外）

- 更新 pin / CI token 真正用于 `cargo fetch`
- `intree | qmapi` 换模块（J qmc → L lyrics → I vkey → A/B transport+sign →
  C/D login/session）
- LIVE VERIFY 与 P14-C soak

YAQMC 树内 `LICENSING_CONSENT.md` 与 `npm run provenance:enforce` 已通过；这仍**不**
等于可以链接这个 GPL crate。`qm-api-rs` 自己的 ASAR / `mzj3920` 声明要另做 crate 级
provenance，才能进入 P14-B。
