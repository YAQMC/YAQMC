package org.yaqmc.android.core

import android.content.Context
import androidx.annotation.Keep
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/** Process-wide bridge to the Rust Core. JSON stays opaque to the Android host. */
object CoreManager {
    interface Callback {
        fun onCoreResponse(id: Long, json: String)
        fun onCoreEvent(sequence: Long, channel: String, json: String)
    }

    private val initialized = AtomicBoolean(false)
    private val ids = AtomicLong(0)
    private val callbacks = CopyOnWriteArrayList<Callback>()
    private val oneShotResponses = ConcurrentHashMap<Long, (String) -> Unit>()
    private val lifecycleLock = Any()
    @Volatile private var handle = 0L
    private lateinit var credentials: CredentialStore
    @Volatile private var _audioBackend: org.yaqmc.android.media.ExoAudioBackend? = null
    val audioBackend: org.yaqmc.android.media.ExoAudioBackend? get() = _audioBackend

    fun initialize(context: Context, buildJson: String, callback: Callback? = null) {
        callback?.let(::addCallback)
        if (initialized.get()) return
        synchronized(lifecycleLock) {
            if (initialized.get()) return
            System.loadLibrary("yaqmc_core")
            credentials = CredentialStore(context.applicationContext)
            _audioBackend = org.yaqmc.android.media.ExoAudioBackend(context.applicationContext)
            val nativeHandle = nativeInitialize(
                context.applicationContext,
                context.filesDir.absolutePath,
                context.cacheDir.absolutePath,
                buildJson,
                NativeCallbacks,
            )
            check(nativeHandle != 0L) { "Rust Core initialization returned a null handle" }
            handle = nativeHandle
            initialized.set(true)
        }
    }

    fun isReady(): Boolean = initialized.get() && handle != 0L

    fun addCallback(callback: Callback) {
        callbacks.addIfAbsent(callback)
    }

    fun removeCallback(callback: Callback) {
        callbacks.remove(callback)
    }

    fun invoke(
        method: String,
        paramsJson: String = "{}",
        origin: String = "main",
        listener: Callback? = null,
        onResponse: ((String) -> Unit)? = null,
    ): Long {
        listener?.let(::addCallback)
        require(method.length in 1..128) { "invalid Core method name" }
        require(origin == "main" || origin == "host") { "invalid Core origin" }
        val activeHandle = handle
        check(initialized.get() && activeHandle != 0L) { "Rust Core is unavailable" }
        val id = ids.incrementAndGet()
        onResponse?.let { oneShotResponses[id] = it }
        nativeInvoke(activeHandle, id, origin, method, paramsJson)
        return id
    }

    fun setLifecycle(state: String) {
        val activeHandle = handle
        if (initialized.get() && activeHandle != 0L) {
            nativeSetLifecycle(activeHandle, state)
        }
    }

    fun reportAudioState(
        streamId: Long,
        positionMs: Long,
        durationMs: Long,
        isPlaying: Boolean,
        isBuffering: Boolean,
        isEnded: Boolean,
        errorKind: String?,
        error: String?,
    ) {
        val activeHandle = handle
        if (initialized.get() && activeHandle != 0L) {
            nativeReportAudioState(
                activeHandle,
                streamId,
                positionMs,
                durationMs,
                isPlaying,
                isBuffering,
                isEnded,
                errorKind,
                error,
            )
        }
    }

    fun shutdown() {
        synchronized(lifecycleLock) {
            val activeHandle = handle
            handle = 0
            if (initialized.compareAndSet(true, false) && activeHandle != 0L) {
                nativeShutdown(activeHandle)
            }
            _audioBackend?.release()
            _audioBackend = null
            oneShotResponses.clear()
        }
    }

    private fun emitResponse(id: Long, json: String) {
        oneShotResponses.remove(id)?.invoke(json)
        callbacks.forEach { it.onCoreResponse(id, json) }
    }

    private fun emitEvent(sequence: Long, channel: String, json: String) {
        callbacks.forEach { it.onCoreEvent(sequence, channel, json) }
    }

    @Keep
    private object NativeCallbacks {
        fun onCoreResponse(id: Long, json: String) = emitResponse(id, json)

        fun onCoreEvent(sequence: Long, channel: String, json: String) =
            emitEvent(sequence, channel, json)

        fun credentialLoad(account: String): String? = credentials.get(account)

        fun credentialSave(account: String, secret: String): Boolean =
            runCatching {
                credentials.put(account, secret)
                true
            }.getOrDefault(false)

        fun credentialDelete(account: String): Boolean =
            runCatching {
                credentials.remove(account)
                true
            }.getOrDefault(false)

        fun audioLoad(streamId: Long, localPath: String?, format: String): Boolean =
            _audioBackend?.load(streamId, localPath, format) ?: false

        fun audioPlay() {
            _audioBackend?.play()
        }

        fun audioPause() {
            _audioBackend?.pause()
        }

        fun audioStop() {
            _audioBackend?.stop()
        }

        fun audioSeek(positionMs: Long) {
            _audioBackend?.seek(positionMs)
        }

        fun audioSetVolume(volume: Float) {
            _audioBackend?.setVolume(volume)
        }
    }

    @JvmStatic
    private external fun nativeInitialize(
        context: Context,
        filesDir: String,
        cacheDir: String,
        buildJson: String,
        callback: Any,
    ): Long

    @JvmStatic
    private external fun nativeInvoke(
        handle: Long,
        id: Long,
        origin: String,
        method: String,
        paramsJson: String,
    )

    @JvmStatic
    private external fun nativeSetLifecycle(handle: Long, state: String)

    @JvmStatic
    private external fun nativeReportAudioState(
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

    @JvmStatic
    private external fun nativeStreamOpen(streamId: Long, position: Long): Long

    @JvmStatic
    private external fun nativeStreamRead(
        streamId: Long,
        buffer: ByteArray,
        offset: Int,
        length: Int,
    ): Int

    @JvmStatic
    private external fun nativeStreamClose(streamId: Long)

    fun streamOpen(streamId: Long, position: Long): Long = nativeStreamOpen(streamId, position)

    fun streamRead(streamId: Long, buffer: ByteArray, offset: Int, length: Int): Int =
        nativeStreamRead(streamId, buffer, offset, length)

    fun streamClose(streamId: Long) = nativeStreamClose(streamId)

    @JvmStatic
    private external fun nativeShutdown(handle: Long)
}
