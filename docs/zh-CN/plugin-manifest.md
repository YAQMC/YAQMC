# 插件清单

> **简体中文** | [English](../plugin-manifest.md)

`manifest.json` 有两种刻意分离的运行时结构：

- manifest v1 / Plugin API v1-v2 可以组合样式、场景和隔离脚本；
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
相互独立。宿主理解 API 版本 `1`、`2` 和 `3`。不兼容包可以保持安装并停用，同时显示原因；不会部分激活。

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

## 依赖、冲突与路径

`dependencies` 不会自动从网络下载。依赖缺失、过旧或成环时阻止启用。`conflicts` 仅说明不能同时启用的插件，不做
自动化解。入口路径相对于包根目录；父级穿越、绝对路径、Windows 盘符、隐藏路径分量、大小写不敏感冲突和重复入口都会
被拒绝。Provider 包必须只包含一个位于声明 `.wasm` 入口的 Component Model 二进制；Core Wasm 模块和
PE/ELF/Mach-O/原生可执行文件都会被拒绝。
