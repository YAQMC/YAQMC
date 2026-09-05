package org.yaqmc.android.core

import android.content.Intent
import android.net.Uri
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.util.Collections
import java.util.IdentityHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicReference

data class CatalogSongDeepLink(val providerId: String, val entityId: String)

/** Android implementation of apps/desktop/main/deep-link.ts's catalog-song contract. */
class DeepLinkManager {
    private val consumed = Collections.newSetFromMap(IdentityHashMap<Any, Boolean>())

    fun accept(intent: Intent?): CatalogSongDeepLink? =
        if (intent == null) null else accept(intent, intent.dataString)

    internal fun accept(identity: Any, rawUrl: String?): CatalogSongDeepLink? {
        if (!consumed.add(identity)) return null
        val target = parse(rawUrl) ?: return null
        DeepLinkInbox.offer(target)
        return target
    }

    companion object {
        const val MAX_URI_BYTES = 2_048
        const val MAX_ENTITY_ID_BYTES = 256
        private val providerPattern = Regex("^[a-z0-9][a-z0-9._-]{0,63}$")
        private val invalidEscape = Regex("%(?![0-9a-f]{2})", RegexOption.IGNORE_CASE)

        fun parse(uri: Uri?): CatalogSongDeepLink? = parse(uri?.toString())

        fun parse(value: String?): CatalogSongDeepLink? {
            if (
                value.isNullOrEmpty() ||
                hasControl(value) ||
                invalidEscape.containsMatchIn(value) ||
                value.toByteArray(StandardCharsets.UTF_8).size > MAX_URI_BYTES
            ) {
                return null
            }
            val uri = runCatching { URI(value) }.getOrNull() ?: return null
            if (
                uri.scheme != "yaqmc" ||
                uri.host != "catalog" ||
                uri.rawUserInfo != null ||
                uri.port != -1 ||
                uri.rawFragment != null
            ) {
                return null
            }
            val segments = uri.rawPath.orEmpty().split('/').filter(String::isNotEmpty)
            if (segments.size != 2 || segments[1] != "song") return null
            val provider = segments[0]
            if (!providerPattern.matches(provider)) return null
            val fields = uri.rawQuery?.split('&') ?: return null
            if (fields.size != 1) return null
            val equals = fields[0].indexOf('=')
            if (equals <= 0) return null
            val queryName = decode(fields[0].substring(0, equals)) ?: return null
            val entity = decode(fields[0].substring(equals + 1)) ?: return null
            if (
                queryName != "id" ||
                entity.isEmpty() ||
                entity != entity.trim() ||
                hasControl(entity) ||
                entity.toByteArray(StandardCharsets.UTF_8).size > MAX_ENTITY_ID_BYTES
            ) {
                return null
            }
            return CatalogSongDeepLink(provider, entity)
        }

        fun isCatalogUri(uri: Uri): Boolean = parse(uri) != null

        private fun decode(value: String): String? =
            runCatching {
                URLDecoder.decode(value.replace("+", "%2B"), StandardCharsets.UTF_8.name())
            }.getOrNull()

        private fun hasControl(value: String) = value.any { it.code <= 31 || it.code == 127 }
    }
}

/** Process-local inbox bridges cold start delivery and a renderer that is not ready yet. */
object DeepLinkInbox {
    private val pending = AtomicReference<CatalogSongDeepLink?>(null)
    private val listeners = CopyOnWriteArrayList<(CatalogSongDeepLink) -> Unit>()

    @Synchronized
    fun offer(target: CatalogSongDeepLink) {
        if (listeners.isEmpty()) {
            pending.set(target)
        } else {
            listeners.forEach { it(target) }
        }
    }

    fun take(): CatalogSongDeepLink? = pending.getAndSet(null)

    @Synchronized
    fun subscribe(listener: (CatalogSongDeepLink) -> Unit): AutoCloseable {
        listeners.add(listener)
        pending.getAndSet(null)?.let(listener)
        return AutoCloseable { listeners.remove(listener) }
    }
}
