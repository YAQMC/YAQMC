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

托盘控制、全局快捷键、本地回环 API、文件导出以及加载未打包的插件文件夹在 Android 上有意不提供。应用内歌词页面仍然保留。

## 插件

Android 以 `plugins` 特性构建 Core（Wasmtime 36.0.19、Cranelift、Component Model），支持 `arm64-v8a` 和 `x86_64`；`system-media` 与 `local-api` 保持关闭。Core 将平台报告为 `android`，清单的 `platforms` 必须包含 `android`（或省略 `platforms`）才能启用；`unknown` 永远不会匹配。手机底部导航第五项为**插件**，平板侧栏同样提供；插件自定义的 v4 页面显示在侧栏，并作为插件页面的快捷入口。详见[插件页面与插件商店](https://github.com/YAQMC/yaqmc-plugins/blob/main/docs/zh-CN/plugin-store.md)。

**选择文件**会打开系统文档选择器（`ACTION_OPEN_DOCUMENT`，无需存储权限）。所选 `content://` 文档在后台线程通过 `ContentResolver` 复制到 `cacheDir/plugin-imports`，流式复制时限制为 32 MiB（不信任声明的文件名和长度），只有该私有路径会进入既有的审核与安装事务。取消选择不返回任何内容；旧的选择会在下次选择和启动时删除。所有 Core 调用都在 Core 运行时中执行，不占用 UI 线程。

脚本、样式和场景插件与桌面一样在 WebView 中运行（Web Worker 脚本、经过清理的 CSS）。Android 原生 AMLL 歌词层是另一种渲染表面：它只读取当前场景解析后的字体、字重、行高和颜色；其它插件 CSS 作用于网页歌词舞台、元数据和背景，不作用于原生歌词行渲染。开发者模式可以切换，但 Android 上无法选择未打包文件夹。

## 应用外的歌词界面

原生歌词依赖固定为 AMLL 提交 `1ed23d4344d66c71cb81b94258b86710efa81b6f`，Maven 版本为
`0.1.0-yaqmc.1ed23d4`。CI 的 `setup-android` 会从此提交构建。本地构建时，先在独立的
`amll-android` 克隆中检出该提交，再执行
`AMLL_VERSION=0.1.0-yaqmc.1ed23d4 bash ./gradlew :amll:publishReleasePublicationToMavenLocal`。
旧的 snapshot 包没有本版本需要的歌词设置接口。

Android 上的 **设置 → 歌词界面** 复用桌面端的界面偏好：

| 界面                     | 说明                                                                                                                                                                                                                                                                             | 要求                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 悬浮歌词                 | YAQMC 在后台时显示在其他应用上方。支持横向和纵向拖动，保存两个方向的位置，并在窗口尺寸改变后限制在屏幕内。轻点歌词打开 YAQMC；小工具栏提供锁定和关闭。锁定后隐藏工具栏并穿透触摸，可通过通知栏的“解锁歌词”、设置 → 歌词界面 → 悬浮歌词或“全部解锁”恢复。锁定状态会在重启后保留。 | 用户授予“显示在其他应用的上层”（`SYSTEM_ALERT_WINDOW`）权限；通知栏解锁需要通知权限。 |
| 系统灵动岛／流体云       | 当前版本不可用。已移除原先由应用绘制的悬浮胶囊，旧版本开启过该功能也不会再创建胶囊。                                                                                                                                                                                             | 需要经过验证的手机系统接入，此项不会申请悬浮窗权限。                                  |
| 车载蓝牙歌词（兼容模式） | 蓝牙 AVRCP 只有标题/歌手/专辑，没有歌词字段。连接蓝牙 A2DP 输出时，当前歌词行替换媒体标题，歌名移到歌手字段。由于 Android 只有一份会话元数据，通知、锁屏、手表等所有媒体客户端都会看到。每秒最多更新一次；关闭或断开后立即恢复原标题。                                           | 需手动开启，默认关闭。车机是否刷新显示取决于接收端。                                  |

悬浮歌词与车载歌词跟随 Core 的歌词时间线（`lyrics://projection`），不轮询；由于 Core 时钟在后台每秒一跳，下一行由投影中的下一行开始时间调度。歌词设置中的用户时间偏移不作用于这些界面。

Android 12 及以上锁定时同时设置 `FLAG_NOT_TOUCHABLE` 和不超过系统遮挡阈值的**窗口透明度**。仅改变背景或 View 透明度会导致触摸被系统拦截，详见 [Android 窗口文档](https://developer.android.com/reference/android/view/WindowManager.LayoutParams#FLAG_NOT_TOUCHABLE)。工具栏、通知栏和设置页的锁定／解锁均通过 Core 原子写入，旧 WebView 的样式同步不能覆盖锁定状态；保存失败会恢复原状态并提示错误。

“悬浮歌词控制”通知使用低优先级通道，在歌词启用、已锁定且有悬浮窗权限时保留，包括暂停播放和应用位于前台时。
点击通知正文或“解锁歌词”按钮直接解锁，不打开 Activity。接收器不导出，使用显式、不可变的 PendingIntent。
解锁、关闭悬浮歌词或撤销悬浮窗权限后，宿主刷新时移除通知。Android 13 及以上在启用悬浮歌词且已获得悬浮窗权限后
申请一次通知权限；拒绝通知权限或关闭通知通道不影响锁定，提示会指向应用内设置。之后可在 Android 应用设置中开启通知。

### ColorOS 流体云接入前置条件

以下 OPPO 官方文档已于 2026-11-07 核验：

- [流体云模板](https://open.oppomobile.com/documentation/page/info?id=12658)：包含 `category="media"` 音乐模板。
  OML 描述的是系统渲染卡片，不是 Android 悬浮窗 API。
- [快速开始](https://open.oppomobile.com/documentation/page/info?id=12639)：需要开发者认证，并由 OPPO 分配授权码、服务 ID 和意图。
  申请需提供应用 ID、应用名、服务 URL／名称和产品描述；宿主开发前需要将 UPK 发布到服务库。
- [SeedlingSupportSDK 接入指南](https://open.oppomobile.com/documentation/page/info?id=12719)：当前页面提供 SDK 3.0.7，
  通过 `SeedlingCardWidgetProvider` 收到卡片生命周期并更新数据，Manifest 授权键为 `com.oplus.ocs.card.AUTH_CODE`。
  `SeedlingTool.updateIntelligentData` 的事件码、事件名称和数据格式须与 OPPO 约定，不能把其他业务的示例值当成 YAQMC 的接入参数。

YAQMC **尚未申请这些材料**，因此内置 ColorOS 适配暂未启用，保留 `SystemLyricsPlugin` 接入入口。
获得实际 APK 应用 ID 对应的授权和服务参数后，创建并发布歌词 UPK，实现宿主 Provider 和适配器，
再在 ColorOS 16 真机验证切行、暂停、返回前台、关闭功能及进程退出。`.perftest` 测试包的应用 ID 也需对应授权。
SDK IPC 放在后台线程；Provider 生命周期回调本身也在后台线程执行。复用 Core 歌词投影，并保留下文的异常隔离机制。

其他厂商接口尚未核验。现有 MediaSession 可供系统媒体界面使用，但这不代表已实现系统灵动岛歌词。

### 车载元数据核验

车载兼容模式会同时更新当前会话元数据和会话队列里的当前条目。
[AOSP 的 `MediaPlayerWrapper.isMetadataSynced`](https://android.googlesource.com/platform/packages/modules/Bluetooth/+/refs/heads/main/android/app/src/com/android/bluetooth/audio_util/MediaPlayerWrapper.java)
会比较队列和会话的标题／歌手，单独更新会话可能使蓝牙栈等待同步。
[Media3 1.10.1](https://github.com/androidx/media/blob/1.10.1/libraries/session/src/main/java/androidx/media3/session/MediaSessionLegacyStub.java)
分别发布 MediaItem 队列信息和当前元数据，因此两条路径都需收到新歌词。
歌词绑定曲目 ID，旧投影不会写到下一首歌；关闭功能、蓝牙断连或无歌词时恢复原始元数据。
仅装饰对外投影的会话队列，Core 队列不变。该功能不包含连接后自动播放或驾驶模式界面。

## 系统歌词插件

设置 → 歌词界面 → 系统灵动岛／流体云提供“插件开发”和“贡献适配”入口。当前没有内置厂商适配器。
这是随 APK 编译的 Android 原生扩展，与桌面插件系统独立；不加载下载的 APK 或 JavaScript 插件。

适配器实现 `org.yaqmc.android.lyrics.SystemLyricsPlugin`，提供接受 Android `Context` 的公开构造函数
（宿主传入应用 Context），并在应用 Manifest 中登记完整类名：

```xml
<meta-data
    android:name="org.yaqmc.android.SYSTEM_LYRICS_PLUGIN"
    android:value="your.package.ColorOsLyricsPlugin" />
```

- `isAvailable(): Boolean`：核实系统版本、API 和厂商授权。必须快速返回，不能执行网络请求；仅可用插件会启用系统歌词开关。
- `show(lyric: SurfaceLyric)`：创建或更新真正的系统界面。快照包含曲目 ID、歌名、歌手、当前行、副行、下一行和播放状态。
  数据变化时才调用，宿主已调度下一行；不要另建歌词解析器、播放器或轮询计时器。
- `hide()`：移除界面，允许重复调用。关闭功能、应用回到前台、清空曲目、授权失效或插件异常时调用。
  进程退出后的清理由适配器使用厂商提供的有效期／生命周期机制处理。

以上方法均在主线程调用。适配器负责厂商 SDK、Manifest 声明、授权和异步任务；异常会停用该插件并尝试清理，
不影响悬浮歌词或播放。系统适配不得退回 `TYPE_APPLICATION_OVERLAY`。R8 会保留插件实现；没有插件或插件不支持
当前系统时，不申请悬浮窗权限，也不创建仿制灵动岛。

贡献 ColorOS 16 适配时，可从设置入口打开 Issue，或提交 PR，附上准确机型和系统构建号、官方 API 文档、授权要求、
实现和真机证据。验证缺少授权、不支持的设备、切行、暂停、返回前台、关闭功能、进程退出以及 R8 后的发布 APK。
需要确认真实的系统胶囊和展开面板，编译通过或普通通知显示并不能证明流体云接入成功。此接口不包含状态栏歌词。

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

正式 Manifest 申请联网、媒体播放前台服务、唤醒锁权限，以及仅供上述可选歌词界面使用的“显示在其他应用的上层”权限（在启用界面时才向用户申请）。通知权限仅用于可选的悬浮歌词通知栏解锁。不申请麦克风、广泛存储或安装 APK 权限。唤醒锁只在播放或缓冲期间持有。

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
