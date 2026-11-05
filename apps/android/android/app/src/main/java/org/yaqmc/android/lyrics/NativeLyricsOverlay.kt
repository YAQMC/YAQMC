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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.em
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
    /** The sibling WebView's text zoom (100 × system font scale unless overridden). */
    private val webTextZoomPercent: () -> Int = { 100 },
) {
    private var playerView: AMLLPlayerView? = null
    private var isRunning = false
    /** False between Activity stop and start: the overlay stays shown but idles its frame loop. */
    private var hostStarted = true
    private var frameCallbackPosted = false
    private var timingOffsetMs = 0L
    private var animating = false

    var onSeekListener: ((Long) -> Unit)? = null

    /** True while the overlay is visible and playback advances it every frame (no touch input involved). */
    var onAnimatingChanged: ((Boolean) -> Unit)? = null

    private val frameCallback = object : Choreographer.FrameCallback {
        override fun doFrame(frameTimeNanos: Long) {
            frameCallbackPosted = false
            if (!isRunning || !hostStarted) return
            val audioBackend = CoreManager.audioBackend
            if (audioBackend != null) {
                val position = lyricPosition(audioBackend.currentPositionForUiMs())
                val playing = audioBackend.isPlaying
                playerView?.update(positionMs = position, isPlaying = playing)
                setAnimating(playing)
            }
            postFrameLoop()
        }
    }

    private fun postFrameLoop() {
        if (!isRunning || !hostStarted || frameCallbackPosted) return
        frameCallbackPosted = true
        Choreographer.getInstance().postFrameCallback(frameCallback)
    }

    private fun cancelFrameLoop() {
        if (!frameCallbackPosted) return
        frameCallbackPosted = false
        Choreographer.getInstance().removeFrameCallback(frameCallback)
    }

    /**
     * Activity stop/start. A shown overlay keeps its lyrics and composition, but must not keep
     * requesting vsync, reading the player clock, or holding the high refresh-rate request while
     * the app is not visible.
     */
    @MainThread
    fun setHostStarted(started: Boolean) {
        if (hostStarted == started) return
        hostStarted = started
        if (started) {
            postFrameLoop()
        } else {
            cancelFrameLoop()
            setAnimating(false)
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
        if (view.visibility != View.VISIBLE || view.alpha < 1f) {
            // Fade in from wherever an interrupted fade-out left it. Alpha is a RenderNode
            // property: no layout or recomposition, and it follows the system animator scale.
            view.animate().cancel()
            if (view.visibility != View.VISIBLE) view.alpha = 0f
            view.visibility = View.VISIBLE
            view.animate().alpha(1f).setDuration(FADE_IN_MS).start()
        }
        val audioBackend = CoreManager.audioBackend
        if (audioBackend != null) {
            view.update(
                positionMs = lyricPosition(audioBackend.currentPositionForUiMs()),
                isPlaying = audioBackend.isPlaying,
            )
        }
        isRunning = true
        postFrameLoop()
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
        isRunning = false
        cancelFrameLoop()
        setAnimating(false)
        val view = playerView ?: return
        if (view.visibility != View.VISIBLE) return
        view.animate().cancel()
        view.animate().alpha(0f).setDuration(FADE_OUT_MS).withEndAction {
            if (!isRunning) view.visibility = View.GONE
        }.start()
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
            view.animate().cancel()
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
        // Re-assigning identical params still requests a full relayout of the hosted player.
        if (
            existing is ViewGroup.MarginLayoutParams &&
            existing.width == width &&
            existing.height == height &&
            existing.leftMargin == x &&
            existing.topMargin == y
        ) {
            return
        }
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
        timingOffsetMs = options.optLong("timingOffsetMs", timingOffsetMs)
        // Equal styles are a no-op: AMLLPlayerView.style is structurally compared snapshot state.
        view.style = styleFromOptions(
            options = options,
            base = view.style,
            webTextZoomPercent = webTextZoomPercent(),
            fontScale = activity.resources.configuration.fontScale,
        )
    }

    private fun lyricPosition(audioPositionMs: Long): Long =
        (audioPositionMs + timingOffsetMs).coerceAtLeast(0L)

    private fun audioPosition(lyricPositionMs: Long): Long =
        (lyricPositionMs - timingOffsetMs).coerceAtLeast(0L)

    companion object {
        /** The WebView stage slides for 500 ms; a short fade keeps controls immediately usable. */
        private const val FADE_IN_MS = 180L
        private const val FADE_OUT_MS = 120L

        /**
         * Maps the WebView's lyric options onto [base]. Font sizes arrive as unzoomed CSS px
         * (1 CSS px = 1 dp here); the WebView scales its own text by textZoom (100 × the system
         * font scale unless overridden), so native text uses the same factor. Compose multiplies sp
         * by the system font scale, which textZoom already contains, so it is divided out once.
         */
        internal fun styleFromOptions(
            options: JSONObject,
            base: AMLLStyle,
            webTextZoomPercent: Int,
            fontScale: Float,
        ): AMLLStyle {
            // Vertical focus anchor only; the horizontal `textAlign` used to be read here as `align`.
            val alignAnchor = when (options.optString("alignAnchor", "center")) {
                "top" -> AMLLAlignAnchor.Top
                "bottom" -> AMLLAlignAnchor.Bottom
                else -> AMLLAlignAnchor.Center
            }
            val textAlign = when (options.optString("textAlign", "left")) {
                "center" -> TextAlign.Center
                "right" -> TextAlign.End
                else -> TextAlign.Start
            }
            val lineFontSizeSp = options.optDouble("lineFontSizePx", Double.NaN)
                .takeIf { it.isFinite() && it > 0.0 }
                ?.let { it.toFloat() * webTextZoomPercent / 100f / fontScale.coerceAtLeast(0.1f) }
            val lineHeight = options.optDouble("lineHeight", Double.NaN)
                .takeIf { it.isFinite() && it in 0.5..3.0 }?.toFloat()?.em ?: TextUnit.Unspecified
            val foreground = parseCssColor(options.optString("foregroundColor", ""), base.activeColor)
            return base.copy(
                alignAnchor = alignAnchor,
                // Same clamp as the web player's alignPosition.
                alignPosition = options.optDouble("followAnchor", 0.35).toFloat().coerceIn(0.1f, 0.9f),
                textAlign = textAlign,
                lineHeight = lineHeight,
                enableWordEmphasis = options.optBoolean("wordEmphasis", true),
                enableSpring = options.optBoolean("enableSpring", true),
                enableScale = options.optBoolean("enableScale", true),
                enableBlur = options.optBoolean("enableBlur", true),
                hidePassedLines = options.optBoolean("hidePassedLines", false),
                // AMLL core defaults to a half-em wide moving fade; keep that for older WebView hosts.
                wordFadeWidthEm = options.optDouble("wordFadeWidth", 0.5).toFloat(),
                lineFontSize = lineFontSizeSp?.sp ?: base.lineFontSize,
                secondaryFontSize = lineFontSizeSp?.times(0.5f)?.sp ?: base.secondaryFontSize,
                lyricFontWeight = FontWeight(options.optInt("fontWeight", 600).coerceIn(1, 1_000)),
                activeColor = foreground,
                inactiveColor = foreground.copy(alpha = foreground.alpha * 0.40f),
                secondaryActiveColor = foreground.copy(alpha = foreground.alpha * 0.30f),
                secondaryInactiveColor = foreground.copy(alpha = foreground.alpha * 0.30f),
            )
        }

        /**
         * Android WebView normally sends an rgb()/rgba() computed color. Keep a
         * small parser here because Color.parseColor only accepts hex and a few
         * named colors, while CSS custom properties may remain in functional form.
         */
        internal fun parseCssColor(value: String, fallback: Color): Color {
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
