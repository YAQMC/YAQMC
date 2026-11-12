package org.yaqmc.android.plugin

import org.json.JSONObject
import java.util.Base64

/** Portable names keep the same relative-path contract on SAF, Windows, Linux and macOS. */
internal object PluginFilePolicy {
    const val MAX_BYTES = 512 * 1024

    fun name(value: String): String {
        require(value.isNotEmpty() && value != "." && value != ".." &&
            value.none { it <= '\u001f' || it in "\\/:<>\"|?*" } &&
            !value.endsWith('.') && !value.endsWith(' ') &&
            !Regex("^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\\.|$)", RegexOption.IGNORE_CASE).containsMatchIn(value) &&
            value.toByteArray(Charsets.UTF_8).size <= 255) { "files.invalid-path" }
        return value
    }

    fun parts(value: Any?): List<String> {
        if (value == null) return emptyList()
        require(value is String && value.length <= 2048) { "files.invalid-path" }
        return if (value.isEmpty()) emptyList() else value.split('/').map(::name)
    }

    fun number(value: Any?, fallback: Long, max: Long): Long {
        if (value == null) return fallback
        require(value is Number && value.toDouble().isFinite() && value.toDouble() >= 0 &&
            value.toDouble() <= max.toDouble() && value.toLong().toDouble() == value.toDouble()) { "files.invalid-argument" }
        return value.toLong()
    }

    fun encoding(p: JSONObject): String {
        val value = p.opt("encoding") ?: "utf8"
        require(value == "utf8" || value == "base64") { "files.invalid-argument" }
        return value.toString()
    }

    fun data(p: JSONObject): ByteArray {
        val value = p.opt("data")
        require(value is String) { "files.invalid-argument" }
        val data = if (encoding(p) == "base64") {
            val bytes = runCatching { Base64.getDecoder().decode(value) }
                .getOrElse { throw IllegalArgumentException("files.invalid-argument") }
            require(Base64.getEncoder().encodeToString(bytes) == value) { "files.invalid-argument" }
            bytes
        } else value.toByteArray(Charsets.UTF_8)
        require(data.size <= MAX_BYTES) { "files.too-large" }
        return data
    }
}
