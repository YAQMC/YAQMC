package org.yaqmc.android.media

import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import androidx.media3.common.util.UnstableApi
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import java.net.URI
import org.json.JSONArray
import org.json.JSONObject
import org.yaqmc.android.core.CoreManager

/** Media3 Player facade. Rust Core remains the only playback engine and clock. */
@UnstableApi
class CorePlayer(
    looper: Looper,
    private val beforePlay: () -> Boolean,
    private val onUserPause: () -> Unit,
    private val onUserPlay: () -> Unit,
    private val onPlaybackResourcesChanged: (Boolean) -> Unit,
    private val onStopRequested: () -> Unit,
) : SimpleBasePlayer(looper), CoreManager.Callback {
    @Volatile private var positionMs = 0L
    @Volatile private var durationMs = C.TIME_UNSET
    @Volatile private var currentIndex = C.INDEX_UNSET
    @Volatile private var repeatMode = Player.REPEAT_MODE_OFF
    @Volatile private var shuffle = false
    @Volatile private var volume = 1f
    @Volatile private var playlist: List<MediaItemData> = emptyList()
    @Volatile private var corePhase = CorePlaybackPhase.IDLE
    @Volatile private var projection = projectPlaybackState(corePhase, false)
    @Volatile private var playerError: PlaybackException? = null
    @Volatile private var playWhenReadyReason = Player.PLAY_WHEN_READY_CHANGE_REASON_REMOTE
    @Volatile private var systemPause = false
    private var resourcesHeld = false
    private val handler = Handler(looper)

    init {
        CoreManager.addCallback(this)
        runCatching {
            CoreManager.invoke("player_snapshot", onResponse = ::applyCoreEnvelope)
        }
    }

    override fun getState(): State {
        val currentPlaylist = playlist
        val normalizedIndex = currentIndex.takeIf { it in currentPlaylist.indices } ?: C.INDEX_UNSET
        return State.Builder()
            .setAvailableCommands(
                Player.Commands.Builder().addAll(
                    Player.COMMAND_PLAY_PAUSE,
                    Player.COMMAND_STOP,
                    Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM,
                    Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
                    Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
                    Player.COMMAND_GET_CURRENT_MEDIA_ITEM,
                    Player.COMMAND_GET_TIMELINE,
                    Player.COMMAND_GET_METADATA,
                    Player.COMMAND_SET_REPEAT_MODE,
                    Player.COMMAND_SET_SHUFFLE_MODE,
                    Player.COMMAND_SET_VOLUME,
                ).build(),
            )
            .setPlaylist(currentPlaylist)
            .setPlaybackState(projection.phase.toMedia3State())
            .setPlayWhenReady(projection.playWhenReady, playWhenReadyReason)
            .setIsLoading(projection.loading)
            .setPlayerError(playerError)
            .setCurrentMediaItemIndex(normalizedIndex)
            .setContentPositionMs(positionMs)
            .setVolume(volume)
            .setRepeatMode(repeatMode)
            .setShuffleModeEnabled(shuffle)
            .setAudioAttributes(MEDIA_AUDIO_ATTRIBUTES)
            .build()
    }

    override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
        if (playWhenReady) {
            if (!beforePlay()) return failedFuture("Android audio focus was not granted")
            onUserPlay()
            playWhenReadyReason = Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST
            playerError = null
            setPlaybackIntent(true)
            return invokeCore("player_play")
        }

        val fromSystem = systemPause
        systemPause = false
        if (!fromSystem) onUserPause()
        playWhenReadyReason = if (fromSystem) {
            Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS
        } else {
            Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST
        }
        setPlaybackIntent(false)
        return invokeCore("player_pause")
    }

    override fun handleStop(): ListenableFuture<*> {
        onUserPause()
        playWhenReadyReason = Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST
        setPlaybackIntent(false)
        return invokeCore("player_stop", onSuccess = onStopRequested)
    }

    fun pauseForSystem() {
        systemPause = true
        pause()
    }

    /** Called before renderer-originated Core play commands cross the JNI boundary. */
    fun noteExternalPlayRequest() {
        handler.post {
            playWhenReadyReason = Player.PLAY_WHEN_READY_CHANGE_REASON_REMOTE
            playerError = null
            setPlaybackIntent(true)
        }
    }

    fun cancelExternalPlayRequest() {
        handler.post {
            if (corePhase != CorePlaybackPhase.PLAYING) setPlaybackIntent(false)
        }
    }

    fun hasPlaybackIntent(): Boolean = projection.playWhenReady

    override fun handleSeek(
        mediaItemIndex: Int,
        positionMs: Long,
        seekCommand: Int,
    ): ListenableFuture<*> = when (seekCommand) {
        Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM -> invokeCore("player_next")
        Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM -> invokeCore("player_previous")
        else -> {
            if (positionMs != C.TIME_UNSET) this.positionMs = positionMs.coerceAtLeast(0L)
            invalidateState()
            invokeCore("player_seek", JSONObject().put("positionMs", this.positionMs).toString())
        }
    }

    override fun handleSetRepeatMode(mode: Int): ListenableFuture<*> {
        repeatMode = mode
        invalidateState()
        return invokeCore("player_set_repeat", JSONObject().put("mode", repeatName(mode)).toString())
    }

    override fun handleSetShuffleModeEnabled(enabled: Boolean): ListenableFuture<*> {
        shuffle = enabled
        invalidateState()
        return invokeCore("player_set_shuffle", JSONObject().put("enabled", enabled).toString())
    }

    override fun handleSetVolume(value: Float, volumeOperationType: Int): ListenableFuture<*> {
        volume = value.coerceIn(0f, 1f)
        invalidateState()
        return invokeCore("player_set_volume", JSONObject().put("volume", volume).toString())
    }

    fun close() {
        CoreManager.removeCallback(this)
    }

    override fun onCoreResponse(id: Long, json: String) = Unit

    override fun onCoreEvent(sequence: Long, channel: String, json: String) {
        if (channel == "player://snapshot") applySnapshot(json)
    }

    private fun invokeCore(
        method: String,
        paramsJson: String = "{}",
        onSuccess: (() -> Unit)? = null,
    ): ListenableFuture<*> {
        val future = SettableFuture.create<Any?>()
        runCatching {
            CoreManager.invoke(
                method,
                paramsJson,
                onResponse = { json ->
                    handler.post {
                        runCatching {
                            val envelope = JSONObject(json)
                            if (!envelope.optBoolean("ok")) {
                                throw playbackException(envelope.optJSONObject("error"))
                            }
                            envelope.optJSONObject("result")?.let(::applySnapshotObject)
                            onSuccess?.invoke()
                        }.onSuccess {
                            future.set(null)
                        }.onFailure { error ->
                            val failure = error.asPlaybackException()
                            playerError = failure
                            setPlaybackIntent(false)
                            future.setException(failure)
                        }
                    }
                },
            )
        }.onFailure { error ->
            val failure = error.asPlaybackException()
            playerError = failure
            setPlaybackIntent(false)
            future.setException(failure)
        }
        return future
    }

    private fun applyCoreEnvelope(json: String) {
        runCatching {
            val envelope = JSONObject(json)
            if (envelope.optBoolean("ok")) envelope.optJSONObject("result") else null
        }.getOrNull()?.let(::applySnapshotObject)
    }

    private fun applySnapshot(json: String) {
        runCatching { JSONObject(json) }.getOrNull()?.let(::applySnapshotObject)
    }

    private fun applySnapshotObject(state: JSONObject) {
        val nextPosition = state.optLong("positionMs", positionMs).coerceAtLeast(0L)
        val nextDuration = state.nullableLong("playbackDurationMs")
        val nextIndex = state.nullableInt("currentIndex") ?: C.INDEX_UNSET
        val nextShuffle = state.optBoolean("shuffle", shuffle)
        val nextRepeat = repeatModeFrom(state.optString("repeat", "off"))
        val nextPlaylist = mediaItems(state.optJSONArray("queue"))
        val nextPhase = CorePlaybackPhase.fromWire(state.optString("playbackState", "idle"))
        val nextProjection = projectPlaybackState(nextPhase, projection.playWhenReady)
        val failure = state.optJSONObject("playbackError")
        val nextError = if (nextProjection.error) playbackException(failure) else null
        val nextVolume = state.optDouble("volume", volume.toDouble()).toFloat().coerceIn(0f, 1f)
        val muted = state.optBoolean("isMuted", false)

        handler.post {
            positionMs = nextPosition
            durationMs = nextDuration?.takeIf { it >= 0 } ?: C.TIME_UNSET
            currentIndex = nextIndex
            shuffle = nextShuffle
            repeatMode = nextRepeat
            playlist = nextPlaylist
            volume = if (muted) 0f else nextVolume
            corePhase = nextPhase
            projection = nextProjection
            playerError = nextError
            notifyResourceState(nextProjection.holdsPlaybackResources)
            invalidateState()
        }
    }

    private fun setPlaybackIntent(enabled: Boolean) {
        projection = projection.copy(
            playWhenReady = enabled,
            holdsPlaybackResources = when (corePhase) {
                CorePlaybackPhase.LOADING,
                CorePlaybackPhase.BUFFERING,
                CorePlaybackPhase.PLAYING,
                -> enabled
                else -> false
            },
        )
        notifyResourceState(projection.holdsPlaybackResources)
        invalidateState()
    }

    private fun notifyResourceState(held: Boolean) {
        if (resourcesHeld == held) return
        resourcesHeld = held
        onPlaybackResourcesChanged(held)
    }

    private fun repeatName(mode: Int) = when (mode) {
        Player.REPEAT_MODE_ALL -> "all"
        Player.REPEAT_MODE_ONE -> "one"
        else -> "off"
    }

    private fun repeatModeFrom(mode: String) = when (mode) {
        "all" -> Player.REPEAT_MODE_ALL
        "one" -> Player.REPEAT_MODE_ONE
        else -> Player.REPEAT_MODE_OFF
    }

    private fun mediaItems(queue: JSONArray?): List<MediaItemData> {
        if (queue == null) return emptyList()
        return buildList {
            for (index in 0 until queue.length()) {
                val song = queue.optJSONObject(index) ?: continue
                val id = song.optString("id", "queue-$index")
                val title = song.optString("title", id)
                val artists = song.optJSONArray("artists")
                val artist = buildString {
                    if (artists != null) for (artistIndex in 0 until artists.length()) {
                        val name = artists.optJSONObject(artistIndex)?.optString("name", "").orEmpty()
                        if (name.isBlank()) continue
                        if (isNotEmpty()) append(", ")
                        append(name)
                    }
                }
                val album = song.optJSONObject("album")
                    ?.optString("title")
                    ?.takeIf(String::isNotBlank)
                val artworkUri = song.optJSONObject("artwork")
                    ?.optString("src")
                    ?.takeIf(::isSafeArtworkUrl)
                    ?.let(Uri::parse)
                val metadata = MediaMetadata.Builder()
                    .setTitle(title)
                    .setArtist(artist.takeIf(String::isNotEmpty))
                    .setAlbumTitle(album)
                    .setArtworkUri(artworkUri)
                    .build()
                val item = MediaItem.Builder()
                    .setMediaId(id)
                    .setMediaMetadata(metadata)
                    .build()
                val itemDuration = song.nullableLong("durationMs") ?: C.TIME_UNSET
                add(
                    MediaItemData.Builder(id)
                        .setMediaItem(item)
                        .setMediaMetadata(metadata)
                        .setIsSeekable(itemDuration > 0)
                        .setDurationUs(if (itemDuration >= 0) itemDuration * 1_000 else C.TIME_UNSET)
                        .build(),
                )
            }
        }
    }

    private fun playbackException(error: JSONObject?): PlaybackException {
        val code = error?.optString("code")?.takeIf(String::isNotBlank).orEmpty()
        val message = error?.optString("message")?.takeIf(String::isNotBlank)
            ?: "YAQMC Core playback failed"
        return PlaybackException(message, null, media3ErrorCode(code))
    }

    private fun Throwable.asPlaybackException(): PlaybackException =
        this as? PlaybackException
            ?: PlaybackException(message ?: "YAQMC Core playback failed", this, PlaybackException.ERROR_CODE_REMOTE_ERROR)

    private fun JSONObject.nullableLong(name: String): Long? =
        if (!has(name) || isNull(name)) null else optLong(name)

    private fun JSONObject.nullableInt(name: String): Int? =
        if (!has(name) || isNull(name)) null else optInt(name)

    private fun MediaPlaybackPhase.toMedia3State(): Int = when (this) {
        MediaPlaybackPhase.IDLE -> Player.STATE_IDLE
        MediaPlaybackPhase.BUFFERING -> Player.STATE_BUFFERING
        MediaPlaybackPhase.READY -> Player.STATE_READY
        MediaPlaybackPhase.ENDED -> Player.STATE_ENDED
    }

    private fun failedFuture(message: String): ListenableFuture<*> =
        SettableFuture.create<Any?>().also {
            it.setException(PlaybackException(message, null, PlaybackException.ERROR_CODE_PERMISSION_DENIED))
        }

    companion object {
        private val MEDIA_AUDIO_ATTRIBUTES = AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
            .build()

        private fun isSafeArtworkUrl(value: String): Boolean = runCatching {
            val url = URI(value)
            url.scheme == "https" &&
                !url.host.isNullOrBlank() &&
                url.userInfo == null &&
                url.port == -1
        }.getOrDefault(false)

        private fun media3ErrorCode(code: String): Int = when {
            "timeout" in code -> PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT
            "network" in code || "streaming" in code ->
                PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED
            "auth" in code || "login" in code -> PlaybackException.ERROR_CODE_AUTHENTICATION_EXPIRED
            "premium" in code || "entitlement" in code ->
                PlaybackException.ERROR_CODE_PREMIUM_ACCOUNT_REQUIRED
            "output" in code -> PlaybackException.ERROR_CODE_AUDIO_TRACK_INIT_FAILED
            "decoder" in code || "format" in code ->
                PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED
            else -> PlaybackException.ERROR_CODE_REMOTE_ERROR
        }
    }
}
