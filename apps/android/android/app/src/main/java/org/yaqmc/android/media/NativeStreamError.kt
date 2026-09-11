package org.yaqmc.android.media

import java.io.IOException
import java.io.InterruptedIOException

/**
 * Typed mapping for the `STREAM_*` result codes exported by
 * `crates/yaqmc-android/src/lib.rs`.
 *
 * The native read surface only ever returns `0` for a genuine end of stream;
 * every negative value is a classified failure. Keeping the mapping in one
 * place means the JNI constants are mirrored once and unit-testable without an
 * Android runtime.
 */
internal object NativeStreamError {
    /** Mirrors the Rust `STREAM_ERR_*` constants. */
    const val STREAM_OK_EOF = 0L
    const val STREAM_ERR_IO = -1L
    const val STREAM_ERR_UNKNOWN_ID = -2L
    const val STREAM_ERR_CANCELLED = -3L
    const val STREAM_ERR_INTERNAL = -4L
    const val STREAM_ERR_BUSY = -5L

    fun reason(code: Long): String = when (code) {
        STREAM_ERR_IO -> "native stream I/O failure"
        STREAM_ERR_UNKNOWN_ID -> "native stream is no longer available"
        STREAM_ERR_CANCELLED -> "native stream was cancelled"
        STREAM_ERR_BUSY -> "native stream is in use by another data source"
        STREAM_ERR_INTERNAL -> "native stream could not be copied to the caller"
        else -> "native stream error $code"
    }

    /**
     * Builds the failure Media3 sees. Cancellation maps to
     * [InterruptedIOException] so extractor/loader retry logic can tell a
     * deliberate retire apart from a corrupt stream; everything else becomes a
     * plain [IOException] carrying the classified reason.
     */
    fun failure(operation: String, code: Long, streamId: Long, position: Long): IOException {
        val detail = "${reason(code)} ($operation, stream $streamId at $position)"
        return if (code == STREAM_ERR_CANCELLED) {
            InterruptedIOException(detail)
        } else {
            IOException(detail)
        }
    }
}
