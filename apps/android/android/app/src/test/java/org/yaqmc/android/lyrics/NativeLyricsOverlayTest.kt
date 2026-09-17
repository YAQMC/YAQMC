package org.yaqmc.android.lyrics

import androidx.media3.common.util.UnstableApi
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
}
