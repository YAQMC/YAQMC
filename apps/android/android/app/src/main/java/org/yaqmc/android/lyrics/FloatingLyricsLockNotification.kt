package org.yaqmc.android.lyrics

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.Toast
import androidx.core.app.NotificationCompat
import org.yaqmc.android.R

/** Separate from Media3's playback notification, so paused lyrics can still be unlocked. */
internal class FloatingLyricsLockNotification(private val context: Context) {
    private val manager = context.getSystemService(NotificationManager::class.java)

    init {
        manager.createNotificationChannel(NotificationChannel(
            CHANNEL, context.getString(R.string.floating_lyrics_notification_channel), NotificationManager.IMPORTANCE_LOW,
        ).apply { setShowBadge(false) })
    }

    fun canPost(): Boolean = manager.areNotificationsEnabled() &&
        manager.getNotificationChannel(CHANNEL)?.importance != NotificationManager.IMPORTANCE_NONE

    fun update(locked: Boolean) {
        if (!locked || !canPost()) {
            manager.cancel(ID)
            return
        }
        val unlock = PendingIntent.getBroadcast(
            context, ID,
            Intent(context, FloatingLyricsUnlockReceiver::class.java).setAction(FloatingLyricsUnlockReceiver.ACTION),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_lyrics_lock)
            .setContentTitle(context.getString(R.string.floating_lyrics_notification_title))
            .setContentText(context.getString(R.string.floating_lyrics_notification_text))
            .setContentIntent(unlock)
            .addAction(0, context.getString(R.string.floating_lyrics_unlock), unlock)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setShowWhen(false)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .build()
        try {
            manager.notify(ID, notification)
        } catch (error: SecurityException) {
            // Permission can be revoked between the check and notify().
            Log.w("FloatingLyrics", "Unable to post unlock notification", error)
        }
    }

    private companion object {
        const val CHANNEL = "floating_lyrics_lock"
        const val ID = 0x594C
    }
}

/** Only the app's immutable PendingIntent may invoke this non-exported receiver. */
class FloatingLyricsUnlockReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        AndroidLyricsSurfaces.init(context)
        val pending = goAsync()
        val handler = Handler(Looper.getMainLooper())
        var finished = false
        val finish = Runnable {
            if (!finished) {
                finished = true
                pending.finish()
            }
        }
        // A stalled Core response must not hold a broadcast beyond Android's deadline.
        handler.postDelayed(finish, 8_000L)
        AndroidLyricsSurfaces.setInteraction("desktop", "interactive") { result ->
            try {
                if (result.isFailure) Toast.makeText(
                    context, R.string.floating_lyrics_unlock_failed, Toast.LENGTH_LONG,
                ).show()
            } finally {
                handler.removeCallbacks(finish)
                finish.run()
            }
        }
    }

    companion object {
        const val ACTION = "org.yaqmc.android.UNLOCK_FLOATING_LYRICS"
    }
}
