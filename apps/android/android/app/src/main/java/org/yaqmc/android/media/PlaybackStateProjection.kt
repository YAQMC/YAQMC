package org.yaqmc.android.media

internal enum class CorePlaybackPhase {
    IDLE,
    LOADING,
    BUFFERING,
    PLAYING,
    PAUSED,
    STOPPED,
    ENDED,
    RECOVERABLE_ERROR,
    FATAL_ERROR;

    companion object {
        fun fromWire(value: String): CorePlaybackPhase = when (value) {
            "loading" -> LOADING
            "buffering" -> BUFFERING
            "playing" -> PLAYING
            "paused" -> PAUSED
            "stopped" -> STOPPED
            "ended" -> ENDED
            "recoverable-error" -> RECOVERABLE_ERROR
            "fatal-error" -> FATAL_ERROR
            else -> IDLE
        }
    }
}

internal enum class MediaPlaybackPhase {
    IDLE,
    BUFFERING,
    READY,
    ENDED,
}

internal data class PlaybackProjection(
    val phase: MediaPlaybackPhase,
    val playWhenReady: Boolean,
    val loading: Boolean,
    val holdsPlaybackResources: Boolean,
    val error: Boolean,
)

/** Pure Core-to-Media3 state projection, kept separate so it can be tested on the JVM. */
internal fun projectPlaybackState(
    phase: CorePlaybackPhase,
    previousPlayWhenReady: Boolean,
): PlaybackProjection = when (phase) {
    CorePlaybackPhase.IDLE -> PlaybackProjection(
        MediaPlaybackPhase.IDLE,
        playWhenReady = false,
        loading = false,
        holdsPlaybackResources = false,
        error = false,
    )
    CorePlaybackPhase.LOADING,
    CorePlaybackPhase.BUFFERING,
    -> PlaybackProjection(
        MediaPlaybackPhase.BUFFERING,
        playWhenReady = previousPlayWhenReady,
        loading = true,
        holdsPlaybackResources = previousPlayWhenReady,
        error = false,
    )
    CorePlaybackPhase.PLAYING -> PlaybackProjection(
        MediaPlaybackPhase.READY,
        playWhenReady = true,
        loading = false,
        holdsPlaybackResources = true,
        error = false,
    )
    CorePlaybackPhase.PAUSED -> PlaybackProjection(
        MediaPlaybackPhase.READY,
        playWhenReady = false,
        loading = false,
        holdsPlaybackResources = false,
        error = false,
    )
    CorePlaybackPhase.STOPPED -> PlaybackProjection(
        MediaPlaybackPhase.IDLE,
        playWhenReady = false,
        loading = false,
        holdsPlaybackResources = false,
        error = false,
    )
    CorePlaybackPhase.ENDED -> PlaybackProjection(
        MediaPlaybackPhase.ENDED,
        playWhenReady = false,
        loading = false,
        holdsPlaybackResources = false,
        error = false,
    )
    CorePlaybackPhase.RECOVERABLE_ERROR,
    CorePlaybackPhase.FATAL_ERROR,
    -> PlaybackProjection(
        MediaPlaybackPhase.IDLE,
        playWhenReady = false,
        loading = false,
        holdsPlaybackResources = false,
        error = true,
    )
}
