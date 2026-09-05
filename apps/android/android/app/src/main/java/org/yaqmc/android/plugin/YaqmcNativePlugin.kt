package org.yaqmc.android.plugin

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.ActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.media3.common.util.UnstableApi
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.ConcurrentHashMap
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import org.json.JSONArray
import org.json.JSONObject
import org.yaqmc.android.BuildConfig
import org.yaqmc.android.OAuthActivity
import org.yaqmc.android.core.CatalogSongDeepLink
import org.yaqmc.android.core.CoreManager
import org.yaqmc.android.core.DeepLinkInbox
import org.yaqmc.android.core.MobileLoginPolicy
import org.yaqmc.android.core.MobileLoginOwner
import org.yaqmc.android.media.PlaybackService
import org.yaqmc.android.update.AndroidUpdateChecker
import org.yaqmc.android.update.AndroidUpdateResult
import org.yaqmc.android.update.YaqmcVersion

@CapacitorPlugin(name = "YaqmcNative")
@UnstableApi
class YaqmcNativePlugin : Plugin(), CoreManager.Callback {
    private class OAuthAttempt(
        val attemptId: String,
        val providerId: String?,
        val completeMethod: String,
        val cancelMethod: String,
        val snapshotMethod: String,
        val heartbeatMethod: String,
    ) {
        @Volatile var ownerLeaseId: String? = null
    }

    private data class CoreEnvelope(
        val result: Any? = null,
        val errorCode: String? = null,
        val errorMessage: String? = null,
        val errorDetails: Any? = null,
        val errorRetryable: Boolean = false,
    ) {
        val ok: Boolean get() = errorCode == null
    }

    private val oauthAttempts = ConcurrentHashMap<String, OAuthAttempt>()
    private val oauthHeartbeatTasks = ConcurrentHashMap<String, Runnable>()
    private val oauthHeartbeatHandler = Handler(Looper.getMainLooper())
    private val updateInFlight = AtomicBoolean(false)
    private var deepLinkSubscription: AutoCloseable? = null

    override fun load() {
        if (!CoreManager.isReady()) {
            CoreManager.initialize(
                context,
                JSONObject()
                    .put("platform", "android")
                    .put("appId", context.packageName)
                    .put("version", BuildConfig.VERSION_NAME)
                    .put("releaseChannel", "android")
                    .put("buildCommit", BuildConfig.YAQMC_BUILD_COMMIT)
                    .put("buildType", BuildConfig.BUILD_TYPE)
                    .toString(),
                this,
            )
        } else {
            CoreManager.addCallback(this)
        }
        deepLinkSubscription = DeepLinkInbox.subscribe(::publishDeepLink)
        checkForUpdates(call = null, automatic = true)
    }

    override fun handleOnDestroy() {
        deepLinkSubscription?.close()
        deepLinkSubscription = null
        oauthHeartbeatTasks.values.forEach(oauthHeartbeatHandler::removeCallbacks)
        oauthHeartbeatTasks.clear()
        oauthAttempts.values.forEach(::cancelOAuth)
        oauthAttempts.clear()
        CoreManager.removeCallback(this)
        super.handleOnDestroy()
    }

    @PluginMethod
    fun invoke(call: PluginCall) {
        val method = call.getString("method")?.takeIf { it.length in 1..128 }
            ?: return call.reject("method is required", "protocol.invalid_params")
        val params = call.getObject("params") ?: JSObject()
        when (method) {
            "host.coreStatus" -> {
                call.resolve(
                    JSObject().put(
                        "value",
                        JSObject().put("status", if (CoreManager.isReady()) "ready" else "down"),
                    ),
                )
            }
            "deep_link_status" -> {
                call.resolve(
                    JSObject().put(
                        "value",
                        JSObject()
                            .put("supported", true)
                            .put("registered", true)
                            .put("error", JSONObject.NULL),
                    ),
                )
            }
            "deep_link_take_pending" -> {
                val pending = DeepLinkInbox.take()
                call.resolve(
                    JSObject().put(
                        "value",
                        pending?.let(::deepLinkObject) ?: JSONObject.NULL,
                    ),
                )
            }
            "host_updater_check" -> checkForUpdates(call, automatic = false)
            "host_updater_download", "host_updater_install" ->
                call.reject("Android updates open GitHub Releases and never install in place", "core.unavailable")
            "qqmusic_auth_oauth_start" -> startOAuth(call, params, providerScoped = false)
            "provider_auth_oauth_start" -> {
                val useQqMusicApp = params.optString("attemptId").isNotBlank() || MobileLoginOwner.hasProvider(params.optString("providerId")) || MobileLoginPolicy.shouldUseQqMusicApp(
                    context.resources.configuration.smallestScreenWidthDp,
                    params.optString("providerId").takeIf(String::isNotBlank),
                    params.optString("methodId").takeIf(String::isNotBlank),
                )
                if (useQqMusicApp) startMobileLogin(call, params) else startOAuth(call, params, providerScoped = true)
            }
            else -> {
                if (PlaybackService.isPlaybackStartMethod(method)) {
                    PlaybackService.prepareRendererPlayback(context, method) { allowed, prepared ->
                        bridge.executeOnMainThread {
                            if (!allowed) {
                                call.reject(
                                    "Android audio focus is unavailable",
                                    "core.command_error",
                                )
                            } else {
                                invokeCore(
                                    call,
                                    method,
                                    params.toString(),
                                    "main",
                                    preparedPlayback = prepared,
                                )
                            }
                        }
                    }
                } else {
                    invokeCore(call, method, params.toString(), "main")
                }
            }
        }
    }

    @PluginMethod
    fun shell(call: PluginCall) {
        val url = call.getString("url")?.let(Uri::parse)
        val valid =
            url != null &&
                when (url.scheme) {
                    "https" -> !url.host.isNullOrBlank() && url.userInfo == null
                    "mailto" -> !url.schemeSpecificPart.isNullOrBlank()
                    else -> false
                }
        if (!valid) return call.reject("only strict https and mailto links are allowed")
        runCatching {
            val intent = Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE)
            startExternalActivity(intent)
            call.resolve()
        }.onFailure { call.reject("unable to open link", it.asException()) }
    }

    @PluginMethod
    fun clipboardSet(call: PluginCall) {
        val text = call.getString("text")?.takeIf { it.length <= 32_768 }
            ?: return call.reject("text is required and must be at most 32768 characters")
        val manager = context.getSystemService(android.content.ClipboardManager::class.java)
        manager?.setPrimaryClip(ClipData.newPlainText("YAQMC", text))
        call.resolve()
    }

    @PluginMethod
    fun nativeShare(call: PluginCall) {
        val text = call.getString("text").orEmpty()
        val url = call.getString("url").orEmpty()
        val payload = listOf(text, url).filter(String::isNotBlank).distinct().joinToString("\n")
        if (payload.isBlank() || payload.length > 32_768) {
            return call.reject("share payload is required and must be at most 32768 characters")
        }
        val title = call.getString("title", "YAQMC")?.take(256) ?: "YAQMC"
        val chooser = Intent.createChooser(
            Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, payload)
                putExtra(Intent.EXTRA_TITLE, title)
            },
            title,
        )
        runCatching {
            startExternalActivity(chooser)
            call.resolve()
        }.onFailure { call.reject("unable to share", it.asException()) }
    }

    @PluginMethod
    fun pickBackgroundImage(call: PluginCall) {
        val request = PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
        val intent = ActivityResultContracts.PickVisualMedia().createIntent(context, request)
        runCatching {
            startActivityForResult(call, intent, "backgroundImageResult")
        }.onFailure {
            call.reject("unable to open the system photo picker", "android.photo_picker_failed", it.asException())
        }
    }

    @ActivityCallback
    private fun backgroundImageResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val selected = ActivityResultContracts.PickVisualMedia()
            .parseResult(result.resultCode, result.data)
        if (selected == null) {
            call.resolve(JSObject().put("path", JSONObject.NULL))
            return
        }
        runCatching { copyPickedImage(selected) }
            .onSuccess { file -> call.resolve(JSObject().put("path", file.absolutePath)) }
            .onFailure {
                call.reject("selected image could not be imported", "android.image_import_failed", it.asException())
            }
    }

    override fun onCoreResponse(id: Long, json: String) = Unit

    override fun onCoreEvent(sequence: Long, channel: String, json: String) {
        bridge.executeOnMainThread {
            notifyListeners(
                "coreEvent",
                JSObject()
                    .put("sequence", sequence)
                    .put("channel", channel)
                    .put("json", json),
            )
        }
    }

    private fun invokeCore(
        call: PluginCall,
        method: String,
        paramsJson: String,
        origin: String,
        preparedPlayback: Boolean = false,
    ) {
        runCatching {
            CoreManager.invoke(
                method = method,
                paramsJson = paramsJson,
                origin = origin,
                onResponse = { json ->
                    bridge.executeOnMainThread {
                        val hydrated = attachManagedBackgroundPath(method, json)
                        if (preparedPlayback && !parseCoreEnvelope(hydrated).ok) {
                            PlaybackService.cancelPreparedRendererPlayback()
                        }
                        resolveCoreEnvelope(call, hydrated)
                    }
                },
            )
        }.onFailure {
            if (preparedPlayback) PlaybackService.cancelPreparedRendererPlayback()
            call.reject("Core invocation failed", "core.unavailable", it.asException())
        }
    }

    private fun startOAuth(call: PluginCall, params: JSObject, providerScoped: Boolean) {
        val providerId = if (providerScoped) {
            params.optString("providerId").takeIf { it.isNotBlank() }
                ?: return call.reject("providerId is required", "protocol.invalid_params")
        } else {
            null
        }
        val prepareMethod: String
        val prepareParams: JSObject
        val completeMethod: String
        val cancelMethod: String
        val snapshotMethod: String
        val heartbeatMethod: String
        if (providerScoped) {
            val methodId = params.optString("methodId").takeIf { it.isNotBlank() }
                ?: return call.reject("methodId is required", "protocol.invalid_params")
            prepareMethod = "provider_auth_oauth_prepare"
            prepareParams = JSObject().put("providerId", providerId).put("methodId", methodId)
            completeMethod = "provider_auth_oauth_complete"
            cancelMethod = "provider_auth_oauth_cancel"
            snapshotMethod = "provider_account_snapshot"
            heartbeatMethod = "provider_auth_heartbeat"
        } else {
            val providerKind = params.optString("loginProvider")
                .takeIf { it == "qq" || it == "wechat" }
                ?: return call.reject("loginProvider must be qq or wechat", "protocol.invalid_params")
            prepareMethod = "auth_oauth_prepare"
            prepareParams = JSObject().put("providerKind", providerKind)
            completeMethod = "auth_oauth_complete"
            cancelMethod = "auth_oauth_cancel"
            snapshotMethod = "qqmusic_account_snapshot"
            heartbeatMethod = "qqmusic_auth_heartbeat"
        }

        runCatching {
            CoreManager.invoke(
                method = prepareMethod,
                paramsJson = prepareParams.toString(),
                origin = "host",
                onResponse = { json ->
                    bridge.executeOnMainThread {
                        val envelope = parseCoreEnvelope(json)
                        if (!envelope.ok) {
                            rejectCoreEnvelope(call, envelope)
                            return@executeOnMainThread
                        }
                        val prepared = envelope.result as? JSONObject
                        val attemptId = prepared?.optString("attemptId")?.takeIf { it.isNotBlank() }
                        val url = prepared?.optString("url")?.takeIf { it.isNotBlank() }
                        val mobileUrl = prepared
                            ?.optString("mobileUrl")
                            ?.takeIf { it.isNotBlank() && it != "null" }
                        val callbackPrefix = prepared
                            ?.optJSONObject("callbackMatcher")
                            ?.optString("urlPrefix")
                            ?.takeIf { it.isNotBlank() }
                        val allowlist = prepared
                            ?.optJSONArray("navigationAllowlist")
                            ?.strings()
                            .orEmpty()
                        val externalNavigationRules = prepared
                            ?.optJSONArray("externalNavigationRules")
                            ?.toString()
                            ?: "[]"
                        if (
                            attemptId == null ||
                            url == null ||
                            callbackPrefix == null ||
                            allowlist.isEmpty()
                        ) {
                            attemptId?.let {
                                cancelOAuth(
                                    OAuthAttempt(
                                        it,
                                        providerId,
                                        completeMethod,
                                        cancelMethod,
                                        snapshotMethod,
                                        heartbeatMethod,
                                    ),
                                )
                            }
                            call.reject("Core returned an invalid OAuth contract", "core.protocol")
                            return@executeOnMainThread
                        }
                        val attempt = OAuthAttempt(
                            attemptId,
                            providerId,
                            completeMethod,
                            cancelMethod,
                            snapshotMethod,
                            heartbeatMethod,
                        )
                        oauthAttempts[call.callbackId] = attempt
                        runCatching {
                            startActivityForResult(
                                call,
                                Intent(context, OAuthActivity::class.java).apply {
                                    putExtra(OAuthActivity.EXTRA_URL, url)
                                    mobileUrl?.let {
                                        putExtra(OAuthActivity.EXTRA_MOBILE_URL, it)
                                    }
                                    putStringArrayListExtra(
                                        OAuthActivity.EXTRA_NAVIGATION_ALLOWLIST,
                                        ArrayList(allowlist),
                                    )
                                    putExtra(
                                        OAuthActivity.EXTRA_EXTERNAL_NAVIGATION_RULES,
                                        externalNavigationRules,
                                    )
                                    putExtra(
                                        OAuthActivity.EXTRA_CALLBACK_PREFIX,
                                        callbackPrefix,
                                    )
                                },
                                "oauthResult",
                            )
                            scheduleOAuthHeartbeat(call.callbackId, attempt, 0L)
                        }.onFailure { error ->
                            oauthAttempts.remove(call.callbackId)
                            stopOAuthHeartbeat(call.callbackId)
                            cancelOAuth(attempt)
                            call.reject(
                                "unable to open OAuth login",
                                "oauth.launch_failed",
                                error.asException(),
                            )
                        }
                    }
                },
            )
        }.onFailure {
            call.reject("OAuth preparation failed", "core.unavailable", it.asException())
        }
    }

    private fun startMobileLogin(call: PluginCall, params: JSObject) {
        if (params.optString("methodId") != MobileLoginPolicy.QQ_LOGIN_METHOD_ID) {
            return call.reject("The mobile authorization method is invalid", "protocol.invalid_params")
        }
        val providerId = params.optString("providerId")
            .takeIf { it == MobileLoginPolicy.QQ_MUSIC_PROVIDER_ID }
            ?: return call.reject("providerId is invalid", "protocol.invalid_params")
        // Reopening the official client must use the QR already displayed and subscribed to.
        invokeOAuthLeaseMethod("provider_account_snapshot", JSObject().put("providerId", providerId)) { envelope ->
            if (!envelope.ok) {
                rejectCoreEnvelope(call, envelope)
                return@invokeOAuthLeaseMethod
            }
            val snapshot = envelope.result as? JSONObject
            val expectedAttempt = params.optString("attemptId").takeIf(String::isNotBlank)
            if (expectedAttempt != null && !MobileLoginPolicy.canReopenAttempt(
                    expectedAttempt, snapshot?.optString("attemptId"), snapshot?.optString("state"),
                )
            ) {
                // A stale reopen button must never create a fresh QR or open an unrelated attempt.
                if (snapshot != null) call.resolve(JSObject().put("value", snapshot))
                else call.reject("The authorization snapshot is unavailable", "core.protocol")
                return@invokeOAuthLeaseMethod
            }
            if (snapshot?.optString("state") in MOBILE_ACTIVE_STATES) {
                if (snapshot != null) {
                    MobileLoginOwner.adopt(snapshot, providerId)
                    launchMobileSnapshot(call, snapshot, providerId)
                }
            } else {
                createMobileLogin(call, providerId)
            }
        }
    }

    private fun createMobileLogin(call: PluginCall, providerId: String) {
        val startParams = JSObject().put("providerId", providerId).put("mobile", true)
        runCatching {
            CoreManager.invoke(
                method = "provider_auth_start",
                paramsJson = startParams.toString(),
                origin = "host",
                onResponse = { json ->
                    bridge.executeOnMainThread {
                        val envelope = parseCoreEnvelope(json)
                        if (!envelope.ok) {
                            rejectCoreEnvelope(call, envelope)
                            return@executeOnMainThread
                        }
                        val snapshot = envelope.result as? JSONObject
                        val attemptId = snapshot
                            ?.optString("attemptId")
                            ?.takeIf(String::isNotBlank)
                        val ownerLeaseId = snapshot
                            ?.optString("ownerLeaseId")
                            ?.takeIf(String::isNotBlank)
                        if (
                            snapshot?.optString("state") !in MOBILE_ACTIVE_STATES ||
                            attemptId == null ||
                            ownerLeaseId == null
                        ) {
                            call.reject(
                                "Core returned an invalid mobile login contract",
                                "core.protocol",
                            )
                            return@executeOnMainThread
                        }

                        launchMobileSnapshot(call, snapshot, providerId)
                    }
                },
            )
        }.onFailure {
            call.reject("Mobile login preparation failed", "core.unavailable", it.asException())
        }
    }

    private fun launchMobileSnapshot(call: PluginCall, snapshot: JSONObject, providerId: String) {
        MobileLoginOwner.adopt(snapshot, providerId)
        val target = MobileLoginPolicy.validateLaunchUrl(snapshot.optString("launchUrl"))
        if (snapshot.optString("state") == "waiting-for-scan" && target != null) {
            val launched = runCatching {
                val payload = JSONObject().put("url", target.authorizationUrl).toString()
                val deepLink = Uri.Builder().scheme("qqmusic").authority("qq.com")
                    .appendPath("ui").appendPath("openUrl").appendQueryParameter("p", payload).build()
                startExternalActivity(
                    Intent(Intent.ACTION_VIEW, deepLink).addCategory(Intent.CATEGORY_BROWSABLE)
                        .setPackage(MobileLoginPolicy.QQ_MUSIC_PACKAGE),
                )
            }.isSuccess
            MobileLoginOwner.log(snapshot.optString("attemptId"), if (launched) "official-app-opened" else "official-app-unavailable", "waiting-for-scan")
        }
        // Neither an Android launch result nor returning to this Activity is authorization proof.
        call.resolve(JSObject().put("value", snapshot))
    }

    @ActivityCallback
    private fun oauthResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val attempt = oauthAttempts.remove(call.callbackId)
            ?: return call.reject("OAuth attempt state was lost", "oauth.state_lost")
        stopOAuthHeartbeat(call.callbackId)
        val callbackUrl = result.data?.data?.toString()
        if (result.resultCode != Activity.RESULT_OK || callbackUrl.isNullOrBlank()) {
            val cancelParams = JSObject().put("attemptId", attempt.attemptId)
            attempt.providerId?.let { cancelParams.put("providerId", it) }
            invokeCore(call, attempt.cancelMethod, cancelParams.toString(), "host")
            return
        }
        val completeParams = JSObject()
            .put("attemptId", attempt.attemptId)
            .put("callbackUrl", callbackUrl)
        attempt.providerId?.let { completeParams.put("providerId", it) }
        invokeCore(call, attempt.completeMethod, completeParams.toString(), "host")
    }

    private fun cancelOAuth(attempt: OAuthAttempt) {
        val params = JSObject().put("attemptId", attempt.attemptId)
        attempt.providerId?.let { params.put("providerId", it) }
        runCatching {
            CoreManager.invoke(
                method = attempt.cancelMethod,
                paramsJson = params.toString(),
                origin = "host",
            )
        }
    }

    /**
     * The renderer's start-login promise stays pending while the native OAuth Activity is open,
     * so the Android host owns the Core lease until that Activity returns.
     */
    private fun scheduleOAuthHeartbeat(
        callbackId: String,
        attempt: OAuthAttempt,
        delayMs: Long,
    ) {
        if (oauthAttempts[callbackId] !== attempt) return
        val task = Runnable { renewOAuthLease(callbackId, attempt) }
        oauthHeartbeatTasks.put(callbackId, task)?.let(oauthHeartbeatHandler::removeCallbacks)
        oauthHeartbeatHandler.postDelayed(task, delayMs)
    }

    private fun stopOAuthHeartbeat(callbackId: String) {
        oauthHeartbeatTasks.remove(callbackId)?.let(oauthHeartbeatHandler::removeCallbacks)
    }

    private fun renewOAuthLease(callbackId: String, attempt: OAuthAttempt) {
        if (oauthAttempts[callbackId] !== attempt) return
        val ownerLeaseId = attempt.ownerLeaseId
        if (ownerLeaseId == null) {
            val params = JSObject()
            attempt.providerId?.let { params.put("providerId", it) }
            invokeOAuthLeaseMethod(attempt.snapshotMethod, params) { envelope ->
                val snapshot = envelope.result as? JSONObject
                val matchingAttempt = snapshot
                    ?.optString("attemptId")
                    ?.takeIf { it == attempt.attemptId }
                val lease = snapshot
                    ?.optString("ownerLeaseId")
                    ?.takeIf { it.isNotBlank() }
                if (envelope.ok && matchingAttempt != null && lease != null) {
                    attempt.ownerLeaseId = lease
                    renewOAuthLease(callbackId, attempt)
                } else {
                    scheduleOAuthHeartbeat(callbackId, attempt, OAUTH_HEARTBEAT_RETRY_MS)
                }
            }
            return
        }

        val params = JSObject()
            .put("attemptId", attempt.attemptId)
            .put("ownerLeaseId", ownerLeaseId)
        attempt.providerId?.let { params.put("providerId", it) }
        invokeOAuthLeaseMethod(attempt.heartbeatMethod, params) { envelope ->
            scheduleOAuthHeartbeat(
                callbackId,
                attempt,
                if (envelope.ok) OAUTH_HEARTBEAT_INTERVAL_MS else OAUTH_HEARTBEAT_RETRY_MS,
            )
        }
    }

    private fun invokeOAuthLeaseMethod(
        method: String,
        params: JSObject,
        onResponse: (CoreEnvelope) -> Unit,
    ) {
        runCatching {
            CoreManager.invoke(
                method = method,
                paramsJson = params.toString(),
                origin = "host",
                onResponse = { json ->
                    bridge.executeOnMainThread { onResponse(parseCoreEnvelope(json)) }
                },
            )
        }.onFailure {
            bridge.executeOnMainThread {
                onResponse(
                    CoreEnvelope(
                        errorCode = "core.unavailable",
                        errorMessage = "Core invocation failed",
                    ),
                )
            }
        }
    }

    private fun resolveCoreEnvelope(call: PluginCall, json: String) {
        val envelope = parseCoreEnvelope(json)
        if (!envelope.ok) {
            rejectCoreEnvelope(call, envelope)
            return
        }
        call.resolve(
            JSObject().put(
                "value",
                envelope.result ?: JSONObject.NULL,
            ),
        )
    }

    private fun rejectCoreEnvelope(call: PluginCall, envelope: CoreEnvelope) {
        val data = JSObject().put("retryable", envelope.errorRetryable)
        envelope.errorDetails?.let { data.put("details", it) }
        call.reject(
            envelope.errorMessage ?: "Core request failed",
            envelope.errorCode ?: "core.internal",
            data,
        )
    }

    private fun parseCoreEnvelope(json: String): CoreEnvelope =
        runCatching {
            val envelope = JSONObject(json)
            if (envelope.optBoolean("ok")) {
                CoreEnvelope(result = envelope.opt("result").takeUnless { it === JSONObject.NULL })
            } else {
                val error = envelope.optJSONObject("error")
                CoreEnvelope(
                    errorCode = error?.optString("code")?.takeIf(String::isNotBlank)
                        ?: "core.internal",
                    errorMessage = error?.optString("message")?.takeIf(String::isNotBlank)
                        ?: "Core request failed",
                    errorDetails = error?.opt("details")?.takeUnless { it === JSONObject.NULL },
                    errorRetryable = error?.optBoolean("retryable", false) ?: false,
                )
            }
        }.getOrElse {
            CoreEnvelope(
                errorCode = "core.protocol",
                errorMessage = "Core returned malformed JSON",
            )
        }

    private fun copyPickedImage(uri: Uri): File {
        val mime = context.contentResolver.getType(uri)
        require(mime == null || mime.startsWith("image/")) { "selected item is not an image" }
        val directory = File(context.cacheDir, "background-imports")
        check(directory.isDirectory || directory.mkdirs()) { "background import directory is unavailable" }
        directory.listFiles()?.forEach { candidate ->
            if (candidate.isFile && candidate.name.startsWith("selected-")) candidate.delete()
        }
        val target = File(directory, "selected-${UUID.randomUUID()}.image")
        try {
            val input = context.contentResolver.openInputStream(uri)
                ?: error("selected image stream is unavailable")
            input.use { source ->
                FileOutputStream(target).use { destination ->
                    val buffer = ByteArray(16 * 1024)
                    var total = 0L
                    while (true) {
                        val read = source.read(buffer)
                        if (read < 0) break
                        total += read
                        require(total <= MAX_BACKGROUND_BYTES) { "selected image exceeds 24 MiB" }
                        destination.write(buffer, 0, read)
                    }
                    require(total > 0) { "selected image is empty" }
                    destination.fd.sync()
                }
            }
            return target
        } catch (error: Throwable) {
            target.delete()
            throw error
        }
    }

    private fun attachManagedBackgroundPath(method: String, json: String): String {
        if (
            method != "preferences_set_background_from" &&
            method != "appearance_background_load"
        ) return json
        return runCatching {
            val envelope = JSONObject(json)
            if (!envelope.optBoolean("ok")) return@runCatching json
            val result = envelope.optJSONObject("result") ?: return@runCatching json
            val reference = result.optString("reference")
            if (!MANAGED_BACKGROUND.matches(reference)) return@runCatching json
            val root = File(context.filesDir, "backgrounds").canonicalFile
            val target = File(context.filesDir, reference).canonicalFile
            if (target.parentFile != root || !target.isFile || target.length() > MAX_BACKGROUND_BYTES) {
                return@runCatching json
            }
            result.put("nativePath", target.absolutePath)
            envelope.toString()
        }.getOrDefault(json)
    }

    private fun publishDeepLink(target: CatalogSongDeepLink) {
        bridge.executeOnMainThread {
            notifyListeners("deepLink", deepLinkObject(target), true)
        }
    }

    private fun checkForUpdates(call: PluginCall?, automatic: Boolean) {
        val preferences = context.getSharedPreferences(UPDATE_PREFERENCES, android.content.Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        if (automatic && now - preferences.getLong(LAST_AUTOMATIC_UPDATE_CHECK, 0L) < UPDATE_INTERVAL_MS) {
            return
        }
        if (!updateInFlight.compareAndSet(false, true)) {
            call?.resolve(JSObject().put("value", updatePayload("checking")))
            return
        }
        if (automatic) preferences.edit().putLong(LAST_AUTOMATIC_UPDATE_CHECK, now).apply()
        publishUpdate(updatePayload("checking"))
        thread(name = "yaqmc-update-check", isDaemon = true) {
            val result = AndroidUpdateChecker(BuildConfig.VERSION_NAME).check()
            bridge.executeOnMainThread {
                updateInFlight.set(false)
                val payload = when (result) {
                    is AndroidUpdateResult.Available -> updatePayload("available").apply {
                        put("version", result.release.versionName)
                        put("releaseUrl", result.release.releaseUrl)
                        if (result.release.notes.isNotBlank()) put("releaseNotes", result.release.notes)
                    }
                    AndroidUpdateResult.NotAvailable -> updatePayload("not-available")
                    is AndroidUpdateResult.Error -> updatePayload("error").put("error", result.message)
                }
                publishUpdate(payload)
                call?.resolve(JSObject().put("value", payload))
            }
        }
    }

    private fun updatePayload(state: String): JSObject {
        val version = YaqmcVersion.parse(BuildConfig.VERSION_NAME)
        return JSObject()
            .put("state", state)
            .put("canInstall", false)
            .put("allowPrerelease", version?.prerelease == true)
            .put("channel", version?.channel ?: "latest")
    }

    private fun publishUpdate(payload: JSObject) {
        notifyListeners("updateAvailable", payload, true)
    }

    private fun deepLinkObject(target: CatalogSongDeepLink) =
        JSObject().put("providerId", target.providerId).put("entityId", target.entityId)

    private fun JSONArray.strings(): List<String> = buildList {
        for (index in 0 until length()) {
            optString(index).takeIf(String::isNotBlank)?.let(::add)
        }
    }

    private fun startExternalActivity(intent: Intent) {
        val hostActivity = activity
        if (hostActivity != null) {
            hostActivity.startActivity(intent)
        } else {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
        }
    }

    private fun Throwable.asException(): Exception =
        this as? Exception ?: RuntimeException(this)

    companion object {
        private val MOBILE_ACTIVE_STATES = setOf("starting-login", "waiting-for-scan", "waiting-for-confirmation")
        private const val OAUTH_HEARTBEAT_INTERVAL_MS = 2_000L
        private const val OAUTH_HEARTBEAT_RETRY_MS = 500L
        private const val MAX_BACKGROUND_BYTES = 24L * 1024L * 1024L
        private const val UPDATE_PREFERENCES = "yaqmc-update"
        private const val LAST_AUTOMATIC_UPDATE_CHECK = "last-automatic-check-ms"
        private const val UPDATE_INTERVAL_MS = 24L * 60L * 60L * 1_000L
        private val MANAGED_BACKGROUND =
            Regex("^backgrounds/custom-background\\.(png|jpg|webp|bmp|gif)$")
    }
}
