package org.yaqmc.android.media

import androidx.media3.common.SimpleBasePlayer.MediaItemData
import androidx.media3.common.util.UnstableApi

data class CarLyric(val trackId: String, val line: String)

/** Decorate only the session projection; Core's canonical queue is never modified. */
@UnstableApi
internal fun withCarLyric(items: List<MediaItemData>, index: Int, lyric: CarLyric?): List<MediaItemData> {
    if (lyric == null || lyric.line.isBlank()) return items
    val item = items.getOrNull(index) ?: return items
    if (item.mediaItem.mediaId != lyric.trackId) return items
    val canonical = item.mediaMetadata ?: item.mediaItem.mediaMetadata
    val song = listOfNotNull(canonical.title, canonical.artist).joinToString(" · ")
    val metadata = canonical.buildUpon()
        .setTitle(lyric.line)
        .setDisplayTitle(lyric.line)
        .setArtist(song)
        .setSubtitle(song)
        .build()
    // AOSP Bluetooth waits for the active queue item and session title/artist to match.
    val projected = item.buildUpon()
        .setMediaItem(item.mediaItem.buildUpon().setMediaMetadata(metadata).build())
        .setMediaMetadata(metadata)
        .build()
    return items.toMutableList().also { it[index] = projected }
}
