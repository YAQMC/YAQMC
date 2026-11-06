package org.yaqmc.android.lyrics

import android.annotation.SuppressLint
import android.content.ComponentCallbacks
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.hardware.input.InputManager
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.annotation.MainThread
import org.json.JSONObject
import org.yaqmc.android.R
import org.yaqmc.android.core.CoreManager
import org.yaqmc.android.media.CarLyric
import kotlin.math.abs
import kotlin.math.roundToInt

/** Text a surface shows; derived from Core's `lyrics://projection`, the shared lyric timeline. */
data class SurfaceLyric(
    val trackId: String?,
    val title: String,
    val artist: String,
    val line: String?,
    val secondary: String?,
    val nextLine: String?,
    val playing: Boolean,
)

/** Visible-state rule shared by every surface; pure so it can be unit tested. */
internal fun surfaceShouldShow(
    enabled: Boolean,
    canDrawOverlays: Boolean,
    appForeground: Boolean,
    lyric: SurfaceLyric?,
): Boolean = enabled && canDrawOverlays && !appForeground && lyric?.trackId != null

/** Parses the JSON Core publishes on `lyrics://projection`. Line switches between ticks are scheduled from `nextLine.startMs`. */
internal data class LyricProjection(
    val lyric: SurfaceLyric,
    val positionMs: Long,
    val nextStartMs: Long?,
    val nextLyric: SurfaceLyric?,
) {
    companion object {
        fun parse(json: JSONObject): LyricProjection {
            val track = json.optJSONObject("currentTrack")
            val artists = track?.optJSONArray("artists")
            val artist = buildString {
                if (artists != null) for (i in 0 until artists.length()) {
                    val name = artists.optJSONObject(i)?.optString("name").orEmpty()
                    if (name.isBlank()) continue
                    if (isNotEmpty()) append(", ")
                    append(name)
                }
            }
            fun text(line: JSONObject?, key: String) =
                line?.optString(key)?.trim()?.takeIf { it.isNotEmpty() && it != "null" }
            val current = json.optJSONObject("currentLine")
            val next = json.optJSONObject("nextLine")
            val base = SurfaceLyric(
                trackId = track?.optString("id")?.takeIf(String::isNotBlank),
                title = track?.optString("title").orEmpty(),
                artist = artist,
                line = text(current, "text"),
                secondary = text(current, "translation") ?: text(current, "romanization"),
                nextLine = text(next, "text"),
                playing = json.optBoolean("isPlaying", false),
            )
            val nextStart = next?.takeIf { it.has("startMs") && !it.isNull("startMs") }?.optLong("startMs")
            return LyricProjection(
                lyric = base,
                positionMs = json.optLong("positionMs", 0L),
                nextStartMs = nextStart,
                nextLyric = next?.let {
                    base.copy(
                        line = text(it, "text"),
                        secondary = text(it, "translation") ?: text(it, "romanization"),
                        nextLine = null,
                    )
                },
            )
        }
    }
}

/**
 * Floating lyrics (`desktop`) use a user-authorized `TYPE_APPLICATION_OVERLAY` window.
 * System/OEM islands are not implemented by this overlay. The opt-in car
 * Bluetooth mode, rewrites the media session title while a Bluetooth A2DP output is active.
 *
 * All consumers share Core's lyric timeline: Core publishes on line changes and position ticks,
 * and the next line switch is scheduled from the projection instead of polling.
 */
@SuppressLint("StaticFieldLeak") // Holds the application context only.
object AndroidLyricsSurfaces : CoreManager.Callback {
    private const val PREFS = "yaqmc_lyrics_surfaces"
    private const val KEY_CONFIG = "config"
    private const val KEY_CAR = "car_bluetooth_lyrics"
    private const val CAR_MIN_INTERVAL_MS = 1_000L

    private val main = Handler(Looper.getMainLooper())
    private var context: Context? = null
    private var prefs: SharedPreferences? = null
    private var config = JSONObject()
    private var appForeground = false
    private var subscribed = false
    private var current: SurfaceLyric? = null
    private val surfaces = mutableMapOf<String, OverlaySurface>()
    private var nextLineSwitch: Runnable? = null

    /** Called when a user dismisses a surface on screen, so the WebView can turn its toggle off. */
    var onSurfaceClosed: ((kind: String) -> Unit)? = null

    var onInteractionChanged: ((kind: String, interaction: String) -> Unit)? = null
    private var interactionPending = false
    private var systemLyrics: SystemLyricsPluginHost? = null

    // Car Bluetooth compatibility mode.
    private var carEnabled = false
    private var bluetoothOutput = false
    private var carSink: ((CarLyric?) -> Unit)? = null
    private var carLastSent: CarLyric? = null
    private var carLastSentAt = 0L
    private var carPending: Runnable? = null
    private var deviceCallbackRegistered = false

    @MainThread
    fun init(appContext: Context) {
        if (context != null) return
        val ctx = appContext.applicationContext
        context = ctx
        systemLyrics = SystemLyricsPluginHost.load(ctx) { onSurfaceClosed?.invoke("island") }
        prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).also {
            config = runCatching { JSONObject(it.getString(KEY_CONFIG, "{}") ?: "{}") }
                .getOrDefault(JSONObject())
            carEnabled = it.getBoolean(KEY_CAR, false)
        }
        ctx.registerComponentCallbacks(object : ComponentCallbacks {
            override fun onConfigurationChanged(newConfig: Configuration) {
                main.post { surfaces.values.forEach(OverlaySurface::relayout) }
            }

            @Deprecated("Deprecated in Java")
            override fun onLowMemory() = Unit
        })
        if (!systemIslandAvailable()) config.optJSONObject("island")?.put("enabled", false)
        refresh()
    }

    fun canDrawOverlays(ctx: Context = requireNotNull(context)): Boolean = Settings.canDrawOverlays(ctx)

    fun overlayPermissionIntent(ctx: Context): Intent =
        Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${ctx.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /** Applies the WebView's `surfaces` preference document (full per-surface style). */
    @MainThread
    fun reconcile(surfacesJson: JSONObject) {
        val systemAvailable = systemIslandAvailable()
        config = reconcileFloatingLyrics(surfacesJson, config, systemAvailable)
        if (!systemAvailable && surfacesJson.optJSONObject("island")?.optBoolean("enabled") == true) {
            onSurfaceClosed?.invoke("island")
        }
        saveConfig()
        surfaces.values.forEach { it.applyConfig(config.optJSONObject(it.kind) ?: JSONObject()) }
        refresh()
    }

    private fun saveConfig() {
        prefs?.edit()?.putString(KEY_CONFIG, config.toString())?.apply()
    }

    /** Apply immediately, then persist through Core's atomic host-only preference mutation. */
    @MainThread
    fun setInteraction(
        kind: String,
        interaction: String,
        fallback: String? = null,
        onComplete: (Result<String>) -> Unit,
    ) {
        if (kind != "desktop" || interaction !in listOf("interactive", "passive-locked")) {
            onComplete(Result.failure(IllegalArgumentException("Unsupported surface interaction")))
            return
        }
        if (interactionPending) {
            onComplete(Result.failure(IllegalStateException("A lyrics lock change is still being saved")))
            return
        }
        val settings = config.optJSONObject(kind) ?: JSONObject().also { config.put(kind, it) }
        val previous = settings.optString("interaction", "interactive")
        fun applyInteraction(next: String) {
            config.getJSONObject(kind).put("interaction", next)
            saveConfig()
            surfaces[kind]?.applyConfig(config.getJSONObject(kind))
            refresh()
            onInteractionChanged?.invoke(kind, next)
        }
        interactionPending = true
        applyInteraction(interaction)
        val params = JSONObject()
            .put("kind", kind)
            .put("interaction", interaction)
            .put("value", fallback ?: JSONObject().put("version", 2).put("surfaces", config).toString())
        fun finish(result: Result<String>) {
            interactionPending = false
            if (result.isFailure) applyInteraction(previous)
            onComplete(result)
        }
        runCatching {
            CoreManager.invoke("app_preferences_set_surface_interaction", params.toString(), "host") { json ->
                val result = runCatching {
                    val response = JSONObject(json)
                    check(response.optBoolean("ok")) {
                        response.optJSONObject("error")?.optString("message") ?: "Could not save lyrics interaction"
                    }
                    response.getString("result")
                }
                main.post { finish(result) }
            }
        }.onFailure { finish(Result.failure(it)) }
    }

    @MainThread
    fun setAppForeground(foreground: Boolean) {
        if (appForeground == foreground) return
        appForeground = foreground
        refresh()
    }

    @MainThread
    fun resetPosition(kind: String) {
        prefs?.edit()?.remove("drag_$kind")?.apply()
        surfaces[kind]?.relayout()
    }

    @MainThread
    fun setCarBluetoothLyrics(enabled: Boolean) {
        if (carEnabled == enabled) return
        carEnabled = enabled
        prefs?.edit()?.putBoolean(KEY_CAR, enabled)?.apply()
        refresh()
    }

    /** CorePlayer registers here; `null` restores canonical metadata. */
    @MainThread
    fun attachCarSink(sink: ((CarLyric?) -> Unit)?) {
        carPending?.let(main::removeCallbacks)
        carPending = null
        carSink?.invoke(null)
        carSink = sink
        carLastSent = null
        refresh()
    }

    fun systemIslandAvailable(): Boolean = systemLyrics?.isAvailable() == true

    fun isEnabled(kind: String): Boolean =
        (kind == "desktop" || kind == "island" && systemIslandAvailable()) &&
            config.optJSONObject(kind)?.optBoolean("enabled") == true

    fun isLocked(): Boolean = config.optJSONObject("desktop")?.optString("interaction") == "passive-locked"

    @MainThread
    private fun refresh() {
        val ctx = context ?: return
        updateBluetoothWatch(ctx)
        // Overlays are hidden while YAQMC is visible, so they need no events then.
        val needsTimeline = ((isEnabled("desktop") && canDrawOverlays(ctx) || isEnabled("island")) && !appForeground) ||
            (carEnabled && bluetoothOutput && carSink != null)
        if (needsTimeline != subscribed) {
            subscribed = needsTimeline
            if (needsTimeline) {
                CoreManager.addCallback(this)
                // Prime with the authoritative projection instead of waiting for the next tick.
                runCatching {
                    CoreManager.invoke("lyrics_surface_projection") { json ->
                        val value = runCatching { JSONObject(json).optJSONObject("result") }.getOrNull()
                        if (value != null) main.post { accept(LyricProjection.parse(value)) }
                    }
                }
            } else {
                CoreManager.removeCallback(this)
                cancelLineSwitch()
            }
        }
        for (kind in listOf("desktop")) {
            val show = surfaceShouldShow(isEnabled(kind), canDrawOverlays(ctx), appForeground, current)
            if (show) {
                val surface = surfaces.getOrPut(kind) {
                    OverlaySurface(ctx, kind).also { it.applyConfig(config.optJSONObject(kind) ?: JSONObject()) }
                }
                if (!surface.attach()) {
                    // The permission was revoked or the window was rejected: report it honestly.
                    surfaces.remove(kind)
                    onSurfaceClosed?.invoke(kind)
                    continue
                }
                surface.render(current)
            } else {
                surfaces.remove(kind)?.detach()
            }
        }
        systemLyrics?.update(isEnabled("island"), appForeground, current)
        pushCarLine()
    }

    override fun onCoreResponse(id: Long, json: String) = Unit

    override fun onCoreEvent(sequence: Long, channel: String, json: String) {
        if (channel != "lyrics://projection") return
        val projection = runCatching { LyricProjection.parse(JSONObject(json)) }.getOrNull() ?: return
        main.post { accept(projection) }
    }

    @MainThread
    private fun accept(projection: LyricProjection) {
        cancelLineSwitch()
        show(projection.lyric)
        val nextStart = projection.nextStartMs
        val next = projection.nextLyric
        if (projection.lyric.playing && nextStart != null && next != null && nextStart > projection.positionMs) {
            val switch = Runnable { show(next) }
            nextLineSwitch = switch
            main.postDelayed(switch, nextStart - projection.positionMs)
        }
    }

    @MainThread
    private fun show(lyric: SurfaceLyric) {
        val trackChanged = lyric.trackId != current?.trackId
        if (lyric == current) return
        current = lyric
        if (trackChanged) refresh() else surfaces.values.forEach { it.render(lyric) }
        systemLyrics?.update(isEnabled("island"), appForeground, current)
        pushCarLine()
    }

    private fun cancelLineSwitch() {
        nextLineSwitch?.let(main::removeCallbacks)
        nextLineSwitch = null
    }

    // ---- car Bluetooth ------------------------------------------------------------------------

    private fun updateBluetoothWatch(ctx: Context) {
        val audio = ctx.getSystemService(AudioManager::class.java) ?: return
        if (carEnabled && !deviceCallbackRegistered) {
            deviceCallbackRegistered = true
            audio.registerAudioDeviceCallback(bluetoothCallback, main)
        } else if (!carEnabled && deviceCallbackRegistered) {
            deviceCallbackRegistered = false
            audio.unregisterAudioDeviceCallback(bluetoothCallback)
        }
        bluetoothOutput = carEnabled && audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
            .any { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP }
    }

    private val bluetoothCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = refresh()
        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = refresh()
    }

    private fun currentCarLyric(): CarLyric? {
        if (!carEnabled || !bluetoothOutput) return null
        val trackId = current?.trackId ?: return null
        val line = current?.line?.takeIf(String::isNotBlank) ?: return null
        return CarLyric(trackId, line)
    }

    /** At most one metadata change per second, only while a Bluetooth audio output is connected. */
    @MainThread
    private fun pushCarLine() {
        val sink = carSink ?: return
        val line = currentCarLyric()
        if (line == carLastSent) return
        carPending?.let(main::removeCallbacks)
        val wait = CAR_MIN_INTERVAL_MS - (SystemClock.elapsedRealtime() - carLastSentAt)
        val send = Runnable {
            carPending = null
            val latest = currentCarLyric()
            if (latest == carLastSent) return@Runnable
            carLastSent = latest
            carLastSentAt = SystemClock.elapsedRealtime()
            sink(latest)
        }
        // Restoring canonical metadata is never delayed.
        if (line == null || wait <= 0) send.run() else {
            carPending = send
            main.postDelayed(send, wait)
        }
    }

    // ---- overlay windows ----------------------------------------------------------------------

    private class OverlaySurface(private val ctx: Context, val kind: String) {
        private val windowManager = ctx.getSystemService(WindowManager::class.java)
        private val primary = TextView(ctx)
        private val secondary = TextView(ctx)
        private val toolbar = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
        }
        private val root = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            addView(toolbar)
            addView(primary)
            addView(secondary)
        }
        private val background = GradientDrawable()
        private var settings = JSONObject()
        private var attached = false
        private var lyric: SurfaceLyric? = null
        private val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }

        init {
            root.background = background
            for (view in listOf(primary, secondary)) {
                view.maxLines = 1
                view.ellipsize = TextUtils.TruncateAt.END
                view.setShadowLayer(dp(2f), 0f, 0f, 0x66000000)
            }
            primary.typeface = Typeface.DEFAULT_BOLD
            addTool(R.drawable.ic_lyrics_lock, R.string.floating_lyrics_lock) {
                setInteraction(kind, "passive-locked") { result ->
                    val message = if (result.isSuccess) R.string.floating_lyrics_locked
                        else R.string.floating_lyrics_lock_failed
                    Toast.makeText(ctx, message, Toast.LENGTH_LONG).show()
                }
            }
            addTool(R.drawable.ic_lyrics_close, R.string.floating_lyrics_close, ::dismiss)
            installTouch()
        }

        private fun addTool(icon: Int, label: Int, action: () -> Unit) {
            toolbar.addView(ImageButton(ctx).apply {
                setImageResource(icon)
                contentDescription = ctx.getString(label)
                tooltipText = contentDescription
                setPadding(dp(12f).roundToInt(), dp(12f).roundToInt(), dp(12f).roundToInt(), dp(12f).roundToInt())
                background = GradientDrawable().apply {
                    setColor(0xCC202020.toInt())
                    cornerRadius = dp(24f)
                }
                setOnClickListener { action() }
            }, LinearLayout.LayoutParams(dp(48f).roundToInt(), dp(48f).roundToInt()))
        }

        private fun dp(value: Float) = value * ctx.resources.displayMetrics.density

        fun applyConfig(value: JSONObject) {
            settings = value
            val locked = value.optString("interaction") == "passive-locked"
            params.flags = floatingLyricsFlags(params.flags, locked)
            // Android 12+ blocks touches through opaque, untrusted overlay windows.
            val maximumOpacity = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                ctx.getSystemService(InputManager::class.java).maximumObscuringOpacityForTouch
            } else 1f
            params.alpha = floatingLyricsWindowAlpha(locked, maximumOpacity)
            toolbar.visibility = if (locked) View.GONE else View.VISIBLE
            val fontSize = value.optDouble("fontSize", 30.0).toFloat()
            val secondarySize = value.optDouble("secondaryFontSize", fontSize * 0.52).toFloat()
            // fontSize is the largest size; long lines shrink to fit instead of wrapping.
            primary.setAutoSizeTextTypeUniformWithConfiguration(
                10, fontSize.roundToInt().coerceAtLeast(11), 1, TypedValue.COMPLEX_UNIT_SP,
            )
            primary.setTextSize(TypedValue.COMPLEX_UNIT_SP, fontSize)
            secondary.setTextSize(TypedValue.COMPLEX_UNIT_SP, secondarySize)
            primary.setTextColor(parseColor(value.optString("primaryColor"), Color.WHITE))
            val secondaryColor = parseColor(value.optString("secondaryColor"), 0xFFC7CBC2.toInt())
            secondary.setTextColor(secondaryColor)
            val gravity = when (value.optString("alignment")) {
                "left" -> Gravity.START
                "right" -> Gravity.END
                else -> Gravity.CENTER_HORIZONTAL
            }
            for (view in listOf(primary, secondary)) view.gravity = gravity
            val opacity = value.optDouble("backgroundOpacity", 0.0)
                .coerceIn(0.0, 100.0)
            background.setColor(Color.argb((opacity * 2.55).roundToInt(), 0, 0, 0))
            background.cornerRadius = dp(14f)
            val padH = dp(12f).roundToInt()
            val padV = dp(6f).roundToInt()
            root.setPadding(padH, padV, padH, padV)
            relayout()
            lyric?.let(::render)
        }

        fun relayout() {
            val metrics = ctx.resources.displayMetrics
            val fraction = when (settings.optString("width")) {
                "compact" -> 0.6f
                "wide" -> 0.94f
                else -> 0.8f
            }
            val maxWidth = (metrics.widthPixels * fraction).roundToInt()
            params.width = maxWidth
            primary.maxWidth = maxWidth
            val dragged = prefs?.getInt("drag_$kind", Int.MIN_VALUE) ?: Int.MIN_VALUE
            val offset = if (dragged != Int.MIN_VALUE) dragged else
                dp(settings.optDouble("verticalOffset", 24.0).toFloat()).roundToInt()
            // Keep the window on screen after rotation or a smaller display.
            params.y = offset.coerceIn(0, (metrics.heightPixels - dp(48f).roundToInt()).coerceAtLeast(0))
            params.x = dp(settings.optDouble("horizontalPosition", 0.0).toFloat()).roundToInt()
                .coerceIn(-metrics.widthPixels / 2, metrics.widthPixels / 2)
            if (attached) runCatching { windowManager.updateViewLayout(root, params) }
                .onFailure { detach() }
        }

        fun attach(): Boolean {
            if (attached) return true
            if (!Settings.canDrawOverlays(ctx)) return false
            relayout()
            attached = runCatching { windowManager.addView(root, params) }.isSuccess
            return attached
        }

        fun detach() {
            if (!attached) return
            attached = false
            runCatching { windowManager.removeViewImmediate(root) }
        }

        fun render(value: SurfaceLyric?) {
            lyric = value
            val line = value?.line ?: value?.title.orEmpty()
            primary.text = line
            val double = settings.optString("lineMode", "double") == "double"
            val second = when {
                double -> value?.secondary ?: value?.nextLine
                else -> null
            }
            secondary.text = second.orEmpty()
            secondary.visibility = if (second.isNullOrEmpty()) View.GONE else View.VISIBLE
            // A paused surface keeps its last line but dims it; it schedules no work.
            root.alpha = if (value?.playing == false) 0.6f else 1f
        }

        @SuppressLint("ClickableViewAccessibility")
        private fun installTouch() {
            val slop = ViewConfiguration.get(ctx).scaledTouchSlop
            var downY = 0f
            var startY = 0
            var dragging = false
            root.setOnClickListener { openApp() }
            root.setOnTouchListener { _, event ->
                when (event.actionMasked) {
                    MotionEvent.ACTION_DOWN -> {
                        downY = event.rawY
                        startY = params.y
                        dragging = false
                        true
                    }
                    MotionEvent.ACTION_MOVE -> {
                        val dy = event.rawY - downY
                        if (!dragging && abs(dy) > slop) dragging = true
                        if (dragging) {
                            // Bottom-anchored windows grow upward.
                            params.y = (startY - dy.roundToInt())
                                .coerceIn(0, (ctx.resources.displayMetrics.heightPixels - root.height).coerceAtLeast(0))
                            runCatching { windowManager.updateViewLayout(root, params) }
                        }
                        true
                    }
                    MotionEvent.ACTION_UP -> {
                        when {
                            dragging -> prefs?.edit()?.putInt("drag_$kind", params.y)?.apply()
                            else -> root.performClick()
                        }
                        true
                    }
                    MotionEvent.ACTION_CANCEL -> { dragging = false; true }
                    else -> false
                }
            }
        }

        private fun dismiss() {
            config.optJSONObject(kind)?.put("enabled", false)
            prefs?.edit()?.putString(KEY_CONFIG, config.toString())?.apply()
            onSurfaceClosed?.invoke(kind)
            refresh()
        }

        private fun openApp() {
            ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
                ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                ?.let(ctx::startActivity)
        }

        private fun parseColor(value: String, fallback: Int): Int =
            runCatching { Color.parseColor(value) }.getOrDefault(fallback)
    }
}
