package org.yaqmc.android.lyrics

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidLyricsSurfacesTest {
    private val projection = JSONObject(
        """
        {"positionMs": 1500, "isPlaying": true,
         "currentTrack": {"id": "qqmusic:track:1", "title": "Lemon",
                          "artists": [{"name": "米津玄師"}, {"name": ""}]},
         "currentLine": {"id": "a", "startMs": 1547, "endMs": 2847, "text": "夢ならば",
                         "romanization": "yu me na ra ba", "words": []},
         "nextLine": {"id": "b", "startMs": 2880, "endMs": 6000, "text": "どれほどよかったでしょう",
                      "translation": "那该有多好", "words": []}}
        """,
    )

    @Test
    fun parsesTheSharedCoreProjection() {
        val parsed = LyricProjection.parse(projection)
        assertEquals("qqmusic:track:1", parsed.lyric.trackId)
        assertEquals("Lemon", parsed.lyric.title)
        assertEquals("米津玄師", parsed.lyric.artist)
        assertEquals("夢ならば", parsed.lyric.line)
        // Translation wins over romanization when both exist; romanization fills in otherwise.
        assertEquals("yu me na ra ba", parsed.lyric.secondary)
        assertEquals("どれほどよかったでしょう", parsed.lyric.nextLine)
        assertTrue(parsed.lyric.playing)
        assertEquals(1500L, parsed.positionMs)
        assertEquals(2880L, parsed.nextStartMs)
        assertEquals("どれほどよかったでしょう", parsed.nextLyric?.line)
        assertEquals("那该有多好", parsed.nextLyric?.secondary)
        assertNull(parsed.nextLyric?.nextLine)
    }

    @Test
    fun toleratesGapsAndMissingTracks() {
        val gap = LyricProjection.parse(
            JSONObject("""{"positionMs": 0, "isPlaying": false, "currentTrack": null, "currentLine": null}"""),
        )
        assertNull(gap.lyric.trackId)
        assertNull(gap.lyric.line)
        assertNull(gap.nextStartMs)
        assertNull(gap.nextLyric)
        assertFalse(gap.lyric.playing)
    }

    @Test
    fun surfacesShowOnlyWhenEnabledPermittedBackgroundedAndPlayingSomething() {
        val lyric = LyricProjection.parse(projection).lyric
        assertTrue(surfaceShouldShow(true, true, false, lyric))
        assertFalse(surfaceShouldShow(false, true, false, lyric))
        // Denied or revoked "display over other apps".
        assertFalse(surfaceShouldShow(true, false, false, lyric))
        // The in-app lyrics page replaces floating lyrics while YAQMC is visible.
        assertFalse(surfaceShouldShow(true, true, true, lyric))
        assertFalse(surfaceShouldShow(true, true, false, lyric.copy(trackId = null)))
        assertFalse(surfaceShouldShow(true, true, false, null))
    }
}
