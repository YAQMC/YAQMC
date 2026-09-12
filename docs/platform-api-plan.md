# 多平台 API 与插件端点实施计划

状态：实施中，未完成全量迁移或发布验收。本文是目标、依赖顺序和验收契约，
不是已实现功能说明。现有 QQ 登录、OAuth、MQTT、播放降级和用户数据必须保留。

## 1. 范围与已核实基线

- “全部 QQ 端点”指 YAQMC 当前实际使用的端点；不声称覆盖 QQ Music 未使用的全部内部 API。
- `qm-api-rs` 独立维护 QQ 协议；Spotify 使用独立 provider，不放入 QQ 专用库。
- 现有 ProviderRegistry 和插件已有多 provider、能力分发和来源隔离基础，不重建第二套注册表。
- 现有队列可以保存不同 provider 的歌曲引用；缺口是同平台多 profile、并行账户运行时、
  缓存隔离和来源选择，不是从零开发混合队列。
- 前端 `MusicProviderRoot` 仍只为活动浏览 provider 挂载账户 runtime；
  `ProviderTrackReference` 仍无 profile 字段。
- 插件已有 Wasm 沙箱和固定能力协议；动态替换特定 provider/profile 的逻辑端点仍待实现。
- 已有 `qm-api-rs` 大部分目录 API。迁移先比对请求与响应兼容性，不按模块名称判断能力等价。
- 仓库内尚未找到 Spotify 实现；这不排除用户安装的外部插件自带 Spotify 授权流程。
  “打不开授权页”仍须定位实际插件、宿主和失败阶段，不能先归因于单一域名白名单。

## 2. 责任边界

| 层               | 保留职责                                                                | 不应承担                                                 |
| ---------------- | ----------------------------------------------------------------------- | -------------------------------------------------------- |
| `qm-api-rs`      | QQ URL、CGI module/method、请求签名、wire DTO、解码、协议错误、凭据注入 | YAQMC UI、队列、宿主窗口、平台账户选择                   |
| QQ provider      | DTO 映射、生命周期、业务编排、缓存、错误映射、写操作对账                | 拼 QQ 上游路由或重复实现 wire 协议                       |
| Core             | provider/profile 注册、路由、权限、凭据存储、播放调度、代次校验         | QQ/Spotify 私有端点细节                                  |
| 插件             | 自有平台适配或授权范围内的算法/逻辑端点                                 | 默认接触其他账户密钥、原始 socket、进程或 native library |
| Electron/Android | 系统浏览器、回调、窗口、安全存储、原生播放桥                            | 直接拼音乐服务业务 API                                   |
| Renderer         | 来源选择、状态展示、交互                                                | token、Cookie、签名密钥、上游私有路由                    |

网络策略分两层：库提供协议所需请求；宿主 transport 仍执行 origin、重定向、体积、
取消和凭据隔离策略。收敛 API 不等于取消宿主的纵深校验。
缓存淘汰和 UI entitlement 文案仍归应用；协议字段解释与媒体 URL 构造归库。

## 3. 实施顺序与阶段出口

### A. 端点清单、契约与跨仓库迁移

建立逐端点矩阵：生产调用入口、上游操作、现有库方法、缺口、身份范围、重试类型、
请求/响应 fixture、迁移状态、删除旧实现的证据。测试专用旧路由单独标记，不能算作生产残留。

按以下批次切换：

1. 目录：歌单详情、歌单搜索、歌手专辑、排行榜；复用现有歌曲/专辑/歌手接口。
2. Home/Discover：个性化歌单、普通歌单、新歌、分类、播客、MV、焦点卡、区域页面；
   复用已有 Guess/Radar/daily typed API，核对各入口参数而非只核对函数名。
3. 歌词、artwork：协议和 URL 生成进入库；图片缓存和宿主下载安全策略保留。
4. 播放：clear vkey、encrypted EVkey、现有 `zzb` 签名和结果关联；
   不把另一签名算法视为等价替代，不回退异步解码失败到降级的现有链路。
5. 账户快照、会话恢复和授权：保留登录尝试 ownership、staging、MQTT topic 绑定、
   取消、过期、回滚和事件代次，仅迁移上游协议实现。
6. 收藏、歌单写入与历史：库提供类型化操作和错误结果；provider 保留幂等操作 ID、
   串行化和 safe-read 对账。请求可能已送达时返回 `OutcomeUnknown`，不得自动重放写请求。

每批流程：库增量实现与契约测试 → provider 联调 → parity 检查 → 来源审阅 →
发布可获取 revision → 同步 Cargo、CI 和源码分发 pin → 删除对应旧路径。
联调可使用命令级 Cargo path patch，不修改 Cargo 缓存，也不把绝对本机路径写入正式依赖。

出口：矩阵中所有生产端点有 typed 方法和契约证据；provider 无业务 CGI/URL 构造；
测试-only 和 transport 安全白名单有明确、窄范围例外。只扫描 URL 不足以证明完成，
还要检查动态 module/method、payload 构造和调用链。

### B. Provider/Profile 基础模型与数据迁移

先建立路由依赖的身份模型，再开放持久化插件绑定：

```text
ProviderProfileKey = (providerId, profileId)
TrackSourceRef     = (providerId, profileId, trackId)
RequestContext     = (ProviderProfileKey, accountGeneration, cancellation)
```

- profileId 为稳定、不含真实账号信息的本地不透明 ID；不是昵称、QQ 号或 access token。
- 同平台多个 profile 持有独立 provider 实例/会话，不共享可变 Cookie 容器。
- 凭据、登录尝试、账户快照、缓存、历史、资源刷新和在途请求按 key 隔离。
- “启用平台”“启用账户”“活动浏览来源”“队列条目来源”是独立状态。
- 注销只清理该 profile 的凭据和受保护数据；禁用立即失效该 profile 的播放授权和请求。
- 保留旧账户 façade，使存量页面可逐步迁移到 keyed store；不得维护两个可写权威状态。
- 新请求省略 profileId 时，仅在兼容边界解析为该 provider 的默认 profile；
  已持久化的多来源队列不得再次依赖当前活动账户推断身份。

旧数据采用版本化、事务式、幂等迁移：预检 → 安全备份 → 默认 QQ profile → 校验 → 提交。
旧 QQ track ID 保持不变；已有非 QQ provider 引用保留来源，不一律改写为 QQ。
无有效来源的条目标记 unavailable，不静默发给默认 provider。

双读/单写不能自动保证任意旧版本可无损回滚。旧版本不认识多账户和混合来源数据，
因此回滚必须恢复迁移前快照；新版本产生的数据需单独保留，并明确不能在旧版本展示。
不得用明文导出密钥来实现备份。

出口：两个 provider 可同时登录；同一 provider 两个 profile 并存；A 的刷新/注销不影响 B；
中断、重复启动和回滚演练通过；默认 QQ 兼容 API 行为不变。

### C. 插件逻辑端点路由

复用现有 provider dispatch，在其前面增加路由决策，不创建通用的任意 URL 转发器。

```text
EndpointKey = (providerId, profileId, capability, endpointName, schemaVersion)
Binding     = builtin | plugin(pluginId, operation) | disabled
```

- 未配置绑定时使用内置实现；显式 `disabled` 立即返回禁用结果，不继续 fallback。
- 插件失败只有在绑定策略允许时才回退到同 provider/profile 的内置实现。
- 不提供隐式“全局另一个平台/账户”回退，防止来源和权限意外改变。
- 插件注册自有 namespaced 端点，新增端点并不自动成为内置 UI 功能，必须有声明的消费者。
- 输入/输出使用内置、版本化 Schema 注册表；禁止运行时加载远程 `$ref`、无限递归 Schema
  或把插件 Schema 当作可执行代码。未知版本和 capability fail closed。
- 插件清单声明能力、精确 origin、数据范围；用户显式绑定后才取得该范围内能力。
- 本地推荐只授予选定范围的历史/候选歌曲读权限，默认无网络和账号凭据权限。
- 有网络权限的插件通过宿主代理访问批准 origin；凭据通过绑定句柄由宿主注入，
  不把其他 profile 的 token/Cookie 交给插件。阻止重定向越权和私网 SSRF。
- 每次调用有共享 deadline、Wasm fuel/内存、请求/响应大小及并发上限；fallback 不重置预算。
- 撤销权限、禁用、升级、重新绑定、注销都推进相关 generation，并取消旧请求。
- 请求开始时捕获 account/route/plugin generation；返回及写入缓存时再次比较。
  只在请求发出前检查权限，不能解决异步撤权竞态。
- 若插件委托内置操作，使用受限宿主入口并带调用栈/深度保护，不能递归路由回自身。

首批开放 recommendation 和只读 catalog；登录、账户写入、播放源替换保持默认关闭，
另行安全审阅后才开放对应能力。保留冻结的现有 WIT/API 版本，通过新版本增加端点能力，
不要直接改旧 ABI 而继续标相同版本。

出口：本地算法插件能替换 QQ“猜你喜欢”而不伪造一个新音乐平台；不影响其他 profile；
撤销期间的旧响应不能发布、缓存或再次开启播放；禁用、显式回退和资源上限测试通过。

### D. 混合队列、本地歌单与前端来源交互

- 扩展已有队列引用，不重建播放器；入队时固定来源，播放、预取、歌词、收藏、分享均按条目来源分发。
- 搜索导航的活动 provider 只改变默认浏览上下文，不修改已入队来源。
- 本地歌单可保存多平台条目；远端 QQ/Spotify 歌单继续遵守平台自己的写入约束。
  向远端歌单添加其他平台歌曲时必须拒绝或进入显式匹配流程，不能偷换 track ID。
- 同曲跨平台结果不根据歌名自动合并；保留来源、版本/地区/可播放性差异。
- 列表、详情、队列和播放栏显示来源及必要账户标识；用户可显式选择来源。
- 推荐续播 cursor 绑定 provider/profile/accountGeneration/routeGeneration，跨代次必须重新请求。
- 开关变化后条目保留，显示 unavailable 原因；重启用可恢复资格，但重新校验授权，不复用旧签名 URL。

出口：多来源连续播放、预取切换、删除账户、禁用恢复、手动切歌及旧请求晚到均通过；
列表的来源标识与实际被调用 provider 一致。

### E. Spotify 授权、目录与独立播放适配

先诊断当前“打不开授权页”：实际插件/版本 → 入口点击 → 宿主 open-external/OAuth broker →
客户端配置 → 网络 → 回调接管。只记录非敏感错误类别，不输出 verifier/code/token。

授权使用 Authorization Code + PKCE：一次性 state、S256、尝试超时和取消、回调精确匹配、
刷新 single-flight、失败重授权；renderer 不接触 access/refresh token，不打包 client secret。
独立 provider 通过宿主授权 broker 打开授权页，不扩大 QQ 的专用导航白名单。

2026-09-12 已核验官方限制：

- PKCE 适用于无法安全保存 client secret 的桌面和移动客户端。
- Web Playback SDK 创建浏览器 Spotify Connect 播放设备，需要 Premium；
  不能将其等同于返回音频 URL 的 Web API。
- Android App Remote 控制 Spotify 应用播放，不是 YAQMC 原生解码器的媒体源。
- Web API redirect URI 文档要求 HTTPS；loopback IP 字面量可用 HTTP，`localhost` 不可用。
  Android SDK 与 Web API 回调策略须分别核对，不能默认任意自定义 scheme 都被接受。

因此拆成两个必须分别验证的交付：

1. 登录、账户快照、搜索、歌曲/专辑详情和 source/profile 接入。
2. 独立播放 session 适配（候选为 Connect 控制、Web Playback SDK 或 Android App Remote），
   先验证账户等级、设备依赖、发行政策和 Electron/Android 实际支持。

第二项不从总目标删除，但在选型和端到端验证前不承诺原生全曲播放。
统一播放抽象需要区分“可读取媒体源”和“宿主/远端播放会话”；后者不能进入音频下载/缓存流程，
也不能在插件超时后悄悄切回 QQ。播放会话切换须先释放旧音频焦点并确认停止，避免两边同时出声。
Spotify client ID、注册回调和可测试账户是 LIVE 验收前置条件，不用测试桩宣称真实登录通过。

官方来源：

- <https://developer.spotify.com/documentation/web-api/concepts/authorization>
- <https://developer.spotify.com/documentation/web-api/concepts/redirect_uri>
- <https://developer.spotify.com/documentation/web-playback-sdk>
- <https://developer.spotify.com/documentation/android>

### F. 集成、安全审阅与发布资格

| 范围    | 必要证据                                                             |
| ------- | -------------------------------------------------------------------- |
| QQ 协议 | 逐端点请求、响应、身份、错误/重试契约；旧新路径 parity；生产残留扫描 |
| 账户    | 并行登录/刷新、跨 profile 凭据与缓存隔离、注销/禁用竞态、迁移回滚    |
| 插件    | Schema、WIT 兼容、撤权代次、SSRF、超时/大小/fuel、回退无越权         |
| 播放    | 混合队列、异步解码失败降级、旧源撤销、音频焦点和会话切换             |
| Spotify | PKCE、回调重放/取消/超时、刷新、真实授权和所选播放方案               |
| 工程    | Rust MSRV/check/test/clippy、TS/ESLint/Prettier、前端和契约测试      |
| 平台    | Windows/Linux/Android 构建及各自运行证据；无法执行的项明确 pending   |
| 供应链  | 精确 git pin、来源增量审阅、匹配的 corresponding source、无密钥泄漏  |

沿用现有验证脚本；按阶段做相关门禁，最后执行全矩阵。自动测试只用合成账户和 fixture。
真机、真实账号授权、写操作和跨平台播放需要各自明确的授权/环境，不能沿用无关历史授权。

新能力默认关闭，已完成且验收通过的能力按 provider/profile 开启。每个阶段可独立回退；
回退配置不恢复已撤销权限，也不接受旧 generation 的在途响应。

现有 soak 豁免绑定旧 revision，新 revision 不能自动继承。源码测试通过、
来源审阅通过、LIVE 通过和可发布是不同结论；不为了让 CI 变绿伪造人工豁免。
本计划本身不触发应用 Release、tag、真机安装或真实账户写操作。

## 4. 性能与复杂度预算

- key 化注册和路由查询使用 HashMap，期望 O(1)；空间 O(profile 数 + 路由数)。
- 每次结果提交做常数次 generation 比较，不扫描全部账户。
- 分页聚合时间 O(N)、空间 O(N)，限制页数/字节数，保留合法重复歌曲，不用盲目去重掩盖分页问题。
- 本地推荐按分页或有界窗口读取候选与历史，不默认把完整库一次交给插件。
- 列表来源徽标复用现有行组件；大列表保持虚拟化，不为每个条目创建账户订阅或后台请求。

## 5. 当前实施证据与未完成项

2026-09-12 计划复核基线：

- YAQMC：`main`，HEAD 为 `96e19a8`；本轮 API 边界改动已提交并推送，工作树仅保留既有未跟踪临时文件。
- `qm-api-rs`：HEAD 和本地 `origin/main` 跟踪引用均为
  `94d1aa90d52ff1529e9d379aa2cdcfb1202beee3`，工作树干净；该 revision
  已推送到 `YAQMC/qm-api-rs`。
- 新库提供 Discovery、Web 榜单、Web 首页 Feed、公共歌单/新歌推荐、歌单搜索兼容接口；
  修复歌手专辑空 tags、歌单分页/身份/业务错误检查，以及 Cookie jar 和重定向隔离问题。
- YAQMC Cargo 已接入该 revision；目录兼容实现正在替换为库 typed 方法，
  Discovery 映射已拆到 `qqmusic/discovery.rs`，公共歌单和公共推荐已有合成 transport 测试。
  个性化歌单和新歌推荐已切换到库的 typed Feed，并用每次请求的凭据快照创建认证客户端；
  不修改共享 Client 的默认凭据。并非仍处于临时 path patch 状态；也并非所有端点已经迁移。
- 当前 Cargo.toml 与 Cargo.lock 已固定完整 SHA
  `94d1aa90d52ff1529e9d379aa2cdcfb1202beee3`；CI、来源账本和 readiness 若仍指向旧
  revision，需在发布前同步更新并重新审阅来源和发布资格；不能改写旧 revision 的 soak 豁免。

证据分级：

| 范围                                    | 已有结果                                                                        | 限制                     |
| --------------------------------------- | ------------------------------------------------------------------------------- | ------------------------ |
| 新库全量测试                            | 本次复核：175 lib、6 Discovery、4 Web 推荐、1 public API、4 security 全通过       | 仅覆盖合成契约，不含 LIVE |
| 新库 MSRV Clippy / fmt                  | 本次复核通过                                                                    | 不能代替 YAQMC 集成验证  |
| YAQMC `catalog_tests`                   | 本次收回前序运行结果：8 passed、0 failed、287 filtered out                      | 只是 provider 的定向测试 |
| YAQMC workspace check / provider Clippy | 本次复核通过                                                                    | 全 workspace 测试仍需单独执行 |
| Windows / Linux / Android / LIVE        | 此次接口增量没有完整验收证据                                                    | 不据此签收或发布         |

定向测试同时报告未使用的 `web_home_feed` 和旧 Toplist DTO 警告，属于下一批需收尾事项。
合成 transport 与本地阻断代理用于隔离真实 QQ 请求；未修改登录/MQTT 状态机。

已确认的生产残留包括播放源/EVKey 兼容路径，以及
`qmapi/account.rs` 中 provider 自行拼装 module/method/param 后调用 `request_cgi`。
“已经调用库的通用 request_cgi”不等于“业务端点已经由库负责”。
其余歌词、artwork、vkey、账户和授权代码仍须逐入口核对生产/test-only 可达性。

独立只读审计进一步确认：

- 账户模型仍是单 Provider 单账户。`ProviderAccount`、`ProviderTrackReference`、
  `QueueEntry`、continuation token、`account-runtime.ts` 和插件 component adapter 均没有
  `profileId` 维度；现有 `account_generation` 只是 Provider 级代次。
- 生产账户读路径的收藏、歌单曲目和最近播放现已统一调用
  `qm-api-rs::account::read_page` typed boundary；账户写路径通过
  `qm-api-rs::account::write_legacy` 的固定 allowlist 和账户凭据边界执行，provider 只负责
  身份快照、缓存、分页、业务结果解释和对账。`write_legacy` 是过渡 façade，下一步应以
  `AccountWrite` 枚举替代其兼容字符串参数。
- 生产加密播放现已通过 `qm-api-rs::SongApi::get_song_urls` 的 typed `CgiGetEVkey`
  路径；provider 仅负责候选音质映射、凭据注入和 CDN/ekey 响应校验。旧
  `musics.fcg` payload/signature 代码仅保留在测试 fixture 中。
- 桌面二维码/OAuth、check-sig、ptqrshow/ptqrlogin 和用户资料验证仍有 provider 自有 HTTP；
  手机 QR/MQTT 已使用库接口，但不代表桌面授权路径已迁移。
- 未发现同一 Provider 多 profile 并行、混合队列来源、profile 切换迟到结果丢弃、禁用/恢复或
  profile-aware continuation 的真实测试。现有 multiple-provider 测试不覆盖这些语义。

因此 A2（推荐）已完成代码切换，但 A1 的完整 pin/source 审阅、A3 媒体协议、A4 账户/授权、
B1/B2 身份与运行时仍是未完成项；本计划不把推荐批次的通过结果升级为全量解耦结论。

B–F 阶段仍未完成；Spotify 真实故障尚未复现。此次计划更新不把任何待办项改为已完成。

## 6. 可执行工作包与依赖

下表为后续实施顺序，不是本次已经执行的修改。每个工作包都应保持可独立审阅；
不能将两个仓库的一系列未验收改动压成一次无法定位失败来源的大提交。

| 工作包                | 前置                | 修改范围与交付物                                                                             | 独立退出条件                                                                    |
| --------------------- | ------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| A0 端点台账           | 当前基线            | 逐入口登记 `qqmusic.rs`、`qqmusic/*`、`qmapi/*` 和库对应方法；区分生产、测试、安全 transport | 每个实际调用有身份、请求、响应、重试和残留位置；清单未覆盖的入口不能称已迁移    |
| A1 当前目录批次收尾   | A0                  | 完整 revision pin；移除确实无引用的旧 Toplist DTO；同步 CI/source manifest/来源记录          | 定向与完整 provider 测试、Clippy、pin 检查通过；发布 readiness 保留真实 pending |
| A2 账户推荐           | A1                  | `personalized_songlists`、`new_song_recommend` 已接 typed Feed；剩余为合成凭据/分页回归补强  | 已避免共享 Client 凭据竞态；完整 parity 与真实账户证据仍待完成                  |
| A3 媒体协议           | A2                  | 歌词、artwork、vkey/EVkey 协议已迁入库；宿主下载和播放编排保留                               | 签名/响应关联/重定向契约及 Android 异步解码降级回归仍待验证                     |
| A4 账户读写与授权     | A3                  | 账户快照、恢复、登录、收藏/歌单/历史 typed API；删除迁完的通用业务 CGI façade                | 既有 QQ/TIM/MQTT/OAuth 回归；取消/晚到/凭据隔离；写请求未知结果不重放           |
| A5 反回流门禁         | A4                  | 扩展 provider 边界测试，建立 typed 端点覆盖检查和窄例外清单                                  | 所有 A0 生产入口已迁完；新增 URL 或动态 CGI 业务构造能使门禁失败                |
| B1 身份与协议         | A0，可独立设计      | `yaqmc-provider-api`、`yaqmc-protocol`、client types 增加 profile-aware 引用和上下文         | 默认 profile 兼容；未知/跨 provider profile 拒绝；协议 fixture 一致             |
| B2 账户运行时与存储   | B1、A4              | Core credentials/storage、provider 实例及 `account-runtime.ts` keyed 化；事务迁移            | 同平台双 profile 并存；刷新/注销/禁用不串账户；中断、重入、备份恢复测试通过     |
| C1 安全端点路由       | B2                  | Core dispatch、plugin manifest/permissions/host、Schema 和版本适配                           | 显式 disabled 不回退；绑定范围与结果提交代次校验；限额、撤权和恶意输入测试通过  |
| C2 推荐替换闭环       | C1                  | 本地推荐示例插件、设置页绑定/启停、明确错误状态                                              | QQ 内置候选可由本地算法排序；输出来源可验证；无网络/无凭据授权也能完成本地推荐  |
| D 来源与混合播放      | B2、C1              | 现有队列/预取/歌词/收藏/分享按条目来源；本地歌单和来源 UI                                    | 浏览平台切换不重绑队列；禁用恢复/账户删除/自动续播代次/跨平台远端写拒绝通过     |
| E0 Spotify 故障复现   | A0，可独立诊断      | 实际插件与宿主授权链证据；核实 client ID、回调和官方播放方式                                 | 定位打不开授权页的失败阶段；不能用新 provider 的成功替代原问题复现              |
| E1 Spotify 授权与目录 | E0、B2              | 独立 provider、现有宿主 broker 的 provider-aware 扩展、PKCE 和目录                           | state/取消/重复回调/刷新隔离自动测试；真实授权和目录单独记录结果                |
| E2 Spotify 播放适配   | E1、D、官方能力选型 | 独立播放 session，与现有可读媒体源类型区分                                                   | 所选平台的真实播放、暂停/seek/结束、音频焦点与队列接续通过；不伪造媒体 URL      |
| F 集成与交付审阅      | A5、C2、D、E2       | 全矩阵、数据回滚演练、公开 API/插件文档、对应源码和最终风险表                                | 功能、数据、安全、构建和真实运行分别有证据；缺环境的项目明确阻塞，不写 PASS     |

每个工作包都须记录：父 revision、实际 diff、新增/更新的回归用例、执行命令与退出码、
未完成项及下一工作包所需契约。并行工作只能读已冻结契约或使用隔离候选目录；
本计划不自动启动子代理、不向其他任务追加消息。

### A1–A2 的首批具体操作

1. 保留当前目录定向测试，先运行完整 provider 测试取得新基线；旧 DTO 先查引用再删除。
2. 将 Cargo.toml 的短 SHA、Cargo.lock、`scripts/ci/qm-api-rs-access.mjs` 及其测试、
   `.github/workflows/electron-release.yml` 的 source checkout 统一到实际完整 revision。
3. 审阅新 revision 对应源码增量后更新 `docs/release` 的来源记录；readiness 的旧豁免保持原适用范围，
   测试应验证 pending 能阻止发布，而不是强制仓库当前记录永远 ready。
4. 使用显式 `Credential` 接入 Feed。若歌单 typed 方法暂不支持单次凭据，先在库补接口，
   禁止对共享 `Client` 临时 `set_credential` 再恢复的竞态实现。
5. 保留现有推荐的页数上限、请求缓存参数和卡片筛选语义；新增类型不能导致多返回一类歌单。
6. 每个 endpoint 增加合成身份/分页/空结果/错误 fixture，禁止删除失败用例或改成接受任意错误。

## 7. 后续验证命令与报告约束

以下是实施阶段需要执行的命令，不是本次全部已通过的记录。命令在对应仓库根目录运行，
使用仓库要求的 Node `26.7.0`、Rust MSRV `1.88.0`；不可在缺工具链时静默用其他版本替代。

`qm-api-rs`：

```powershell
cargo +1.88.0 fmt --all -- --check
cargo +1.88.0 test --locked --offline --all-targets --all-features
cargo +1.88.0 clippy --locked --offline --all-targets --all-features -- -D warnings
git diff --check
```

YAQMC 每批 QQ 接入：

```powershell
cargo +1.88.0 check -p yaqmc-provider-qqmusic --locked --offline --all-targets
cargo +1.88.0 test -p yaqmc-provider-qqmusic --locked --offline
cargo +1.88.0 clippy -p yaqmc-provider-qqmusic --locked --offline --all-targets -- -D warnings
node scripts/ci/qm-api-rs-access.mjs --check
npm run ci:test-scripts
npm run contracts:check
```

YAQMC 最终集成：

```powershell
cargo +1.88.0 fmt --all -- --check
cargo +1.88.0 check --workspace --locked --all-targets
cargo +1.88.0 test --workspace --locked --all-targets
cargo +1.88.0 clippy --workspace --locked --all-targets -- -D warnings
npm run typecheck
npm run lint
npm run format:check
npm run test
npm run build
npm run docs:check
npm run ci:verify-workspace
npm run ci:test-scripts
npm run contracts:check
npm run plugin:validate
npm run plugin:verify:provider-platform-example
npm run typecheck --workspace @yaqmc/desktop
npm run test --workspace @yaqmc/desktop
npm run build --workspace @yaqmc/desktop
npm run android:check
npm run android:build:debug
git diff --check
```

- 缺少 Cargo 离线依赖时，先记录缺项，再针对性获取已锁定依赖；不删除 `--locked` 让依赖漂移。
- 硬性文档/格式失败如来自原有未跟踪交接文件，应单独说明归属，不批量清理用户文件。
- Android 编译不等于真机通过；ADB 状态、安装/运行版本及测试账户授权须在执行时重新确认。
- Electron smoke/E2E 用隔离 profile；Linux 在实际 Linux runner 或环境验证，交叉编译不代替运行测试。
- provenance/readiness 的 report 和 enforce 分开执行；预计 pending 的 enforce 失败也是有效阻断证据，
  不能改 gate 为 pass 或复用旧 waiver 来消除它。
- 每次最终汇报同时给出源码检查、自动测试、构建、真机/LIVE、可发布五项独立结论。
  远端提交/推送、tag、Release、发安装包属于独立外部动作，不由这些验证命令自动触发。

## 8. 必须在对应阶段关闭的决策项

不阻塞 A1–A5 的本地实现，但阻塞相关真实能力验收：

- Spotify 原失败插件的 ID/版本及实际运行宿主；仓库缺少实现不能证明外部插件没有问题。
- 可用的公开 Spotify client ID、注册回调与官方开发者访问限制；不要求用户提供 client secret。
- Spotify 播放目标究竟是 YAQMC 内播放还是控制已有 Spotify 设备，以及账户等级/官方支持条件。
  在核验前默认将受限播放显示 unavailable，不用 QQ 音源暗中替代。
- 真实账户写入、真实 Spotify 授权与 ADB 安装的测试环境和授权，仅在需要时确认具体范围。

不以固定日历工期承诺尚未核实的上游协议或 Spotify 平台能力。进度以工作包退出条件计量；
高风险身份/凭据/迁移/插件边界需要独立复核，普通本地检查不宣称外部可信审计已通过。
