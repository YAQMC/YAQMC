# Android JNI contract for the Rust Core

The Kotlin host loads `libyaqmc_core.so` and calls static native methods on `org.yaqmc.android.core.CoreManager` (`CoreManager.kt`). Every method is declared as `@JvmStatic private external fun`, so the JVM name of the Kotlin declaration is exactly the method name below and the exported symbol is:

```text
Java_org_yaqmc_android_core_CoreManager_<name>
```

| Kotlin declaration (JVM descriptor)                                                         | Exported symbol (`crates/yaqmc-android/src/lib.rs`)              |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `nativeInitialize(Context, String, String, String, Object): Long`                           | `Java_org_yaqmc_android_core_CoreManager_nativeInitialize`       |
| `nativeInvoke(Long, Long, String, String, String)`                                          | `Java_org_yaqmc_android_core_CoreManager_nativeInvoke`           |
| `nativeSetLifecycle(Long, String)`                                                          | `Java_org_yaqmc_android_core_CoreManager_nativeSetLifecycle`     |
| `nativeShutdown(Long)`                                                                      | `Java_org_yaqmc_android_core_CoreManager_nativeShutdown`         |
| `nativeReportAudioState(Long, Long, Long, Long, Boolean, Boolean, Boolean, String, String)` | `Java_org_yaqmc_android_core_CoreManager_nativeReportAudioState` |
| `nativeStreamOpen(Long, Long): Long`                                                        | `Java_org_yaqmc_android_core_CoreManager_nativeStreamOpen`       |
| `nativeStreamRead(Long, ByteArray, Int, Int): Int`                                          | `Java_org_yaqmc_android_core_CoreManager_nativeStreamRead`       |
| `nativeStreamClose(Long)`                                                                   | `Java_org_yaqmc_android_core_CoreManager_nativeStreamClose`      |

`Boolean` maps to the JNI `boolean`/`jboolean` type and `Long` to `long`/`jlong`; nullable Kotlin `String?` parameters accept `null`.

## Why the stream bindings are `private external` behind public wrappers

The class, not the host, decides the symbol name. Kotlin mangles the JVM name of `internal` declarations with the module and compilation suffix (`name$app_debug` or `name$yaqmc_android_app_debug`, depending on the Kotlin toolchain) so that two modules can declare the same internal member. A native method declared `internal external fun nativeStreamOpen` would therefore be called as `nativeStreamOpen$app_debug`, while Rust still exports `Java_org_yaqmc_android_core_CoreManager_nativeStreamOpen`. The lookup fails at the first call with `UnsatisfiedLinkError`.

`private` is not mangled, so `@JvmStatic private external fun` keeps the exact JVM name. Media3 lives in the `org.yaqmc.android.media` package and cannot call a private member, so the object exposes three thin public wrappers that do nothing except delegate:

```kotlin
fun streamOpen(streamId: Long, position: Long): Long = nativeStreamOpen(streamId, position)
fun streamRead(streamId: Long, buffer: ByteArray, offset: Int, length: Int): Int =
    nativeStreamRead(streamId, buffer, offset, length)
fun streamClose(streamId: Long) = nativeStreamClose(streamId)
```

Keep the `private`/`@JvmStatic` shape. Do not introduce `internal` on any `external` declaration; `scripts/ci/check-android-jni-symbols.mjs` fails the build when one appears.

## Host object passed to `nativeInitialize`

The fifth parameter is `CoreManager.NativeCallbacks`, a private Kotlin object retained by the Core for the native lifetime. The callback surface actually called from Rust:

```text
onCoreResponse(long id, String json)
onCoreEvent(long sequence, String channel, String json)
credentialLoad(String account): String?
credentialSave(String account, String secret): Boolean
credentialDelete(String account): Boolean
audioLoad(long streamId, String? localPath, String format): Boolean
audioPlay()
audioPause()
audioStop()
audioSeek(long positionMs)
audioSetVolume(float volume)
```

Rust attaches each worker thread to the JVM before calling back and detaches it afterwards. Callback JSON must be valid UTF-8 JSON. The host treats payloads as opaque, except the `playerState` event consumed by the Media3 facade:

```json
{ "positionMs": 0, "playing": false }
```

`nativeInitialize` returns the Core handle, or `0` after throwing a Java exception. The handle is required by `nativeInvoke`, `nativeSetLifecycle`, `nativeShutdown`, and `nativeReportAudioState`; the stream bindings are handle-free and identify their stream by id alone. `nativeSetLifecycle` accepts `"background"` (anything else means foreground) and forwards it to `player.set_background_mode`. `nativeShutdown` removes the handle, shuts the Core down and throws when the handle is unknown and not `0`.

JNI calls are intentionally asynchronous. `nativeInvoke` must eventually call `onCoreResponse` for the supplied id, including an error object when a method is unknown or unavailable; `origin` is `main` or `host`, and anything else fails with `protocol.denied`. Do not return or log credential values in event payloads; use the Android credential plugin methods for secure storage.

## Stream lifecycle and lease semantics

`NativeAudioDataSource` does not own the stream. Media3 closes and reopens its data source around every seek, so stream lifetime follows the playback generation, not the data source session.

- The flat stream registry (`STREAMS`, keyed by the id returned from `audioLoad`) is the only source of stream lifetime. `retire_stream` is the only path that ends a stream; it runs when `load` replaces the active generation and when `stop` is invoked.
- `nativeStreamOpen(streamId, position)` takes over the cursor. It releases the lease that currently owns the stream, acquires a fresh lease (creating one if the stream has none), seeks to `position`, and returns the remaining byte count. A second live data source therefore replaces the previous cursor owner instead of failing or destroying the stream.
- Cursor ownership is a lease, not a lock: the owner is stored as `StreamState.cursor_owner`, and `nativeStreamClose(streamId)` releases only the lease that this stream id currently owns. Releasing a lease never destroys the stream, so the reopen that follows a Media3 seek keeps working.
- A second data source that waits for a contended cursor for more than `LEASE_WAIT_TIMEOUT` (5 s) receives `-5` (`STREAM_ERR_BUSY`) rather than queueing indefinitely. Media3 drives one data source per media period, so a contended stream is a defect worth surfacing.
- Only the per-stream `reader` mutex covers the actual read/seek. The registry and lease locks are dropped before any I/O; holding them across a blocking progressive read would deadlock every other stream.
- Retiring a stream sets `retired`, clears the cursor owner, wakes lease waiters, removes every lease for that stream id, and cancels the progressive monitor so a read blocked on a range segment returns. Cancellation is requested only on retirement, never on data source close.

## Read result codes

`nativeStreamOpen` returns the remaining byte count (>= 0) or one of the negative codes below. `nativeStreamRead` returns the byte count, or `0` for a genuine end of stream, or one of the negative codes below. The values mirror `STREAM_*` in `crates/yaqmc-android/src/lib.rs` and the companion constants in `NativeStreamError.kt`; both sides must be changed together.

| Code | Constant                | Meaning                                                                                                |
| ---- | ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `0`  | `STREAM_OK_EOF`         | End of stream. `nativeStreamRead` never uses `0` for an error, and a retired stream never returns `0`. |
| `-1` | `STREAM_ERR_IO`         | Reader failure (including a seek past `content_length`).                                               |
| `-2` | `STREAM_ERR_UNKNOWN_ID` | Stream id is unknown, or nobody holds a cursor for it.                                                 |
| `-3` | `STREAM_ERR_CANCELLED`  | The stream was retired while the caller waited, or a blocked progressive read was interrupted.         |
| `-4` | `STREAM_ERR_INTERNAL`   | Rust could not hand the bytes to Kotlin (`set_region` failed). Never reported as EOF.                  |
| `-5` | `STREAM_ERR_BUSY`       | Another data source held the cursor for longer than the lease timeout.                                 |

`NativeAudioDataSource` maps these onto Media3:

- `nativeStreamOpen` returning a negative code throws before any transfer starts.
- `nativeStreamRead` returning `0` becomes `C.RESULT_END_OF_INPUT`.
- `nativeStreamRead` returning a negative code throws `InterruptedIOException` for `-3` and `IOException` for every other code. A negative code must never be treated as end of input: doing so silently truncated playback and suppressed quality fallback (audit F-02).
- `NativeAudioDataSource` also returns `C.RESULT_END_OF_INPUT` locally when the data spec length is already exhausted, before it calls the native layer.
- Every successful read calls `bytesTransferred(bytesRead)` and decrements the remaining length, so a short native read is reported to Media3 as delivered bytes rather than as a seek or an error.

`nativeStreamRead` copies at most `min(length, 64 KiB)` bytes into `buffer` at `offset`; `length == 0` returns `STREAM_OK_EOF` without touching the buffer.

## `nativeReportAudioState`

`ExoAudioBackend` reports Media3 state on every relevant change and every 500 ms while playing:

```text
nativeReportAudioState(
  handle: Long,
  streamId: Long,
  positionMs: Long,
  durationMs: Long,
  isPlaying: Boolean,
  isBuffering: Boolean,
  isEnded: Boolean,
  errorKind: String?,
  error: String?,
)
```

Parameter order is part of the contract. On the Rust side the first parameter after `JClass` is the Core handle; `streamId` is the id from the matching `audioLoad`, `positionMs` is clamped to `>= 0`, and a negative `isPlaying`/`isBuffering`/`isEnded` cannot occur (`jboolean`).

- `durationMs < 0` is the "unknown duration" sentinel. Kotlin sends `-1` (`DURATION_UNSET_SENTINEL` in `ExoAudioBackend`, also used when `C.TIME_UNSET` or a cleared stop report is sent). Rust clears its cached duration, which is how a stop or a new load drops the previous track's duration. `durationMs == 0` leaves the cached value untouched; only positive values overwrite it.
- `isEnded = true` forces the Core's `playing` flag to `false` and wakes the playback clock.
- A report whose `streamId` is nonzero and does not match the Core's active stream is dropped. `streamId = 0` means "no native stream" (local file playback) and is always accepted. This keeps a late callback from a replaced data source from overwriting the current track's state.
- `errorKind` and `error` are stored verbatim. Rust classifies the snapshot from `errorKind`:

| `errorKind`                    | Snapshot effect                                                                                                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source-expired`               | `source_url_expired = true`, `source_error = error`. The progressive monitor's `UrlExpired` also forces this, because it is the only component that sees the upstream HTTP status. |
| `source`, `network`, `decoder` | `source_error = error`, no output error.                                                                                                                                           |
| anything else, or `null`       | `output_error = error`.                                                                                                                                                            |

`ExoAudioBackend.classifyError` produces exactly `network`, `source`, `decoder`, and `output` from the Media3 `PlaybackException` error codes. A kind Rust does not recognise is treated as an output error, so new kinds must be added on both sides.

## Changing the contract

Keep these files in lockstep; the JNI names, result codes, and error-kind strings are ABI:

- `crates/yaqmc-android/src/lib.rs` - exported symbols, `STREAM_*` constants, stream/lease semantics, `nativeReportAudioState` handling and error classification.
- `apps/android/android/app/src/main/java/org/yaqmc/android/core/CoreManager.kt` - `external` declarations, wrappers, `NativeCallbacks`, `reportAudioState` parameter order.
- `apps/android/android/app/src/main/java/org/yaqmc/android/media/NativeStreamError.kt` - `STREAM_ERR_*` mirror constants and the Media3 exception mapping.
- `apps/android/android/app/src/main/java/org/yaqmc/android/media/NativeAudioDataSource.kt` - Media3 data source that consumes those codes.
- `apps/android/android/app/src/main/java/org/yaqmc/android/media/ExoAudioBackend.kt` - `DURATION_UNSET_SENTINEL`, `KIND_*` strings, callback method names and signatures.
- `.github/workflows/ci.yml` and `scripts/ci/check-android-jni-symbols.mjs` - the Android quality job asserts this table still matches the sources.

The ABI output is supplied outside the source tree through `YAQMC_ANDROID_NATIVE_LIB_DIR`; the Gradle source set never reads checked-in JNI binaries.
