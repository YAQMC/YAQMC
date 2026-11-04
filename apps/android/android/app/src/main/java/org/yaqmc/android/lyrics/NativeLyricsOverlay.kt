package org.yaqmc.android.lyrics

import android.app.Activity
import android.view.Choreographer
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.annotation.MainThread
import androidx.coordinatorlayout.widget.CoordinatorLayout
import androidx.media3.common.util.UnstableApi
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import dev.yaqmc.amll.model.LyricLine
import dev.yaqmc.amll.model.LyricRuby
import dev.yaqmc.amll.model.LyricWord
import dev.yaqmc.amll.ui.AMLLAlignAnchor
import dev.yaqmc.amll.ui.AMLLPlayerView
import dev.yaqmc.amll.ui.AMLLStyle
import org.json.JSONArray
import org.json.JSONObject
import org.yaqmc.android.core.CoreManager

@UnstableApi
class NativeLyricsOverlay(
    private val activity: Activity,
    private val container: ViewGroup,
) {
    private var playerView: AMLLPlayerView? = null
    private var isRunning = false
    private var timingOffsetMs = 0L
    private var animating = false

    var onSeekListener: ((Long) -> Unit)? = null

    /** True while the overlay is visible and playback advances it every frame (no touch input involved). */
    var onAnimatingChanged: ((Boolean) -> Unit)? = null

    private val frameCallback = object : Choreographer.FrameCallback {
        override fun doFrame(frameTimeNanos: Long) {
            if (!isRunning) return
            val audioBackend = CoreManager.audioBackend
            if (audioBackend != null) {
                val position = lyricPosition(audioBackend.currentPositionForUiMs())
                val playing = audioBackend.isPlaying
                playerView?.update(positionMs = position, isPlaying = playing)
                setAnimating(playing)
            }
            if (isRunning) {
                Choreographer.getInstance().postFrameCallback(this)
            }
        }
    }

    init {
        ensureViewCreated()
    }

    @MainThread
    private fun ensureViewCreated(): AMLLPlayerView {
        playerView?.let { return it }
        val view = AMLLPlayerView(activity).apply {
            visibility = View.GONE
            onLineClick = { line ->
                val audioBackend = CoreManager.audioBackend
                val audioPosition = audioPosition(line.startTimeMs)
                audioBackend?.seek(audioPosition)
                onSeekListener?.invoke(audioPosition)
            }
        }
        val params = createLayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )
        container.addView(view, params)
        playerView = view
        return view
    }

    @MainThread
    fun show(bounds: JSONObject?, linesJson: JSONArray?, options: JSONObject?) {
        val view = ensureViewCreated()
        if (linesJson != null) {
            view.setLyricLines(parseLyricLines(linesJson))
        }
        if (options != null) {
            updateStyle(options)
        }
        updateBounds(bounds)
        view.bringToFront()
        view.visibility = View.VISIBLE
        val audioBackend = CoreManager.audioBackend
        if (audioBackend != null) {
            view.update(
                positionMs = lyricPosition(audioBackend.currentPositionForUiMs()),
                isPlaying = audioBackend.isPlaying,
            )
        }
        if (!isRunning) {
            isRunning = true
            Choreographer.getInstance().postFrameCallback(frameCallback)
        }
    }

    @MainThread
    fun update(bounds: JSONObject?, linesJson: JSONArray?, options: JSONObject?) {
        val view = playerView ?: return
        if (linesJson != null) {
            view.setLyricLines(parseLyricLines(linesJson))
        }
        if (options != null) {
            updateStyle(options)
        }
        updateBounds(bounds)
    }

    @MainThread
    fun hide() {
        if (isRunning) {
            isRunning = false
            Choreographer.getInstance().removeFrameCallback(frameCallback)
        }
        playerView?.visibility = View.GONE
        setAnimating(false)
    }

    private fun setAnimating(active: Boolean) {
        if (animating == active) return
        animating = active
        onAnimatingChanged?.invoke(active)
    }

    @MainThread
    fun destroy() {
        hide()
        playerView?.let { view ->
            container.removeView(view)
        }
        playerView = null
    }

    private fun createLayoutParams(
        width: Int,
        height: Int,
        leftMargin: Int = 0,
        topMargin: Int = 0,
    ): ViewGroup.LayoutParams {
        return when (container) {
            is CoordinatorLayout -> {
                CoordinatorLayout.LayoutParams(width, height).apply {
                    this.leftMargin = leftMargin
                    this.topMargin = topMargin
                }
            }
            is FrameLayout -> {
                FrameLayout.LayoutParams(width, height).apply {
                    this.leftMargin = leftMargin
                    this.topMargin = topMargin
                }
            }
            is android.widget.RelativeLayout -> {
                android.widget.RelativeLayout.LayoutParams(width, height).apply {
                    this.leftMargin = leftMargin
                    this.topMargin = topMargin
                }
            }
            else -> {
                ViewGroup.MarginLayoutParams(width, height).apply {
                    this.leftMargin = leftMargin
                    this.topMargin = topMargin
                }
            }
        }
    }

    private fun updateBounds(bounds: JSONObject?) {
        val view = playerView ?: return
        val width: Int
        val height: Int
        val x: Int
        val y: Int

        if (bounds == null) {
            width = ViewGroup.LayoutParams.MATCH_PARENT
            height = ViewGroup.LayoutParams.MATCH_PARENT
            x = 0
            y = 0
        } else {
            val density = activity.resources.displayMetrics.density
            val rawWidth = (bounds.optDouble("width", 0.0) * density).toInt()
            val rawHeight = (bounds.optDouble("height", 0.0) * density).toInt()
            if (rawWidth <= 0 || rawHeight <= 0) {
                width = ViewGroup.LayoutParams.MATCH_PARENT
                height = ViewGroup.LayoutParams.MATCH_PARENT
                x = 0
                y = 0
            } else {
                width = rawWidth
                height = rawHeight
                x = (bounds.optDouble("left", 0.0) * density).toInt()
                y = (bounds.optDouble("top", 0.0) * density).toInt()
            }
        }

        val existing = view.layoutParams
        if (existing is ViewGroup.MarginLayoutParams) {
            existing.width = width
            existing.height = height
            existing.leftMargin = x
            existing.topMargin = y
            view.layoutParams = existing
        } else {
            view.layoutParams = createLayoutParams(width, height, x, y)
        }
    }

    private fun updateStyle(options: JSONObject) {
        val view = playerView ?: return
        val anchorStr = if (options.has("alignAnchor")) {
            options.optString("alignAnchor", "center")
        } else {
            options.optString("align", "center")
        }
        val alignAnchor = when (anchorStr) {
            "top" -> AMLLAlignAnchor.Top
            "bottom" -> AMLLAlignAnchor.Bottom
            else -> AMLLAlignAnchor.Center
        }
        val alignPos = options.optDouble("followAnchor", 0.35).toFloat()
        val enableSpring = options.optBoolean("enableSpring", true)
        val enableScale = options.optBoolean("enableScale", true)
        val enableBlur = options.optBoolean("enableBlur", true)
        val hidePassedLines = options.optBoolean("hidePassedLines", false)
        // AMLL core defaults to a half-em wide moving fade. Keep the native fallback identical
        // when an older WebView host does not send the preference explicitly.
        val wordFadeWidth = options.optDouble("wordFadeWidth", 0.5).toFloat()
        timingOffsetMs = options.optLong("timingOffsetMs", timingOffsetMs)
        val lineFontSizePx = options.optDouble("lineFontSizePx", Double.NaN)
            .takeIf { it.isFinite() && it > 0.0 }
        val fontWeight = options.optInt("fontWeight", 600).coerceIn(1, 1_000)
        val foreground = parseCssColor(
            options.optString("foregroundColor", ""),
            view.style.activeColor,
        )
        view.style = (view.style).copy(
            alignAnchor = alignAnchor,
            alignPosition = alignPos,
            enableSpring = enableSpring,
            enableScale = enableScale,
            enableBlur = enableBlur,
            hidePassedLines = hidePassedLines,
            wordFadeWidthEm = wordFadeWidth,
            lineFontSize = lineFontSizePx?.toFloat()?.sp ?: view.style.lineFontSize,
            secondaryFontSize = lineFontSizePx?.toFloat()?.times(0.5f)?.sp
                ?: view.style.secondaryFontSize,
            lyricFontWeight = FontWeight(fontWeight),
            activeColor = foreground,
            inactiveColor = foreground.copy(alpha = foreground.alpha * 0.40f),
            secondaryActiveColor = foreground.copy(alpha = foreground.alpha * 0.30f),
            secondaryInactiveColor = foreground.copy(alpha = foreground.alpha * 0.30f),
        )
    }

    private fun lyricPosition(audioPositionMs: Long): Long =
        (audioPositionMs + timingOffsetMs).coerceAtLeast(0L)

    private fun audioPosition(lyricPositionMs: Long): Long =
        (lyricPositionMs - timingOffsetMs).coerceAtLeast(0L)

    /**
     * Android WebView normally sends an rgb()/rgba() computed color. Keep a
     * small parser here because Color.parseColor only accepts hex and a few
     * named colors, while CSS custom properties may remain in functional form.
     */
    private fun parseCssColor(value: String, fallback: Color): Color {
        val raw = value.trim()
        if (raw.isEmpty()) return fallback

        val parsedHex = runCatching { android.graphics.Color.parseColor(raw) }.getOrNull()
        if (parsedHex != null) {
            return Color(
                red = android.graphics.Color.red(parsedHex) / 255f,
                green = android.graphics.Color.green(parsedHex) / 255f,
                blue = android.graphics.Color.blue(parsedHex) / 255f,
                alpha = android.graphics.Color.alpha(parsedHex) / 255f,
            )
        }

        val match = RGB_COLOR_PATTERN.matchEntire(raw) ?: return fallback
        fun channel(value: String): Float? = value.removeSuffix("%").toFloatOrNull()?.let {
            if (value.endsWith('%')) it * 2.55f else it
        }
        val red = channel(match.groupValues[1])?.coerceIn(0f, 255f)?.div(255f)
            ?: return fallback
        val green = channel(match.groupValues[2])?.coerceIn(0f, 255f)?.div(255f)
            ?: return fallback
        val blue = channel(match.groupValues[3])?.coerceIn(0f, 255f)?.div(255f)
            ?: return fallback
        val alpha = match.groupValues.getOrNull(4)?.takeIf(String::isNotEmpty)?.let {
            if (it.endsWith('%')) {
                it.removeSuffix("%").toFloatOrNull()?.div(100f)
            } else {
                it.toFloatOrNull()?.let { value -> if (value > 1f) value / 255f else value }
            }
        }?.coerceIn(0f, 1f) ?: 1f
        return Color(red = red, green = green, blue = blue, alpha = alpha)
    }

    companion object {
        private val RGB_COLOR_PATTERN = Regex(
            "rgba?\\(\\s*([0-9.]+)\\s*[, ]\\s*([0-9.]+)\\s*[, ]\\s*([0-9.]+)(?:\\s*[,/]\\s*([0-9.]+%?))?\\s*\\)",
            RegexOption.IGNORE_CASE,
        )

        fun parseLyricLines(json: JSONArray): List<LyricLine> {
            val list = ArrayList<LyricLine>(json.length())
            for (i in 0 until json.length()) {
                val lineObj = json.optJSONObject(i) ?: continue
                val wordsArr = lineObj.optJSONArray("words") ?: JSONArray()
                val words = ArrayList<LyricWord>(wordsArr.length())
                for (j in 0 until wordsArr.length()) {
                    val wObj = wordsArr.optJSONObject(j) ?: continue
                    val start = wObj.optLong("startTimeMs", 0L).coerceAtLeast(0L)
                    val end = wObj.optLong("endTimeMs", start).coerceAtLeast(start)
                    val text = wObj.optString("text", "")
                    val roman = wObj.optString("romanText").takeIf { it.isNotBlank() && it != "null" }
                    val rubyArr = wObj.optJSONArray("ruby")
                    val rubies = if (rubyArr != null && rubyArr.length() > 0) {
                        buildList {
                            for (r in 0 until rubyArr.length()) {
                                val rObj = rubyArr.optJSONObject(r) ?: continue
                                val rStart = rObj.optLong("startTimeMs", start).coerceAtLeast(0L)
                                val rEnd = rObj.optLong("endTimeMs", rStart).coerceAtLeast(rStart)
                                val rText = rObj.optString("text", "")
                                if (rText.isNotEmpty()) add(LyricRuby(rStart, rEnd, rText))
                            }
                        }
                    } else emptyList()
                    words.add(
                        LyricWord(
                            startTimeMs = start,
                            endTimeMs = end,
                            text = text,
                            romanText = roman,
                            obscene = wObj.optBoolean("obscene", false),
                            ruby = rubies,
                        )
                    )
                }
                val lineStart = lineObj.optLong("startTimeMs", 0L).coerceAtLeast(0L)
                val lineEnd = lineObj.optLong("endTimeMs", lineStart).coerceAtLeast(lineStart)
                if (words.isEmpty()) {
                    val fallbackText = lineObj.optString("text", "")
                    if (fallbackText.isNotEmpty()) {
                        words.add(LyricWord(lineStart, lineEnd, fallbackText))
                    }
                }
                list.add(
                    LyricLine(
                        words = words,
                        translatedLyric = lineObj.optString("translatedLyric", ""),
                        romanLyric = lineObj.optString("romanLyric", ""),
                        startTimeMs = lineStart,
                        endTimeMs = lineEnd,
                        isBackground = lineObj.optBoolean("isBackground", false),
                        isDuet = lineObj.optBoolean("isDuet", false),
                    )
                )
            }
            return list
        }
    }
}
