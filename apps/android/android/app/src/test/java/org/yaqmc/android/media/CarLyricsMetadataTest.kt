package org.yaqmc.android.media

import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.SimpleBasePlayer.MediaItemData
import androidx.media3.common.util.UnstableApi
import org.junit.Assert.*
import org.junit.Test

@UnstableApi
class CarLyricsMetadataTest {
    private fun item(id: String): MediaItemData {
        val metadata = MediaMetadata.Builder().setTitle("Song").setArtist("Singer").setAlbumTitle("Album").build()
        return MediaItemData.Builder(id)
            .setMediaItem(MediaItem.Builder().setMediaId(id).setMediaMetadata(metadata).build())
            .setMediaMetadata(metadata).build()
    }

    @Test
    fun sessionAndQueueTitlesMatchOnEveryLyricUpdate() {
        val queue = listOf(item("a"), item("b"))
        for (line in listOf("First line", "Second line")) {
            val result = withCarLyric(queue, 0, CarLyric("a", line))
            val session = result[0].mediaMetadata!!
            val entry = result[0].mediaItem.mediaMetadata
            assertEquals(line, session.title)
            assertEquals(session.title, entry.title)
            assertEquals(session.artist, entry.artist)
            assertEquals(line, entry.displayTitle)
            assertEquals("Song · Singer", session.artist)
            assertEquals("Album", session.albumTitle)
            assertEquals(queue[0].uid, result[0].uid)
            assertSame(queue[1], result[1])
        }
        assertEquals("Song", queue[0].mediaMetadata!!.title)
        assertEquals("Song", queue[0].mediaItem.mediaMetadata.title)
    }

    @Test
    fun disableDisconnectGapsAndTrackChangesRestoreCanonicalMetadata() {
        val queue = listOf(item("a"), item("b"))
        assertSame(queue, withCarLyric(queue, 0, null))
        assertSame(queue, withCarLyric(queue, 0, CarLyric("a", " ")))
        assertSame(queue, withCarLyric(queue, 1, CarLyric("a", "Old lyric")))
        assertSame(queue, withCarLyric(queue, -1, CarLyric("a", "Line")))
        assertEquals("New lyric", withCarLyric(queue, 1, CarLyric("b", "New lyric"))[1].mediaMetadata!!.title)
    }
}
