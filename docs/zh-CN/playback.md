# 播放系统

> **简体中文** | [English](../playback.md)

`crates/yaqmc-core/src/player.rs` 中的 `PlayerService` 是桌面播放唯一事实源，负责队列、当前曲目、真实引擎
进度/时长、播放状态、循环与随机模式、音量、歌词以及结构化错误。

## 原生音频引擎

`RodioAudioEngine` 在专用线程中持有 CPAL 输出流和 Rodio `Player`，通过命令处理加载、播放、暂停、
停止、seek、音量和设备切换。没有可用设备时，应用不会崩溃，而是返回稳定的设备错误。

| 提供器格式 | 引擎输入  | 状态                             |
| ---------- | --------- | -------------------------------- |
| MP3        | MP3       | 已启用并完成真实 QQ 曲目检查     |
| AAC / M4A  | AAC       | 已启用，尚未完成原生验收         |
| FLAC       | FLAC      | 已启用，支持无损与 Hi-Res        |
| QQ mflac   | 流式 FLAC | 仅用于账号已获 URL + ekey 的音源 |
| WAV        | PCM WAV   | 已由确定性原生测试覆盖           |
| ALAC       | 仅元数据  | 不声明可播放                     |

原生时钟每 50 ms 读取引擎；UI/SSE 进度最多每秒发布四次，歌词只在行/词边界改变时广播。自动下一首
由引擎结束事件触发，不靠目录时长估算。

## 状态机与防竞态

```text
idle / stopped / ended
          │
       loading  ── 解析新音源
          │
      buffering ── 首段/缓存/解码
          │
       playing  <──> paused
          │
        ended ──> repeat / next / idle
```

每次加载都有 generation。旧加载即使较晚完成也会被丢弃，避免快速切歌时旧声音或旧歌词覆盖当前曲目。
401/403/404/410 的签名 URL 只允许重新解析一次。队列跳过失败曲目也限制为一轮。

## 播放会话与 Seek 合并

每次权威当前队列项开始加载时，`PlayerService` 都会分配新的 `sessionId`。音源解析、解码器加载、HTTP Range、
音质回退、URL 恢复、进度时钟、EOS 和歌词投影都必须带上该会话（音频引擎还有 `sourceGeneration`）。会话 41
的异步结果不得改写会话 42，即使两首歌的 song ID 相同。

同一会话内的 Seek 使用最新值邮箱（`lastSeekRevision`）。进度条快速拖动不会把无限 FIFO 的原生 Seek 塞进音频
线程：拖动时前端只预览，命令适配器合并飞行中的 Seek，Rodio 工作线程只保留一个待执行 Seek。Play/Pause/Next/Stop
不会被大量 Seek 堵住。松手时提交最终位置；更早的 Seek 完成不能把进度或当前曲目滚回去。

Player 快照还有单调递增的 `snapshotRevision`。React 投影会忽略更旧的会话，或同一会话中更旧的 revision，避免滞后
的 `player://snapshot` 把底栏或歌词页显示成上一首歌。若 UI 事件订阅者发生 `Lagged`，会从权威快照重新同步，而
不是退出循环。

单曲循环仍然只在当前会话的 EOS 上重载当前队列项。Seek 或切歌之前的过期 EOS 会被丢弃。随机遍历和历史与 Seek
正交。

账号音源额外携带不可序列化的播放 epoch（账号 scope、auth generation、取消令牌和共享时钟）。提供器
解析、缓存准备、解码加载、播放以及最终 `Playing` 提交前都会校验。注销/换号会立即让旧音源失效。
前端只能看到请求音质、实际音质、回退原因和试听标记，看不到 URL、vkey、Cookie、ekey 或 scope。

## 音质与试听

目录标注不是权益证明。解析器取目录格式、规范化账号权益和实际 vkey/evkey 响应的交集：

- 自动：当前账号有权且实际可用的最高完整音质，然后才是官方试听；
- 明确选择高品质/无损/Hi-Res/臻品：可按顺序回退，并给出 `account-rights`、`source-unavailable` 或
  `preview-only` 原因；
- 权益未知时只允许标准音质；
- PlayerBar 音质选择只作用于当前歌曲，下一首恢复设置页默认值。

官方试听使用独立的播放时长与时间轴偏移，歌曲目录总时长不会冒充实际可播放时长。

## 队列语义

- `playTracks` 替换队列并选择指定可播放歌曲；
- 删除正在播放项会正确加载后继，不继续旧音频；
- `previous` 超过阈值时先回到本曲开头，否则切到前一首；
- 播放栏提供三个互斥主模式：顺序播放、随机播放、单曲循环。它们是 `PlaybackOrder` + `RepeatMode`
  的投影，不是替换。列表循环仍供 HTTP API、MPRIS `LoopStatus=Playlist`、持久化以及高级菜单使用；
- 选择顺序/随机会把 `repeat` 设为 `off`；进入单曲循环会记住当前顺序，退出时可直接恢复。切换模式
  不会重载当前音频；
- 单曲循环在引擎结束时把当前队列项重载到 0，明确的下一首/上一首仍会切歌；队列列表不会重复当前曲；
- 列表循环可回绕、随机只从合法索引选择；
- 恢复的曲目保持暂停，需用户主动继续。

流媒体细节见[渐进式流媒体](streaming.md)，权益矩阵见[播放权益](entitlement.md)。
