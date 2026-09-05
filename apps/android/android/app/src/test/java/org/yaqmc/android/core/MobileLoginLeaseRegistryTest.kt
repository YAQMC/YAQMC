package org.yaqmc.android.core

import org.junit.Assert.*
import org.junit.Test

class MobileLoginLeaseRegistryTest {
    private class Harness {
        var now = 0L
        val tasks = mutableListOf<Runnable>()
        val replies = mutableListOf<(String?, String?, String?) -> Unit>()
        val calls = mutableListOf<MobileLoginLeaseRegistry.Attempt>()
        val registry = MobileLoginLeaseRegistry(
            { task, _ -> tasks.add(task) }, { task -> tasks.remove(task); Unit },
            { attempt, complete -> calls.add(attempt); replies.add(complete) }, { now },
        )
        fun tick() = tasks.removeAt(0).run()
        fun attempt(id: String) = MobileLoginLeaseRegistry.Attempt(id, "qqmusic", "lease-$id", 120_000)
    }

    @Test fun `background and Activity recreation preserve a single bounded owner`() {
        val h = Harness()
        h.registry.adopt(h.attempt("a"))
        h.registry.lifecycle("background")
        h.registry.lifecycle("activity-recreated")
        h.registry.adopt(h.attempt("a"))
        assertEquals(1, h.tasks.size)
        h.tick()
        h.replies.single()("waiting-for-scan", "a", "lease-a")
        assertEquals(1, h.tasks.size)
        assertTrue(h.registry.hasProvider("qqmusic"))
    }

    @Test fun `late old heartbeat cannot replace or restart a retry`() {
        val h = Harness()
        h.registry.adopt(h.attempt("a")); h.tick()
        h.registry.adopt(h.attempt("b"))
        h.replies[0]("waiting-for-scan", "a", "lease-a")
        assertEquals(1, h.tasks.size)
        h.tick()
        assertEquals(listOf("a", "b"), h.calls.map { it.attemptId })
        h.replies[1]("authenticated", null, null)
        assertFalse(h.registry.hasProvider("qqmusic"))
        assertTrue(h.tasks.isEmpty())
    }

    @Test fun `transport failures retry only until the original attempt deadline`() {
        val h = Harness()
        h.registry.adopt(h.attempt("a")); h.tick()
        h.replies.single()(null, null, null)
        assertEquals(1, h.tasks.size)
        h.now = 120_000
        h.tick()
        assertFalse(h.registry.hasProvider("qqmusic"))
        assertEquals(1, h.calls.size)
    }
}
