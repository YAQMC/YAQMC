package org.yaqmc.android

import java.net.URI
import org.json.JSONArray
import org.json.JSONObject

/** The host-authorized subset of an isolated browser session returned to Core. */
internal data class OAuthBrowserSessionPolicy(
    val url: String,
    val cookieNames: List<String>,
    val requiredCookieNames: List<String>,
)

internal object OAuthBrowserSessionPolicyCodec {
    private const val MAX_URL_BYTES = 2048
    private const val MAX_COOKIE_HEADER_BYTES = 16 * 1024
    private const val MAX_COOKIE_VALUE_BYTES = 8 * 1024
    private val COOKIE_NAME = Regex("^[A-Za-z0-9!#$%&'*+.^_|~-]{1,64}$")

    fun parse(raw: String?): OAuthBrowserSessionPolicy? = runCatching {
        val value = JSONObject(raw ?: return null)
        val url = value.getString("url")
        require(secureCookieUrl(url))
        val format = value.getString("format")
        require(format == "cookie" || format == "kugou-web")
        val cookieNames = names(value.getJSONArray("cookieNames"))
        val requiredCookieNames = names(value.getJSONArray("requiredCookieNames"))
        require(requiredCookieNames.all(cookieNames::contains))
        val origins = value.getJSONArray("credentialOrigins").strings()
        require(origins.isNotEmpty() && origins.all(::secureOrigin))
        OAuthBrowserSessionPolicy(url, cookieNames, requiredCookieNames)
    }.getOrNull()

    /**
     * Returns only the cookie names Core authorized. The caller keeps this JSON
     * out of renderer storage; it exists solely in the app-internal Activity result.
     */
    fun selectedCookies(header: String?, policy: OAuthBrowserSessionPolicy): JSONArray? {
        if (header == null || header.toByteArray(Charsets.UTF_8).size > MAX_COOKIE_HEADER_BYTES) {
            return null
        }
        val found = linkedMapOf<String, String>()
        for (part in header.split(';')) {
            val separator = part.indexOf('=')
            if (separator <= 0) continue
            val name = part.substring(0, separator).trim()
            if (name !in policy.cookieNames || name in found) continue
            val value = part.substring(separator + 1).trim()
            if (value.isEmpty() || value.toByteArray(Charsets.UTF_8).size > MAX_COOKIE_VALUE_BYTES) {
                continue
            }
            found[name] = value
        }
        if (policy.requiredCookieNames.any { it !in found }) return null
        return JSONArray().apply {
            for (name in policy.cookieNames) {
                val value = found[name] ?: continue
                put(JSONObject().put("name", name).put("value", value))
            }
        }
    }

    private fun names(value: JSONArray): List<String> {
        val names = value.strings()
        require(names.size in 1..8 && names.toSet().size == names.size)
        require(names.all(COOKIE_NAME::matches))
        return names
    }

    private fun secureCookieUrl(value: String): Boolean {
        if (value.toByteArray(Charsets.UTF_8).size > MAX_URL_BYTES) return false
        val uri = URI(value)
        return uri.scheme.equals("https", ignoreCase = true) &&
            !uri.host.isNullOrBlank() &&
            uri.rawUserInfo == null &&
            uri.port in setOf(-1, 443) &&
            uri.rawFragment == null
    }

    private fun secureOrigin(value: String): Boolean {
        if (!secureCookieUrl(value)) return false
        val uri = URI(value)
        return uri.rawQuery == null && (uri.rawPath.isNullOrEmpty() || uri.rawPath == "/")
    }

    private fun JSONArray.strings(): List<String> = buildList {
        for (index in 0 until length()) {
            val value = optString(index)
            require(value.isNotEmpty())
            add(value)
        }
    }
}
