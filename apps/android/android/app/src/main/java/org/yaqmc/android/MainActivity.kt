package org.yaqmc.android

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.media3.common.util.UnstableApi
import com.capacitorjs.plugins.app.AppPlugin
import com.getcapacitor.BridgeActivity
import com.getcapacitor.WebViewListener
import org.yaqmc.android.core.DeepLinkManager
import org.yaqmc.android.core.MobileLoginOwner
import org.yaqmc.android.media.PlaybackService
import org.yaqmc.android.plugin.YaqmcNativePlugin
import kotlin.math.roundToInt

@UnstableApi
class MainActivity : BridgeActivity() {
    private val deepLinks = DeepLinkManager()

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        registerPlugin(AppPlugin::class.java)
        registerPlugin(YaqmcNativePlugin::class.java)
        super.onCreate(savedInstanceState)
        installFullBleedWebViewInsets()
        handleDeepLink(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleDeepLink(intent)
    }

    override fun onStart() {
        super.onStart()
        PlaybackService.ensureStarted(this)
    }

    override fun onResume() {
        super.onResume()
        requestResponsiveFrameRate()
        MobileLoginOwner.lifecycle("foreground")
    }

    override fun onPause() {
        MobileLoginOwner.lifecycle("background")
        super.onPause()
    }

    override fun onDestroy() {
        MobileLoginOwner.lifecycle(if (isChangingConfigurations) "activity-recreated" else "activity-destroyed")
        super.onDestroy()
    }

    private fun handleDeepLink(intent: Intent?) {
        deepLinks.accept(intent)
    }

    /** Prefer the platform's high UI frame-rate category while preserving its
     * power, thermal and seamless-switching decisions. */
    private fun requestResponsiveFrameRate() {
        val webView = bridge?.webView ?: return
        val preferred = highestRefreshRate(webView.display?.supportedRefreshRates ?: floatArrayOf())
        if (preferred <= 0f) return
        val attributes = window.attributes
        attributes.preferredRefreshRate = preferred
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            attributes.setFrameRateBoostOnTouchEnabled(true)
            webView.setRequestedFrameRate(preferred)
        }
        window.attributes = attributes
    }

    /**
     * Capacitor pads the WebView container on Android WebView versions below 140 because those
     * versions expose incorrect CSS safe-area env values. That leaves visible letterboxing around
     * the app in landscape. Keep the WebView edge-to-edge and publish the real insets as the same
     * CSS custom properties used by Capacitor instead.
     */
    private fun installFullBleedWebViewInsets() {
        WindowCompat.setDecorFitsSystemWindows(window, false)

        val webView = bridge?.webView ?: return
        val container = webView.parent as? View ?: return
        ViewCompat.setOnApplyWindowInsetsListener(container) { view, insets ->
            val safeArea = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            val keyboardVisible = insets.isVisible(WindowInsetsCompat.Type.ime())
            val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())

            // Resize only for the software keyboard. System bars are handled in CSS so the
            // background can continue behind them without placing controls in unsafe regions.
            view.setPadding(0, 0, 0, if (keyboardVisible) keyboard.bottom else 0)
            publishSafeAreaInsets(
                webView,
                top = safeArea.top,
                right = safeArea.right,
                bottom = if (keyboardVisible) 0 else safeArea.bottom,
                left = safeArea.left,
            )
            insets
        }

        bridge.addWebViewListener(
            object : WebViewListener() {
                override fun onPageCommitVisible(view: WebView, url: String) {
                    (view.parent as? View)?.let(ViewCompat::requestApplyInsets)
                }
            },
        )
        ViewCompat.requestApplyInsets(container)
    }

    private fun publishSafeAreaInsets(
        webView: WebView,
        top: Int,
        right: Int,
        bottom: Int,
        left: Int,
    ) {
        val density = resources.displayMetrics.density
        fun cssPixels(value: Int) = (value / density).roundToInt()

        val script =
            """
            (() => {
              const root = document.documentElement;
              if (!root) return;
              root.style.setProperty('--safe-area-inset-top', '${cssPixels(top)}px');
              root.style.setProperty('--safe-area-inset-right', '${cssPixels(right)}px');
              root.style.setProperty('--safe-area-inset-bottom', '${cssPixels(bottom)}px');
              root.style.setProperty('--safe-area-inset-left', '${cssPixels(left)}px');
            })();
            """.trimIndent()
        webView.post { webView.evaluateJavascript(script, null) }
    }
}

internal fun highestRefreshRate(rates: FloatArray): Float =
    rates.asSequence().filter { it.isFinite() && it > 0f }.maxOrNull() ?: 0f
