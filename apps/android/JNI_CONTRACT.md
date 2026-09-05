# Android JNI contract for the Rust Core

The Kotlin host loads `libyaqmc_core.so` and invokes static JNI methods on `org.yaqmc.android.core.CoreManager`. The native library must export these methods using the normal JNI names for that class:

```text
nativeInitialize(Context context, String filesDir, String cacheDir,
                 String buildJson, NativeCallback callback)
nativeInvoke(long id, String method, String paramsJson)
nativeShutdown()
```

`NativeCallback` is `CoreManager.NativeCallback` and has these methods:

```text
onCoreResponse(long id, String json)
onCoreEvent(String event, String json)
onCredentialRequest(String requestId, String json)
```

The callback object is retained by the Kotlin singleton for the native lifetime. Rust may invoke callbacks from worker threads, but must attach each thread to the JVM first and detach it before exit. Callback JSON must be valid UTF-8 JSON. The host treats payloads as opaque, except `playerState` events consumed by the Media3 facade:

```json
{ "positionMs": 0, "playing": false }
```

Suggested player methods forwarded by `CorePlayer` are `player.prepare`, `player.set_playing` with `{"playing":true|false}`, `player.seek` with `{"positionMs":123}`, and `player.stop`.

JNI calls are intentionally asynchronous. `nativeInvoke` must eventually call `onCoreResponse` for the supplied id, including an error object when a method is unknown or unavailable. Do not return or log credential values in event payloads; use the Android credential plugin methods for secure storage.

The ABI output is supplied outside the source tree through `YAQMC_ANDROID_NATIVE_LIB_DIR`; the Gradle source set never reads checked-in JNI binaries.
