package org.yaqmc.android.lyrics

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.media3.common.util.UnstableApi
import dev.yaqmc.amll.ui.AMLLAlignAnchor
import dev.yaqmc.amll.ui.AMLLStyle
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@UnstableApi
class NativeLyricsOverlayTest {

    @Test
    fun parseLyricLines_parsesWordSyncedLyricsAndRubies() {
        val json = JSONArray().apply {
            put(
                JSONObject().apply {
                    put("startTimeMs", 1000L)
                    put("endTimeMs", 3000L)
                    put("translatedLyric", "Hello world")
                    put("romanLyric", "Ni hao")
                    put("isDuet", true)
                    put("isBackground", false)
                    put(
                        "words",
                        JSONArray().apply {
                            put(
                                JSONObject().apply {
                                    put("startTimeMs", 1000L)
                                    put("endTimeMs", 2000L)
                                    put("text", "Hello")
                                    put("romanText", "Ni")
                                    put(
                                        "ruby",
                                        JSONArray().apply {
                                            put(
                                                JSONObject().apply {
                                                    put("startTimeMs", 1000L)
                                                    put("endTimeMs", 2000L)
                                                    put("text", "hel-lo")
                                                }
                                            )
                                        }
                                    )
                                }
                            )
                            put(
                                JSONObject().apply {
                                    put("startTimeMs", 2000L)
                                    put("endTimeMs", 3000L)
                                    put("text", "world")
                                }
                            )
                        }
                    )
                }
            )
        }

        val lines = NativeLyricsOverlay.parseLyricLines(json)
        assertEquals(1, lines.size)
        val line = lines[0]
        assertEquals(1000L, line.startTimeMs)
        assertEquals(3000L, line.endTimeMs)
        assertEquals("Hello world", line.translatedLyric)
        assertEquals("Ni hao", line.romanLyric)
        assertTrue(line.isDuet)
        assertFalse(line.isBackground)
        assertEquals("Helloworld", line.text)

        assertEquals(2, line.words.size)
        val word1 = line.words[0]
        assertEquals("Hello", word1.text)
        assertEquals(1000L, word1.startTimeMs)
        assertEquals(2000L, word1.endTimeMs)
        assertEquals("Ni", word1.romanText)
        assertEquals(1, word1.ruby.size)
        assertEquals("hel-lo", word1.ruby[0].text)

        val word2 = line.words[1]
        assertEquals("world", word2.text)
        assertEquals(2000L, word2.startTimeMs)
        assertEquals(3000L, word2.endTimeMs)
        assertTrue(word2.ruby.isEmpty())
    }

    @Test
    fun parseLyricLines_coercesNegativeOrInvertedTimings() {
        val json = JSONArray().apply {
            put(
                JSONObject().apply {
                    put("startTimeMs", -100L)
                    put("endTimeMs", -200L)
                    put(
                        "words",
                        JSONArray().apply {
                            put(
                                JSONObject().apply {
                                    put("startTimeMs", -50L)
                                    put("endTimeMs", -100L)
                                    put("text", "Invalid")
                                }
                            )
                        }
                    )
                }
            )
        }

        val lines = NativeLyricsOverlay.parseLyricLines(json)
        assertEquals(1, lines.size)
        val line = lines[0]
        assertEquals(0L, line.startTimeMs)
        assertEquals(0L, line.endTimeMs)
        assertEquals(1, line.words.size)
        assertEquals(0L, line.words[0].startTimeMs)
        assertEquals(0L, line.words[0].endTimeMs)
    }

    private fun style(
        options: JSONObject,
        zoom: Int = 100,
        fontScale: Float = 1f,
        base: AMLLStyle = AMLLStyle(),
    ) = NativeLyricsOverlay.styleFromOptions(options, base, zoom, fontScale)

    @Test
    fun styleFromOptions_keepsHorizontalAlignmentApartFromFocusAnchor() {
        val right = style(JSONObject().put("textAlign", "right").put("alignAnchor", "center"))
        assertEquals(TextAlign.End, right.textAlign)
        assertEquals(AMLLAlignAnchor.Center, right.alignAnchor)
        assertEquals(TextAlign.Center, style(JSONObject().put("textAlign", "center")).textAlign)
        assertEquals(TextAlign.Start, style(JSONObject().put("textAlign", "left")).textAlign)
        // The old host read the horizontal `align` as a vertical anchor; it must be ignored now.
        assertEquals(AMLLAlignAnchor.Center, style(JSONObject().put("align", "bottom")).alignAnchor)
        assertEquals(AMLLAlignAnchor.Top, style(JSONObject().put("alignAnchor", "top")).alignAnchor)
    }

    @Test
    fun styleFromOptions_clampsFollowAnchorLikeTheWebPlayer() {
        assertEquals(0.1f, style(JSONObject().put("followAnchor", 0.0)).alignPosition)
        assertEquals(0.9f, style(JSONObject().put("followAnchor", 1.4)).alignPosition)
        assertEquals(0.6f, style(JSONObject().put("followAnchor", 0.6)).alignPosition, 1e-6f)
    }

    @Test
    fun styleFromOptions_convertsCssPxThroughTextZoomWithoutDoubleFontScale() {
        // Default WebView: textZoom = 130 at fontScale 1.3. 20 CSS px render as 26 dp = 20 sp.
        val scaled = style(JSONObject().put("lineFontSizePx", 20.0), zoom = 130, fontScale = 1.3f)
        assertEquals(20f, scaled.lineFontSize.value, 1e-4f)
        assertEquals(10f, scaled.secondaryFontSize.value, 1e-4f)
        // An app that pins textZoom to 100 keeps 20 dp regardless of the system font scale.
        val pinned = style(JSONObject().put("lineFontSizePx", 20.0), zoom = 100, fontScale = 1.3f)
        assertEquals(20f / 1.3f, pinned.lineFontSize.value, 1e-4f)
        // Missing or invalid sizes keep the previous style.
        val base = AMLLStyle(lineFontSize = 31.sp)
        assertEquals(31.sp, style(JSONObject().put("lineFontSizePx", -4.0), base = base).lineFontSize)
    }

    @Test
    fun styleFromOptions_mapsEverySettingWithoutTouchingUnrelatedStyle() {
        val base = AMLLStyle()
        val mapped = style(
            JSONObject()
                .put("enableSpring", false)
                .put("enableScale", false)
                .put("enableBlur", false)
                .put("hidePassedLines", true)
                .put("wordFadeWidth", 0.9)
                .put("wordEmphasis", false)
                .put("lineHeight", 1.4)
                .put("fontWeight", 800)
                .put("foregroundColor", "rgb(255, 0, 0)"),
            base = base,
        )
        assertFalse(mapped.enableSpring)
        assertFalse(mapped.enableScale)
        assertFalse(mapped.enableBlur)
        assertTrue(mapped.hidePassedLines)
        assertEquals(0.9f, mapped.wordFadeWidthEm, 1e-6f)
        assertFalse(mapped.enableWordEmphasis)
        assertEquals(1.4f.em, mapped.lineHeight)
        assertEquals(FontWeight(800), mapped.lyricFontWeight)
        assertEquals(Color(1f, 0f, 0f, 1f), mapped.activeColor)
        assertEquals(0.4f, mapped.inactiveColor.alpha, 1e-3f)
        assertEquals(base.verticalPadding, mapped.verticalPadding)
        assertEquals(TextUnit.Unspecified, style(JSONObject().put("lineHeight", 9.0)).lineHeight)
        // Re-sending identical options yields an equal style, which the snapshot state ignores.
        val options = JSONObject().put("textAlign", "center").put("lineFontSizePx", 22.0)
        assertEquals(style(options, base = mapped), style(options, base = style(options, base = mapped)))
    }
}
