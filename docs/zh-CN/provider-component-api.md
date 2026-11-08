# Provider Component API

> **简体中文** | [English](../provider-component-api.md)

Plugin API v3 冻结 `yaqmc:provider@0.1.0` WIT 包。机器可读操作清单是
[`protocol-v0.1.json`](../../wit/yaqmc-provider/protocol-v0.1.json)，WIT world 与 Host import 定义在
[`yaqmc-provider.wit`](../../wit/yaqmc-provider/yaqmc-provider.wit)。CI 会检查该清单、Core Component 适配器、renderer
IPC fixture 和本地 OpenAPI 中 provider 身份是否漂移。

## 信封

每个 Component 只导出一个函数：

```text
invoke(capability, operation, payload-json) -> result<string, string>
```

请求和成功响应使用有界 JSON。客体错误使用 `{ code, message, retryable }`，Core 会清洗其结构，错误中禁止出现密钥值。
JSON 信封让应用 DTO 可以独立于 Component ABI 版本化，但它不会授予权限：Host 每次分派前核对 manifest capability，
Component 也只能调用所选 WIT world 实际存在的 import。

## 能力

| 能力                      | 操作族                                 | Host 行为                                                        |
| ------------------------- | -------------------------------------- | ---------------------------------------------------------------- |
| `provider.catalog`        | 搜索、实体、歌手分页、首页、发现、专区 | 校验并重新限定每个实体和 provider 引用。                         |
| `provider.playback`       | 解析、客户端降级、音质选择             | 只接受不透明受管缓存或精确 origin HTTPS 配方，由 Core 流式消费。 |
| `provider.recommendation` | 下一批续播                             | 按 provider/账号代次隔离并丢弃过期响应。                         |
| `provider.lyrics`         | 归一化歌词文档                         | 校验有界逐行/逐字时间，失败时独立降级。                          |
| `provider.comments`       | 只读歌曲评论及回复                     | 宿主统一渲染评论面板和歌词弹幕，校验有界分页。                   |
| `provider.account`        | 登录、快照、账号库、收藏和歌单变更     | 把状态、取消、存储和凭据句柄绑定到单个 provider 实例。           |

JSON fixture 是完整操作名列表。实现可以对可选账号变更返回清洗后的 `unsupported-operation`，但不能虚构未声明能力，
也不能把操作放到另一个 capability 下调用。

冻结操作：

- `provider.catalog`：`catalog.search`、`catalog.song`、`catalog.album`、`catalog.artist`、`catalog.artist-page`、
  `catalog.playlist`、`catalog.home`、`catalog.discover`、`catalog.area`、`catalog.artwork-data-uri`；
- `provider.playback`：`playback.resolve`、`playback.resolve-client-fallback`、
  `playback.set-preferred-quality`、`playback.set-current-quality`；
- `provider.recommendation`：`recommendation.next`；`provider.lyrics`：`lyrics.get`；
- `provider.comments`：`comments.list`。请求、返回、分页、旧版兼容和生命周期见[歌曲评论](song-comments.md)。
- `provider.account`：`account.snapshot`、`account.restore-session`、`account.sign-out`、账号库/歌单读写，以及
  `account.auth.*` QR/OAuth 生命周期。每个精确账号操作名以 fixture 为准。

fixture 还固定了每项能力的代表请求/响应、清洗后的权限撤销错误，以及停用/重新启用/账号代次结果。播放样例只含
Host 缓存配方，不含媒体 URL、请求 header、凭据值或文件系统路径。

## 插件提供的歌曲标签

平台标签由插件通过 [`songBadges` 和 `ui.songBadges`](plugin-manifest.md#声明式歌曲标签) 声明，宿主不维护平台名称或颜色映射。独立歌曲按经过校验的 provider ID 匹配；聚合歌曲按宿主设置的可选字段 `provider.originProviderId` 匹配原始成员，该字段在嵌套聚合和持久化时保留，组件响应不能自行设置。未知来源不显示标签。

播放、歌词、评论、凭据和权限仍遵循 `providerId` / `profileId` / `trackId`。原始来源字段仅用于展示，不授予路由权限。禁用或卸载贡献标签的插件后，标签消失；缺少原始来源字段的旧聚合记录需要重新加载才能显示标签。

## 兼容与生命周期

`network.request` 的 JSON 信封在 `responseFormat` 为 `json` 时可指定 `responseJsonFields`：1–128 个不重复、
非空且不含控制字符的字段名，每个最长 64 个 UTF-8 字节。成功的 JSON 响应会在返回 `bodyJson` 前递归保留这些
对象字段，数组顺序和标量值保持原样，保留的嵌套深度最多 64 层。省略此项时返回完整响应；错误正文沿用原有行为。
网络权限、响应字节上限和 Component 执行上限仍然有效。

账号快照的 `revision` 与账号分页的 `authRevision` 使用同一个 Host 账号代次。读取未变化的快照不会递增；账号状态、
身份、能力及显式登录/会话切换可以推进代次。远端播放历史可使用 `source: "provider-account"`，既有提供器的
`qqmusic-account` 仍然有效。

manifest v1 / API v1-v2 包继续使用原有 Worker、样式、Scene、存储和 UI 契约；它们不选择 WIT world，也不能取得 API v3
Provider 权限。manifest v2 包只能包含一个 Component，不能混入旧版入口。

provider ID 会保留在歌曲、队列条目和目录路由上。停用/卸载会撤销在途调用和不透明音源；自动队列遍历跳过相关条目，
UI 则保留明确的不可用状态和移除操作。重新启用同一 ID 后，页面和队列恢复资格，不进行跨平台同名匹配。

Component Model 的 WIT world 是显式 import/export 边界；可参阅 Bytecode Alliance 的
[world 文档](https://component-model.bytecodealliance.org/design/worlds.html)与
[`wit-bindgen`](https://github.com/bytecodealliance/wit-bindgen)。YAQMC 在 workspace 与示例 lockfile 中固定具体 Host/guest
版本，不依赖无界工具链。
