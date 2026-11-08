package org.yaqmc.android.lyrics

import org.junit.Assert.*
import org.junit.Test

class SystemLyricsPluginTest {
    private val lyric = SurfaceLyric("qqmusic:1", "Title", "Artist", "Line", null, "Next", true)
    private class Plugin : SystemLyricsPlugin {
        var available = true
        var fail = false
        val shown = mutableListOf<SurfaceLyric>()
        var hidden = 0
        override fun isAvailable() = available
        override fun show(lyric: SurfaceLyric) {
            check(!fail)
            shown += lyric
        }
        override fun hide() { hidden++ }
    }

    @Test
    fun missingOrUnsupportedPluginCannotAdvertiseAnIsland() {
        assertFalse(SystemLyricsPluginHost(null) { throw AssertionError(it) }.isAvailable())
        val plugin = Plugin().apply { available = false }
        val host = SystemLyricsPluginHost(plugin) { throw AssertionError(it) }
        host.update(true, false, lyric)
        assertFalse(host.isAvailable())
        assertTrue(plugin.shown.isEmpty())
    }

    @Test
    fun forwardsLineChangesOnceAndHidesOnForegroundDisableOrClearedTrack() {
        val plugin = Plugin()
        val host = SystemLyricsPluginHost(plugin) { throw AssertionError(it) }
        host.update(true, false, lyric)
        host.update(true, false, lyric)
        host.update(true, false, lyric.copy(line = "Another"))
        assertEquals(2, plugin.shown.size)
        host.update(true, true, lyric)
        assertEquals(1, plugin.hidden)
        host.update(true, false, lyric)
        host.update(false, false, lyric)
        assertEquals(2, plugin.hidden)
        host.update(true, false, lyric)
        host.update(true, false, lyric.copy(trackId = null))
        assertEquals(3, plugin.hidden)
    }

    @Test
    fun losingVendorAuthorizationHidesTheExistingSurface() {
        val plugin = Plugin()
        val host = SystemLyricsPluginHost(plugin) { throw AssertionError(it) }
        host.update(true, false, lyric)
        plugin.available = false
        host.update(true, false, lyric)
        assertEquals(1, plugin.hidden)
        assertFalse(host.isAvailable())
    }

    @Test
    fun vendorFailureRemovesSurfaceAndDisablesOnlyThatPlugin() {
        val plugin = Plugin()
        var failures = 0
        val host = SystemLyricsPluginHost(plugin) { failures++ }
        host.update(true, false, lyric)
        plugin.fail = true
        host.update(true, false, lyric.copy(line = "Another"))
        assertFalse(host.isAvailable())
        assertEquals(1, failures)
        assertEquals(1, plugin.hidden)
        host.update(true, false, lyric)
        assertEquals(1, plugin.shown.size)
    }
}
