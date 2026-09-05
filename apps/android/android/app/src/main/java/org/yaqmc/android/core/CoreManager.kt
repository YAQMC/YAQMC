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

    fun initialize(context: Context, buildJson: String, callback: Callback? = null) {
        callback?.let(::addCallback)
        if (initialized.get()) return
        synchronized(lifecycleLock) {
            if (initialized.get()) return
            System.loadLibrary("yaqmc_core")
            credentials = CredentialStore(context.applicationContext)
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

    fun shutdown() {
        synchronized(lifecycleLock) {
            val activeHandle = handle
            handle = 0
            if (initialized.compareAndSet(true, false) && activeHandle != 0L) {
                nativeShutdown(activeHandle)
            }
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
    private external fun nativeShutdown(handle: Long)
}
