package org.yaqmc.android.lyrics

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class PendingSurfaceClosuresTest {
    @Test
    fun closeWritesWithoutWebViewAndDoesNotDuplicateInFlightRequests() {
        var saved = emptySet<String>()
        val writes = mutableListOf<String>()
        lateinit var complete: (Boolean) -> Unit
        val state = PendingSurfaceClosures(emptySet(), { saved = it }) { kind, done ->
            writes.add(kind)
            complete = done
        }
        state.close("desktop")
        state.retry()
        state.retry()
        assertEquals(listOf("desktop"), writes)
        assertEquals(setOf("desktop"), saved)
        val stale = JSONObject("""{"desktop":{"enabled":true,"fontSize":30}}""")
        state.applyPending(stale)
        assertFalse(stale.getJSONObject("desktop").getBoolean("enabled"))
        assertEquals(30, stale.getJSONObject("desktop").getInt("fontSize"))
        complete(true)
        assertTrue(saved.isEmpty())
        val reopened = JSONObject("""{"desktop":{"enabled":true}}""")
        state.applyPending(reopened)
        assertTrue(reopened.getJSONObject("desktop").getBoolean("enabled"))
    }

    @Test
    fun failedCoreWriteStaysPendingAndCanBeRetried() {
        var saved = emptySet<String>()
        var attempts = 0
        val state = PendingSurfaceClosures(emptySet(), { saved = it }) { _, done ->
            attempts++
            done(attempts > 1)
        }
        state.close("desktop")
        assertEquals(1, attempts)
        assertEquals(setOf("desktop"), saved)
        state.retry()
        assertEquals(2, attempts)
        assertTrue(saved.isEmpty())
    }

    @Test
    fun synchronousFailureAndProcessRestartKeepTheCloseRecoverable() {
        var saved = emptySet<String>()
        var attempts = 0
        val old = PendingSurfaceClosures(emptySet(), { saved = it }) { _, _ ->
            attempts++
            error("Core unavailable")
        }
        old.close("desktop")
        assertEquals(1, attempts)
        assertEquals(setOf("desktop"), saved)
        val restarted = PendingSurfaceClosures(saved, { saved = it }) { kind, done ->
            assertEquals("desktop", kind)
            attempts++
            done(true)
        }
        restarted.retry()
        assertEquals(2, attempts)
        assertTrue(saved.isEmpty())
    }
}
