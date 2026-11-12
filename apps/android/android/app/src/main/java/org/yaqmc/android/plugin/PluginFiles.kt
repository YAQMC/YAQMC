package org.yaqmc.android.plugin

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract as Docs
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import org.json.JSONArray
import org.json.JSONObject
import java.io.FileNotFoundException
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** SAF grants live only for one plugin runtime; paths and content URIs never cross into the worker. */
internal class PluginFiles(
    private val context: Context,
    private val authorize: (JSONObject, (Boolean) -> Unit) -> Unit,
    private val openPicker: (PluginCall, Intent) -> Unit,
) {
    private data class Grant(val token: String, val tree: Uri?, var uri: Uri, val writable: Boolean)
    private class Pending(val call: PluginCall, val request: JSONObject) {
        val token: String = request.getString("token")
        val method: String = request.getString("method")
        val payload: JSONObject = request.getJSONObject("payload")
        @Volatile var cancelled = false
    }
    private val grants = ConcurrentHashMap<String, Grant>()
    private val pending = ConcurrentHashMap<String, Pending>()
    private val picker = AtomicReference<String?>(null)
    private val executor = Executors.newSingleThreadExecutor()
    @Volatile private var closed = false
    private val resolver get() = context.contentResolver

    private fun ensureCapacity(token: String) {
        require(grants.values.count { it.token == token } < 64 && grants.size < 512) { "files.handle-limit" }
    }

    fun pickerFailed(call: PluginCall) {
        pending[call.callbackId]?.let { operation -> attempt(operation) { error("files.picker-unavailable") } }
    }

    @Synchronized fun release(token: String) {
        pending.values.filter { it.token == token }.forEach { it.cancelled = true }
        grants.entries.removeIf { it.value.token == token }
    }

    @Synchronized fun close() {
        closed = true
        grants.clear()
        pending.values.forEach { it.cancelled = true; it.call.reject("files.cancelled") }
        pending.clear()
        executor.shutdownNow()
    }

    @Synchronized fun invoke(call: PluginCall, params: JSONObject) {
        if (closed) { call.reject("files.cancelled"); return }
        val request = params.optJSONObject("request")
        if (request == null || request.opt("token") !is String || request.optString("token").length !in 1..256 ||
            request.opt("method") !is String || !request.optString("method").startsWith("files.") ||
            request.optJSONObject("payload") == null || request.toString().length > 768 * 1024) {
            call.reject("files.invalid-argument"); return
        }
        if (pending.size >= 32) { call.reject("files.busy"); return }
        val operation = Pending(call, request)
        pending[call.callbackId] = operation
        executor.execute {
            attempt(operation) {
                check(operation)
                if (operation.method == "files.pickFile" || operation.method == "files.pickDirectory") {
                    val writable = operation.payload.opt("writable") ?: false
                    require(writable is Boolean) { "files.invalid-argument" }
                    ensureCapacity(operation.token)
                    require(picker.compareAndSet(null, call.callbackId)) { "files.busy" }
                    val directory = operation.method == "files.pickDirectory"
                    val intent = Intent(if (directory) Intent.ACTION_OPEN_DOCUMENT_TREE else Intent.ACTION_OPEN_DOCUMENT).apply {
                        if (!directory) { addCategory(Intent.CATEGORY_OPENABLE); type = "*/*" }
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        if (writable) addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                    }
                    try { openPicker(call, intent) } catch (error: Exception) { picker.compareAndSet(call.callbackId, null); throw error }
                } else {
                    val value = perform(operation)
                    check(operation)
                    finish(operation, value)
                }
            }
        }
    }

    @Synchronized fun picked(call: PluginCall?, result: ActivityResult) {
        if (call == null || closed) return
        picker.compareAndSet(call.callbackId, null)
        val operation = pending[call.callbackId] ?: return
        executor.execute {
            attempt(operation) {
                check(operation)
                val uri = result.data?.data
                if (result.resultCode != android.app.Activity.RESULT_OK || uri == null) { finish(operation, null); return@attempt }
                require(uri.scheme == "content") { "files.invalid-selection" }
                val directory = operation.method == "files.pickDirectory"
                require(if (directory) Docs.isTreeUri(uri) else Docs.isDocumentUri(context, uri)) { "files.invalid-selection" }
                val writable = operation.payload.optBoolean("writable", false)
                if (writable) require((result.data!!.flags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0) { "files.read-only" }
                val document = if (directory) Docs.buildDocumentUriUsingTree(uri, Docs.getTreeDocumentId(uri)) else uri
                val grant = Grant(operation.token, if (directory) uri else null, document, writable)
                val entry = info(document, writable)
                require((entry.getString("type") == "directory") == directory) { "files.invalid-selection" }
                check(operation)
                val handle = UUID.randomUUID().toString()
                synchronized(this) {
                    require(!closed && !operation.cancelled) { "files.cancelled" }
                    ensureCapacity(operation.token)
                    grants[handle] = grant
                }
                finish(operation, JSONObject().put("handle", handle).put("name", entry.getString("name"))
                    .put("type", entry.getString("type")).put("writable", writable))
            }
        }
    }

    private fun check(operation: Pending) {
        require(!operation.cancelled) { "files.cancelled" }
        val ready = CountDownLatch(1)
        var allowed = false
        authorize(operation.request) { allowed = it; ready.countDown() }
        require(ready.await(10, TimeUnit.SECONDS) && allowed && !operation.cancelled) { "files.permission-denied" }
    }

    private fun attempt(operation: Pending, action: () -> Unit) {
        try { action() } catch (error: Exception) {
            picker.compareAndSet(operation.call.callbackId, null)
            if (pending.remove(operation.call.callbackId, operation)) {
                val code = when {
                    error.message?.startsWith("files.") == true -> error.message!!
                    error is FileNotFoundException -> "files.not-found"
                    error is SecurityException -> "files.permission-denied"
                    else -> "files.io"
                }
                operation.call.reject(code)
            }
        }
    }

    private fun finish(operation: Pending, value: Any?) {
        if (pending.remove(operation.call.callbackId, operation)) operation.call.resolve(JSObject().put("value", value ?: JSONObject.NULL))
    }

    private fun info(uri: Uri, writable: Boolean): JSONObject {
        val columns = arrayOf(Docs.Document.COLUMN_DOCUMENT_ID, Docs.Document.COLUMN_DISPLAY_NAME,
            Docs.Document.COLUMN_MIME_TYPE, Docs.Document.COLUMN_SIZE, Docs.Document.COLUMN_LAST_MODIFIED)
        return requireNotNull(resolver.query(uri, columns, null, null, null)) { "files.not-found" }.use { cursor ->
            require(cursor.moveToFirst()) { "files.not-found" }
            JSONObject().put("name", cursor.getString(1)).put("type", if (cursor.getString(2) == Docs.Document.MIME_TYPE_DIR) "directory" else "file")
                .put("size", if (cursor.isNull(3)) JSONObject.NULL else cursor.getLong(3))
                .put("modifiedMs", if (cursor.isNull(4)) JSONObject.NULL else cursor.getLong(4)).put("writable", writable)
        }
    }

    private fun children(grant: Grant, parent: Uri, offset: Long = 0, limit: Int = 200): Pair<List<Pair<Uri, JSONObject>>, Long?> {
        val tree = requireNotNull(grant.tree) { "files.not-a-directory" }
        val query = Docs.buildChildDocumentsUriUsingTree(tree, Docs.getDocumentId(parent))
        val columns = arrayOf(Docs.Document.COLUMN_DOCUMENT_ID, Docs.Document.COLUMN_DISPLAY_NAME,
            Docs.Document.COLUMN_MIME_TYPE, Docs.Document.COLUMN_SIZE, Docs.Document.COLUMN_LAST_MODIFIED)
        return requireNotNull(resolver.query(query, columns, null, null, null)) { "files.not-found" }.use { cursor ->
            val entries = mutableListOf<Pair<Uri, JSONObject>>()
            var index = 0L
            while (cursor.moveToNext()) {
                if (index++ < offset) continue
                if (entries.size == limit) return@use entries to (index - 1)
                val name = cursor.getString(1)
                if (runCatching { PluginFilePolicy.name(name) }.isFailure) continue
                val uri = Docs.buildDocumentUriUsingTree(tree, cursor.getString(0))
                entries.add(uri to JSONObject().put("name", name)
                    .put("type", if (cursor.getString(2) == Docs.Document.MIME_TYPE_DIR) "directory" else "file")
                    .put("size", if (cursor.isNull(3)) JSONObject.NULL else cursor.getLong(3))
                    .put("modifiedMs", if (cursor.isNull(4)) JSONObject.NULL else cursor.getLong(4)).put("writable", grant.writable))
            }
            entries to null
        }
    }

    private fun child(grant: Grant, parent: Uri, name: String): Uri? {
        var cursor = 0L
        do {
            val (entries, next) = children(grant, parent, cursor)
            entries.firstOrNull { it.second.getString("name") == name }?.let { return it.first }
            cursor = next ?: return null
        } while (cursor < 1_000_000)
        error("files.directory-too-large")
    }

    private fun resolve(grant: Grant, parts: List<String>): Uri {
        require(grant.tree != null || parts.isEmpty()) { "files.invalid-path" }
        var uri = grant.uri
        for (part in parts) uri = child(grant, uri, part) ?: error("files.not-found")
        return uri
    }

    private fun perform(operation: Pending): Any {
        val p = operation.payload
        if (operation.method == "files.capabilities") return JSONObject().put("available", true)
            .put("maxBytes", PluginFilePolicy.MAX_BYTES).put("maxEntries", 200)
            .put("persistentHandles", false).put("recursiveDelete", false).put("directoryDelete", false)
        val handle = p.optString("handle")
        val grant = grants[handle]?.takeIf { it.token == operation.token } ?: error("files.invalid-handle")
        if (operation.method == "files.close") { grants.remove(handle); return JSONObject().put("ok", true) }
        val parts = PluginFilePolicy.parts(p.opt("path"))
        val writing = operation.method in setOf("files.writeFile", "files.mkdir", "files.rename", "files.remove")
        require(!writing || grant.writable) { "files.read-only" }
        if (operation.method == "files.mkdir" || operation.method == "files.writeFile") {
            val data = if (operation.method == "files.writeFile") PluginFilePolicy.data(p) else null
            val parent = if (parts.isEmpty()) null else resolve(grant, parts.dropLast(1))
            var target = if (parent == null) grant.uri else child(grant, parent, parts.last())
            val overwrite = p.opt("overwrite") ?: false
            require(overwrite is Boolean) { "files.invalid-argument" }
            if (operation.method == "files.mkdir") require(parts.isNotEmpty()) { "files.invalid-path" }
            if (target != null && (data == null || !overwrite)) error("files.exists")
            check(operation)
            if (target == null) {
                target = Docs.createDocument(resolver, requireNotNull(parent), if (data == null) Docs.Document.MIME_TYPE_DIR else "application/octet-stream", parts.last())
                    ?: error("files.io")
                // Providers may adjust a duplicate/unsupported name. Remove only our newly
                // created document before reporting failure, never an existing document.
                if (info(target, true).getString("name") != parts.last()) {
                    runCatching { Docs.deleteDocument(resolver, target) }
                    error("files.name-changed")
                }
            }
            if (data != null) {
                require(info(target, true).getString("type") == "file") { "files.not-a-file" }
                check(operation)
                val descriptor = requireNotNull(resolver.openFileDescriptor(target, "rwt")) { "files.io" }
                ParcelFileDescriptor.AutoCloseOutputStream(descriptor).use { it.write(data) }
            }
            return JSONObject().put("ok", true).apply { if (data != null) put("bytesWritten", data.size) }
        }
        val target = resolve(grant, parts)
        return when (operation.method) {
            "files.stat" -> info(target, grant.writable)
            "files.list" -> {
                val offset = PluginFilePolicy.number(p.opt("cursor"), 0, 1_000_000)
                val limit = PluginFilePolicy.number(p.opt("limit"), 100, 200).toInt()
                require(limit > 0 && info(target, false).getString("type") == "directory") { "files.not-a-directory" }
                val (entries, next) = children(grant, target, offset, limit)
                JSONObject().put("entries", JSONArray(entries.map { it.second })).put("nextCursor", next ?: JSONObject.NULL)
            }
            "files.readFile" -> {
                val offset = PluginFilePolicy.number(p.opt("offset"), 0, 9_007_199_254_740_991L)
                val length = PluginFilePolicy.number(p.opt("length"), PluginFilePolicy.MAX_BYTES.toLong(), PluginFilePolicy.MAX_BYTES.toLong()).toInt()
                require(length > 0) { "files.invalid-argument" }
                val encoding = PluginFilePolicy.encoding(p)
                val metadata = info(target, false)
                require(metadata.getString("type") == "file") { "files.not-a-file" }
                val descriptor = requireNotNull(resolver.openFileDescriptor(target, "r")) { "files.io" }
                ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { input ->
                        if (offset > 0) runCatching { input.channel.position(offset) }.getOrElse { error("files.unsupported-seek") }
                        val buffer = ByteArray(length)
                        var count = 0
                        while (count < length) { val read = input.read(buffer, count, length - count); if (read < 0) break; if (read == 0) error("files.io"); count += read }
                        val data = buffer.copyOf(count)
                        JSONObject().put("data", if (encoding == "base64") Base64.getEncoder().encodeToString(data) else String(data, Charsets.UTF_8))
                            .put("bytesRead", count).put("eof", count < length || (!metadata.isNull("size") && offset + count >= metadata.getLong("size")))
                }
            }
            "files.rename" -> {
                require(grant.tree == null || parts.isNotEmpty()) { "files.root-operation-denied" }
                val name = PluginFilePolicy.name(p.optString("name"))
                if (info(target, true).getString("name") == name) return JSONObject().put("ok", true).put("name", name)
                if (parts.isNotEmpty()) require(child(grant, resolve(grant, parts.dropLast(1)), name) == null) { "files.exists" }
                check(operation)
                val renamed = Docs.renameDocument(resolver, target, name) ?: error("files.unsupported")
                if (grant.tree == null) grant.uri = renamed
                JSONObject().put("ok", true).put("name", info(renamed, true).getString("name"))
            }
            "files.remove" -> {
                // SAF deleteDocument may recursively delete a directory. Do not advertise or emulate
                // an atomic empty-directory delete that DocumentsProvider cannot guarantee.
                require(info(target, true).getString("type") == "file") { "files.unsupported-directory-delete" }
                check(operation)
                require(Docs.deleteDocument(resolver, target)) { "files.io" }
                if (grant.tree == null) grants.remove(handle)
                JSONObject().put("ok", true)
            }
            else -> error("files.unsupported")
        }
    }
}
