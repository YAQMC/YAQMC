package org.yaqmc.android

import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import org.json.JSONArray

/**
 * Isolated OAuth WebView. It has no JavaScript bridge, file/content access,
 * popup support, downloads, mixed content, or persistent browser state.
 */
class OAuthActivity : ComponentActivity() {
    private lateinit var navigationAllowlist: List<String>
    private lateinit var externalNavigationRules: List<OAuthExternalNavigationRule>
    private lateinit var callbackPrefix: String
    private var webView: WebView? = null
    private var backButton: ImageButton? = null
    private var progress: ProgressBar? = null
    private var loadError: View? = null
    private var retryUrl: String? = null
    private var finished = false
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        onBackPressedDispatcher.addCallback(this) { navigateBackOrCancel() }
        navigationAllowlist =
            intent.getStringArrayListExtra(EXTRA_NAVIGATION_ALLOWLIST)?.toList().orEmpty()
        externalNavigationRules = OAuthUrlPolicy.parseExternalNavigationRules(
            intent.getStringExtra(EXTRA_EXTERNAL_NAVIGATION_RULES),
        ) ?: run {
            cancel()
            return
        }
        callbackPrefix = intent.getStringExtra(EXTRA_CALLBACK_PREFIX).orEmpty()
        val presentedUrl = OAuthUrlPolicy.selectPresentationUrl(
            intent.getStringExtra(EXTRA_URL),
            intent.getStringExtra(EXTRA_MOBILE_URL),
            resources.configuration.smallestScreenWidthDp,
        )
        if (
            navigationAllowlist.isEmpty() ||
            callbackPrefix.isBlank() ||
            !OAuthUrlPolicy.matchesAllowlist(presentedUrl, navigationAllowlist)
        ) {
            cancel()
            return
        }
        retryUrl = presentedUrl

        val browser = WebView(this)
        webView = browser
        browser.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            safeBrowsingEnabled = true
            cacheMode = WebSettings.LOAD_NO_CACHE
            useWideViewPort = true
            loadWithOverviewMode = false
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(browser, false)
        }
        browser.setDownloadListener { _, _, _, _, _ -> browser.stopLoading() }
        browser.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                progress?.progress = newProgress
                progress?.visibility = if (newProgress in 0..99) View.VISIBLE else View.INVISIBLE
            }
        }
        browser.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean = handleNavigation(request.url, request.isForMainFrame)

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                updateBackButton(view)
                val href = url ?: run {
                    view.stopLoading()
                    cancel()
                    return
                }
                val uri = Uri.parse(href)
                if (OAuthUrlPolicy.matchesCallback(href, callbackPrefix)) {
                    handleNavigation(uri, true)
                    return
                }
                if (!OAuthUrlPolicy.matchesAllowlist(href, navigationAllowlist)) {
                    view.stopLoading()
                    cancel()
                    return
                }
                retryUrl = href
                loadError?.visibility = View.GONE
                view.visibility = View.VISIBLE
            }

            override fun onPageFinished(view: WebView, url: String?) {
                updateBackButton(view)
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: android.webkit.WebResourceError,
            ) {
                if (request.isForMainFrame) showLoadError(view, request.url.toString())
            }
        }
        val contentView = createContentView(browser)
        setContentView(contentView)
        ViewCompat.requestApplyInsets(contentView)
        CookieManager.getInstance().removeAllCookies {
            if (!isFinishing && !isDestroyed) browser.loadUrl(presentedUrl!!)
        }
    }

    override fun onDestroy() {
        cleanWebView()
        super.onDestroy()
    }

    private fun handleNavigation(uri: Uri, isForMainFrame: Boolean): Boolean {
        if (OAuthUrlPolicy.matchesCallback(uri.toString(), callbackPrefix)) {
            if (!finished) {
                finished = true
                setResult(RESULT_OK, Intent().setData(uri))
                finishAndClean()
            }
            return true
        }
        // QQ's current mobile login emits its package-scoped scheme through a hidden iframe.
        // Frame origin does not widen this boundary: the full scheme/host/path and every
        // destination package still have to come from the provider-owned rule set.
        val externalRule = OAuthUrlPolicy.matchingExternalNavigationRule(
            uri.toString(),
            externalNavigationRules,
        )
        if (externalRule != null) {
            openExternalApp(uri, externalRule)
            return true
        }
        if (!isForMainFrame) {
            return !uri.scheme.equals("https", ignoreCase = true)
        }
        if (!OAuthUrlPolicy.matchesAllowlist(uri.toString(), navigationAllowlist)) {
            cancel()
            return true
        }
        return false
    }

    private fun openExternalApp(uri: Uri, rule: OAuthExternalNavigationRule) {
        for (packageName in rule.androidPackages) {
            val external = Intent(Intent.ACTION_VIEW, uri).apply {
                addCategory(Intent.CATEGORY_BROWSABLE)
                setPackage(packageName)
            }
            try {
                startActivity(external)
                return
            } catch (_: ActivityNotFoundException) {
                // Try the next package declared by the provider.
            } catch (_: SecurityException) {
                // Treat a non-exported or policy-blocked target as unavailable.
            }
        }
        Toast.makeText(this, R.string.oauth_app_unavailable, Toast.LENGTH_SHORT).show()
    }

    private fun cancel() {
        if (finished) return
        finished = true
        setResult(RESULT_CANCELED)
        finishAndClean()
    }

    private fun navigateBackOrCancel() {
        val browser = webView
        if (browser?.canGoBack() == true) {
            browser.goBack()
        } else {
            cancel()
        }
    }

    private fun updateBackButton(browser: WebView) {
        backButton?.apply {
            isEnabled = browser.canGoBack()
            alpha = if (isEnabled) 1f else 0.38f
        }
    }

    private fun createContentView(browser: WebView): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val safeArea = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            val keyboardBottom = if (insets.isVisible(WindowInsetsCompat.Type.ime())) {
                insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            } else {
                0
            }
            view.setPadding(
                safeArea.left,
                safeArea.top,
                safeArea.right,
                maxOf(safeArea.bottom, keyboardBottom),
            )
            insets
        }
        val toolbar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(4), 0, dp(4), 0)
            elevation = dp(2).toFloat()
            setBackgroundColor(Color.WHITE)
        }
        val back = ImageButton(this).apply {
            setImageResource(R.drawable.ic_oauth_back)
            setBackgroundResource(android.R.drawable.list_selector_background)
            contentDescription = getString(R.string.oauth_back)
            isEnabled = false
            alpha = 0.38f
            setOnClickListener { navigateBackOrCancel() }
        }
        backButton = back
        toolbar.addView(back, LinearLayout.LayoutParams(dp(48), dp(48)))
        toolbar.addView(
            TextView(this).apply {
                text = getString(R.string.oauth_title)
                setTextColor(Color.rgb(32, 33, 36))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
                setTypeface(typeface, android.graphics.Typeface.BOLD)
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(8), 0, dp(8), 0)
            },
            LinearLayout.LayoutParams(0, dp(56), 1f),
        )
        toolbar.addView(
            ImageButton(this).apply {
                setImageResource(R.drawable.ic_oauth_close)
                setBackgroundResource(android.R.drawable.list_selector_background)
                contentDescription = getString(R.string.oauth_close)
                setOnClickListener { cancel() }
            },
            LinearLayout.LayoutParams(dp(48), dp(48)),
        )
        root.addView(
            toolbar,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(56)),
        )
        val loading = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            isIndeterminate = false
        }
        progress = loading
        root.addView(
            loading,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3)),
        )
        val content = FrameLayout(this).apply {
            addView(
                browser,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                ),
            )
            addView(
                createLoadErrorView(),
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                ),
            )
        }
        root.addView(content, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        return root
    }

    private fun createLoadErrorView(): View =
        LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            visibility = View.GONE
            setPadding(dp(32), dp(24), dp(32), dp(24))
            setBackgroundColor(Color.WHITE)
            addView(
                TextView(context).apply {
                    text = getString(R.string.oauth_load_failed)
                    setTextColor(Color.rgb(32, 33, 36))
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
                    setTypeface(typeface, android.graphics.Typeface.BOLD)
                    gravity = Gravity.CENTER
                },
            )
            addView(
                TextView(context).apply {
                    text = getString(R.string.oauth_load_failed_detail)
                    setTextColor(Color.rgb(95, 99, 104))
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
                    gravity = Gravity.CENTER
                },
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ).apply { setMargins(0, dp(10), 0, dp(18)) },
            )
            addView(
                Button(context).apply {
                    text = getString(R.string.oauth_retry)
                    minHeight = dp(48)
                    setOnClickListener { retry() }
                },
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    dp(48),
                ),
            )
            loadError = this
        }

    private fun showLoadError(browser: WebView, failedUrl: String) {
        if (finished || !OAuthUrlPolicy.matchesAllowlist(failedUrl, navigationAllowlist)) {
            cancel()
            return
        }
        retryUrl = failedUrl
        browser.stopLoading()
        browser.visibility = View.GONE
        progress?.visibility = View.INVISIBLE
        loadError?.visibility = View.VISIBLE
    }

    private fun retry() {
        val target = retryUrl
        val browser = webView
        if (
            target == null ||
            browser == null ||
            !OAuthUrlPolicy.matchesAllowlist(target, navigationAllowlist)
        ) {
            cancel()
            return
        }
        loadError?.visibility = View.GONE
        browser.visibility = View.VISIBLE
        browser.loadUrl(target)
    }

    private fun dp(value: Int): Int =
        (value * resources.displayMetrics.density + 0.5f).toInt()

    private fun finishAndClean() {
        cleanWebView()
        finish()
    }

    private fun cleanWebView() {
        webView?.let { browser ->
            (browser.parent as? ViewGroup)?.removeView(browser)
            browser.apply {
                stopLoading()
                clearHistory()
                clearCache(true)
                removeAllViews()
                webViewClient = WebViewClient()
                webChromeClient = null
                destroy()
            }
        }
        webView = null
        backButton = null
        progress = null
        loadError = null
        retryUrl = null
        CookieManager.getInstance().removeAllCookies(null)
        CookieManager.getInstance().flush()
    }

    companion object {
        const val EXTRA_URL = "org.yaqmc.android.oauth.url"
        const val EXTRA_MOBILE_URL = "org.yaqmc.android.oauth.mobile_url"
        const val EXTRA_NAVIGATION_ALLOWLIST = "org.yaqmc.android.oauth.navigation_allowlist"
        const val EXTRA_EXTERNAL_NAVIGATION_RULES =
            "org.yaqmc.android.oauth.external_navigation_rules"
        const val EXTRA_CALLBACK_PREFIX = "org.yaqmc.android.oauth.callback_prefix"
    }
}

data class OAuthExternalNavigationRule(
    val scheme: String,
    val host: String,
    val path: String,
    val androidPackages: List<String>,
)

/** Exact port of the desktop OAuth URL boundary. */
object OAuthUrlPolicy {
    private const val MAX_URL_BYTES = 8 * 1024
    private const val TABLET_MIN_WIDTH_DP = 600
    private val SAFE_SCHEME = Regex("^[a-z][a-z0-9+.-]{1,31}$")
    private val SAFE_HOST = Regex("^[a-z0-9.-]{1,255}$")
    private val SAFE_PACKAGE = Regex("^[a-zA-Z][a-zA-Z0-9_]*(?:\\.[a-zA-Z0-9_]+)+$")

    /**
     * The provider owns both URLs. Android only selects the phone presentation;
     * it never rewrites an upstream endpoint or query.
     */
    fun selectPresentationUrl(
        defaultUrl: String?,
        mobileUrl: String?,
        smallestScreenWidthDp: Int,
    ): String? = if (smallestScreenWidthDp < TABLET_MIN_WIDTH_DP && !mobileUrl.isNullOrBlank()) {
        mobileUrl.takeIf { parse(it) != null }
    } else {
        defaultUrl.takeIf { parse(it) != null }
    }

    fun parseExternalNavigationRules(value: String?): List<OAuthExternalNavigationRule>? {
        if (value == null) return emptyList()
        return runCatching {
            val array = JSONArray(value)
            require(array.length() <= 8)
            buildList {
                for (index in 0 until array.length()) {
                    val item = array.getJSONObject(index)
                    val scheme = item.getString("scheme").lowercase()
                    val host = item.getString("host").lowercase()
                    val path = item.getString("path")
                    val packages = item.getJSONArray("androidPackages")
                    require(SAFE_SCHEME.matches(scheme))
                    require(scheme != "http" && scheme != "https" && scheme != "intent")
                    require(SAFE_HOST.matches(host))
                    require(path.isEmpty() || (path.startsWith('/') && path.length <= 256))
                    require(packages.length() in 1..4)
                    val androidPackages = buildList {
                        for (packageIndex in 0 until packages.length()) {
                            val packageName = packages.getString(packageIndex)
                            require(SAFE_PACKAGE.matches(packageName))
                            add(packageName)
                        }
                    }
                    add(OAuthExternalNavigationRule(scheme, host, path, androidPackages))
                }
            }
        }.getOrNull()
    }

    fun matchingExternalNavigationRule(
        value: String?,
        rules: List<OAuthExternalNavigationRule>,
    ): OAuthExternalNavigationRule? {
        val uri = parse(value) ?: return null
        if (uri.rawUserInfo != null || uri.port != -1 || uri.rawFragment != null) return null
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme == "http" || scheme == "https" || scheme == "intent") return null
        val host = uri.host?.lowercase() ?: return null
        val path = uri.rawPath.orEmpty()
        return rules.firstOrNull { rule ->
            rule.scheme == scheme && rule.host == host && rule.path == path
        }
    }

    fun matchesAllowlist(value: String?, allowlist: List<String>): Boolean {
        val uri = parse(value) ?: return false
        if (!isSecureUri(uri)) return false
        val href = value!!
        if (href.toByteArray(StandardCharsets.UTF_8).size > MAX_URL_BYTES) return false
        return allowlist.any { glob ->
            when {
                glob.endsWith("/**") -> {
                    val base = parse(glob.dropLast(3))
                    base != null && sameOrigin(uri, base)
                }
                glob.endsWith("**") -> {
                    val prefix = glob.dropLast(2)
                    val base = parse(prefix)
                    base != null &&
                        sameOrigin(uri, base) &&
                        (
                            if (prefix.endsWith('/')) {
                                uri.rawPath.orEmpty().startsWith(base.rawPath.orEmpty())
                            } else {
                                uri.rawPath == base.rawPath
                            }
                        ) &&
                        href.startsWith(prefix)
                }
                else -> href == glob
            }
        }
    }

    fun matchesCallback(value: String?, prefix: String): Boolean {
        val uri = parse(value) ?: return false
        val expected = parse(prefix) ?: return false
        if (
            !isSecureUri(uri) ||
            !isSecureUri(expected) ||
            !uri.scheme.equals(expected.scheme, ignoreCase = true) ||
            uri.rawUserInfo != expected.rawUserInfo ||
            !uri.host.equals(expected.host, ignoreCase = true) ||
            effectivePort(uri) != effectivePort(expected) ||
            uri.rawPath != expected.rawPath ||
            (expected.rawFragment != null && uri.rawFragment != expected.rawFragment)
        ) {
            return false
        }
        val expectedQuery = queryValues(expected) ?: return false
        val candidateQuery = queryValues(uri) ?: return false
        return expectedQuery.all { (key, values) ->
            candidateQuery[key] == values
        }
    }

    private fun isSecureUri(uri: URI): Boolean =
        uri.scheme.equals("https", ignoreCase = true) &&
            !uri.host.isNullOrBlank() &&
            uri.rawUserInfo == null &&
            effectivePort(uri) == 443

    private fun sameOrigin(left: URI, right: URI): Boolean =
        isSecureUri(right) &&
            left.scheme.equals(right.scheme, ignoreCase = true) &&
            left.host.equals(right.host, ignoreCase = true) &&
            effectivePort(left) == effectivePort(right)

    private fun effectivePort(uri: URI): Int =
        if (uri.port == -1 && uri.scheme.equals("https", ignoreCase = true)) 443 else uri.port

    private fun parse(value: String?): URI? {
        if (
            value.isNullOrBlank() ||
            value.any { it.code <= 31 || it.code == 127 } ||
            value.toByteArray(StandardCharsets.UTF_8).size > MAX_URL_BYTES
        ) {
            return null
        }
        return runCatching { URI(value) }.getOrNull()
    }

    private fun queryValues(uri: URI): Map<String, List<String>>? {
        val query = uri.rawQuery ?: return emptyMap()
        if (query.isEmpty()) return emptyMap()
        val result = linkedMapOf<String, MutableList<String>>()
        for (field in query.split('&')) {
            val equals = field.indexOf('=')
            val rawKey = if (equals < 0) field else field.substring(0, equals)
            val rawValue = if (equals < 0) "" else field.substring(equals + 1)
            val key = decode(rawKey) ?: return null
            val value = decode(rawValue) ?: return null
            result.getOrPut(key) { mutableListOf() }.add(value)
        }
        return result
    }

    private fun decode(value: String): String? =
        runCatching {
            URLDecoder.decode(value, StandardCharsets.UTF_8.name())
        }.getOrNull()
}
