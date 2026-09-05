package org.yaqmc.android.core

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

data class QqMusicMobileLoginTarget(val authorizationUrl: String)

/** Strict boundary for the undocumented QQ Music app hand-off used by phone login. */
object MobileLoginPolicy {
    const val PHONE_SMALLEST_WIDTH_DP = 600
    const val QQ_MUSIC_PROVIDER_ID = "qqmusic"
    const val QQ_LOGIN_METHOD_ID = "qq"
    const val QQ_MUSIC_PACKAGE = "com.tencent.qqmusic"

    private const val AUTHORIZATION_HOST = "y.qq.com"
    private const val AUTHORIZATION_PATH = "/m/client/qr_code_login/authorize.html"
    private const val MAX_URL_BYTES = 2_048
    private const val MAX_QR_CODE_ID_BYTES = 512
    private val invalidEscape = Regex("%(?![0-9a-fA-F]{2})")

    fun shouldUseQqMusicApp(
        smallestScreenWidthDp: Int,
        providerId: String?,
        methodId: String?,
    ): Boolean =
        smallestScreenWidthDp in 1 until PHONE_SMALLEST_WIDTH_DP &&
            providerId == QQ_MUSIC_PROVIDER_ID &&
            methodId == QQ_LOGIN_METHOD_ID

    /** Reopening may only target the same still-active attempt; terminal results require a new explicit start. */
    fun canReopenAttempt(expectedId: String, actualId: String?, state: String?): Boolean =
        expectedId.isNotBlank() && expectedId == actualId && state in MobileLoginLeaseRegistry.ACTIVE_STATES

    fun validateLaunchUrl(value: String?): QqMusicMobileLoginTarget? {
        if (
            value.isNullOrEmpty() ||
            hasControl(value) ||
            invalidEscape.containsMatchIn(value) ||
            value.toByteArray(StandardCharsets.UTF_8).size > MAX_URL_BYTES
        ) {
            return null
        }
        val uri = runCatching { URI(value) }.getOrNull() ?: return null
        if (
            !uri.scheme.equals("https", ignoreCase = true) ||
            !uri.host.equals(AUTHORIZATION_HOST, ignoreCase = true) ||
            uri.rawUserInfo != null ||
            (uri.port != -1 && uri.port != 443) ||
            uri.rawPath != AUTHORIZATION_PATH ||
            uri.rawFragment != null
        ) {
            return null
        }
        val rawQuery = uri.rawQuery ?: return null
        if (rawQuery.contains('&')) return null
        val separator = rawQuery.indexOf('=')
        if (separator <= 0) return null
        val name = decode(rawQuery.substring(0, separator)) ?: return null
        val identifier = decode(rawQuery.substring(separator + 1)) ?: return null
        if (
            name != "qrcode_id" ||
            identifier.isEmpty() ||
            identifier != identifier.trim() ||
            hasControl(identifier) ||
            identifier.toByteArray(StandardCharsets.UTF_8).size > MAX_QR_CODE_ID_BYTES
        ) {
            return null
        }
        val encodedIdentifier = URLEncoder
            .encode(identifier, StandardCharsets.UTF_8.name())
            .replace("+", "%20")
            .replace("%7E", "~")
        return QqMusicMobileLoginTarget(
            "https://$AUTHORIZATION_HOST$AUTHORIZATION_PATH?qrcode_id=$encodedIdentifier",
        )
    }

    private fun decode(value: String): String? =
        runCatching {
            URLDecoder.decode(value.replace("+", "%2B"), StandardCharsets.UTF_8.name())
        }.getOrNull()

    private fun hasControl(value: String): Boolean =
        value.any { it.code <= 31 || it.code == 127 }
}
