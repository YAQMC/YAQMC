# 插件清单

> **简体中文** | [English](../plugin-manifest.md)

`manifest.json` 有两种刻意分离的运行时结构：

- manifest v1 / Plugin API v1、v2 与 v4 可以组合样式、场景、隔离脚本，以及（v4）由宿主渲染的页面、导航入口与布局选项，见[插件页面 API](plugin-pages-api.md)；
- manifest v2 / Plugin API v3 描述一个沙箱化 Provider Component。

同一个包不能混用两种结构。

## 旧版组合清单

```json
{
  "manifestVersion": 1,
  "id": "dev.example.sakura",
  "name": "Sakura",
  "version": "1.0.0",
  "apiVersion": 1,
  "engines": { "yaqmc": ">=0.1.0" },
  "entrypoints": {
    "styles": ["styles/main.css"],
    "scenes": ["scenes/vinyl.scene.json"],
    "script": "dist/main.js"
  },
  "permissions": ["track.read", "lyrics.read"]
}
```

必填字段为 `manifestVersion`、`id`、`name`、`version`、`apiVersion`。可选字段包括描述、作者、主页、仓库、
许可证、engines、platforms、architectures、entrypoints、permissions、dependencies、conflicts、
`settingsSchema` 和预留的 `signatures`。

插件 ID 使用反向域名，例如 `dev.example.plugin`。版本号为 semver。`apiVersion` 与包版本和 `manifestVersion`
相互独立。宿主理解 API 版本 `1`、`2`、`3` 和 `4`。不兼容包可以保持安装并停用，同时显示原因；不会部分激活。

## Provider Component 清单

```json
{
  "manifestVersion": 2,
  "id": "dev.example.catalog",
  "name": "Example catalog",
  "version": "1.0.0",
  "apiVersion": 3,
  "entrypoints": { "component": "component/provider.wasm" },
  "provider": {
    "id": "dev.example.catalog",
    "name": "Example platform",
    "witVersion": "0.1.0",
    "world": "provider",
    "capabilities": ["provider.catalog"]
  },
  "permissions": ["provider.catalog"]
}
```

API v3 当前冻结为 `yaqmc:provider@0.1.0`。导出的 `invoke` 信封使用带版本的 JSON 操作协议；Host 会在结果进入
Core 前校验并强制重写 provider 作用域。以下能力分别授权：

- `provider.catalog`
- `provider.playback`
- `provider.recommendation`
- `provider.lyrics`
- `provider.account`

完整操作清单和错误信封冻结在 [Provider Component API](provider-component-api.md) 及其机器可读 fixture 中。未知操作
fail closed；操作不能借用另一个已声明 capability 的权限。

WIT world 必须与申请的 Host imports 精确匹配：

| World                      | Host imports                        | 清单必须申请的权限                                     |
| -------------------------- | ----------------------------------- | ------------------------------------------------------ |
| `provider`                 | 无                                  | 仅 provider 能力                                       |
| `provider-storage`         | utilities、私有 KV/缓存             | `plugin.storage`                                       |
| `provider-network`         | utilities、精确 origin HTTPS 代理   | 一个或多个 `network:https://…`                         |
| `provider-network-storage` | utilities、私有 KV/缓存、HTTPS 代理 | `plugin.storage` 和一个或多个精确 origin               |
| `provider-account`         | utilities、存储、HTTPS、凭据句柄    | `provider.account`、`plugin.storage` 和精确网络 origin |

world 比权限更宽或权限无法由 world 导入时都会拒绝清单。API v3 不提供网络通配、原始 socket、文件系统路径、环境变量、
原生库、HTML、Shell 或子进程入口。

## 声明式歌曲标签

API v2/v3/v4 插件可以通过 `ui.songBadges` 权限和清单中的 `songBadges` 提供纯文本标签，无需脚本入口、Worker、图片请求或逐曲调用。尚不认识此权限的旧宿主需要先更新。

```json
{
  "permissions": ["ui.songBadges"],
  "songBadges": [
    {
      "id": "catalog-origin",
      "providerIds": ["org.example.catalog"],
      "label": "Example catalog",
      "labels": { "zh-CN": "示例音乐平台", "en-US": "Example catalog" },
      "color": "#4588cc"
    }
  ]
}
```

将以上字段合入有效清单并保留已有权限。平台匹配规则、名称、翻译和颜色由插件维护；宿主仅在歌曲列表、播放栏、队列、歌曲详情和主歌词视图提供通用展示位置。悬停提示标识贡献插件，标签不改变播放路由，也不构成宿主对第三方来源的认证。

优先匹配 `song.provider.originProviderId`，没有该字段时匹配 `song.provider.providerId`。原始 provider 信息由宿主联合音源设置，嵌套聚合及持久化时保留，组件响应不能自行提供。未知来源不显示标签，不解析不透明歌曲 ID，也不通过标题、音频 URL 或封面推断来源。旧版本保存的聚合歌曲如果缺少该字段，需要重新加载。

每个插件最多 16 条规则，规则 ID 唯一且为 1–48 个 ASCII 字母、数字、`_` 或 `-`；每条规则包含 1–16 个精确 provider ID（1–128 个 ASCII 字母、数字、`.`、`_` 或 `-`）。标签必须非空、最多 48 个 Unicode 字符且不含控制字符；最多 8 个翻译，locale 键为 1–35 个 ASCII 字母、数字或 `-`。翻译依次尝试完整 locale、基础语言和默认 `label`；颜色仅接受六位 `#RRGGBB`。不解释 HTML 或任意 CSS。

全局最多启用 128 条规则，每个 provider 最多显示 4 个标签，按宿主插件 ID 和声明顺序取值。索引仅在插件快照变化时重建，单曲匹配为 O(1)、输出有上限，索引空间为 O(规则数 × provider ID 数)。只有启用、包内容校验通过且有权限的插件贡献标签；禁用、卸载、撤销权限或进入安全模式后，已有队列中的标签也会消失。

## 依赖、冲突与路径

`dependencies` 不会自动从网络下载。依赖缺失、过旧或成环时阻止启用。`conflicts` 仅说明不能同时启用的插件，不做
自动化解。入口路径相对于包根目录；父级穿越、绝对路径、Windows 盘符、隐藏路径分量、大小写不敏感冲突和重复入口都会
被拒绝。Provider 包必须只包含一个位于声明 `.wasm` 入口的 Component Model 二进制；Core Wasm 模块和
PE/ELF/Mach-O/原生可执行文件都会被拒绝。
