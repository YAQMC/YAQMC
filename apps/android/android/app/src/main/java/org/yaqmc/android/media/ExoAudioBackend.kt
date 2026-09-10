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

        exoPlayer.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
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
                lastError = error.message
                isPlaying = false
                isBuffering = false
                reportState()
            }
        })
    }

    fun load(streamId: Long, localPath: String?, format: String): Boolean {
        mainHandler.post {
            lastError = null
            isEnded = false
            currentPositionMs = 0L

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

            exoPlayer.setMediaItem(mediaItem)
            exoPlayer.prepare()
            reportState()
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
        mainHandler.post {
            mainHandler.removeCallbacks(progressUpdater)
            exoPlayer.stop()
            exoPlayer.clearMediaItems()
            isPlaying = false
            isBuffering = false
            isEnded = false
            currentPositionMs = 0L
            reportState()
        }
    }

    fun seek(positionMs: Long) {
        mainHandler.post {
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

    private fun reportState() {
        CoreManager.reportAudioState(
            positionMs = currentPositionMs,
            durationMs = durationMs,
            isPlaying = isPlaying,
            isBuffering = isBuffering,
            isEnded = isEnded,
            error = lastError,
        )
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
    }
}
