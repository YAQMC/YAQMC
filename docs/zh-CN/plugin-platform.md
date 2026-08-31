# 插件平台

> **简体中文** | [English](../plugin-platform.md)

YAQMC 运行时插件是由 `ExtensionHost` 加载的用户安装包（`*.yaqmc-plugin`）。它们不是 Electron 扩展，也不会加载
原生 `dll` / `so` 模块。

Plugin API v1 提供样式、歌词场景和隔离脚本宿主。API v2 增加声明式设置、读写事件、安全 UI 插槽、可选的 Host 代理
HTTPS 和开发者模式。API v3 增加由 Wasmtime 托管的、本地旁加载且未签名的 WebAssembly Provider Component。
现有 v1/v2 插件保持兼容。

## 包结构

```text
legacy-plugin.yaqmc-plugin
├── manifest.json
├── dist/main.js
├── styles/main.css
├── scenes/*.scene.json
└── assets/

provider-plugin.yaqmc-plugin
├── manifest.json
└── component/provider.wasm
```

不存在用户编写的 HTML 入口、插件 iframe、原生库或任意设置页。

## 生命周期与持久化

已安装 → 停用 / 正在启用 → 活动 → 正在停用 → 失败 / 不兼容。

启用和停用无需重启。活动版本显式记录，不使用符号链接。API v3 的私有 KV、受管缓存和凭据句柄索引使用哈希命名空间，
Component 不会获得宿主路径。

停用 Provider 插件会取消调用、撤销 Host context 并注销 provider；重新启用会创建新 context。卸载会先停用，仅在用户选择
时删除私有数据。激活期间异常退出会让下一次启动进入安全模式。

队列条目和目录路由会保留自己的 `providerId`。平台停用或移除后，Core 拒绝其音源，自动遍历会跳过，renderer 显示确定的
不可用状态，而不会把曲目 ID 交给另一个平台。用户仍可移除或重排该条目。重新启用同一 provider 后，链接、播放资格和
provider 私有账号状态恢复，不需要重写队列。

## 限制

| 边界           | API v1-v2 | API v3 Provider Component |
| -------------- | --------- | ------------------------- |
| 压缩包         | 8 MiB     | 32 MiB                    |
| 展开体积       | 32 MiB    | 96 MiB                    |
| 文件数         | 256       | 512                       |
| 单文件         | 4 MiB     | 32 MiB Component          |
| 私有 KV        | 64 KiB    | 4 MiB                     |
| 受管缓存       | —         | 64 MiB                    |
| Component 内存 | —         | 64 MiB                    |
| 并发调用       | —         | 4                         |
| 请求/响应      | 依 API    | 4 MiB                     |
| 操作 deadline  | 依 API    | 15 秒                     |

API v3 还使用 CPU fuel 与 epoch interruption。连续三次沙箱 fault 会在当前会话熔断，只有显式重新启用才能恢复。

## Provider 沙箱

Provider Component 使用冻结的 `yaqmc:provider@0.1.0` WIT 和 WASI 0.2 Component Model。默认没有文件系统、环境变量、
进程、Shell、原始 socket、宿主凭据、renderer IPC 或 HTML 权限。清单选择的 WIT world 必须与用户授权精确匹配：

- HTTPS 仅允许精确 origin；Core 把连接固定到已校验 DNS 地址，并在每次重定向重新检查 origin、DNS 与私网地址；
- KV/缓存有配额、按插件隔离，客体看不到路径；
- 创建凭据只返回不可读、不可枚举的句柄。只有 account world 能在同 origin Host 请求中引用，密文不会返回 Wasm 或
  renderer；
- 时钟、随机数和日志有边界，疑似敏感日志整条替换为脱敏标记。

能力与 world 的精确映射见[清单参考](plugin-manifest.md)。

`provider.playback` 只能返回精确 origin 的 HTTPS 配方或 Host 受管缓存 key。Core 解析并流式消费不透明音源；签名 URL、
请求 Header、凭据和 Host 路径都不会序列化进 renderer 协议。`provider.account` 绑定到声明它的 provider 实例及其哈希
存储域，不能检查或覆盖内置 QQ 音乐账号。

## 明确不实现

本版本不含插件市场、远程更新、已验证发行方签名、原生模块、任意设置 HTML 或云同步。`network:*` 通配被拒绝。旧版
打包示例以及只读/完整 Rust Provider Component 见[示例插件](plugin-examples.md)。
