package org.yaqmc.android.lyrics

import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import androidx.annotation.MainThread

/** Optional, APK-bundled OEM adapter. See docs/android.md#system-lyrics-plugins. */
@MainThread
interface SystemLyricsPlugin {
    /** True only on a supported system with the required vendor authorization. */
    fun isAvailable(): Boolean
    /** Update a real system surface; never create an application overlay as a fallback. */
    fun show(lyric: SurfaceLyric)
    /** Remove the system surface. Must be safe to call more than once. */
    fun hide()
}

/** Isolates optional vendor failures from playback and floating lyrics. */
internal class SystemLyricsPluginHost(
    private var plugin: SystemLyricsPlugin?,
    private val onFailure: (Throwable) -> Unit,
) {
    private var last: SurfaceLyric? = null

    fun isAvailable(): Boolean = try {
        plugin?.isAvailable() == true
    } catch (error: Exception) {
        disable(error)
        false
    } catch (error: LinkageError) {
        disable(error)
        false
    }

    fun update(enabled: Boolean, appForeground: Boolean, lyric: SurfaceLyric?) {
        val visible = enabled && !appForeground && lyric?.trackId != null && isAvailable()
        val next = if (visible) lyric else null
        if (next == last) return
        try {
            if (next == null) plugin?.hide() else plugin?.show(next)
            last = next
        } catch (error: Exception) {
            disable(error)
        } catch (error: LinkageError) {
            disable(error)
        }
    }

    private fun disable(error: Throwable) {
        val failed = plugin
        plugin = null
        last = null
        runCatching { failed?.hide() }
        onFailure(error)
    }

    companion object {
        const val METADATA = "org.yaqmc.android.SYSTEM_LYRICS_PLUGIN"

        fun load(context: Context, onFailure: () -> Unit): SystemLyricsPluginHost {
            val report: (Throwable) -> Unit = { error ->
                Log.w("SystemLyricsPlugin", "System lyrics adapter unavailable", error)
                onFailure()
            }
            val plugin = runCatching {
                @Suppress("DEPRECATION")
                val info = context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
                val name = info.metaData?.getString(METADATA)?.takeIf(String::isNotBlank)
                name?.let {
                    Class.forName(it, true, context.classLoader)
                        .asSubclass(SystemLyricsPlugin::class.java)
                        .getConstructor(Context::class.java)
                        .newInstance(context.applicationContext)
                }
            }.onFailure(report).getOrNull()
            return SystemLyricsPluginHost(plugin, report)
        }
    }
}
