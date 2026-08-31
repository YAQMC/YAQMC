# 整体架构

> **简体中文** | [English](../architecture.md)

YAQMC 是 Electron 桌面应用。React 负责展示，Rust Core 负责 QQ 音乐网络访问、凭据、缓存、原生音频、
系统媒体控制以及窗口策略。浏览器层不会持有播放 URL、Cookie、vkey/ekey 或操作系统凭据。

```text
沙箱化 React renderer（主窗口 / 歌词 / 歌词岛 / OAuth）
        │ contextBridge：按窗口角色限制 API
        ▼
Electron preload + Main
窗口 · 托盘 · 快捷键 · 更新器 · 对话框 · Core supervisor
        │ 子进程 stdio 上的 framed protocol v1
        ▼
yaqmc-core
ProviderRegistry
        ├── QQMusicProvider ── 精确 pin 的 qm-api-rs + 保留的 hybrid
        └── ExtensionHost ── Wasmtime Provider Component（`yaqmc:provider@0.1.0`）
                              └── 由 WIT world 选定的 Host import
                                  精确 origin HTTPS · 私有存储/缓存 · 凭据句柄
        │
        ├── PlayerService ── MediaPreparer / HTTP Range 缓存 ── AudioEngine（Rodio / CPAL）
        ├── ContinuationService ── 类型化 RecommendationProvider 批次
        ├── StorageService ── SQLite、设置、历史、队列、缓存索引
        ├── CredentialStore ── 操作系统 keychain / credential vault
        ├── LocalApiService ── 认证后的 127.0.0.1 HTTP + SSE
        └── SystemMediaIntegration ── MPRIS 2.2 / SMTC

仅 QA 的 Vite 开发服务器：React ── FakeMusicProvider + 模拟 adapter
发行 renderer：只使用 NativeApplication；bundle 扫描器拒绝假数据和 QA hook
```

## 责任边界

- `src/domain`：与提供器无关的歌曲、歌词、账号和播放模型。
- `src/providers`：公开目录接口、QQ 音乐 Electron 协议适配器，以及只供开发/测试使用的假数据提供器。
- `src/application`：React 状态投影、偏好设置、播放与登录运行时协调。
- `src/components`、`src/pages`、`src/surfaces`：主窗口和歌词窗口。
- `crates/yaqmc-core/src/player.rs`：队列、当前曲目、进度、循环/随机、音量、错误与歌词时钟的唯一事实源。
- `crates/yaqmc-core/src/continuation.rs`：猜你喜欢/雷达会话、cursor、去重、预取、有界重试与过期响应丢弃；
  只通过 `PlayerService` 原子追加，React 不保存会话事实。
- `crates/yaqmc-core/src/audio.rs`：解码、输出设备和 seek。
- `crates/yaqmc-core/src/streaming.rs`：HTTP Range、稀疏缓存和授权 mflac 读取。
- `crates/yaqmc-provider-api`：对象安全的目录/账号 trait、冻结 wire DTO 与 provider registry。
- `crates/yaqmc-provider-qqmusic/src/qqmusic.rs`：兼容协议、账号资料与音源解析；OAuth 窗口位于 Electron Main。
- `ExtensionHost`：Provider Component 的安装/启用状态、能力授权、代次、故障预算和 Wasmtime 实例。manifest
  只选择一个冻结 WIT world；网络、存储、缓存和凭据操作全部留在 Host，guest 不获得环境文件系统/网络或凭据值。
- Component 只返回有界音源配方，Core 将其转成不透明 `Read + Seek` 源。签名 URL、header、缓存路径和凭据句柄
  不进入 renderer IPC；账号存储和凭据按 provider 实例隔离，不能覆盖内置 QQ 音乐账号。
- `crates/yaqmc-core/src/storage.rs`：SQLite 与文件缓存索引。

## 数据流

1. React 通过 `MusicProvider` 请求公开目录；账号页面通过 `ProviderAccount` 契约访问。
2. Rust 校验地址、请求和响应，把上游 DTO 转成稳定领域类型。
3. 普通播放请求进入 `PlayerService`；猜你喜欢/雷达播放请求同时建立一个 Core 推荐会话，并携带提供器 seed。
4. 缓存/Range 层向音频线程提供 `Read + Seek`；加密 mflac 只在读取时于内存解密。
5. 原生播放快照投影到 React、MPRIS/SMTC、本地 API、托盘与歌词窗口；这些适配器不拥有独立状态。
6. 推荐会话接近队尾时由 Core 预取类型化批次；会话、请求、提供器或账号代次不匹配的响应全部丢弃。
7. 队列、模式、音量和选中曲目写入 SQLite；账号秘密只进入操作系统安全存储。

Vite 开发服务器只为确定性本机 QA 组合 `FakeMusicProvider`，不是浏览器产品目标。正式 Vite 与 Electron Main
使用独立的 release build 语义；打包前的受检 bundle 门禁会拒绝假实体、Playwright/E2E hook、诊断 query 开关、
harness 路径和非产品封面。

## 并发与故障边界

- 曲目加载、页面请求、登录和账号操作都带 generation；旧请求不能覆盖新状态。
- 账号读写还绑定随机的账号 scope。注销或换号会取消旧 I/O，并禁止旧结果写入 UI/缓存。
- 停用 Component 会取消其调用、撤销不透明音源，并保留明确不可用的队列/路由；重新启用同一 provider ID
  会创建新代次，只恢复该 provider 的状态。
- 过期签名 URL 最多重新解析一次，不进行无界重试。
- 无输出设备时使用稳定的“设备不可用”实现，目录、设置和缓存仍可使用。
- 缓存写入使用随机 `.part` 文件和原子重命名，启动时清理中断残留。

继续阅读：[播放](playback.md)、[QQ 音乐提供器](qqmusic-provider.md)、[登录](authentication.md)和
[缓存](caching.md)。
