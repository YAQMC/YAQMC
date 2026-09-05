package org.yaqmc.android.update

import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import org.json.JSONArray

internal data class YaqmcVersion(
    val major: Int,
    val minor: Int,
    val patch: Int,
    val channel: String?,
    val serial: Int,
) : Comparable<YaqmcVersion> {
    override fun compareTo(other: YaqmcVersion): Int =
        compareValuesBy(this, other, YaqmcVersion::major, YaqmcVersion::minor, YaqmcVersion::patch)
            .takeIf { it != 0 }
            ?: compareValues(stageRank(channel), stageRank(other.channel)).takeIf { it != 0 }
            ?: compareValues(serial, other.serial)

    val prerelease: Boolean get() = channel != null

    companion object {
        private val PATTERN = Regex(
            "^v?(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(alpha|beta|rc)\\.(0|[1-9]\\d*))?$",
        )

        fun parse(raw: String): YaqmcVersion? {
            val value = raw.removeSuffix("-debug")
            val match = PATTERN.matchEntire(value) ?: return null
            return runCatching {
                YaqmcVersion(
                    match.groupValues[1].toInt(),
                    match.groupValues[2].toInt(),
                    match.groupValues[3].toInt(),
                    match.groupValues[4].ifBlank { null },
                    match.groupValues[5].ifBlank { "0" }.toInt(),
                )
            }.getOrNull()
        }

        private fun stageRank(channel: String?): Int = when (channel) {
            "alpha" -> 1
            "beta" -> 2
            "rc" -> 3
            null -> 9
            else -> 0
        }
    }
}

internal data class ReleaseCandidate(
    val version: YaqmcVersion,
    val versionName: String,
    val prerelease: Boolean,
    val releaseUrl: String,
    val notes: String,
)

internal sealed interface AndroidUpdateResult {
    data class Available(val release: ReleaseCandidate) : AndroidUpdateResult
    data object NotAvailable : AndroidUpdateResult
    data class Error(val message: String) : AndroidUpdateResult
}

internal fun selectUpdate(
    current: YaqmcVersion,
    candidates: List<ReleaseCandidate>,
): ReleaseCandidate? = candidates
    .asSequence()
    .filter { candidate ->
        candidate.version > current &&
            candidate.prerelease == candidate.version.prerelease &&
            if (current.prerelease) {
                candidate.prerelease && candidate.version.channel == current.channel
            } else {
                !candidate.prerelease && !candidate.version.prerelease
            }
    }
    .maxByOrNull(ReleaseCandidate::version)

internal class AndroidUpdateChecker(
    private val currentVersion: String,
) {
    fun check(): AndroidUpdateResult {
        val current = YaqmcVersion.parse(currentVersion)
            ?: return AndroidUpdateResult.Error("The installed version is not valid SemVer")
        return runCatching {
            val releases = fetchReleases()
            selectUpdate(current, releases)
                ?.let(AndroidUpdateResult::Available)
                ?: AndroidUpdateResult.NotAvailable
        }.getOrElse {
            AndroidUpdateResult.Error("GitHub Releases could not be reached")
        }
    }

    private fun fetchReleases(): List<ReleaseCandidate> {
        val connection = URL(RELEASES_API).openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "GET"
            connection.connectTimeout = 10_000
            connection.readTimeout = 10_000
            connection.instanceFollowRedirects = false
            connection.setRequestProperty("Accept", "application/vnd.github+json")
            connection.setRequestProperty("X-GitHub-Api-Version", "2026-03-10")
            connection.setRequestProperty("User-Agent", "YAQMC-Android/$currentVersion")
            check(connection.responseCode == HttpURLConnection.HTTP_OK) {
                "GitHub Releases returned HTTP ${connection.responseCode}"
            }
            val body = connection.inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
                val text = reader.readText()
                require(text.length <= MAX_RESPONSE_CHARS) { "GitHub Releases response is too large" }
                text
            }
            parseReleases(JSONArray(body))
        } finally {
            connection.disconnect()
        }
    }

    private fun parseReleases(array: JSONArray): List<ReleaseCandidate> = buildList {
        for (index in 0 until array.length()) {
            val release = array.optJSONObject(index) ?: continue
            if (release.optBoolean("draft")) continue
            val tag = release.optString("tag_name")
            val version = YaqmcVersion.parse(tag) ?: continue
            val prerelease = release.optBoolean("prerelease")
            val releaseUrl = release.optString("html_url").takeIf(::isOfficialReleaseUrl) ?: continue
            add(
                ReleaseCandidate(
                    version = version,
                    versionName = tag.removePrefix("v"),
                    prerelease = prerelease,
                    releaseUrl = releaseUrl,
                    notes = release.optString("body").take(MAX_NOTES_CHARS),
                ),
            )
        }
    }

    companion object {
        private const val RELEASES_API =
            "https://api.github.com/repos/YAQMC/YAQMC/releases?per_page=30&page=1"
        private const val MAX_RESPONSE_CHARS = 2 * 1024 * 1024
        private const val MAX_NOTES_CHARS = 4_000

        private fun isOfficialReleaseUrl(value: String): Boolean = runCatching {
            val uri = URI(value)
            uri.scheme == "https" &&
                uri.host.equals("github.com", ignoreCase = true) &&
                uri.port == -1 &&
                uri.userInfo == null &&
                uri.path.startsWith("/YAQMC/YAQMC/releases/")
        }.getOrDefault(false)
    }
}
