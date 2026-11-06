package org.yaqmc.android.lyrics

import android.view.WindowManager.LayoutParams
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class FloatingLyricsInteractionTest {
    @Test
    fun staleReconcileCannotUndoNativeLockOrSettingsUnlock() {
        for ((saved, stale) in listOf("passive-locked" to "interactive", "interactive" to "passive-locked")) {
            val current = JSONObject("""{"desktop":{"interaction":"$saved","fontSize":30}}""")
            val incoming = JSONObject("""{"desktop":{"interaction":"$stale","fontSize":34}}""")
            val next = reconcileFloatingLyrics(incoming, current)
            assertEquals(saved, next.getJSONObject("desktop").getString("interaction"))
            assertEquals(34, next.getJSONObject("desktop").getInt("fontSize"))
            assertEquals(stale, incoming.getJSONObject("desktop").getString("interaction"))
        }
    }

    @Test
    fun upgradeDisablesFakeIslandAndKeepsFloatingLyrics() {
        val previous = JSONObject("""{"desktop":{"enabled":true,"interaction":"passive-locked"},"island":{"enabled":true}}""")
        val next = reconcileFloatingLyrics(previous, JSONObject())
        assertFalse(next.getJSONObject("island").getBoolean("enabled"))
        assertTrue(next.getJSONObject("desktop").getBoolean("enabled"))
        assertEquals("passive-locked", next.getJSONObject("desktop").getString("interaction"))
        assertTrue(previous.getJSONObject("island").getBoolean("enabled"))
        val withPlugin = reconcileFloatingLyrics(previous, JSONObject(), systemIslandAvailable = true)
        assertTrue(withPlugin.getJSONObject("island").getBoolean("enabled"))
    }

    @Test
    fun lockAndUnlockRestoreTouchWithoutChangingOtherWindowFlags() {
        val flags = LayoutParams.FLAG_NOT_FOCUSABLE or LayoutParams.FLAG_LAYOUT_IN_SCREEN
        val locked = floatingLyricsFlags(flags, true)
        assertTrue(locked and LayoutParams.FLAG_NOT_TOUCHABLE != 0)
        assertEquals(flags, floatingLyricsFlags(locked, false))
        // View/background alpha cannot satisfy Android 12's window obscuring-opacity check.
        assertEquals(0.8f, floatingLyricsWindowAlpha(true, 0.8f), 0f)
        assertEquals(0.6f, floatingLyricsWindowAlpha(true, 0.6f), 0f)
        assertEquals(1f, floatingLyricsWindowAlpha(false, 0.8f), 0f)
    }
}
