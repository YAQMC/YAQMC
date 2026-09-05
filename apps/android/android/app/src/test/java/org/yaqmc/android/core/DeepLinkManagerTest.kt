package org.yaqmc.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DeepLinkManagerTest {
    @Test
    fun acceptsOnlyStrictCatalogLink() {
        assertEquals(
            CatalogSongDeepLink("qqmusic", "qqmusic:track:000qgbM90wbOxx"),
            DeepLinkManager.parse(
                "yaqmc://catalog/qqmusic/song?id=qqmusic%3Atrack%3A000qgbM90wbOxx",
            ),
        )
        assertNull(DeepLinkManager.parse("yaqmc://catalog:443/qqmusic/song?id=a"))
        assertNull(DeepLinkManager.parse("yaqmc://catalog/qqmusic/song?id="))
        assertNull(DeepLinkManager.parse("yaqmc://catalog/qqmusic/song?id=a&id=b"))
        assertNull(DeepLinkManager.parse("yaqmc://user@catalog/qqmusic/song?id=a"))
        assertNull(DeepLinkManager.parse("yaqmc://catalog/qqmusic/song?id=a#fragment"))
        assertNull(DeepLinkManager.parse("yaqmc://catalog/QQ/song?id=a"))
        assertNull(DeepLinkManager.parse("yaqmc://evil"))
        assertNull(DeepLinkManager.parse("https://catalog/qqmusic/song?id=a"))
    }

    @Test
    fun eachIntentIdentityIsConsumedOnce() {
        val manager = DeepLinkManager()
        val first = Any()
        val link = "yaqmc://catalog/qqmusic/song?id=a"
        assertEquals(CatalogSongDeepLink("qqmusic", "a"), manager.accept(first, link))
        assertNull(manager.accept(first, link))
        assertEquals(CatalogSongDeepLink("qqmusic", "a"), manager.accept(Any(), link))
    }
}
