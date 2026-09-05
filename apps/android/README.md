# YAQMC Android host

This directory contains the Capacitor 8.5.1 Android host (`org.yaqmc.android`). The web renderer is the workspace `dist/` directory; `npm run build:web` builds it and `npm run sync` runs Capacitor synchronization.

## Build

Install Node 26.7.0, Android SDK 36, NDK `28.2.13676358`, and Gradle 8.14.3. From this directory (npm may hoist dependencies to the workspace root):

```text
npm install
npm run build:web
npm run sync
gradle -p android :app:assembleDebug
```

Debug accepts `arm64-v8a` and `x86_64`. Release is arm64-only. Release version metadata comes from `YAQMC_VERSION_NAME` and `YAQMC_VERSION_CODE`. A release build fails unless all of these are present in the environment: `ANDROID_RELEASE_KEYSTORE`, `ANDROID_RELEASE_KEY_ALIAS`, `ANDROID_RELEASE_STORE_PASSWORD`, and `ANDROID_RELEASE_KEY_PASSWORD`. Secrets are intentionally not stored in `gradle.properties`.

The Rust library is not checked into this source tree. The core build must copy ABI-specific `.so` files into a build output directory and set `YAQMC_ANDROID_NATIVE_LIB_DIR` to that directory. The Gradle source set reads JNI libraries from that output only.

## Native contract

`CoreManager` is the process singleton. Its JNI contract is:

```text
nativeInitialize(context, filesDir, cacheDir, buildJson, callback)
nativeInvoke(id, method, paramsJson)
nativeShutdown()

callback.onCoreResponse(id, json)
callback.onCoreEvent(event, json)
callback.onCredentialRequest(requestId, json)
```

Rust should attach worker threads to the JVM before invoking callback methods and must serialize JSON as UTF-8 strings. `nativeInvoke` is asynchronous at the bridge boundary; responses are routed to the Capacitor `coreResponse` event and unsolicited events to `coreEvent`.

## Security and platform behavior

Credentials use Android Keystore AES-256-GCM keys with per-value random IVs. The OAuth surface is a non-exported Activity and only follows HTTPS hosts explicitly supplied by the caller. The shell bridge only opens `http`, `https`, or `mailto` links. The only custom URI filter is the strict `yaqmc://catalog` deep link; cold and hot intents are each consumed once.

The `YaqmcNative` plugin exposes `credentialGet`, `credentialSet`, and `credentialRemove` for Core's credential-request flow; the raw credential value is never sent in an event payload.

Background playback uses Media3 `MediaSessionService` and `SimpleBasePlayer`; no ExoPlayer player or decoder is used. Playback commands are forwarded to Rust Core. The service requests audio focus, pauses on audio becoming noisy, holds a partial wakelock only while playing, and remains alive when the task is swiped away during active playback. No notification, microphone, overlay, external storage, or package-install permission is requested. Media3 may publish its system media controls as required for foreground playback.

Run host tests with `gradle -p android :app:testDebugUnitTest`.
