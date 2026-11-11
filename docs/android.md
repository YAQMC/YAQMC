# Android

> [简体中文](zh-CN/android.md) | **English**

YAQMC for Android reuses the React renderer and the same Rust Core as the desktop application. QQ Music transport,
account state, playback, quality fallback, encrypted-media handling, queue persistence, and listening statistics stay
inside Core. The Android host supplies lifecycle, secure storage, sharing, deep links, and system media controls; it
does not duplicate provider routes.

## Supported devices

- Android 8.0 (API 26) or newer;
- release APKs contain `arm64-v8a` only;
- `x86_64` is supported only by debug and emulator builds;
- phones, foldables, and tablets use adaptive layouts and may rotate freely.

YAQMC is distributed as a signed APK on GitHub Releases. It is not currently distributed through Google Play and no
Android App Bundle is published.

## Android behavior

The native lyrics dependency is pinned to AMLL commit `1ed23d4344d66c71cb81b94258b86710efa81b6f`,
Maven version `0.1.0-yaqmc.1ed23d4`. CI builds that source in `setup-android`. For a local build, check out
that commit in a separate `amll-android` clone, then run
`AMLL_VERSION=0.1.0-yaqmc.1ed23d4 bash ./gradlew :amll:publishReleasePublicationToMavenLocal`
before building YAQMC. Older snapshot packages lack the required renderer settings APIs.

- Home, Discover, Search, Library, account pages, playback queue, statistics, and in-app lyrics use the shared UI.
- A four-destination bottom bar is used on compact screens; larger screens switch to a navigation rail.
- Rust/CPAL owns audio output. AndroidX Media3 projects that state into the media notification, lock screen,
  Bluetooth controls, and headset buttons.
- Dismissing the task while music is playing does not stop playback. Use Pause or the notification's Stop action.
- Song sharing uses the Android share sheet. `yaqmc://catalog/...` links are handled as explicit Android intents;
  Android never polls the clipboard for links.
- Update checks only notify and open the matching GitHub Release in the system browser. YAQMC does not download or
  install APKs itself.

Tray controls, global shortcuts, the loopback Local API, file exports and loading unpacked plugin folders are
intentionally absent from Android. The in-app lyric screen remains available.

## Plugins

Android builds Core with the `plugins` feature (Wasmtime 36.0.19 with Cranelift, Component Model) for `arm64-v8a`
and `x86_64`; `system-media` and `local-api` stay off. Core reports the platform as `android`, so a manifest must
list `android` in `platforms` (or omit `platforms`) to activate; `unknown` never matches. **Plugins** is the fifth
bottom-navigation item on phones and a rail item on tablets; plugin-defined v4 pages appear in the rail and as
shortcuts on the Plugins page. See [Plugins page and plugin store](https://github.com/YAQMC/yaqmc-plugins/blob/main/docs/plugin-store.md).

**Choose file** opens the system document picker (`ACTION_OPEN_DOCUMENT`, no storage permission). The selected
`content://` document is copied with `ContentResolver` on a background thread into
`cacheDir/plugin-imports`, bounded to 32 MiB while streaming (declared names and lengths are not trusted), and only
that private path reaches the existing review and installation transaction. Cancelling returns nothing; earlier
selections are deleted on the next pick and on start-up. Every Core call runs on the Core runtime, not the UI thread.

Script, style and scene plugins run in the WebView exactly as on desktop (Web Worker scripts, sanitized CSS).
Android's native AMLL lyric overlay is a different surface: it reads only the resolved font, weight, line height and
colour of the active scene; other plugin CSS affects the web lyric stage, metadata and backgrounds, not the native
line renderer. Developer Mode can be toggled, but unpacked folders cannot be selected on Android.

## Lyric surfaces outside the app

**Settings → Lyrics surfaces** reuses the desktop surface preferences on Android:

| Surface                              | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                    | Requirements                                                                                         |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Floating lyrics                      | A movable lyric bar over other apps while YAQMC is in the background. Drag horizontally or vertically; both coordinates persist and stay within the display after a size change. Tap the text to open YAQMC. The toolbar has Lock and Close buttons. Lock hides the toolbar and passes touches through. Use the notification's Unlock action, Settings → Lyrics surfaces → Floating lyrics, or Unlock all. The lock persists across restarts. | User-granted "Display over other apps" (`SYSTEM_ALERT_WINDOW`); notifications for the unlock action. |
| System island / Fluid Cloud          | Unavailable in this build. The old app-drawn island pill has been removed, including for existing enabled preferences.                                                                                                                                                                                                                                                                                                                        | A verified integration for the device's system. This option does not request overlay permission.     |
| Car Bluetooth lyrics (compatibility) | Bluetooth AVRCP has title/artist/album but no lyric field. While a Bluetooth A2DP output is connected, the current line replaces the media title and the song moves to the artist field. This is visible to every media client (notification, lock screen, watch) because Android has one session metadata. Updates are limited to one per second; turning it off or disconnecting restores the canonical title immediately.                  | Opt-in, off by default. Whether the head unit shows title changes depends on the receiver.           |

Floating lyrics and car lyrics follow Core's lyric timeline (`lyrics://projection`): no polling loop runs, and the next
line is scheduled from the projection's next-line start because Core's clock ticks once per second in the background.
The user timing offset from the lyrics settings is not applied to these surfaces.

Locked floating lyrics use `FLAG_NOT_TOUCHABLE` and **window alpha** at or below the system's maximum obscuring opacity
on Android 12+. Changing only the view or background opacity would block touches to other apps. See the
[Android window documentation](https://developer.android.com/reference/android/view/WindowManager.LayoutParams#FLAG_NOT_TOUCHABLE).
Settings, toolbar and notification lock/unlock use Core's atomic host-only preference mutation, so stale WebView style updates
cannot overwrite the interaction state. A failed save restores the previous state and reports the error.

The low-importance **Floating lyrics controls** notification remains available while lyrics are enabled and locked,
including during pauses and while the app is visible. Both the notification body and its **Unlock lyrics** button
unlock directly without opening an activity. The receiver is not exported and uses an explicit, immutable
PendingIntent. Unlocking, disabling floating lyrics or revoking overlay access removes the notification when the
host refreshes. Android 13+ asks for notification permission once after floating lyrics are enabled and overlay
access is granted. If permission or the notification channel is disabled, locking still works and the toast directs
the user to YAQMC settings. Notification permission can subsequently be enabled in Android's app settings.

### ColorOS Fluid Cloud integration prerequisites

The following official OPPO pages were checked on 2026-11-07:

- [Fluid Cloud templates](https://open.oppomobile.com/documentation/page/info?id=12658) describe OML templates,
  including `category="media"`. They define a system-rendered card layout, not an Android overlay API.
- [Quick start](https://open.oppomobile.com/documentation/page/info?id=12639) requires a developer account and OPPO-assigned
  authorization code, service ID and intent. The application ID, app name, service URL/name and product description
  are supplied to OPPO. The UPK must be published to the service library before host development.
- [SeedlingSupportSDK integration](https://open.oppomobile.com/documentation/page/info?id=12719) documents SDK 3.0.7,
  `SeedlingCardWidgetProvider`, the manifest authorization key `com.oplus.ocs.card.AUTH_CODE`, and card updates.
  `SeedlingTool.updateIntelligentData` uses the event code, event name and payload agreed with OPPO; sample values
  from an unrelated service must not be copied as YAQMC credentials or event contracts.

YAQMC has **not applied for these assets yet**. Built-in ColorOS support is therefore pending; the existing
`SystemLyricsPlugin` entry point remains available. Once OPPO assigns the service and authorizes the actual APK
application ID, create and publish the lyric UPK, implement its host provider and adapter, then verify
line changes, pause, foreground return, disabling and process death on ColorOS 16. Test builds with the `.perftest`
application ID need their own applicable authorization. SDK IPC must run off the main thread; provider lifecycle
callbacks also run on background threads. Reuse Core's lyric projection and preserve the failure isolation below.

Other OEM integrations have not been verified. The existing MediaSession remains available to system media UIs;
that alone does not implement lyric support in a system island.

### Bluetooth metadata verification

The car compatibility mode now updates the active session metadata **and** the active item in the session queue.
[AOSP's `MediaPlayerWrapper.isMetadataSynced`](https://android.googlesource.com/platform/packages/modules/Bluetooth/+/refs/heads/main/android/app/src/com/android/bluetooth/audio_util/MediaPlayerWrapper.java)
compares queue and session title/artist before sending updates; changing only the session can leave metadata waiting
for synchronization. [Media3 1.10.1](https://github.com/androidx/media/blob/1.10.1/libraries/session/src/main/java/androidx/media3/session/MediaSessionLegacyStub.java)
publishes the queue from MediaItem metadata and current metadata separately. Both paths therefore receive each line.
The lyric is bound to its track ID, so an old projection cannot label the next song. Disabling the setting,
disconnecting Bluetooth, or a missing line restores the untouched canonical metadata. Only the projected session
queue is decorated; Core's queue remains unchanged. The feature does not include auto-play or a driving-mode UI.

## System lyrics plugins

Settings → Lyrics surfaces → System island / Fluid Cloud has **Plugin development** and **Contribute an adapter**
entries. No OEM adapter is bundled yet. This is a native Android extension compiled into the APK, separate from the
desktop plugin system; it does not load downloaded APKs or JavaScript plugins.

An adapter implements `org.yaqmc.android.lyrics.SystemLyricsPlugin` and has a public constructor accepting an Android
`Context` (the host passes the application context). Register its fully qualified class name in the app manifest:

```xml
<meta-data
    android:name="org.yaqmc.android.SYSTEM_LYRICS_PLUGIN"
    android:value="your.package.ColorOsLyricsPlugin" />
```

- `isAvailable(): Boolean` checks the actual OS/API and required vendor authorization. It must be cheap and must not
  perform network I/O. Only an available adapter enables the system-island switch.
- `show(lyric: SurfaceLyric)` creates or updates the **system** surface. The snapshot contains track ID, title, artist,
  current/secondary/next line and playing state. Updates arrive only when this data changes; the host already schedules
  the next line. Do not start another lyric parser, playback engine or polling timer.
- `hide()` removes the surface and is idempotent. The host calls it on disable, foreground return, cleared track,
  lost availability or plugin failure. Use the vendor's expiry/lifecycle mechanism for process death as well.

All methods run on the main thread. The adapter owns its vendor SDK, manifest declarations, authorization and any
asynchronous work. An exception disables that adapter for the session and attempts cleanup; floating lyrics and
playback remain independent. A system integration must not fall back to `TYPE_APPLICATION_OVERLAY`. R8 keeps registered
plugin implementations. Absent or unsupported plugins do not request overlay permission or create a fake island.

To contribute a ColorOS 16 adapter, use the settings contribution entry or open an issue/PR with the exact device and
OS build, official API documentation, authorization requirements, implementation and device evidence. Include tests
for missing authorization, unsupported devices, line changes, pause, foreground return, disable, process death and
the release APK after R8. Verify the actual system capsule and expanded panel; compilation or an ordinary notification
alone does not prove Fluid Cloud support. Keep status-bar lyrics out of this extension.

## Lyrics frame rate

Synchronized lyrics on Android are drawn by a native overlay (`NativeLyricsOverlay`) on `Choreographer` vsync, reading
Media3's playback position every frame. The WebView beneath does not run its own per-frame lyric clock. The vsync loop
runs only while the overlay is shown and the activity is started; it stops when the app goes to the background and
resumes on return, so a hidden lyrics page does not keep waking the main thread.

The app normally leaves the refresh rate to the system (with touch boost on Android 15+), so adaptive/LTPO panels can
drop to a low rate on static pages. Lyrics animate without touch input, so **while the lyric overlay is visible and
playback is running**, the activity asks for the highest refresh rate available at the current resolution. Pausing,
leaving the lyrics page, or backgrounding the app returns to the system default. Device power policies, battery
saver, and thermal limits can still override the request.

Measure frame pacing instead of relying on the display setting. With USB or wireless debugging connected, open the
lyrics page, start playback, then run (pass `--package` for another build, for example
`org.yaqmc.android.perftest` or `org.yaqmc.android.debug`; layers and processes are matched exactly):

```sh
node scripts/android/measure-frames.mjs --label before --seconds 20
# install the new build, repeat the same song/position, then:
node scripts/android/measure-frames.mjs --label after --seconds 20
node scripts/android/measure-frames.mjs --compare artifacts/android-perf/android-frames-before.json artifacts/android-perf/android-frames-after.json
```

The report records:

- the device and SoC;
- the package, version and whether the build is profileable or debuggable (compare release-like builds only);
- refresh-rate samples taken through the run and the vsync period used as the frame budget;
- per-frame app timings from `gfxinfo framestats` (the window's HWUI timeline, which covers both the WebView and the
  native lyric overlay): p50/p95/p99/max and frames over one and two vsync periods;
- SurfaceFlinger present intervals for the app layer (on-screen FPS, p50/p95/p99, and intervals that skipped a refresh;
  `null` where the device does not expose latency data for BLAST layers);
- `gfxinfo` frame percentiles and jank counters, including GPU percentiles;
- the busiest app threads by CPU;
- thermal status.

## Privacy and storage

Android uses the application-private files and cache directories. Its preferences, queue, cache, and statistics are
independent from a desktop installation. Account secrets are encrypted with a non-exportable Android Keystore key;
there is no plaintext fallback. Losing or invalidating that key requires signing in again.

The release manifest requests Internet access, media-playback foreground-service access, wake-lock access, and the
"display over other apps" permission used only by the opt-in lyric surfaces above (Android asks the user at the moment
a surface is enabled). Notification permission is requested for the optional floating-lyrics unlock action.
It does not request microphone, broad storage, or package-install permissions.
The wake lock is held only while playback is active or buffering.

## Build and verify

Required tools are Node.js 26.7.0, Rust 1.88.0, JDK 21, Android SDK 36, Android NDK 28.2.13676358, and cargo-ndk
4.1.2.

```powershell
npm ci
npm run android:check
npm run android:build:debug
```

The debug APK is exported to the current user's dedicated `Downloads/YAQMC/Android/debug` directory by default.
Set `YAQMC_ANDROID_DEBUG_OUTPUT_DIR` to override that export location.

A local release build additionally requires the four Gradle signing variables documented by the build script. The
tagged workflow accepts the keystore as Base64 and also requires its expected certificate SHA-256 digest, as
documented in [CI](ci.md). Never put a keystore or signing password in the repository or `gradle.properties`.

Published APKs are named `YAQMC-android-arm64-v8a-v<version>.apk`. Verify their SHA-256 value with the adjacent
`SHA256SUMS-android.txt` before sideloading. Android upgrades require the same package ID
(`org.yaqmc.android`) and signing certificate for the lifetime of the application.

See [development](development.md), [architecture](architecture.md), [playback](playback.md),
[authentication](authentication.md), [external URI security](deep-link.md), and [CI](ci.md).
