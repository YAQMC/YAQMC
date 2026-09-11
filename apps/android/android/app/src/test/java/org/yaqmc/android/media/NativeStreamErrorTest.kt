package org.yaqmc.android.media

import java.io.IOException
import java.io.InterruptedIOException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

class NativeStreamErrorTest {
    @Test
    fun `error codes mirror the rust contract`() {
        assertEquals(0L, NativeStreamError.STREAM_OK_EOF)
        assertEquals(-1L, NativeStreamError.STREAM_ERR_IO)
        assertEquals(-2L, NativeStreamError.STREAM_ERR_UNKNOWN_ID)
        assertEquals(-3L, NativeStreamError.STREAM_ERR_CANCELLED)
        assertEquals(-4L, NativeStreamError.STREAM_ERR_INTERNAL)
        assertEquals(-5L, NativeStreamError.STREAM_ERR_BUSY)
    }

    @Test
    fun `cancellation maps to InterruptedIOException`() {
        val failure = NativeStreamError.failure(
            "read",
            NativeStreamError.STREAM_ERR_CANCELLED,
            7L,
            2048L,
        )
        assertIs<InterruptedIOException>(failure)
        assertTrue(failure.message.orEmpty().contains("cancelled"))
    }

    @Test
    fun `every other negative code maps to a classified IOException`() {
        val cases = mapOf(
            NativeStreamError.STREAM_ERR_IO to "I/O failure",
            NativeStreamError.STREAM_ERR_UNKNOWN_ID to "no longer available",
            NativeStreamError.STREAM_ERR_INTERNAL to "could not be copied",
            NativeStreamError.STREAM_ERR_BUSY to "in use by another data source",
        )
        for ((code, fragment) in cases) {
            val failure = NativeStreamError.failure("open", code, 3L, 0L)
            assertIs<IOException>(failure)
            assertFalse(failure is InterruptedIOException, "code $code must not look like EOF")
            assertTrue(failure.message.orEmpty().contains(fragment), "code $code message")
        }
    }
}
