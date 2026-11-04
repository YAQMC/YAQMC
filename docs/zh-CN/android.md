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

Android v1 有意不提供桌面歌词、歌词岛、托盘、全局快捷键、插件、开发者模式、本地 HTTP API 和
文件导出。应用内歌词页面仍然保留。

## 歌词帧率

Android 上的同步歌词由原生悬浮层（`NativeLyricsOverlay`）在 `Choreographer` 垂直同步时绘制，每帧读取 Media3 的播放位置；
下方的 WebView 不再运行自己的逐帧歌词时钟。

应用通常把刷新率交给系统决定（Android 15+ 另有触摸加速），因此自适应/LTPO 屏幕在静态页面上可能降到较低刷新率。
歌词在没有触摸输入时也会持续动画，所以**仅当歌词悬浮层可见且正在播放时**，Activity 会请求当前分辨率下可用的最高刷新率；
暂停、离开歌词页或切到后台后恢复系统默认。设备的功耗策略、省电模式与温控仍可能覆盖该请求。

请测量帧节奏，而不是依据显示设置判断。连接 USB 或无线调试后，打开歌词页并开始播放，然后运行：

```sh
node scripts/android/measure-frames.mjs --label before --seconds 20
# 安装新版本，使用同一首歌和相近位置后：
node scripts/android/measure-frames.mjs --label after --seconds 20
node scripts/android/measure-frames.mjs --compare artifacts/android-perf/android-frames-before.json artifacts/android-perf/android-frames-after.json
```

报告包含：

- 设备与 SoC；
- 测量过程中采样的刷新率；
- 应用图层的 SurfaceFlinger 呈现间隔（屏幕实际 FPS、p50/p95/p99、跳过刷新的间隔数）；
- `gfxinfo` 帧耗时分位数与卡顿计数（含 GPU 分位数）；
- CPU 占用最高的应用线程；
- 温控状态。

## 隐私与存储

Android 使用应用私有文件和缓存目录，其偏好、队列、缓存和统计与桌面安装相互独立。账号秘密通过
不可导出的 Android Keystore 密钥加密，不存在明文降级路径。密钥丢失或失效后必须重新登录。

正式 Manifest 只申请联网、媒体播放前台服务和唤醒锁权限，不申请麦克风、悬浮窗、广泛存储、普通
通知或安装 APK 权限。唤醒锁只在播放或缓冲期间持有。

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
