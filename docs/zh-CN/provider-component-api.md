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
| `provider.account`        | 登录、快照、账号库、收藏和歌单变更     | 把状态、取消、存储和凭据句柄绑定到单个 provider 实例。           |

JSON fixture 是完整操作名列表。实现可以对可选账号变更返回清洗后的 `unsupported-operation`，但不能虚构未声明能力，
也不能把操作放到另一个 capability 下调用。

冻结操作：

- `provider.catalog`：`catalog.search`、`catalog.song`、`catalog.album`、`catalog.artist`、`catalog.artist-page`、
  `catalog.playlist`、`catalog.home`、`catalog.discover`、`catalog.area`、`catalog.artwork-data-uri`；
- `provider.playback`：`playback.resolve`、`playback.resolve-client-fallback`、
  `playback.set-preferred-quality`、`playback.set-current-quality`；
- `provider.recommendation`：`recommendation.next`；`provider.lyrics`：`lyrics.get`；
- `provider.account`：`account.snapshot`、`account.restore-session`、`account.sign-out`、账号库/歌单读写，以及
  `account.auth.*` QR/OAuth 生命周期。每个精确账号操作名以 fixture 为准。

fixture 还固定了每项能力的代表请求/响应、清洗后的权限撤销错误，以及停用/重新启用/账号代次结果。播放样例只含
Host 缓存配方，不含媒体 URL、请求 header、凭据值或文件系统路径。

## 兼容与生命周期

manifest v1 / API v1-v2 包继续使用原有 Worker、样式、Scene、存储和 UI 契约；它们不选择 WIT world，也不能取得 API v3
Provider 权限。manifest v2 包只能包含一个 Component，不能混入旧版入口。

provider ID 会保留在歌曲、队列条目和目录路由上。停用/卸载会撤销在途调用和不透明音源；自动队列遍历跳过相关条目，
UI 则保留明确的不可用状态和移除操作。重新启用同一 ID 后，页面和队列恢复资格，不进行跨平台同名匹配。

Component Model 的 WIT world 是显式 import/export 边界；可参阅 Bytecode Alliance 的
[world 文档](https://component-model.bytecodealliance.org/design/worlds.html)与
[`wit-bindgen`](https://github.com/bytecodealliance/wit-bindgen)。YAQMC 在 workspace 与示例 lockfile 中固定具体 Host/guest
版本，不依赖无界工具链。
