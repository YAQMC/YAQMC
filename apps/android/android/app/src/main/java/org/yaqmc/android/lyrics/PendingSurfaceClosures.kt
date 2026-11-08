package org.yaqmc.android.lyrics

import org.json.JSONObject

/** Main-thread close writes survive the WebView and are retried after Core becomes available. */
internal class PendingSurfaceClosures(
    initial: Set<String>,
    private val save: (Set<String>) -> Unit,
    private val write: (String, (Boolean) -> Unit) -> Unit,
) {
    private val pending = initial.filterTo(mutableSetOf()) { it == "desktop" || it == "island" }
    private val inFlight = mutableSetOf<String>()

    fun close(kind: String) {
        require(kind == "desktop" || kind == "island")
        pending.add(kind)
        save(pending.toSet())
        retry()
    }

    fun applyPending(config: JSONObject) {
        pending.forEach { kind ->
            val surface = config.optJSONObject(kind) ?: JSONObject().also { config.put(kind, it) }
            surface.put("enabled", false)
        }
    }

    fun retry() {
        pending.toList().forEach { kind ->
            if (!inFlight.add(kind)) return@forEach
            runCatching {
                write(kind) { success ->
                    inFlight.remove(kind)
                    if (success && pending.remove(kind)) save(pending.toSet())
                }
            }.onFailure { inFlight.remove(kind) }
        }
    }
}
