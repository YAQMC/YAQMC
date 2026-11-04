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

- Home, Discover, Search, Library, account pages, playback queue, statistics, and in-app lyrics use the shared UI.
- A four-destination bottom bar is used on compact screens; larger screens switch to a navigation rail.
- Rust/CPAL owns audio output. AndroidX Media3 projects that state into the media notification, lock screen,
  Bluetooth controls, and headset buttons.
- Dismissing the task while music is playing does not stop playback. Use Pause or the notification's Stop action.
- Song sharing uses the Android share sheet. `yaqmc://catalog/...` links are handled as explicit Android intents;
  Android never polls the clipboard for links.
- Update checks only notify and open the matching GitHub Release in the system browser. YAQMC does not download or
  install APKs itself.

Desktop lyric overlays, Lyrics Island, tray controls, global shortcuts, plugins, developer mode, the loopback Local
API, and file exports are intentionally absent from Android v1. The in-app lyric screen remains available.

## Lyrics frame rate

Synchronized lyrics on Android are drawn by a native overlay (`NativeLyricsOverlay`) on `Choreographer` vsync, reading
Media3's playback position every frame. The WebView beneath does not run its own per-frame lyric clock.

The app normally leaves the refresh rate to the system (with touch boost on Android 15+), so adaptive/LTPO panels can
drop to a low rate on static pages. Lyrics animate without touch input, so **while the lyric overlay is visible and
playback is running**, the activity asks for the highest refresh rate available at the current resolution. Pausing,
leaving the lyrics page, or backgrounding the app returns to the system default. Device power policies, battery
saver, and thermal limits can still override the request.

Measure frame pacing instead of relying on the display setting. With USB or wireless debugging connected, open the
lyrics page, start playback, then run:

```sh
node scripts/android/measure-frames.mjs --label before --seconds 20
# install the new build, repeat the same song/position, then:
node scripts/android/measure-frames.mjs --label after --seconds 20
node scripts/android/measure-frames.mjs --compare artifacts/android-perf/android-frames-before.json artifacts/android-perf/android-frames-after.json
```

The report records:

- the device and SoC;
- refresh-rate samples taken through the run;
- SurfaceFlinger present intervals for the app layer (on-screen FPS, p50/p95/p99, and intervals that skipped a refresh);
- `gfxinfo` frame percentiles and jank counters, including GPU percentiles;
- the busiest app threads by CPU;
- thermal status.

## Privacy and storage

Android uses the application-private files and cache directories. Its preferences, queue, cache, and statistics are
independent from a desktop installation. Account secrets are encrypted with a non-exportable Android Keystore key;
there is no plaintext fallback. Losing or invalidating that key requires signing in again.

The release manifest requests only Internet access, media-playback foreground-service access, and wake-lock access.
It does not request microphone, overlay, broad storage, notification, or package-install permissions. The wake lock
is held only while playback is active or buffering.

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
