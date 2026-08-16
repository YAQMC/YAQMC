# 整体架构

> **简体中文** | [English](../architecture.md)

YAQMC 是 Tauri 2 桌面应用。React 负责展示，Rust 负责 QQ 音乐网络访问、凭据、缓存、原生音频、
系统媒体控制以及窗口策略。浏览器层不会持有播放 URL、Cookie、vkey/ekey 或操作系统凭据。

```text
React 主界面 / 歌词窗口 / 本地 API / 托盘 / 系统媒体面板
                         │
                         ▼
              唯一权威 PlayerService（Rust）
                         │
             ┌───────────┴───────────┐
             ▼                       ▼
      QQ 音乐提供器与缓存        Rodio / CPAL 音频引擎
```

## 责任边界

- `src/domain`：与提供器无关的歌曲、歌词、账号和播放模型。
- `src/providers`：公开目录接口、QQ 音乐 Tauri 适配器和永久保留的假数据提供器。
- `src/application`：React 状态投影、偏好设置、播放与登录运行时协调。
- `src/components`、`src/pages`、`src/surfaces`：主窗口和歌词窗口。
- `crates/yaqmc-core/src/player.rs`：队列、当前曲目、进度、循环/随机、音量、错误与歌词时钟的唯一事实源。
- `crates/yaqmc-core/src/audio.rs`：解码、输出设备和 seek。
- `crates/yaqmc-core/src/streaming.rs`：HTTP Range、稀疏缓存和授权 mflac 读取。
- `crates/yaqmc-core/src/qqmusic.rs`：兼容协议、账号资料与音源解析；Tauri 的 OAuth 窗口适配器位于 `src-tauri/src/qqmusic_oauth_host.rs`。
- `src-tauri/src/storage.rs`：SQLite 与文件缓存索引。

## 数据流

1. React 通过 `MusicProvider` 请求公开目录；账号页面只通过单独的 `AccountMusicProvider` 扩展访问。
2. Rust 校验地址、请求和响应，把上游 DTO 转成稳定领域类型。
3. 播放请求进入 `PlayerService`，由提供器按当前账号权益解析一次性音源。
4. 缓存/Range 层向音频线程提供 `Read + Seek`；加密 mflac 只在读取时于内存解密。
5. 原生播放快照投影到 React、MPRIS/SMTC、本地 API、托盘与歌词窗口；这些适配器不拥有独立状态。
6. 队列、模式、音量和选中曲目写入 SQLite；账号秘密只进入操作系统安全存储。

## 并发与故障边界

- 曲目加载、页面请求、登录和账号操作都带 generation；旧请求不能覆盖新状态。
- 账号读写还绑定随机的账号 scope。注销或换号会取消旧 I/O，并禁止旧结果写入 UI/缓存。
- 过期签名 URL 最多重新解析一次，不进行无界重试。
- 无输出设备时使用稳定的“设备不可用”实现，目录、设置和缓存仍可使用。
- 缓存写入使用随机 `.part` 文件和原子重命名，启动时清理中断残留。

继续阅读：[播放](playback.md)、[QQ 音乐提供器](qqmusic-provider.md)、[登录](authentication.md)和
[缓存](caching.md)。
