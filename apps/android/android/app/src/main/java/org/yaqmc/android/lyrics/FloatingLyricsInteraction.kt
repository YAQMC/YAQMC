package org.yaqmc.android.lyrics

import android.view.WindowManager
import org.json.JSONObject
import kotlin.math.roundToInt

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

/** Coordinates for a bottom/center-anchored window, including its entire measured size. */
internal data class FloatingLyricsPosition(val x: Int, val y: Int) {
    fun drag(dx: Float, dy: Float) = FloatingLyricsPosition(x + dx.roundToInt(), y - dy.roundToInt())

    fun clamp(screenWidth: Int, screenHeight: Int, width: Int, height: Int): FloatingLyricsPosition {
        val horizontalRange = ((screenWidth - width) / 2).coerceAtLeast(0)
        return FloatingLyricsPosition(
            x.coerceIn(-horizontalRange, horizontalRange),
            y.coerceIn(0, (screenHeight - height).coerceAtLeast(0)),
        )
    }
}

internal fun shouldShowLyricsUnlockNotification(enabled: Boolean, locked: Boolean, overlayAllowed: Boolean): Boolean =
    enabled && locked && overlayAllowed
