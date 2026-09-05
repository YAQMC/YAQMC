package org.yaqmc.android.media

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.content.ContextCompat
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

@UnstableApi
class PlaybackService : MediaSessionService() {
    private var session: MediaSession? = null
    private var player: CorePlayer? = null
    private var focusRequest: AudioFocusRequest? = null
    private lateinit var audioManager: AudioManager
    private lateinit var wakeLock: PowerManager.WakeLock
    private val handler = Handler(Looper.getMainLooper())
    private val focusPolicy = AudioFocusPolicy()
    private var focusHeld = false
    private var noisyReceiverRegistered = false
    private var shuttingDown = false

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        val focusChange = when (change) {
            AudioManager.AUDIOFOCUS_GAIN -> FocusChange.GAIN
            AudioManager.AUDIOFOCUS_LOSS -> FocusChange.LOSS
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> FocusChange.LOSS_TRANSIENT
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> FocusChange.LOSS_TRANSIENT_CAN_DUCK
            else -> null
        } ?: return@OnAudioFocusChangeListener
        if (focusChange == FocusChange.GAIN) focusHeld = true
        if (focusChange == FocusChange.LOSS) focusHeld = false
        applyFocusAction(
            focusPolicy.onFocusChange(
                focusChange,
                player?.hasPlaybackIntent() == true,
            ),
        )
    }

    private val noisyReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != AudioManager.ACTION_AUDIO_BECOMING_NOISY) return
            applyFocusAction(
                focusPolicy.onBecomingNoisy(player?.hasPlaybackIntent() == true),
            )
        }
    }

    override fun onCreate() {
        super.onCreate()
        active = this
        audioManager = getSystemService(AudioManager::class.java)
        wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "yaqmc:playback")
            .apply { setReferenceCounted(false) }
        player = CorePlayer(
            Looper.getMainLooper(),
            ::requestAudioFocus,
            onUserPause = focusPolicy::onUserPause,
            onUserPlay = focusPolicy::onUserPlay,
            onPlaybackResourcesChanged = ::updatePlaybackResources,
            onStopRequested = ::stopAfterCore,
        )
        session = MediaSession.Builder(this, player!!).setId("yaqmc").build()
        ContextCompat.registerReceiver(
            this,
            noisyReceiver,
            IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
            ContextCompat.RECEIVER_EXPORTED,
        )
        noisyReceiverRegistered = true
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Media3's ongoing definition includes buffering, unlike Player.isPlaying.
        if (!isPlaybackOngoing()) stopSelf()
    }

    override fun onDestroy() {
        if (active === this) active = null
        if (noisyReceiverRegistered) {
            unregisterReceiver(noisyReceiver)
            noisyReceiverRegistered = false
        }
        abandonAudioFocus()
        updateWakeLock(false)
        session?.release()
        player?.close()
        player?.release()
        session = null
        player = null
        super.onDestroy()
    }

    private fun prepareForRendererCommand(method: String): Pair<Boolean, Boolean> {
        if (shuttingDown) return false to false
        val shouldStart = method != "player_toggle" || player?.hasPlaybackIntent() != true
        if (!shouldStart) return true to false
        if (!requestAudioFocus()) return false to false
        focusPolicy.onUserPlay()
        player?.noteExternalPlayRequest()
        return true to true
    }

    private fun cancelPreparedPlayback() {
        player?.cancelExternalPlayRequest()
        if (player?.hasPlaybackIntent() != true) abandonAudioFocus()
    }

    private fun requestAudioFocus(): Boolean {
        if (focusHeld) return true
        val attributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
            .build()
        val result = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val request = focusRequest ?: AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(attributes)
                .setOnAudioFocusChangeListener(focusListener, handler)
                .setWillPauseWhenDucked(true)
                .build()
                .also { focusRequest = it }
            audioManager.requestAudioFocus(request)
        } else {
            @Suppress("DEPRECATION")
            audioManager.requestAudioFocus(
                focusListener,
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN,
            )
        }
        focusHeld = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        return focusHeld
    }

    private fun abandonAudioFocus() {
        if (!focusHeld && focusRequest == null) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest?.let(audioManager::abandonAudioFocusRequest)
        } else {
            @Suppress("DEPRECATION")
            audioManager.abandonAudioFocus(focusListener)
        }
        focusRequest = null
        focusHeld = false
    }

    private fun applyFocusAction(action: FocusAction) {
        when (action) {
            FocusAction.PAUSE -> player?.pauseForSystem()
            FocusAction.RESUME -> player?.play()
            FocusAction.NONE -> Unit
        }
    }

    private fun updatePlaybackResources(held: Boolean) {
        if (held && !focusHeld && !requestAudioFocus()) {
            player?.pauseForSystem()
            return
        }
        updateWakeLock(held)
        if (!held) abandonAudioFocus()
    }

    private fun updateWakeLock(held: Boolean) {
        if (held && !wakeLock.isHeld) wakeLock.acquire()
        if (!held && wakeLock.isHeld) wakeLock.release()
    }

    private fun stopAfterCore() {
        if (shuttingDown) return
        shuttingDown = true
        abandonAudioFocus()
        updateWakeLock(false)
        stopSelf()
    }

    companion object {
        private const val START_TIMEOUT_MS = 2_000L
        private val mainHandler = Handler(Looper.getMainLooper())
        @Volatile private var active: PlaybackService? = null

        private val PLAYBACK_START_METHODS = setOf(
            "continuation_start",
            "player_play",
            "player_play_from_queue",
            "player_play_next_queue_entry",
            "player_play_queue_entry",
            "player_play_tracks",
            "player_toggle",
        )

        fun ensureStarted(context: Context): Boolean = runCatching {
            context.applicationContext.startService(
                Intent(context.applicationContext, PlaybackService::class.java),
            )
            true
        }.getOrDefault(false)

        fun isPlaybackStartMethod(method: String): Boolean = method in PLAYBACK_START_METHODS

        fun prepareRendererPlayback(
            context: Context,
            method: String,
            callback: (allowed: Boolean, prepared: Boolean) -> Unit,
        ) {
            if (!ensureStarted(context)) {
                callback(false, false)
                return
            }
            val deadline = SystemClock.uptimeMillis() + START_TIMEOUT_MS
            mainHandler.post(object : Runnable {
                override fun run() {
                    val service = active
                    if (service != null) {
                        val (allowed, prepared) = service.prepareForRendererCommand(method)
                        callback(allowed, prepared)
                    } else if (SystemClock.uptimeMillis() < deadline) {
                        mainHandler.postDelayed(this, 20L)
                    } else {
                        callback(false, false)
                    }
                }
            })
        }

        fun cancelPreparedRendererPlayback() {
            mainHandler.post { active?.cancelPreparedPlayback() }
        }
    }
}
