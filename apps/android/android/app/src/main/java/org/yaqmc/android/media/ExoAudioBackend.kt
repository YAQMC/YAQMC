package org.yaqmc.android.media

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionParameters
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import java.io.File
import org.yaqmc.android.core.CoreManager

@UnstableApi
class ExoAudioBackend(context: Context) {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val exoPlayer: ExoPlayer

    @Volatile var currentPositionMs: Long = 0L
        private set
    @Volatile var durationMs: Long = C.TIME_UNSET
        private set
    @Volatile var isPlaying: Boolean = false
        private set
    @Volatile var isBuffering: Boolean = false
        private set
    @Volatile var isEnded: Boolean = false
        private set
    @Volatile var lastError: String? = null
        private set
    @Volatile var errorKind: String? = null
        private set

    /** Stream id of the loaded source, sent with every state report. */
    private var loadedStreamId: Long = 0L

    /**
     * Bumped on every load and stop.
     *
     * Each callback and posted block captures the epoch it belongs to, so work
     * queued by a previous track cannot report state for the current one.
     */
    private var loadEpoch: Long = 0L
    private var activeListener: Player.Listener? = null

    /**
     * Fails a load whose source never reaches READY or ERROR.
     *
     * Media3 reports neither success nor failure while a data source stalls, so
     * without an upper bound Core would sit in `buffering` forever after a
     * black-holed request. The runnable is replaced on every load and removed on
     * stop, and it re-checks the epoch before touching state.
     */
    private var prepareTimeoutTask: Runnable? = null

    private val progressUpdater = object : Runnable {
        override fun run() {
            if (isPlaying) {
                currentPositionMs = exoPlayer.currentPosition
                val playerDuration = exoPlayer.duration
                if (playerDuration != C.TIME_UNSET) {
                    durationMs = playerDuration
                }
                reportState()
                mainHandler.postDelayed(this, PROGRESS_UPDATE_INTERVAL_MS)
            }
        }
    }

    init {
        val appContext = context.applicationContext
        val baseDataSourceFactory = DefaultDataSource.Factory(appContext)
        val yaqmcDataSourceFactory = NativeAudioDataSourceFactory(baseDataSourceFactory)
        val mediaSourceFactory = DefaultMediaSourceFactory(yaqmcDataSourceFactory)
        val renderersFactory = DefaultRenderersFactory(appContext)

        val attributes = AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
            .build()

        exoPlayer = ExoPlayer.Builder(appContext, renderersFactory, mediaSourceFactory)
            .setLooper(Looper.getMainLooper())
            .setAudioAttributes(attributes, /* handleAudioFocus = */ false)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()

        // Enable Media3 Audio Offload (allows DSP hardware offloading and deep sleep scheduling on Android)
        val offloadPreferences = TrackSelectionParameters.AudioOffloadPreferences.Builder()
            .setAudioOffloadMode(TrackSelectionParameters.AudioOffloadPreferences.AUDIO_OFFLOAD_MODE_ENABLED)
            .setIsGaplessSupportRequired(false)
            .setIsSpeedChangeSupportRequired(false)
            .build()

        exoPlayer.trackSelectionParameters = exoPlayer.trackSelectionParameters
            .buildUpon()
            .setAudioOffloadPreferences(offloadPreferences)
            .build()

        exoPlayer.addAudioOffloadListener(object : ExoPlayer.AudioOffloadListener {
            override fun onSleepingForOffloadChanged(isSleepingForOffload: Boolean) {
                // ExoPlayer playback thread sleeping state changed
            }
        })

    }

    /**
     * Binds listener callbacks to the load epoch they belong to.
     *
     * Media3 dispatches state changes and errors on the main thread, so a
     * callback queued for the previous track can arrive after a new `load()`.
     * Each listener checks its own epoch and drops stale reports.
     */
    private fun attachListener(epoch: Long) {
        activeListener?.let { exoPlayer.removeListener(it) }
        val listener = object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                if (epoch != loadEpoch) return
                if (playbackState == Player.STATE_READY || playbackState == Player.STATE_ENDED) {
                    clearPrepareTimeout()
                }
                isBuffering = playbackState == Player.STATE_BUFFERING
                isEnded = playbackState == Player.STATE_ENDED
                if (playbackState == Player.STATE_READY) {
                    val playerDuration = exoPlayer.duration
                    if (playerDuration != C.TIME_UNSET) {
                        durationMs = playerDuration
                    }
                }
                currentPositionMs = exoPlayer.currentPosition
                reportState()
            }

            override fun onIsPlayingChanged(playing: Boolean) {
                if (epoch != loadEpoch) return
                isPlaying = playing
                currentPositionMs = exoPlayer.currentPosition
                reportState()
                if (playing) {
                    mainHandler.removeCallbacks(progressUpdater)
                    mainHandler.post(progressUpdater)
                } else {
                    mainHandler.removeCallbacks(progressUpdater)
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                if (epoch != loadEpoch) return
                clearPrepareTimeout()
                errorKind = classifyError(error)
                lastError = error.message
                isPlaying = false
                isBuffering = false
                reportState()
            }
        }
        activeListener = listener
        exoPlayer.addListener(listener)
    }

    private fun clearPrepareTimeout() {
        prepareTimeoutTask?.let { mainHandler.removeCallbacks(it) }
        prepareTimeoutTask = null
    }

    private fun schedulePrepareTimeout(epoch: Long) {
        clearPrepareTimeout()
        val timeout = Runnable {
            if (epoch != loadEpoch) return@Runnable
            if (errorKind != null || isEnded) return@Runnable
            if (!isBuffering) return@Runnable
            errorKind = KIND_SOURCE
            lastError = "Media3 did not prepare the source within ${PREPARE_TIMEOUT_MS / 1_000}s"
            isBuffering = false
            isPlaying = false
            reportState()
        }
        prepareTimeoutTask = timeout
        mainHandler.postDelayed(timeout, PREPARE_TIMEOUT_MS)
    }

    fun load(streamId: Long, localPath: String?, format: String): Boolean {
        val epoch = ++loadEpoch
        clearPrepareTimeout()
        loadedStreamId = streamId
        lastError = null
        errorKind = null

        mainHandler.post {
            if (epoch != loadEpoch) return@post

            isEnded = false
            isPlaying = false
            // Media3 has not prepared the source yet. Reporting buffering keeps
            // Core from treating the load as immediately playable.
            isBuffering = true
            currentPositionMs = 0L
            durationMs = C.TIME_UNSET

            val mimeType = mimeTypeForFormat(format)
            val mediaItem = if (!localPath.isNullOrEmpty()) {
                val file = File(localPath)
                MediaItem.Builder()
                    .setUri(Uri.fromFile(file))
                    .setMimeType(mimeType)
                    .build()
            } else {
                MediaItem.Builder()
                    .setUri(Uri.parse("yaqmc-stream://stream/$streamId"))
                    .setMimeType(mimeType)
                    .build()
            }

            attachListener(epoch)
            exoPlayer.setMediaItem(mediaItem)
            exoPlayer.prepare()
            reportState()
            schedulePrepareTimeout(epoch)
        }
        return true
    }

    fun play() {
        mainHandler.post {
            exoPlayer.play()
        }
    }

    fun pause() {
        mainHandler.post {
            exoPlayer.pause()
        }
    }

    fun stop() {
        loadEpoch += 1
        clearPrepareTimeout()
        mainHandler.post {
            mainHandler.removeCallbacks(progressUpdater)
            exoPlayer.stop()
            exoPlayer.clearMediaItems()
            activeListener?.let { exoPlayer.removeListener(it) }
            activeListener = null
            isPlaying = false
            isBuffering = false
            isEnded = false
            currentPositionMs = 0L
            durationMs = C.TIME_UNSET
            lastError = null
            errorKind = null
            reportState(clearDuration = true)
        }
    }

    fun seek(positionMs: Long) {
        val epoch = loadEpoch
        mainHandler.post {
            if (epoch != loadEpoch) return@post
            exoPlayer.seekTo(positionMs)
            currentPositionMs = positionMs
            reportState()
        }
    }

    fun setVolume(volume: Float) {
        mainHandler.post {
            exoPlayer.volume = volume.coerceIn(0f, 1f)
        }
    }

    fun release() {
        mainHandler.post {
            mainHandler.removeCallbacks(progressUpdater)
            exoPlayer.release()
        }
    }

    private fun reportState(clearDuration: Boolean = false) {
        CoreManager.reportAudioState(
            streamId = loadedStreamId,
            positionMs = currentPositionMs,
            durationMs = if (clearDuration || durationMs == C.TIME_UNSET) {
                DURATION_UNSET_SENTINEL
            } else {
                durationMs
            },
            isPlaying = isPlaying,
            isBuffering = isBuffering,
            isEnded = isEnded,
            errorKind = errorKind,
            error = lastError,
        )
    }

    /**
     * Maps a Media3 failure onto the source/output categories Core reacts to.
     *
     * `source-expired` is decided in Rust from the progressive monitor, which is
     * the only component that observes the upstream HTTP status.
     */
    private fun classifyError(error: PlaybackException): String = when (error.errorCode) {
        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT,
        PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS -> KIND_NETWORK

        PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND,
        PlaybackException.ERROR_CODE_IO_NO_PERMISSION,
        PlaybackException.ERROR_CODE_IO_CLEARTEXT_NOT_PERMITTED,
        PlaybackException.ERROR_CODE_IO_INVALID_HTTP_CONTENT_TYPE,
        PlaybackException.ERROR_CODE_IO_UNSPECIFIED,
        PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED,
        PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED,
        PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED,
        PlaybackException.ERROR_CODE_PARSING_MANIFEST_UNSUPPORTED -> KIND_SOURCE

        PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
        PlaybackException.ERROR_CODE_DECODER_QUERY_FAILED,
        PlaybackException.ERROR_CODE_DECODING_FAILED,
        PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED -> KIND_DECODER

        else -> KIND_OUTPUT
    }

    private fun mimeTypeForFormat(format: String): String = when (format.lowercase()) {
        "mp3" -> MimeTypes.AUDIO_MPEG
        "aac", "m4a" -> MimeTypes.AUDIO_AAC
        "flac" -> MimeTypes.AUDIO_FLAC
        "wav" -> MimeTypes.AUDIO_WAV
        else -> MimeTypes.AUDIO_UNKNOWN
    }

    companion object {
        private const val PROGRESS_UPDATE_INTERVAL_MS = 500L
        /** Upper bound for a load that never reaches READY or ERROR. */
        private const val PREPARE_TIMEOUT_MS = 15_000L

        /**
         * Sent to Rust when the duration is unknown.
         *
         * Rust clears its cached duration for negative values, which is how a
         * stop or a new load drops the previous track's duration.
         */
        private const val DURATION_UNSET_SENTINEL = -1L
        private const val KIND_NETWORK = "network"
        private const val KIND_SOURCE = "source"
        private const val KIND_DECODER = "decoder"
        private const val KIND_OUTPUT = "output"
    }
}
