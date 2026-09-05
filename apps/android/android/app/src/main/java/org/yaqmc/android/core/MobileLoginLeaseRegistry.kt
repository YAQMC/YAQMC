package org.yaqmc.android.core

/** A process-owned lease; Activity recreation must not end an external authorization. */
internal class MobileLoginLeaseRegistry(
    private val schedule: (Runnable, Long) -> Unit,
    private val unschedule: (Runnable) -> Unit,
    private val heartbeat: (Attempt, (String?, String?, String?) -> Unit) -> Unit,
    private val now: () -> Long,
    private val event: (Attempt, String, String?) -> Unit = { _, _, _ -> },
) {
    data class Attempt(
        val attemptId: String,
        val providerId: String,
        val ownerLeaseId: String,
        val deadlineMs: Long,
    )

    private val attempts = mutableMapOf<String, Attempt>()
    private val tasks = mutableMapOf<String, Runnable>()

    fun hasProvider(providerId: String) = attempts.values.any { it.providerId == providerId }

    fun adopt(attempt: Attempt) {
        val current = attempts[attempt.attemptId]
        if (current != null && current.ownerLeaseId == attempt.ownerLeaseId) return
        attempts.values.filter { it.providerId == attempt.providerId }.toList().forEach(::stop)
        attempts[attempt.attemptId] = attempt
        event(attempt, "owner-attached", null)
        enqueue(attempt, 0)
    }

    fun lifecycle(state: String) {
        attempts.values.forEach { event(it, "lifecycle", state) }
    }

    private fun enqueue(attempt: Attempt, delay: Long) {
        if (attempts[attempt.attemptId] !== attempt) return
        tasks.remove(attempt.attemptId)?.let(unschedule)
        val task = Runnable { renew(attempt) }
        tasks[attempt.attemptId] = task
        schedule(task, delay)
    }

    private fun renew(attempt: Attempt) {
        if (attempts[attempt.attemptId] !== attempt) return
        if (now() >= attempt.deadlineMs) {
            event(attempt, "owner-deadline", null)
            stop(attempt)
            return
        }
        heartbeat(attempt) { state, id, lease ->
            // A response queued before a retry must never revive the previous owner.
            if (attempts[attempt.attemptId] !== attempt) return@heartbeat
            if (state == null) {
                enqueue(attempt, 1_000)
            } else if (state in ACTIVE_STATES && id == attempt.attemptId && lease == attempt.ownerLeaseId) {
                enqueue(attempt, 2_000)
            } else {
                event(attempt, "owner-finished", state)
                stop(attempt)
            }
        }
    }

    private fun stop(attempt: Attempt) {
        if (attempts[attempt.attemptId] !== attempt) return
        attempts.remove(attempt.attemptId)
        tasks.remove(attempt.attemptId)?.let(unschedule)
    }

    companion object {
        val ACTIVE_STATES = setOf("starting-login", "waiting-for-scan", "waiting-for-confirmation")
    }
}
