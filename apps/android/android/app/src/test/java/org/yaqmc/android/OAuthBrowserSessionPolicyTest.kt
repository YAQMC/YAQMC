package org.yaqmc.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotNull
import org.junit.Test

class OAuthBrowserSessionPolicyTest {
    private val spotify = OAuthBrowserSessionPolicyCodec.parse(
        """{
          "url":"https://open.spotify.com/",
          "cookieNames":["sp_dc","sp_key","sp_t"],
          "requiredCookieNames":["sp_dc"],
          "credentialOrigins":["https://open.spotify.com"],
          "format":"cookie"
        }""",
    )

    @Test
    fun parsesOnlyTheAuthorizedCookiePolicy() {
        val policy = requireNotNull(spotify)
        assertEquals("https://open.spotify.com/", policy.url)
        assertEquals(listOf("sp_dc", "sp_key", "sp_t"), policy.cookieNames)
    }

    @Test
    fun filtersCookiesAndRejectsAMissingRequiredValue() {
        val policy = requireNotNull(spotify)
        val cookies = OAuthBrowserSessionPolicyCodec.selectedCookies(
            "unrelated=secret; sp_dc=dc-value; sp_key=a=b; sp_t=last",
            policy,
        )
        assertNotNull(cookies)
        assertEquals(3, cookies!!.length())
        assertEquals("sp_dc", cookies.getJSONObject(0).getString("name"))
        assertEquals("a=b", cookies.getJSONObject(1).getString("value"))

        assertNull(
            OAuthBrowserSessionPolicyCodec.selectedCookies(
                "unrelated=secret; sp_key=a=b",
                policy,
            ),
        )
    }

    @Test
    fun rejectsUnsafeOrIncompletePolicies() {
        assertNull(
            OAuthBrowserSessionPolicyCodec.parse(
                """{
                  "url":"http://open.spotify.com/",
                  "cookieNames":["sp_dc"],
                  "requiredCookieNames":["sp_dc"],
                  "credentialOrigins":["https://open.spotify.com"],
                  "format":"cookie"
                }""",
            ),
        )
        assertNull(
            OAuthBrowserSessionPolicyCodec.parse(
                """{
                  "url":"https://open.spotify.com/",
                  "cookieNames":["sp_dc"],
                  "requiredCookieNames":["other"],
                  "credentialOrigins":["https://open.spotify.com"],
                  "format":"cookie"
                }""",
            ),
        )
    }

    @Test
    fun malformedHeaderNeverBecomesStructuredCookies() {
        assertNull(OAuthBrowserSessionPolicyCodec.selectedCookies("sp_dc", spotify!!))
    }
}
