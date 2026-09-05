package org.yaqmc.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileLoginPolicyTest {
    @Test
    fun `reopening is bound to the existing active attempt independently of viewport`() {
        assertTrue(MobileLoginPolicy.canReopenAttempt("a", "a", "waiting-for-scan"))
        assertTrue(MobileLoginPolicy.canReopenAttempt("a", "a", "waiting-for-confirmation"))
        assertFalse(MobileLoginPolicy.canReopenAttempt("a", "b", "waiting-for-scan"))
        assertFalse(MobileLoginPolicy.canReopenAttempt("a", "a", "expired"))
        assertFalse(MobileLoginPolicy.canReopenAttempt("a", "a", "authenticated"))
        assertFalse(MobileLoginPolicy.canReopenAttempt("a", null, null))
        assertFalse(MobileLoginPolicy.canReopenAttempt("", "", "waiting-for-scan"))
    }

    @Test
    fun `only QQ Music login on a phone uses the app hand-off`() {
        assertTrue(MobileLoginPolicy.shouldUseQqMusicApp(599, "qqmusic", "qq"))
        assertFalse(MobileLoginPolicy.shouldUseQqMusicApp(600, "qqmusic", "qq"))
        assertFalse(MobileLoginPolicy.shouldUseQqMusicApp(360, "plugin.example", "qq"))
        assertFalse(MobileLoginPolicy.shouldUseQqMusicApp(360, "qqmusic", "wechat"))
        assertFalse(MobileLoginPolicy.shouldUseQqMusicApp(0, "qqmusic", "qq"))
    }

    @Test
    fun `launch URL accepts only the exact QQ Music mobile QR endpoint`() {
        assertEquals(
            "https://y.qq.com/m/client/qr_code_login/authorize.html?qrcode_id=qid-contract-1",
            MobileLoginPolicy.validateLaunchUrl(
                "https://y.qq.com/m/client/qr_code_login/authorize.html?qrcode_id=qid-contract-1",
            )?.authorizationUrl,
        )
        assertEquals(
            "https://y.qq.com/m/client/qr_code_login/authorize.html?qrcode_id=a%2Bb",
            MobileLoginPolicy.validateLaunchUrl(
                "https://y.qq.com:443/m/client/qr_code_login/authorize.html?qrcode_id=a%2Bb",
            )?.authorizationUrl,
        )
    }

    @Test
    fun `launch URL rejects redirects and ambiguous query strings`() {
        val rejected = listOf(
            "http://y.qq.com/m/client/qr_code_login/authorize.html?qrcode_id=a",
            "https://y.qq.com.evil.test/m/client/qr_code_login/authorize.html?qrcode_id=a",
            "https://user@y.qq.com/m/client/qr_code_login/authorize.html?qrcode_id=a",
            "https://y.qq.com/other?qrcode_id=a",
            "https://y.qq.com/m/client/qr_code_login/authorize.html",
            "https://y.qq.com/m/client/qr_code_login/authorize.html?qrcode_id=",
            "https://y.qq.com/m/client/qr_code_login/authorize.html?qrcode_id=a&next=evil",
            "https://y.qq.com/m/client/qr_code_login/authorize.html?qrcode_id=a#fragment",
            "https://y.qq.com/m/client/qr_code_login/authorize.html?qrcode_id=%0A",
            "https://y.qq.com/m/client/qr_code_login/authorize.html?qrcode_id=%zz",
        )
        rejected.forEach { value -> assertNull(value, MobileLoginPolicy.validateLaunchUrl(value)) }
        assertNull(
            MobileLoginPolicy.validateLaunchUrl(
                "https://y.qq.com/m/client/qr_code_login/authorize.html?qrcode_id=${"a".repeat(513)}",
            ),
        )
    }
}
