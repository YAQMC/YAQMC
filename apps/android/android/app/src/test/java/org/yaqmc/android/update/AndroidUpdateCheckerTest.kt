package org.yaqmc.android.update

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class AndroidUpdateCheckerTest {
    private fun release(version: String, prerelease: Boolean = false) = ReleaseCandidate(
        version = requireNotNull(YaqmcVersion.parse(version)),
        versionName = version.removePrefix("v"),
        prerelease = prerelease,
        releaseUrl = "https://github.com/YAQMC/YAQMC/releases/tag/${version.removePrefix("v")}",
        notes = "notes",
    )

    @Test
    fun `stable builds ignore prereleases and select newest stable`() {
        val selected = selectUpdate(
            requireNotNull(YaqmcVersion.parse("1.2.0")),
            listOf(
                release("1.3.0-beta.1", prerelease = true),
                release("1.2.1"),
                release("1.4.0"),
            ),
        )
        assertEquals("1.4.0", selected?.versionName)
    }

    @Test
    fun `prerelease builds only advance within their channel`() {
        val selected = selectUpdate(
            requireNotNull(YaqmcVersion.parse("2.0.0-beta.2")),
            listOf(
                release("2.0.0-beta.1", prerelease = true),
                release("2.0.0-beta.3", prerelease = true),
                release("2.0.0-rc.1", prerelease = true),
                release("2.0.0"),
            ),
        )
        assertEquals("2.0.0-beta.3", selected?.versionName)
    }

    @Test
    fun `invalid or mismatched release metadata is rejected`() {
        assertNull(YaqmcVersion.parse("1.0.0-preview.1"))
        val selected = selectUpdate(
            requireNotNull(YaqmcVersion.parse("1.0.0")),
            listOf(release("1.1.0", prerelease = true)),
        )
        assertNull(selected)
    }
}
