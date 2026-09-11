package org.yaqmc.android.media

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener
import java.io.IOException
import org.yaqmc.android.core.CoreManager

@UnstableApi
class NativeAudioDataSource(private val streamId: Long) : BaseDataSource(/* isNetwork = */ false) {
    private var dataSpec: DataSpec? = null
    private var bytesRemaining: Long = 0
    private var opened = false

    override fun open(dataSpec: DataSpec): Long {
        this.dataSpec = dataSpec
        transferInitializing(dataSpec)
        val remaining = CoreManager.streamOpen(streamId, dataSpec.position)
        if (remaining < 0) {
            throw NativeStreamError.failure("open", remaining, streamId, dataSpec.position)
        }
        bytesRemaining = if (dataSpec.length != C.LENGTH_UNSET.toLong()) {
            dataSpec.length
        } else {
            remaining
        }
        opened = true
        transferStarted(dataSpec)
        return bytesRemaining
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (length == 0) return 0
        if (bytesRemaining == 0L) return C.RESULT_END_OF_INPUT

        val bytesToRead = if (bytesRemaining != C.LENGTH_UNSET.toLong()) {
            length.toLong().coerceAtMost(bytesRemaining).toInt()
        } else {
            length
        }

        val bytesRead = CoreManager.streamRead(streamId, buffer, offset, bytesToRead)
        if (bytesRead == 0) {
            return C.RESULT_END_OF_INPUT
        }
        if (bytesRead < 0) {
            // A negative code is a real failure. Treating it as end-of-input
            // silently truncated playback and suppressed quality fallback.
            throw NativeStreamError.failure(
                "read",
                bytesRead.toLong(),
                streamId,
                dataSpec?.position ?: 0L,
            )
        }
        if (bytesRemaining != C.LENGTH_UNSET.toLong()) {
            bytesRemaining -= bytesRead
        }
        bytesTransferred(bytesRead)
        return bytesRead
    }

    override fun getUri(): Uri? = dataSpec?.uri

    override fun close() {
        if (opened) {
            opened = false
            CoreManager.streamClose(streamId)
            transferEnded()
        }
    }

}

@UnstableApi
class NativeAudioDataSourceFactory(
    private val defaultFactory: DataSource.Factory,
) : DataSource.Factory {
    override fun createDataSource(): DataSource {
        return object : DataSource {
            private var activeDelegate: DataSource? = null

            override fun addTransferListener(transferListener: TransferListener) {
                defaultFactory.createDataSource().addTransferListener(transferListener)
            }

            override fun open(dataSpec: DataSpec): Long {
                val uri = dataSpec.uri
                val dataSource = if (uri.scheme == "yaqmc-stream") {
                    val streamId = uri.lastPathSegment?.toLongOrNull()
                        ?: uri.host?.toLongOrNull()
                        ?: throw IOException("Invalid yaqmc-stream URI: $uri")
                    NativeAudioDataSource(streamId)
                } else {
                    defaultFactory.createDataSource()
                }
                activeDelegate = dataSource
                return dataSource.open(dataSpec)
            }

            override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                return activeDelegate?.read(buffer, offset, length) ?: C.RESULT_END_OF_INPUT
            }

            override fun getUri(): Uri? = activeDelegate?.uri

            override fun close() {
                try {
                    activeDelegate?.close()
                } finally {
                    activeDelegate = null
                }
            }
        }
    }
}
