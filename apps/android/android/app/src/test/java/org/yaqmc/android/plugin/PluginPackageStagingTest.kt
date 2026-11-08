package org.yaqmc.android.plugin

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PluginPackageStagingTest {
    private val directory = Files.createTempDirectory("plugin-staging").toFile()

    @Test
    fun copiesIntoPrivateStagingAndReplacesEarlierSelections() {
        val staging = PluginPackageStaging(directory, maxBytes = 16)
        val first = staging.stage { ByteArrayInputStream(byteArrayOf(1, 2, 3)) }
        val second = staging.stage { ByteArrayInputStream(byteArrayOf(4)) }
        assertFalse(first.exists())
        assertEquals(directory.canonicalFile, second.parentFile!!.canonicalFile)
        assertTrue(second.name.endsWith(".yaqmc-plugin"))
        assertEquals(listOf<Byte>(4), second.readBytes().toList())
    }

    @Test
    fun boundsUnknownLengthStreamsAndRemovesPartialFiles() {
        val staging = PluginPackageStaging(directory, maxBytes = 8)
        val endless = object : InputStream() {
            override fun read(): Int = 7
        }
        assertThrows(IllegalArgumentException::class.java) { staging.stage { endless } }
        assertThrows(IllegalArgumentException::class.java) {
            staging.stage { ByteArrayInputStream(ByteArray(0)) }
        }
        assertThrows(IllegalStateException::class.java) { staging.stage { null } }
        assertTrue(directory.listFiles().orEmpty().isEmpty())
    }
}
