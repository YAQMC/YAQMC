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

歌词页是全窗口沉浸界面，背景来自封面。沉浸歌词页与[歌词编排器](lyrics-composer.md)共用同一个
`LyricsScene`。顶栏按版式分组循环**全部**已解析预设：经典后是分栏自定义，沉浸后是全窗口自定义，
黑胶后是唱片自定义；只改变 `selectedId`。桌面歌词 / 歌词岛保留各自的表面字体。布局同时作为当前
[歌词预设](lyrics-presets.md)保存。

经典 / 黑胶的模糊背景仍用离屏 canvas（`stackblur-canvas`）生成静态模糊图，**铺满舞台且不降低透明度**，
和加入编排器之前一样。刻意避开实时 CSS `filter: blur()`，因为 WebKitGTK 会把大尺寸模糊层栅格化成黑色。
沉浸工厂图的 blur 为 0，直接用原始封面铺底。外观里的纯色 / 自定义图片仍会覆盖这层封面。

行强调使用封面感知墨色：控件、进度、逐字填充与已唱文字用纯墨色，当前行取封面色与墨色混合。主字号为
场景根上的 `clamp(18px, 5.6cqh, 96px) × fontScale`。字号只改字形大小；行距是场景相对的 `cqh` 间距，
放大字号不会把行与行之间的空隙一起撑开。

当前行锚定在视口 35%（`followAnchor`，歌词组件可覆盖），通过阻尼弹簧在 transform 平移层上跟踪播放。
行切换时在共享滚动弹簧之上叠加逐行级联：位于滚动方向前端的行领先共享运动，后端的行跟随，
相邻行间距在波经过时伸缩，而不是整块刚性平移（参考 SPlayer 的灵动感）。
带位移的滚轮会暂停跟随；单纯按下指针不会。**跟随当前行** 即使行号不变也会强制滚动。点击定时行 seek
并恢复跟随。换词不会重新居中。

React 不在每次音频轮询时重排整份歌词。原生服务按真实位置发布行/词边界；小型视觉循环只更新当前词
的揭示进度，通过 ref 写 CSS 变量。提供两种揭示效果：

- **逐字跳动**（默认）：把当前词拆成可动的单元，随演唱逐个上移一小段距离并保持抬起。CJK 词逐字拆分，
  拉丁词整体作为一个单元一起动，参考 SPlayer 风格。只有高亮行应用该效果，其余行保持暗淡不高亮。
- **渐进填充**：在词上写 `--word-progress`，从左到右裁剪纯墨色覆盖层。

两者共用同一个 rAF 循环，暂停/隐藏时停止，减少动画时立即完成整词。memo 行只在自身视觉状态变化时更新。
自动下一首和 seek 都依赖 timeline revision，旧歌曲定时器不能推动新歌词。

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
