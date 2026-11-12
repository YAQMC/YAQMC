package org.yaqmc.android.plugin

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import org.json.JSONObject

class PluginFilePolicyTest {
    @Test
    fun `portable paths reject traversal absolute paths aliases and malformed components`() {
        assertEquals(listOf("notes", "中文.txt"), PluginFilePolicy.parts("notes/中文.txt"))
        assertEquals(emptyList(), PluginFilePolicy.parts(""))
        for (path in listOf("../secret", "/etc/passwd", "C:/secret", "a\\b", "a//b", "a/..", "x:stream", "NUL.txt", "name.", "x\u0000")) {
            assertFailsWith<IllegalArgumentException>(path) { PluginFilePolicy.parts(path) }
        }
    }

    @Test
    fun `binary writes require canonical base64 and bounded decoded content`() {
        assertEquals(listOf<Byte>(0, 1, -1), PluginFilePolicy.data(JSONObject().put("data", "AAH/").put("encoding", "base64")).toList())
        for (data in listOf("@@@", "a", "AA==\n")) assertFailsWith<IllegalArgumentException> {
            PluginFilePolicy.data(JSONObject().put("data", data).put("encoding", "base64"))
        }
        assertFailsWith<IllegalArgumentException> {
            PluginFilePolicy.data(JSONObject().put("data", "x".repeat(PluginFilePolicy.MAX_BYTES + 1)))
        }
        assertFailsWith<IllegalArgumentException> {
            PluginFilePolicy.data(JSONObject().put("data", "中".repeat(PluginFilePolicy.MAX_BYTES / 3 + 1)))
        }
    }

    @Test
    fun `offsets and lengths must be finite nonnegative integers`() {
        assertEquals(7L, PluginFilePolicy.number(null, 7, 10))
        assertEquals(10L, PluginFilePolicy.number(10, 0, 10))
        for (number in listOf(-1, 11, 0.5, Double.NaN, Double.POSITIVE_INFINITY, "1", JSONObject.NULL))
            assertFailsWith<IllegalArgumentException> { PluginFilePolicy.number(number, 0, 10) }
    }
}
