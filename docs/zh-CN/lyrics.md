# 歌词架构

> **简体中文** | [English](../lyrics.md)

```text
QQ QRC / LRC / 假数据文档
          │
  提供器解密、解析、规范化 ──> LyricDocument
                                      │
  Rodio PlayerService 真实进度 ───────┤
                                      ▼
                             React / 本地 API
```

`LyricDocument` 支持无时间、逐行和逐字歌词；行可以携带翻译、罗马音、歌手身份、起止边界和独立定时
词/音节。QQ 提供器在 Rust 解密 QRC，提取 XML `LyricContent`，保留定时词中的字面括号，解码 entity，
按时间戳对齐翻译/罗马音；LRC 是回退。缓存键含 parser revision，修复解析器后不会继续用旧坏数据。

## 渲染

主歌词使用一个扩散封面层和克制的颜色/对比 wash，当前行接近视口中心。滚轮/指针交互会暂停自动跟随，
Follow 可恢复；点击定时行通过同一播放器契约 seek。

React 不在每次音频轮询时重排整份歌词。原生服务按真实位置发布行/词边界；小型视觉循环只更新当前词
填充，通过 ref 写一个 CSS 变量。memo 行只在自身视觉状态变化时更新。减少动画时立即滚动并关闭通用
transition/animation。自动下一首和 seek 都依赖 timeline revision，旧歌曲定时器不能推动新歌词。

## 呈现层

- Normal：保留导航和 PlayerBar；
- Focus：收起导航，歌词与 PlayerBar 占完整宽度；
- 原生全屏：请求主 Tauri 窗口进入 OS fullscreen，使用居中 transport。

全屏请求异步串行且可恢复；pending/失败时歌词界面仍然可见。按钮和 F11 使用同一边界。Escape 逐层退出
原生全屏、Focus、Lyrics。外部原生全屏变化由窗口事件协调，旧 snapshot 不能覆盖新状态。

全屏 transport 直接读共享播放器 store，2400ms 播放无操作后隐藏，指针移动/换歌显示，拥有焦点时固定，
上下首和播放暂停使用 PlayerBar 相同命令。

沉浸歌词封面必须经过 safe-artwork resolver：本地/同源和合法 image data URI 可直接用；远程只允许 HTTPS
`y.gtimg.cn`、`qpic.y.qq.com` 经原生缓存，拒绝重定向、凭据、非 443、`music.tc.qq.com`、其他来源、
非图片 MIME 和错误 IPC data URI。

Windows 本机矩阵见 [Windows 验收](windows-acceptance.md)。YAQMC 没有使用 AGPL-3.0-only 的 AMLL 包或
源码；当前渲染器依据自身领域模型独立实现。
