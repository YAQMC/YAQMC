# 日志系统

> **简体中文** | [English](../logging.md)

YAQMC 使用一条统一的日志流水线，用带脱敏的滚动日志文件替代旧有的
`println!` 与随手 `console.log`。Rust 核心与前端事件都会汇入同一个日志文件。

流水线 **完全本地**：不会上传，任何时候都不发送遥测，也不会连任何第三方服务。

## 分层

```
前端 (React)               ─┐
Rust 核心 (Tauri 命令)     ─┤─▶ tracing_subscriber
平台适配器                 ─┤        │
Provider / audio / player  ─┘        ▼
                                 RedactingWriter
                                     │
                                     ▼
                              滚动日志文件
```

- **Rust 核心**：`tracing` 事件通过 `tracing_subscriber::registry()`
  分发。开发构建包含一个格式化 stderr 层；所有构建都会附带一个通过
  `RedactingWriter` 写入 `tracing-appender` 按日滚动文件的 file 层。
- **前端**：`src/application/logger.ts` 会本地批处理事件（最多 128 条，
  最长约 400 ms 刷新一次），通过 `diagnostics_log_frontend` 命令发送。Rust
  端命令再把每一条重放到同一批 `tracing` target，前端与 Rust 事件在最终
  日志中一致。
- **Provider / 音频 / 播放器**：这些模块使用 `tracing::info!` / `warn!` /
  `debug!` 与结构化字段（`tracing` 的 key/value）。刻意避免 `{:?}` 打印
  庞大结构体，每一行日志都能在一屏内看完。
- **脱敏**：所有写入在触盘之前先过 `RedactingWriter`。契约见
  [security.md](security.md)。

## 日志级别

| 级别  | 含义                                     |
| ----- | ---------------------------------------- |
| ERROR | 用户可见的失败；记录进环形缓冲并 flush。 |
| WARN  | 可恢复的降级；默认写入诊断包。           |
| INFO  | 稳定运行的里程碑（Release 默认值）。     |
| DEBUG | 复现问题时的深度细节（开发默认值）。     |
| TRACE | 逐回调追踪；只在主动调查时打开。         |

- Release 默认：`INFO`。
- 开发默认：`DEBUG`。
- `TRACE` 严格 opt-in，永远不作为默认。
- 实时路径（音频回调、逐帧歌词 tick）不会在 `INFO` / `DEBUG` 打点，只在
  节流后升级到 `TRACE`。

`设置 → 诊断与日志 → 日志级别` 只暴露 `Info` / `Debug` / `Trace` 三挡。
选择通过 `application_settings` 的 `logging.level` 持久化，下次启动读取。

## Target（日志领域）

领域命名遵循 `名词.动词`，是稳定标识符。新增领域需要同时更新
[diagnostics.md](diagnostics.md) 以约束命名蔓延。

```
app.startup            app.shutdown
qqmusic.auth           qqmusic.search      qqmusic.account
qqmusic.library        qqmusic.playlist    qqmusic.favorite
qqmusic.entitlement    qqmusic.source      qqmusic.lyrics
player.command         player.queue        player.order
player.seek            player.eos
audio.engine           audio.output        audio.decode
audio.stream           audio.qmc
lyrics.fetch           lyrics.parse        lyrics.timeline
lyrics.surface
network.http           network.range       cache.media   cache.artwork
platform.windows       platform.linux
platform.mpris         platform.smtc
ui.navigation          ui.error
issue.bundle           issue.report
```

预留：`scene.load` / `scene.render` / `scene.script` / `scene.security`
（Scene Engine 尚未实现）。

## 关联 ID

任何跨层操作（provider 解析 → HTTP Range → decoder → 音频引擎）都由发起
层通过 `logging::new_op_id()` 生成短 `op-XXXXXXXX` ID，并作为结构化字段
一路带过去，例如：

```
[qqmusic.source][INFO][op=8f3b41] resolve started track=QQ:003abc quality=lossless
[audio.qmc]    [WARN][op=8f3b41] encrypted source validation failed
[player.source][INFO][op=8f3b41] automatic fallback=high
```

绝对不能把敏感 URL 本身写入日志——只写安全标识符和 op ID。

## Session 身份

每次进程启动都由 `logging::generate_session_id()` 生成一个 16 字节随机
Session ID：

- 每次运行独立，
- 不持久化，
- 与账号、设备、安装均无关联，
- 会随诊断快照一起提供，方便把一次 bug 报告与对应日志对齐。

**没有分析 ID，没有安装 ID，没有指纹。**

## 文件、滚动与位置

日志由 `tracing_appender::rolling::Builder::new()` 写入 Tauri app-log
目录：

| 平台     | 路径                                                 |
| -------- | ---------------------------------------------------- |
| Windows  | `%LOCALAPPDATA%\Velune\YAQMC\logs\yaqmc-current.log` |
| Linux    | `$XDG_DATA_HOME/Velune/YAQMC/logs/yaqmc-current.log` |
| 默认回退 | Tauri `app_log_dir()` 返回值。                       |

当前日志为 `yaqmc-current.log`，`tracing-appender` 每日滚动最多保留 7 个
`yaqmc-current.log.YYYY-MM-DD` 文件。`diagnostics_clear_logs` 只删除
滚动文件。

用户可以在 **设置 → 诊断与日志 → 打开日志文件夹** 直接跳到目录。

## 性能

流水线为三条约束设计：

1. **绝不阻塞音频**：音频回调不在 `INFO`/`DEBUG` 打点；确实需要日志时
   预先构造字符串并使用 `TRACE`。
2. **绝不刷爆磁盘**：重复的逐帧数据（播放位置、桌面歌词 tick、MPRIS
   position）要么去抖 (> 500 ms)，要么只在状态跃迁时记录。
3. **前端 IPC 批处理**：`logger.ts` 最多缓存 400 ms 才通过
   `diagnostics_log_frontend` 一次性发送整批，即使突发交互也只产生几次
   IPC。

实际测量记录在 [windows-acceptance.md](windows-acceptance.md)。

## 明确不做

- 无分析。
- 无云上传。
- 无自动上报 bug。
- 日志中无凭据、Cookie、Token、签名 URL。
- 无用户账号资料、真实用户名、设备标识。
