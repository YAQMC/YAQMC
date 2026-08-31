# 下一阶段功能路线图

> **简体中文** | [English](../roadmap.md)

本文是歌曲分享、推荐续播、收听统计、发现页分类和 Provider 插件的工程实施计划。它描述依赖关系、边界、
验收条件和风险，不承诺具体发布日期。功能只有在对应验收条件满足后才可以在发布说明中标记为完成。

## 实施状态

- [x] P0 —— 可组合 Provider 能力、运行时安全 Provider ID，以及 `qm-api-rs` 类型化推荐接口。
- [x] P1 —— 可访问的发现页标签、提供器中立分享，以及 fail-closed Electron 深链。
- [x] P2 —— Core 持有的猜你喜欢/雷达续播，包含有界预取、重试、去重和过期响应守卫。
- [x] P3 —— 本机收听统计。
- [x] P4/P5 —— 沙箱化 Provider 插件运行时，以及生命周期/UI 集成。
- [x] P6 自动收尾 —— 本机 Windows 及原生 Linux/Windows CI 可复现证据。

已勾选项目只代表自动实现门禁通过，不代表可发布、生产账号、GUI、LIVE、打包或维护者最终签收。精确依赖固定的
三日 Provider soak 仍为 `not-started`；见 [Provider Component v3 自动收尾](../release/provider-component-v3.md)。

## 1. 目标与非目标

本路线图交付五组能力：

1. 分享歌曲信息、提供商公开链接和 YAQMC 内部深链。
2. 让“猜你喜欢”和“听《歌曲》也会喜欢”使用同一套可靠的连续推荐会话。
3. 在本机统计真实收听行为，而不是把“解析过音源”误当作“听过”。
4. 把发现页改为可访问、可键盘操作的分类标签页。
5. 让插件能够提供自定义音乐平台、音源、歌词和账号能力，同时维持明确的安全边界。

以下内容不在本路线图内：

- 浏览器版或浏览器扩展；YAQMC 仍是 Electron 桌面应用。
- 云端统计、云同步、社交动态和公开用户画像。
- 插件市场、自动远程更新和发行方信任体系。
- 原生 `dll`、`so`、任意子进程或不受控 Shell 插件。
- 通过分享链接自动播放、自动登录或静默修改账号状态。
- 在 YAQMC 中新增 QQ 音乐上游 URL、模块名或方法名。

## 2. 不可破坏的工程边界

### 2.1 网络与提供器边界

- QQ 音乐网络协议必须由 `qm-api-rs` 提供类型化接口、DTO 和契约测试。YAQMC 的 QQ 音乐适配器只负责
  调用、归一化和错误映射。
- 若功能所需接口在 `qm-api-rs` 中缺失，先在该仓库增加接口和测试，再把 YAQMC 固定到精确 commit。
- YAQMC 中现有的推荐路由字符串也要在续播工作开始前迁回 `qm-api-rs`；不能因为它们已经存在就继续扩展。
- 第三方平台插件不经过 `qm-api-rs`。它们只能调用 Extension Host 明确授予的 HTTPS、凭据、存储等能力。

### 2.2 状态归属

- Core 的 `PlayerService` 是队列、当前曲目、播放时钟、EOS 和推荐会话的唯一事实来源。
- React/Zustand 只保存视图投影和短暂交互状态，不能决定原生播放会话是否仍然有效。
- Electron Main 只处理窗口、系统协议、文件对话框和操作系统集成，不实现音乐平台 API。
- 凭据、签名 URL、敏感鉴权头和 Cookie 不进入渲染进程、日志、统计记录或分享文本。

### 2.3 兼容性与隐私

- Plugin API v1/v2 和现有样式、歌词场景、脚本插件继续可用；Provider 插件使用新的 manifest/API 版本。
- 收听统计默认仅保存在本机，不发送遥测；用户可以导出和清除。
- 所有外部 URI、插件包、插件返回值和提供器标识都按不可信输入处理。
- 自动测试不使用维护者生产账号。真实账号、GUI、LIVE 和最终发布验收只在实现汇报后由维护者另行授权。

## 3. 实施前基线与缺口

- 分享：没有歌曲分享动作，也没有自定义 URI scheme；现有 `shell.openExternal` 只允许固定产品链接。
- 猜你喜欢：`useGuessContinuation` 在 React 中观察 `ended` 并追加五首歌；原生命令提前返回时，
  `guessSessionActive` 的重置并不可靠。
- 雷达推荐：首页可以展示“听《歌曲》也会喜欢”，但列表没有连续推荐会话。
- 统计：`playback_history` 保存最近解析过的歌曲快照，不能表达暂停、跳过、完整播放或实际收听时长。
- 发现页：一个 `DiscoverFeed` 已经包含全部区段，但页面把所有内容纵向铺开，没有标签页。
- 插件：当前 manifest v1 / API v2 支持样式、歌词场景、隔离脚本、安全 UI 插槽和受限 HTTPS；
  `provider`、`account`、`native`、`filesystem` 仍是保留且禁止的权限。
- 提供器：Rust `MusicProvider` 强制同时实现播放、目录和账号，注册表 ID 是 `&'static str`；前端也只暴露
  一个活动 `MusicProvider`。这两点都会阻碍动态平台和无账号提供器。

## 4. 目标架构

```text
React UI
  -> 类型化 Renderer/Core 协议
  -> Core 服务
       - PlayerService（队列、时钟、EOS）
       - ContinuationService（推荐会话、预取、去重）
       - ListeningStatisticsService（事件记录、聚合、导出）
       - ProviderRegistry（动态能力与实例）
       - ExtensionHost（插件生命周期与能力沙箱）
            -> 内置 QQMusic Provider -> qm-api-rs
            -> WASM Provider Component -> 受限 Host 能力
  -> Electron Main（深链、窗口、系统对话框）
```

提供器契约从一个“大而全”的 trait 逐步拆成可组合能力：

- `CatalogProvider`：搜索、歌曲、专辑、歌手、歌单和发现内容。
- `PlaybackSourceProvider`：解析可播放源；敏感 URL 和 Header 保留在 Core。
- `RecommendationProvider`：猜你喜欢、雷达推荐和连续批次。
- `LyricsProvider`：普通、逐字和翻译歌词。
- `AccountProvider`：登录、账号快照、收藏和账号歌单；它是可选能力。
- `ShareProvider`：规范化公开链接和可分享元数据。

迁移期保留一个兼容适配器，把当前内置 QQ `MusicProvider` 映射到这些能力。只有在协议消费者完成迁移后才删除
旧的单体接口，避免一次性重写播放器、账号页和测试夹具。

`ProviderRegistry` 改用受校验的运行时字符串 ID，并区分：

- 提供器类型：例如内置 `qqmusic` 或某个插件提供的平台。
- 提供器实例：插件、配置和存储域的组合。
- 账号配置：隶属于一个提供器实例；首版允许保存多个账号，但每个实例只有一个活动账号。

队列中的每首歌继续携带 `providerId + trackId`，因此队列可以跨提供器。提供器被停用时，相应曲目显示为不可用并
安全跳过，不能悄悄回退到其他平台的同名歌曲。

## 5. 工作流 A：歌曲分享

### 5.1 契约

增加提供器中立的分享结果：

```text
ShareTarget
  providerId
  entityKind = song
  entityId
  title
  artists[]
  album?
  canonicalHttpsUrl?
```

QQ 音乐的公开链接解析由 QQ Provider 负责；如需网络读取或上游字段，先通过 `qm-api-rs` 增加类型化接口。
React 不拼接平台域名或上游路由。

### 5.2 用户体验

首版提供两个明确动作：

- **复制公开链接**：优先复制提供器返回的 HTTPS 链接；没有公开链接时禁用并解释原因。
- **复制 YAQMC 链接**：复制 `yaqmc://catalog/<provider>/song?id=<percent-encoded-id>`，用于已安装 YAQMC 的设备。

分享动作出现在歌曲页、Player Bar 的更多菜单、歌词页和 TrackList 的歌曲上下文菜单。复制成功或失败使用现有通知
系统反馈。为不支持链接的平台，还可复制纯文本 `歌曲 — 歌手`，但不能伪装成可点击链接。

### 5.3 深链处理

- Electron 注册 `yaqmc` scheme，并复用现有 single-instance 机制。
- Windows/Linux 的 `second-instance` 和 macOS 的 `open-url` 都进入同一个纯解析器。
- 解析器只接受 `catalog/song`，限制 URI 总长、provider ID 和 entity ID 长度，并拒绝用户名、端口、片段、
  未知查询参数、控制字符和重复关键参数。
- 解析结果只转换成类型化的“打开歌曲详情”导航命令；不进入 Shell、文件系统、SQL、HTML 或任意 IPC。
- 深链只聚焦主窗口并打开详情，不自动播放、不登录、不打开辅助歌词窗口。
- 注册失败不阻止应用启动；设置页显示当前协议注册状态并允许关闭。

Electron 官方文档说明 Windows/Linux 第二实例需要专门处理，见
[Electron Deep Links](https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app)。

### 5.4 验收条件

- 四个入口复制出的文本一致，特殊字符 ID 可以往返解析。
- 已启动和未启动两种场景都只打开一个主窗口并导航到正确歌曲。
- 模糊测试覆盖超长 URI、重复参数、编码错误和注入式输入。
- 链接绝不触发播放、账号变更、外部 Shell 或敏感数据输出。
- 没有公开链接时，UI 明确降级，不生成猜测 URL。

## 6. 工作流 B：猜你喜欢与雷达续播

### 6.1 Core 推荐会话

用 `ContinuationService` 替换 renderer 中的 `guessSessionActive`。会话至少保存：

- `sessionId`、`providerId`、`kind`（`guess` / `radar`）和创建时的账号代次。
- 雷达入口歌曲或猜你喜欢上下文、provider cursor/page 和请求代次。
- 已见过的 `providerId + trackId` 集合、连续空批次数和当前请求状态。

以下操作开启会话：

- 点击猜你喜欢卡片的播放/打开动作。
- 点击“听《歌曲》也会喜欢”区段的播放动作或其中任意歌曲；从被点击歌曲开始，保留该区段后续歌曲。

以下操作结束会话：

- 用其他页面内容替换队列、切换活动提供器/账号、退出登录、停用提供器或显式停止。
- 提供器明确返回结束，或连续三批在去重后为空。

暂停、恢复、Seek、队列重排和手工追加歌曲不结束会话。Repeat One 不发起新批次；Repeat All 在活动推荐会话中只控制
当前队列遍历，不阻止预取。

### 6.2 预取、去重与错误

- 当当前曲目之后只剩两首可播放推荐时，Core 异步预取下一批，默认批量为五首。
- 响应必须匹配会话 ID、请求代次、提供器和账号代次；过期响应无条件丢弃。
- 在会话范围内按 `providerId + trackId` 去重，最多保留 500 个已见 ID；超过后结束会话，避免无限增长。
- 网络/限流错误使用有抖动的 `1s / 3s / 8s` 三次重试。已有队列继续播放；耗尽后结束会话并显示一次非阻塞通知。
- 鉴权、协议结构、权益和不支持错误不盲目重试。
- 追加是原子操作，永不清空用户队列；Core 自动 EOS 转场继续负责真正的下一首。

### 6.3 `qm-api-rs` 前置工作

当前 `qm-api-rs` 已有猜你喜欢和雷达入口，但参数不足；YAQMC 内仍存在 `get_radio_track` 和 `GetRadarSong` 路由字符串。
续播实现前必须：

1. 在 `qm-api-rs` 增加带 `limit/from/cursor` 的猜你喜欢请求，以及带 `page/entranceSongs/credential` 的雷达请求。
2. 在 `qm-api-rs` 增加成功、空结果、非零 code 和结构漂移契约测试。
3. 在 YAQMC 更新精确 `rev` 和 provenance 记录。
4. 删除 YAQMC QQ Provider 中相应的模块名、方法名、原始 JSON 请求和重复 DTO 解析。

### 6.4 验收条件

- 原生播放器连续播放至少三个批次，不出现 React `ended` 竞态或重复首曲。
- 猜你喜欢和雷达共用一套 Core 状态机，但保留不同 seed/cursor。
- 切歌、Seek、Repeat One/All、Shuffle、队列编辑、账号切换和退出均有确定测试。
- 延迟响应不能污染新会话；重复、空批次和提供器失败不会形成无限循环。
- 未登录降级行为由提供器能力声明，不在 UI 中猜测。

## 7. 工作流 C：本地收听统计

### 7.1 统计定义

统计由 Core 播放时钟累计，不使用 wall-clock 推算：

- 只有同一 `sessionId` 处于 `Playing` 且引擎位置正常推进时才增加 `listenedMs`。
- 暂停、缓冲、Seek 跳跃和错误恢复等待不增加时长。
- “有效播放”阈值为 `min(30 秒, 已知可播放时长的 50%)`；未知时长使用 30 秒。
- `completed`：权威 EOS。
- `qualified`：达到有效播放阈值后由 Next、队列跳转、停止或替换结束。
- `skipped`：显式 Next/队列跳转发生在阈值前。
- `stopped`：停止、退出或队列替换发生在阈值前。
- `error`：不可恢复错误在阈值前结束；达到阈值后仍记为 `qualified`，同时保留错误标记。
- Repeat One 每次 EOS 结束一个记录并开启新的播放记录；Preview 使用实际可播放时长计算阈值。

### 7.2 存储

增加独立 `listening_sessions` 表，不改变 `playback_history` 的“最近播放快照”用途。记录包括：

- 不透明 session ID、provider/track/album/artist 标识和归一化显示快照。
- 开始/结束时间、累计收听毫秒、可播放时长、结果、来源上下文。
- 请求音质、实际音质、是否 Preview；不保存 URL、Header、Cookie、账号 token 或原始上游 JSON。

活动记录在内存累计，每 15 秒和每次播放状态/曲目切换时事务化 checkpoint；崩溃最多损失一个 checkpoint 周期。
启动时把遗留的 `in_progress` 记录安全结算为 `stopped`。首版保留全部记录以保证 all-time 精确，并显示数据库占用；
若真实数据证明聚合变慢，再引入版本化 rollup，而不是先牺牲准确性。

索引覆盖结束时间、`provider + track`、album 和 artist。单次状态更新为 O(1) 内存操作；checkpoint 的数据库复杂度为
O(log n) 索引写入。按范围聚合最坏为 O(n)，首版通过索引和分页限制结果集。

### 7.3 UI 与协议

新增“统计”侧边栏页面，提供滚动 7 天、30 天、365 天和全部时间范围：

- 总有效收听时长、有效播放次数、完整播放数和跳过率。
- 热门歌曲、歌手和专辑。
- 每日收听趋势、音质分布和提供器分布。
- JSON/CSV 导出、数据库占用和二次确认的清除操作。

Renderer 只调用 `statistics_snapshot(range)`、`statistics_export(format)` 和 `statistics_clear()` 等类型化 Core 方法。
文件路径由 Electron 保存对话框与 Core 协作处理，不让插件或辅助窗口获得任意路径能力。Core 发布
`statistics.changed`，UI 做节流刷新，不按播放时钟频率重查数据库。

### 7.4 验收条件

- 确定性时钟测试覆盖暂停、缓冲、Seek、Next、Previous、Repeat、Preview、错误和崩溃恢复。
- 同一测试播放脚本的 UI 汇总、JSON 和 CSV 数值一致。
- 清除操作原子完成，不能删除队列、缓存、账号或最近搜索。
- 断网时统计完整可用，网络抓包中没有统计上传。
- 10 万条会话的常用范围查询在目标机器上保持可交互；若不满足，必须在交付前增加 rollup 或查询优化。

## 8. 工作流 D：发现页标签分类

首版不新增网络 API，也不改变 `DiscoverFeed` 缓存。页面只重组已有数据，降低回归范围：

- **精选**：featured 和 popular songlists。
- **排行榜**：charts。
- **新歌**：new songs。
- **新专辑**：new albums。
- **分类**：areas/categories。
- **MV**：new MVs。
- **播客**：podcasts。

只有有内容的分类才生成 tab；刷新后若活动分类消失，回退到第一个可用分类。选择按 provider ID 在当前应用会话内记忆，
不写入长期偏好。窄窗口使用水平滚动，不缩成不可读文字。

沿用歌手页/搜索页的无障碍模式：`tablist`、`tab`、`tabpanel`、`aria-selected`、`aria-controls`、roving
`tabIndex`，支持 Left/Right、Home/End。当前 feed 已预加载，焦点移动可以即时激活；未来若插件分类需要慢速懒加载，
改为 Enter/Space 手动激活，避免键盘焦点被网络延迟阻塞。实现以
[W3C WAI-ARIA Tabs Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) 为准。

验收条件：

- 初次加载仍只发一次 discover 请求，定时刷新和旧内容保留语义不变。
- 鼠标、键盘和屏幕阅读器关系完整；隐藏 panel 不可聚焦。
- 空分类、刷新分类变化、窄窗口、错误和 stale cache 均有测试。
- Play/Open 行为与当前页面一致，改 tab 不重置播放器或滚动整个应用。

## 9. 工作流 E：Provider 插件 v3

### 9.1 运行时选择

Provider 插件不在 renderer Worker 中执行，也不加载原生动态库。Plugin API v3 使用 Wasmtime 托管的
WebAssembly Component Model，首版固定到 WASI 0.2 和一套版本化自定义 WIT world。选择 0.2 是为了使用稳定、
可固定的工具链；WASI 0.3 只在兼容性和 Rust 工具链验证完成后另行升级。

WIT 明确列出 component 的 exports/imports；未授予的能力根本不出现在实例中。Component Model 官方说明 world 是
严格的导入/导出边界，见
[Component Model Worlds](https://component-model.bytecodealliance.org/design/worlds.html)。

### 9.2 manifest 与能力

新增 `manifestVersion: 2`、`apiVersion: 3`，并增加 component entrypoint。一个插件可以组合：

- `provider.catalog`：平台目录、搜索、实体和发现内容。
- `provider.playback`：音源匹配和解析。
- `provider.recommendation`：首页推荐和续播。
- `provider.lyrics`：歌词源。
- `provider.account`：该插件提供器的登录、账号状态和账号库。

账号能力必须绑定到同一插件的 provider 实例，不能读取或覆盖内置 QQ 账号，也不能声明“全局账号代理”。音源插件返回
不透明 source handle 或 Host 请求配方；签名 URL、Header 和 token 在 Core 内消费，不进入 React。

现有 manifest v1 / API v1-v2 继续使用原限制。包含 WASM component 的 v3 包使用独立上限：32 MiB 压缩、
96 MiB 展开、单个 component 32 MiB、最多 512 个文件。提高上限不能放宽 zip-slip、symlink、重复路径和展开炸弹检查。

### 9.3 Host 能力与默认拒绝

WASM 实例默认没有文件系统、环境变量、Shell、子进程、原始 socket、任意 IPC 或宿主凭据。可按 manifest 和用户同意
授予：

- 精确 origin 的 HTTPS 代理；每次重定向重做 scheme、DNS 和私网/回环地址检查。
- 插件私有的凭据句柄；只允许该插件在 Host 请求中引用，不能枚举或读取其他域。
- 4 MiB 插件 KV 设置、64 MiB 受管缓存、单调时钟、随机数和脱敏日志。
- 受限账号授权窗口；只加载 manifest 白名单 origin，只接受随机 state 绑定的回调。

默认资源预算：每实例 64 MiB 内存、最多 4 个并发 Host 请求、4 MiB 单响应、15 秒操作 deadline，以及独立的
CPU fuel/epoch 中断。三次连续沙箱 fault 触发当次会话熔断；再次启用前显示原因。网络权限、账号权限或 origin 增加时必须
重新征得同意。

Provider 插件首版只支持本地旁加载并标记“未验证发布者”。不实现市场、远程更新或签名信任，也不允许插件添加任意
HTML 设置页；设置继续使用声明式 schema 和安全 UI 插槽。

### 9.4 交付顺序

1. 完成动态 `ProviderRegistry`、能力拆分和内置 QQ 兼容适配器，行为不变。
2. 定义并冻结 WIT v0.1，建立 Rust 示例 component 和契约夹具。
3. 交付只读目录插件：搜索、歌曲、专辑和歌手。
4. 交付音源插件：opaque handle、Core 内流式读取、取消和权益错误。
5. 交付账号插件：授权窗口、插件凭据域、登录/退出和账号切换。
6. 再开放推荐、发现和歌词能力；每项都有独立权限与示例。

### 9.5 验收条件

- Windows/Linux x64 与 arm64 使用同一 component 包；不含平台原生二进制。
- 示例平台插件可以搜索、打开实体并播放；示例账号插件只能访问自己的凭据。
- 恶意/损坏 component、超时、OOM、重定向 SSRF、DNS rebinding 和 zip bomb 都被隔离且不能终止 Core。
- 停用/卸载 provider 后，队列和页面显示确定的 unavailable 状态；重新启用可恢复。
- Plugin API v1/v2 的现有示例和用户数据保持兼容。
- 任何新增权限都能在安装/更新 UI 中逐项解释，撤销后立即生效。

## 10. 分阶段实施

### P0：契约与上游清债

- 为提供器能力拆分增加兼容 façade 和动态 ID，不改变现有用户行为。
- 在 `qm-api-rs` 完善推荐参数与契约，并移除 YAQMC 内相应上游路由。
- 扩展协议 fixture、错误模型和 provenance；保持内置 QQ 与 fake provider 全部测试通过。

退出条件：仓库扫描无法在 YAQMC QQ 适配器中找到本阶段迁移的模块/方法字符串，现有播放和账号矩阵无回归。

### P1：低风险用户界面

- 交付发现页 tabs。
- 交付 ShareTarget、复制公开链接和纯文本降级。
- 深链解析器与 Electron 注册单独提交，便于独立回滚。

退出条件：文档、i18n、无障碍、单元测试和 Electron 本地深链集成测试通过。

### P2：Core 连续推荐

- 增加 `ContinuationService`、Core 协议投影和猜你喜欢迁移。
- 接入雷达会话、预取、去重、重试和账号代次。
- 删除 renderer 会话事实状态和旧续播 Hook。

退出条件：原生播放器确定性矩阵和本地 fake-provider E2E 通过，LIVE 验收仍等待维护者授权。

### P3：本地统计

- 增加 schema migration、Core recorder/aggregator、导出/清除协议和统计页。
- 运行大数据量基准，确定是否需要首版 rollup。

退出条件：时钟语义测试、迁移/崩溃恢复、隐私扫描和 10 万条性能门槛通过。

### P4：Plugin v3 基础

- 完成 Wasmtime 技术验证、WIT 冻结、package v2、权限同意和资源限制。
- 先发布只读目录示例，不承诺播放或账号。

退出条件：安全测试和跨平台 component 夹具通过；若沙箱、体积或启动时间不满足预算，则停止扩展，不开放音源权限。

### P5：平台、音源与账号插件

- 依次开放 playback、account、recommendation、discover 和 lyrics capability。
- 每项能力单独增加示例、威胁模型、恢复策略和更新时重新授权测试。

退出条件：端到端示例、跨提供器队列、账号隔离、故障熔断和 v1/v2 兼容矩阵通过。

### P6：发布收口

- 更新双语用户/开发者文档、OpenAPI/协议 fixture、第三方许可和 release provenance。
- 完成本机 Windows 自动矩阵及原生 Linux/Windows CI 矩阵，并生成可复现证据。
- 实现方先报告自动检查和已知限制；是否执行真实账号、GUI、LIVE、打包和最终 HUMAN 签收由维护者随后决定。

自动收尾证据：[Provider Component v3](../release/provider-component-v3.md)。发布就绪仍被精确依赖固定的三日
Provider soak 阻断；该记录不代表 GUI、LIVE、真实账号、打包或 HUMAN 通过。

## 11. 测试与质量门槛

每个阶段至少包含：

- TypeScript 单元/组件测试、Rust 单元/集成测试和协议 golden fixture。
- fake provider 确定性流程；测试数据不能进入 release renderer 或正式包。
- Core 重启、取消、过期响应、空结果、错误映射和并发竞态测试。
- Electron E2E 只把 Playwright 用作 Electron 自动化驱动，不创建浏览器产品目标，也不把测试 harness 打进正式包。
- `cargo fmt`、MSRV `cargo check/clippy/test`、TypeScript、ESLint、Prettier、公共文档和 secret scan。
- 插件阶段额外运行 manifest/package fuzz、WASM 资源耗尽、SSRF、重定向、DNS rebinding、凭据隔离和故障恢复测试。

性能预算：

- 发现页切 tab 不触发网络且单次渲染只与活动区段项目数线性相关。
- 推荐批次处理为 O(b)；会话去重为均摊 O(1)/曲目，内存上限 500 个 ID。
- 统计时钟 tick 为 O(1)，不随历史记录数增长。
- 插件调用有固定内存、并发、响应体和 deadline 上限；插件失败不能阻塞播放器时钟或主窗口。

## 12. 主要风险与取舍

- Provider 插件是最大范围和最高安全风险，必须晚于能力拆分与 Wasmtime 技术门；不能与普通样式插件同等信任。
- 深链改善分享体验，但扩大外部输入面，因此只允许导航，不允许命令式动作。
- 统计口径是产品策略；本文固定了首版定义，后续修改必须版本化，不能静默重算历史。
- 推荐接口可能受登录态、限流和上游结构影响；预取改善间隙，但会增加少量请求，必须在会话结束时立即取消。
- 多提供器队列提升扩展性，也会暴露失效提供器；明确 unavailable 比自动跨平台匹配更安全且可预测。
- WASM 增加二进制体积和启动成本，但相比原生插件提供跨平台和能力隔离；若技术验证超预算，保留现有 v2，
  不以不安全的 Node/native 方案替代。

## 13. 完成定义

某项功能只有同时满足以下条件才算完成：

- 生产路径使用 Core/Provider/Host 的正确边界，没有 renderer 上游 API 或新的 QQ 路由字符串。
- 正常、空、错误、取消、过期响应、重启和权限撤销都有测试。
- 双语用户文档、开发者契约、隐私与安全说明同步更新。
- 正式构建不包含 fake 数据、测试入口、Playwright harness、fixture 或调试开关。
- 自动验证结果和未执行的 HUMAN/LIVE 项目被准确报告，不把 waiver 写成 PASS。
- 维护者在实现汇报后明确授权最终验收；在此之前不触碰生产账号或创建发布。
