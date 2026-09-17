package org.yaqmc.android.lyrics

import android.app.Activity
import android.view.Choreographer
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.annotation.MainThread
import androidx.media3.common.util.UnstableApi
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

    var onSeekListener: ((Long) -> Unit)? = null

    private val frameCallback = object : Choreographer.FrameCallback {
        override fun doFrame(frameTimeNanos: Long) {
            if (!isRunning) return
            val audioBackend = CoreManager.audioBackend
            if (audioBackend != null) {
                val position = audioBackend.currentPositionForUiMs()
                val playing = audioBackend.isPlaying
                playerView?.update(positionMs = position, isPlaying = playing)
            }
            Choreographer.getInstance().postFrameCallback(this)
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
                audioBackend?.seek(line.startTimeMs)
                onSeekListener?.invoke(line.startTimeMs)
            }
        }
        val params = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT,
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
        view.visibility = View.VISIBLE
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
    }

    @MainThread
    fun destroy() {
        hide()
        playerView?.let { view ->
            container.removeView(view)
        }
        playerView = null
    }

    private fun updateBounds(bounds: JSONObject?) {
        val view = playerView ?: return
        if (bounds == null) {
            view.layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            )
            return
        }

        val density = activity.resources.displayMetrics.density
        val x = (bounds.optDouble("left", 0.0) * density).toInt()
        val y = (bounds.optDouble("top", 0.0) * density).toInt()
        val width = (bounds.optDouble("width", 0.0) * density).toInt()
        val height = (bounds.optDouble("height", 0.0) * density).toInt()

        if (width <= 0 || height <= 0) {
            view.layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            )
        } else {
            view.layoutParams = FrameLayout.LayoutParams(width, height).apply {
                leftMargin = x
                topMargin = y
            }
        }
    }

    private fun updateStyle(options: JSONObject) {
        val view = playerView ?: return
        val alignAnchor = when (options.optString("alignAnchor", "center")) {
            "top" -> AMLLAlignAnchor.Top
            "bottom" -> AMLLAlignAnchor.Bottom
            else -> AMLLAlignAnchor.Center
        }
        val alignPos = options.optDouble("followAnchor", 0.35).toFloat()
        val enableSpring = options.optBoolean("enableSpring", true)
        val enableScale = options.optBoolean("enableScale", true)
        val enableBlur = options.optBoolean("enableBlur", true)
        val hidePassedLines = options.optBoolean("hidePassedLines", false)
        val wordFadeWidth = options.optDouble("wordFadeWidth", 1.0).toFloat()

        view.style = (view.style).copy(
            alignAnchor = alignAnchor,
            alignPosition = alignPos,
            enableSpring = enableSpring,
            enableScale = enableScale,
            enableBlur = enableBlur,
            hidePassedLines = hidePassedLines,
            wordFadeWidthEm = wordFadeWidth,
        )
    }

    companion object {
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
