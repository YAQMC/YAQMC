package org.yaqmc.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OAuthUrlPolicyTest {
    private data class PolicyFixture(
        val kind: String,
        val expected: Boolean,
        val url: String,
        val policy: String,
    )

    @Test
    fun `phone selects provider mobile URL while tablet keeps provider desktop URL`() {
        val desktop =
            "https://graph.qq.com/oauth2.0/show?which=Login&display=pc&state=0123456789abcdef"
        val mobile =
            "https://graph.qq.com/oauth2.0/authorize?which=Login&display=mobile&state=0123456789abcdef"

        assertEquals(
            mobile,
            OAuthUrlPolicy.selectPresentationUrl(desktop, mobile, 599),
        )
        assertEquals(desktop, OAuthUrlPolicy.selectPresentationUrl(desktop, mobile, 600))
        assertEquals(desktop, OAuthUrlPolicy.selectPresentationUrl(desktop, null, 360))
    }

    @Test
    fun `presentation selection fails closed for malformed provider URLs`() {
        assertNull(
            OAuthUrlPolicy.selectPresentationUrl("https://graph.qq.com/", "not a URL", 360),
        )
    }

    @Test
    fun `external app navigation requires an exact provider rule and package allowlist`() {
        val rules = listOf(
            OAuthExternalNavigationRule(
                scheme = "wtloginmqq",
                host = "ptlogin",
                path = "/qlogin",
                androidPackages = listOf("com.tencent.mobileqq", "com.tencent.tim"),
            ),
        )
        val valid = OAuthUrlPolicy.matchingExternalNavigationRule(
            "wtloginmqq://ptlogin/qlogin?p=opaque",
            rules,
        )
        assertEquals(listOf("com.tencent.mobileqq", "com.tencent.tim"), valid?.androidPackages)
        assertNull(
            OAuthUrlPolicy.matchingExternalNavigationRule(
                "wtloginmqq://evil/qlogin?p=opaque",
                rules,
            ),
        )
        assertNull(
            OAuthUrlPolicy.matchingExternalNavigationRule(
                "wtloginmqq://ptlogin/qlogin/extra?p=opaque",
                rules,
            ),
        )
        assertNull(
            OAuthUrlPolicy.matchingExternalNavigationRule(
                "intent://ptlogin/qlogin#Intent;package=com.evil;end",
                rules,
            ),
        )
        assertEquals(emptyList<OAuthExternalNavigationRule>(), OAuthUrlPolicy.parseExternalNavigationRules(null))
    }

    @Test
    fun allowlistRequiresHttpsAndMatchesDesktopGlobRules() {
        val allowlist = listOf("https://graph.qq.com/**", "https://xui.ptlogin2.qq.com/path/**")
        assertTrue(OAuthUrlPolicy.matchesAllowlist("https://graph.qq.com/oauth2.0/show", allowlist))
        assertTrue(
            OAuthUrlPolicy.matchesAllowlist(
                "https://xui.ptlogin2.qq.com/path/login?state=a",
                allowlist,
            ),
        )
        assertFalse(OAuthUrlPolicy.matchesAllowlist("http://graph.qq.com/oauth2.0/show", allowlist))
        assertFalse(OAuthUrlPolicy.matchesAllowlist("https://graph.qq.com.evil.test/", allowlist))
        assertFalse(OAuthUrlPolicy.matchesAllowlist("https://user@graph.qq.com/", allowlist))
    }

    @Test
    fun callbackRequiresOriginPathAndExpectedQueryValues() {
        val prefix =
            "https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https%3A%2F%2Fy.qq.com%2F&state=nonce"
        assertTrue(
            OAuthUrlPolicy.matchesCallback(
                "https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https%3A%2F%2Fy.qq.com%2F&state=nonce&code=ok",
                prefix,
            ),
        )
        assertFalse(
            OAuthUrlPolicy.matchesCallback(
                "https://y.qq.com/portal/wx_redirect.html",
                prefix,
            ),
        )
        assertFalse(
            OAuthUrlPolicy.matchesCallback(
                "https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https%3A%2F%2Fy.qq.com%2F&state=wrong&code=ok",
                prefix,
            ),
        )
        assertFalse(
            OAuthUrlPolicy.matchesCallback(
                "https://y.qq.com.evil.test/portal/wx_redirect.html?state=nonce&code=ok",
                prefix,
            ),
        )
    }

    @Test
    fun sharedUrlPolicyContractMatchesElectron() {
        for (fixture in loadPolicyFixtures()) {
            val actual = when (fixture.kind) {
                "allowlist" ->
                    OAuthUrlPolicy.matchesAllowlist(fixture.url, fixture.policy.split('|'))
                "callback" -> OAuthUrlPolicy.matchesCallback(fixture.url, fixture.policy)
                else -> error("Unknown OAuth policy fixture kind: ${fixture.kind}")
            }
            assertEquals("${fixture.kind}: ${fixture.url}", fixture.expected, actual)
        }
    }

    private fun loadPolicyFixtures(): List<PolicyFixture> {
        val stream = checkNotNull(javaClass.getResourceAsStream("/oauth-url-policy.tsv")) {
            "Shared OAuth policy fixture is missing"
        }
        return stream.bufferedReader(Charsets.UTF_8).useLines { lines ->
            lines.drop(1).filter(String::isNotBlank).mapIndexed { index, line ->
                val fields = line.split('\t')
                check(fields.size == 4) { "Invalid OAuth fixture at row ${index + 2}" }
                PolicyFixture(
                    kind = fields[0],
                    expected = fields[1].toBooleanStrict(),
                    url = fields[2],
                    policy = fields[3],
                )
            }.toList()
        }
    }
}
