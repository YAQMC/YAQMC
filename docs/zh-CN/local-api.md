# 本地 HTTP API

> **简体中文** | [English](../local-api.md)

内嵌 API 用于本机小组件、脚本、状态屏、Stream Deck 类集成和未来配套应用，不是公网或局域网服务。

## 安全与生命周期

- 默认关闭，关闭时没有监听 socket；
- 只绑定 IPv4 loopback `127.0.0.1`，默认端口 `19532`；
- 首次启用生成随机 256-bit bearer token，只存操作系统凭据服务；只有用户明确点“显示”才呈现；
- 重新生成 token 会重启监听器并立即让旧客户端失效；
- 所有 `/v1` 路由需要认证，公开 `/health` 只返回服务/版本状态；
- 不启用 CORS，请求体上限 16 KiB，JSON 拒绝未知字段；
- 不存在通用命令、shell、文件路径、插件执行或 Tauri invoke 端点；
- 停止使用 Axum graceful shutdown，退出应用也会释放端口。

token 防止普通网页或普通本机调用者误用，不抵御以同一 OS 用户权限运行且能读进程内存的恶意软件。
规范 HTTP 形状以 [OpenAPI 3.1](../local-api.openapi.yaml) 为准。

## 启用与认证

在“设置 > 本地 HTTP API”选择端口并开启。仅在配置本机客户端时显示/复制 token。

```powershell
$apiToken = '<从设置复制的 token>'
$headers = @{ Authorization = "Bearer $apiToken" }
Invoke-RestMethod -Uri 'http://127.0.0.1:19532/v1/player' -Headers $headers
```

```bash
curl -H "Authorization: Bearer $YAQMC_API_TOKEN" http://127.0.0.1:19532/v1/player
```

## 端点

| 方法 | 路由                                 | 用途                                 |
| ---- | ------------------------------------ | ------------------------------------ |
| GET  | `/health`                            | 非敏感健康状态                       |
| GET  | `/v1/player`                         | 完整播放器快照                       |
| GET  | `/v1/player/track`                   | 当前曲目或 null                      |
| GET  | `/v1/player/queue`                   | 队列与索引                           |
| POST | `/v1/player/play`、`pause`、`toggle` | 播放控制                             |
| POST | `/v1/player/next`、`previous`        | 上下首                               |
| PUT  | `/v1/player/seek`                    | `{ "positionMs": 123456 }`           |
| PUT  | `/v1/player/volume`                  | `{ "volume": 0.72 }`                 |
| PUT  | `/v1/player/shuffle`                 | `{ "enabled": true }`                |
| PUT  | `/v1/player/repeat`                  | 将循环模式设为 `off`、`all` 或 `one` |
| GET  | `/v1/lyrics`、`/v1/lyrics/current`   | 歌词文档与当前行/词                  |
| GET  | `/v1/events`                         | SSE 事件流                           |

position 使用整数毫秒，volume 必须是 0.0–1.0 的有限数。越界返回 422，需要曲目但未选择时返回 409，
认证失败 401。快照还包含 `playbackOrder`（`sequential` | `shuffle`）和 `primaryPlaybackMode`
（`sequential` | `shuffle` | `repeat-one`）。列表循环仍是 `repeat=all`，不是主模式。
SSE 首先发送 `player.snapshot`，随后只在有意义变化时发送 player、queue 和 lyrics 事件；
进度最多每秒四次。错误响应不包含堆栈或秘密。
