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

歌词页是全窗口沉浸界面，背景来自封面。顶栏按钮可在三种封面布局间切换并持久化：`split`
（左侧封面+标题艺人）、`full`（全窗口锐利封面，右侧毛玻璃渐变歌词面板）、`vinyl`（CSS 绘制黑胶唱片，
圆形封面播放时旋转、暂停时冻结）。布局同时作为当前[歌词预设](lyrics-presets.md)保存。

`split`/`vinyl` 的模糊背景由离屏 canvas 一次性渲染（`stackblur-canvas`）后作为静态图使用——刻意避开
实时 CSS `filter: blur()`，因为 WebKitGTK 会把大尺寸模糊层栅格化成黑色；`full` 布局直接使用原始封面。

行强调使用封面感知墨色：控件、进度、逐字填充与已唱文字用纯墨色，当前行取封面色与墨色混合，
浅色封面也能保持对比；非当前行统一默认淡化色，只有正在唱的行突出。

当前行锚定在视口 35% 处，通过阻尼弹簧在 transform 平移层上跟踪播放——避免逐帧重绘文本。滚轮/指针
交互暂停跟随（Follow 恢复），点击定时行 seek 并恢复跟随。长间奏（定时行间 >= 4 秒）显示间奏标记，
上一句保持淡化；短间隙绝不误报。

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

全屏去掉重复的屏幕内全屏图标：F11 进入/退出，Escape 逐层返回。顶栏只在进入、键盘交互或指针到达顶部
56px 时显示，随后使用同一 2400ms 宽限。换歌会分别淘汰旧文档和旧 cursor generation，较慢的辅助窗口
初始 snapshot 不能覆盖自动下一首已经发布的新歌事件。

沉浸歌词封面必须经过 safe-artwork resolver：本地/同源和合法 image data URI 可直接用；远程只允许 HTTPS
`y.gtimg.cn`、`qpic.y.qq.com` 经原生缓存，拒绝重定向、凭据、非 443、`music.tc.qq.com`、其他来源、
非图片 MIME 和错误 IPC data URI。

Windows 本机矩阵见 [Windows 验收](windows-acceptance.md)。YAQMC 没有使用 AGPL-3.0-only 的 AMLL 包或
源码；当前渲染器依据自身领域模型独立实现。
