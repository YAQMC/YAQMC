# 音乐提供器契约

> **简体中文** | [English](../provider-contract.md)

当前 `MusicProvider` 作为兼容契约保留；Core 逐步迁移到可组合能力视图：

- `CatalogProvider`：规范化目录、主页、发现页、封面和缓存；
- `PlaybackSourceProvider`：音源解析与音质选择；
- `RecommendationProvider`：推荐续播批次；
- `LyricsProvider`：规范化歌词；
- `AccountProvider`：对现有 `ProviderAccount` 的可选封装。

兼容 façade 把内置 QQ provider 投影到上述全部能力，不改变用户可见行为。后续仅提供目录的平台不再被迫实现
登录和账号写操作。只有 Core 消费方完成迁移后才删除旧 `MusicProvider`。

`MusicProvider` 只暴露规范化公开目录操作：主页/访客音乐库、分页搜索、专辑与歌单/榜单详情、歌词。
`ProviderAccount` 是原生提供器实现的账号契约，负责账号快照/OAuth 生命周期、收藏、账号歌单、
最近播放和类型化写操作。公开 Home/Search/Explore 只依赖 `MusicProvider`，账号功能失败不能拖垮访客目录。

进入 React 的值统一使用 `src/domain/music.ts`。QQ 的歌曲 MID、数字 song ID、album MID/ID 和 media MID
不是同一个标识，不能互换。

## Provider 标识与路由

`ProviderRegistry` 现在持有经过验证的运行时 ID，不再借用 `&'static str`。ID 长度为 1–64 字节，只允许
小写 ASCII 字母、数字、点、下划线和连字符；斜杠、冒号、空白、大写字母和控制字符在注册前即被拒绝。
因此配置或插件可以提供动态 ID，同时不能把路径形状的输入带进注册表。

没有 provider reference 的旧歌曲仍使用默认 provider。若歌曲明确指定未知或已停用 provider，则以
`TrackUnavailable` 失败；不能回退到默认 provider，也不能跨平台用同名歌曲替代。

## 播放元数据

歌曲可带：

- `audioFormats`：codec、名义音质/码率、采样率、位深和无损标记；
- `playbackCapability`：完整播放、有限官方试听或不可播放；
- `availability`：可用、不可用或需要权益；
- `provider`：稳定提供器 ID 和原生解析所需不透明 ID。

目录音质不是账号权益证明。原生解析器在播放时请求合法 URL，返回 full/preview/unavailable，URL 不进入
前端。

## 实现

默认 `QQMusicProvider` 是薄 Electron/Core 协议适配器；Rust 负责 HTTP、DTO 解析、封面缓存、歌词解密、音源签名、
秘密存储和错误映射。公开能力包含搜索、专辑/艺人、歌单/榜单、逐字歌词、流媒体和音质选择；账号扩展
只在主渲染器暴露 OAuth，自有/收藏写操作需要认证，最近播放只在能力快照声明时调用。状态仍是“已实现，
等待真实账号验收”。

`FakeMusicProvider` 永久保留，用于浏览器开发、单元测试、截图和离线 UI。它深拷贝 fixture、支持取消、
稳定缺失实体错误，并覆盖所有歌词状态。

## 错误与秘密边界

提供器错误含稳定 `code`、克制 message 和 `retryable`。断网、超时、限流可有限重试；认证过期、权益、
缺失实体、畸形数据和 schema 变化不能盲目重试。旧 query/route 结果必须丢弃，并尽量保留上一个一致页面。

Raw DTO、Cookie header、签名 URL、上游歌词语法和缓存路径不得穿过契约。账号写仅返回 `applied`、
`rejected`、`reconciled`、`outcome-unknown`；超时不能在安全回读前显示为成功。

继续阅读：[QQ 音乐提供器](qqmusic-provider.md)和[账号音乐库](account-library.md)。
