package org.yaqmc.android.core

import android.os.Handler
import android.os.Looper
import android.util.Log
import java.security.MessageDigest
import org.json.JSONObject

/** Contains no Activity, WebView, PluginCall or credential reference. Dies with the process. */
object MobileLoginOwner {
    private val handler = Handler(Looper.getMainLooper())
    private var foreground = false
    private val registry = MobileLoginLeaseRegistry(
        schedule = { task, delay -> handler.postDelayed(task, delay) },
        unschedule = handler::removeCallbacks,
        now = System::currentTimeMillis,
        heartbeat = { attempt, complete ->
            runCatching {
                CoreManager.invoke(
                    "provider_auth_heartbeat",
                    JSONObject()
                        .put("providerId", attempt.providerId)
                        .put("attemptId", attempt.attemptId)
                        .put("ownerLeaseId", attempt.ownerLeaseId)
                        .toString(),
                    origin = "host",
                    onResponse = { json ->
                        handler.post {
                            val envelope = runCatching { JSONObject(json) }.getOrNull()
                            val snapshot = if (envelope?.optBoolean("ok") == true) envelope.optJSONObject("result") else null
                            complete(snapshot?.optString("state"), snapshot?.optString("attemptId"), snapshot?.optString("ownerLeaseId"))
                        }
                    },
                )
            }.onFailure { handler.post { complete(null, null, null) } }
        },
        event = { attempt, event, state -> log(attempt.attemptId, event, state) },
    )

    fun hasProvider(providerId: String): Boolean = registry.hasProvider(providerId)

    fun adopt(snapshot: JSONObject, providerId: String) {
        val attemptId = snapshot.optString("attemptId")
        val lease = snapshot.optString("ownerLeaseId")
        if (attemptId.isBlank() || lease.isBlank()) return
        registry.adopt(
            MobileLoginLeaseRegistry.Attempt(
                attemptId, providerId, lease,
                snapshot.optLong("expiresAtMs", System.currentTimeMillis() + 5 * 60_000),
            ),
        )
    }

    fun lifecycle(state: String) {
        foreground = state == "foreground"
        registry.lifecycle(state)
    }

    fun log(attemptId: String, event: String, state: String? = null) {
        val tag = MessageDigest.getInstance("SHA-256").digest(attemptId.toByteArray())
            .take(6).joinToString("") { "%02x".format(it) }
        // Inputs are internal event enums and state names, never URLs or upstream response bodies.
        Log.i("YAQMC.Auth", JSONObject()
            .put("attempt_tag", tag).put("stage", "android-host").put("event", event)
            .put("state", state ?: JSONObject.NULL).put("foreground", foreground).toString())
    }
}
