package org.yaqmc.android

import android.app.Application
import org.yaqmc.android.core.CoreManager
import org.json.JSONObject

class YaqmcApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        CoreManager.initialize(
            context = this,
            buildJson = JSONObject()
                .put("platform", "android")
                .put("appId", packageName)
                .put("version", BuildConfig.VERSION_NAME)
                .put("releaseChannel", "android")
                .put("buildCommit", BuildConfig.YAQMC_BUILD_COMMIT)
                .put("buildType", BuildConfig.BUILD_TYPE)
                .toString(),
        )
    }
}
