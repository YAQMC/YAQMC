# Android

> **简体中文** | [English](../android.md)

YAQMC Android 版复用桌面端的 React renderer 和同一个 Rust Core。QQ 音乐传输、账号状态、播放、
音质降级、加密媒体处理、队列持久化和收听统计仍由 Core 负责。Android 宿主只提供生命周期、安全
存储、系统分享、深链和系统媒体控制，不复制音乐提供器路由。

## 支持设备

- Android 8.0（API 26）或更高版本；
- 正式 APK 仅包含 `arm64-v8a`；
- `x86_64` 仅用于 debug 和模拟器构建；
- 手机、折叠屏和平板使用自适应布局，不锁定屏幕方向。

Android 版通过 GitHub Releases 提供签名 APK。目前不通过 Google Play 分发，也不发布 Android App
Bundle。

## Android 行为

- 首页、发现、搜索、媒体库、账号页面、播放队列、统计和应用内歌词复用共享界面。
- 紧凑屏幕使用四项底部导航；更大屏幕自动切换为导航栏。
- Rust/CPAL 负责实际音频输出；AndroidX Media3 将状态投影到媒体通知、锁屏、蓝牙控制和耳机按键。
- 播放期间从最近任务划掉 YAQMC 不会停止音乐；需要使用暂停或通知中的停止操作。
- 歌曲分享使用 Android 系统分享面板。`yaqmc://catalog/...` 由 Android Intent 显式交付，Android
  不轮询剪贴板中的分享链接。
- 更新检查只提示新版本并在系统浏览器打开对应 GitHub Release；YAQMC 不自行下载或安装 APK。

托盘控制、全局快捷键、插件、开发者模式、本地回环 API 与文件导出在 Android 上有意不提供。应用内歌词页面仍然保留。

## 应用外的歌词界面

Android 上的 **设置 → 歌词界面** 复用桌面端的界面偏好：

| 界面                     | 说明                                                                                                                                                                                                                                   | 要求                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 悬浮歌词                 | YAQMC 在后台时由 YAQMC 自行绘制、显示在其他应用上方的可移动歌词条。拖动移动，轻点打开 YAQMC，长按关闭；“被动锁定”使其点击穿透。                                                                                                        | “显示在其他应用的上层”（`SYSTEM_ALERT_WINDOW`），首次启用时申请；撤销后界面隐藏并关闭开关。 |
| 岛式歌词                 | 同样由 YAQMC 绘制、位于顶部边缘的紧凑胶囊（轻点展开，显示标题与下一行）。**并非**系统或厂商的灵动岛。                                                                                                                                  | 同上。                                                                                      |
| 车载蓝牙歌词（兼容模式） | 蓝牙 AVRCP 只有标题/歌手/专辑，没有歌词字段。连接蓝牙 A2DP 输出时，当前歌词行替换媒体标题，歌名移到歌手字段。由于 Android 只有一份会话元数据，通知、锁屏、手表等所有媒体客户端都会看到。每秒最多更新一次；关闭或断开后立即恢复原标题。 | 需手动开启，默认关闭。车机是否刷新显示取决于接收端。                                        |

三者都跟随 Core 的歌词时间线（`lyrics://projection`），不额外运行渲染器或轮询；由于 Core 时钟在后台每秒一跳，下一行由投影中的下一行开始时间调度。歌词设置中的用户时间偏移不作用于这些界面。

未实现厂商集成：Android 16 Live Updates 不适用于媒体播放与应用快捷入口；小米澎湃 OS 焦点通知/超级岛需要向小米申请单应用权限；OPPO/一加流体云、vivo 原子岛与三星 Now Bar 属于合作伙伴计划，没有公开的歌词接口。在澎湃 OS、ColorOS 与 One UI 上，系统自身的媒体胶囊仍可能通过常规媒体会话显示曲目。

## 歌词帧率

Android 上的同步歌词由原生悬浮层（`NativeLyricsOverlay`）在 `Choreographer` 垂直同步时绘制，每帧读取 Media3 的播放位置；
下方的 WebView 不再运行自己的逐帧歌词时钟。垂直同步循环只在悬浮层显示且 Activity 处于 started 状态时运行；
应用切到后台时停止、回到前台时恢复，因此不可见的歌词页不会持续唤醒主线程。

应用通常把刷新率交给系统决定（Android 15+ 另有触摸加速），因此自适应/LTPO 屏幕在静态页面上可能降到较低刷新率。
歌词在没有触摸输入时也会持续动画，所以**仅当歌词悬浮层可见且正在播放时**，Activity 会请求当前分辨率下可用的最高刷新率；
暂停、离开歌词页或切到后台后恢复系统默认。设备的功耗策略、省电模式与温控仍可能覆盖该请求。

请测量帧节奏，而不是依据显示设置判断。连接 USB 或无线调试后，打开歌词页并开始播放，然后运行（测量其他构建时传入 `--package`，例如
`org.yaqmc.android.perftest` 或 `org.yaqmc.android.debug`；图层与进程按包名精确匹配）：

```sh
node scripts/android/measure-frames.mjs --label before --seconds 20
# 安装新版本，使用同一首歌和相近位置后：
node scripts/android/measure-frames.mjs --label after --seconds 20
node scripts/android/measure-frames.mjs --compare artifacts/android-perf/android-frames-before.json artifacts/android-perf/android-frames-after.json
```

报告包含：

- 设备与 SoC；
- 包名、版本，以及构建是否 profileable / debuggable（只比较接近 release 的构建）；
- 测量过程中采样的刷新率，以及作为帧预算的 vsync 周期；
- `gfxinfo framestats` 逐帧耗时（窗口的 HWUI 时间线，同时覆盖 WebView 与原生歌词悬浮层）：p50/p95/p99/最大值，
  以及超过一个、两个 vsync 周期的帧数；
- 应用图层的 SurfaceFlinger 呈现间隔（屏幕实际 FPS、p50/p95/p99、跳过刷新的间隔数；设备不为 BLAST 图层提供
  latency 数据时为 `null`）；
- `gfxinfo` 帧耗时分位数与卡顿计数（含 GPU 分位数）；
- CPU 占用最高的应用线程；
- 温控状态。

## 隐私与存储

Android 使用应用私有文件和缓存目录，其偏好、队列、缓存和统计与桌面安装相互独立。账号秘密通过
不可导出的 Android Keystore 密钥加密，不存在明文降级路径。密钥丢失或失效后必须重新登录。

正式 Manifest 申请联网、媒体播放前台服务、唤醒锁权限，以及仅供上述可选歌词界面使用的“显示在其他应用的上层”权限（在启用界面时才向用户申请）。不申请麦克风、广泛存储、普通通知或安装 APK 权限。唤醒锁只在播放或缓冲期间持有。

## 构建与验证

需要 Node.js 26.7.0、Rust 1.88.0、JDK 21、Android SDK 36、Android NDK 28.2.13676358 和
cargo-ndk 4.1.2。

```powershell
npm ci
npm run android:check
npm run android:build:debug
```

Debug APK 默认导出到当前用户的 `Downloads/YAQMC/Android/debug` 专属目录；可用
`YAQMC_ANDROID_DEBUG_OUTPUT_DIR` 改写导出位置。

本地 Release 构建还需要构建脚本列出的四个 Gradle 签名环境变量。Tag 工作流通过 Base64 接收
keystore，并额外要求预期证书的 SHA-256 指纹，详见 [CI](ci.md)。禁止把 keystore 或密码提交到
仓库或写入 `gradle.properties`。

发布文件名为 `YAQMC-android-arm64-v8a-v<version>.apk`。侧载前使用相邻的
`SHA256SUMS-android.txt` 核对 SHA-256。Android 后续升级必须始终使用相同包名
（`org.yaqmc.android`）和签名证书。

继续阅读：[开发环境](development.md)、[整体架构](architecture.md)、[播放系统](playback.md)、
[登录与安全存储](authentication.md)、[外部 URI 安全](deep-link.md)和[CI](ci.md)。
