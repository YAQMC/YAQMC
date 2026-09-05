package org.yaqmc.android.media

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PlaybackStateProjectionTest {
    @Test
    fun `playing and buffering retain playback resources`() {
        val playing = projectPlaybackState(CorePlaybackPhase.PLAYING, false)
        assertEquals(MediaPlaybackPhase.READY, playing.phase)
        assertTrue(playing.playWhenReady)
        assertTrue(playing.holdsPlaybackResources)

        val buffering = projectPlaybackState(CorePlaybackPhase.BUFFERING, true)
        assertEquals(MediaPlaybackPhase.BUFFERING, buffering.phase)
        assertTrue(buffering.loading)
        assertTrue(buffering.holdsPlaybackResources)
    }

    @Test
    fun `restored paused loading does not invent autoplay intent`() {
        val loading = projectPlaybackState(CorePlaybackPhase.LOADING, false)
        assertEquals(MediaPlaybackPhase.BUFFERING, loading.phase)
        assertFalse(loading.playWhenReady)
        assertFalse(loading.holdsPlaybackResources)
    }

    @Test
    fun `ended and failures stop playback`() {
        val ended = projectPlaybackState(CorePlaybackPhase.ENDED, true)
        assertEquals(MediaPlaybackPhase.ENDED, ended.phase)
        assertFalse(ended.playWhenReady)

        val failed = projectPlaybackState(CorePlaybackPhase.RECOVERABLE_ERROR, true)
        assertEquals(MediaPlaybackPhase.IDLE, failed.phase)
        assertTrue(failed.error)
        assertFalse(failed.holdsPlaybackResources)
    }
}
