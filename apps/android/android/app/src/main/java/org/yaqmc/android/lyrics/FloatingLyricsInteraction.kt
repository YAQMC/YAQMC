package org.yaqmc.android.lyrics

import android.view.WindowManager
import org.json.JSONObject

/** Reconcile styles without letting a stale WebView undo a native lock or unlock. */
internal fun reconcileFloatingLyrics(
    incoming: JSONObject,
    current: JSONObject,
    systemIslandAvailable: Boolean = false,
): JSONObject {
    val next = JSONObject(incoming.toString())
    current.optJSONObject("desktop")?.optString("interaction")
        ?.takeIf { it == "interactive" || it == "passive-locked" }
        ?.let { interaction ->
            val desktop = next.optJSONObject("desktop") ?: JSONObject().also { next.put("desktop", it) }
            desktop.put("interaction", interaction)
        }
    // A system island is not an application overlay, including on upgrades from the old build.
    if (!systemIslandAvailable) next.optJSONObject("island")?.put("enabled", false)
    return next
}

internal fun floatingLyricsFlags(flags: Int, locked: Boolean): Int =
    if (locked) flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
    else flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE.inv()

internal fun floatingLyricsWindowAlpha(locked: Boolean, maximumObscuringOpacity: Float): Float =
    if (locked) maximumObscuringOpacity.coerceIn(0f, 1f) else 1f
