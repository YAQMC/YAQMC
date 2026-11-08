package org.yaqmc.android.lyrics

import android.view.WindowManager.LayoutParams
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class FloatingLyricsInteractionTest {
    @Test
    fun dragMovesInBothAxesWithBottomAnchoredY() {
        val start = FloatingLyricsPosition(0, 120)
        assertEquals(FloatingLyricsPosition(60, 120), start.drag(60f, 0f))
        assertEquals(FloatingLyricsPosition(-60, 160), start.drag(-60f, -40f))
        assertEquals(FloatingLyricsPosition(0, 80), start.drag(0f, 40f))
    }

    @Test
    fun dragAndRelayoutKeepTheWholeWindowWithinTheDisplay() {
        assertEquals(FloatingLyricsPosition(100, 1800),
            FloatingLyricsPosition(900, 2500).clamp(1000, 2000, 800, 200))
        assertEquals(FloatingLyricsPosition(-100, 0),
            FloatingLyricsPosition(-900, -50).clamp(1000, 2000, 800, 200))
        // A larger toolbar/font or display rotation clamps using the new dimensions.
        assertEquals(FloatingLyricsPosition(30, 320),
            FloatingLyricsPosition(100, 1800).clamp(600, 500, 540, 180))
        assertEquals(FloatingLyricsPosition(0, 0),
            FloatingLyricsPosition(100, 100).clamp(100, 100, 200, 200))
        assertEquals(FloatingLyricsPosition(35, 120),
            FloatingLyricsPosition(35, 120).clamp(1000, 2000, 800, 200))
    }

    @Test
    fun unlockNotificationSurvivesPauseAndDisappearsWhenUnlockedOrDisabled() {
        // No playback/foreground predicate: a locked preference must remain recoverable.
        assertTrue(shouldShowLyricsUnlockNotification(true, true, true))
        assertFalse(shouldShowLyricsUnlockNotification(true, false, true))
        assertFalse(shouldShowLyricsUnlockNotification(false, true, true))
        assertFalse(shouldShowLyricsUnlockNotification(true, true, false))
    }

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
