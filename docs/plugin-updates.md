# Plugin updates

YAQMC treats a plugin update as a replacement of an installed package, not as a second install. The host first fixes the package bytes and the current installation generation, scans and validates the candidate, then waits for the target plugin to be idle before stopping that plugin. A failed validation or startup leaves the previous package active. The transaction journal and immutable `packages/<sha256>` directory make recovery idempotent after a process exit.

The installed plugin ID is stable. A release has a strict SemVer version, `stable`, `beta`, or `nightly` channel, a display-only build ID, a monotonic release sequence, and the SHA-256 of the package. Equal hashes are a no-op. Equal versions with different hashes are explicitly labelled **same-version replacement**; downgrades, channel changes, new permissions, and provider/session changes require confirmation. An old version string that is not SemVer remains loadable but cannot be ordered automatically.

Remote updates are opt-in per plugin. A release publisher signs the original UTF-8 JSON payload bytes with Ed25519. The host accepts a feed only when its plugin ID, HTTPS feed, key, download origins, expiry, sequence and release signatures match an embedded trusted-source record. `crates/yaqmc-core/src/plugin/updates/sources.json` is intentionally empty in this release, so the UI says **暂无远程更新源 / No remote update source configured** until a publisher is shipped in a later YAQMC update. A plugin manifest cannot add a trusted source.

Use the publisher helper for local signing and verification:

```text
node scripts/plugin-release.mjs sign feed feed.json publisher-private.pem publisher-key feed.envelope.json
node scripts/plugin-release.mjs verify feed feed.envelope.json publisher-public.pem publisher-key
node scripts/plugin-release.mjs hash plugin.yaqmc-plugin
```

The update screen shows the candidate hash, source and key, channel, permissions, session handling, playback impact and the last result. **Update later** waits until the target has held no playback source, login flow, settings edit, bridge call or provider request for the required idle window. **Stop using and update** only stops that plugin's playback source; it does not stop unrelated providers. Local packages are supported through the same preparation and transaction path, but an unverified local replacement pauses automatic updates until the source is confirmed.

Credentials stay in the existing credential backend. Component KV and cache are staged; ordinary settings are retained. A durable journal and an atomic installation pointer provide recovery across these files; this is not one atomic filesystem operation across all data. A changed provider ID or `sessionSchemaVersion` creates a new session namespace and does not inherit old secrets; old data remains available for recovery. A provider must declare session format changes accurately. The host never writes third-party accounts during candidate validation.

The update methods are host/main-window only: `plugin_update_policy_get/set`, `plugin_update_check`, `plugin_update_prepare`, `plugin_update_apply`, `plugin_update_status`, `plugin_update_cancel`, `plugin_update_runtime_ready`, and `plugin_update_editing`. Long operations return an `operationId` and emit `plugin://update-progress`. Plugins, lyrics windows and local HTTP callers cannot invoke these methods.

`plugin_update_prepare` also accepts a plugin store asset (`github: { owner, repo, releaseId, assetId }`); see [Plugins page and plugin store](plugin-store.md). Store packages are reviewed as unverified sources, record `github:<owner>/<repo>/releases/<id>` as their source, require a `source-change` confirmation when they replace a plugin ID that came from elsewhere, and never become trusted update sources.

## Publisher compatibility

Publishers should include `release`, keep the plugin ID and provider IDs stable, increment `releaseSequence` for every published content change, and update `sessionSchemaVersion` whenever old credentials or KV cannot be read safely. A hotfix with the same version is valid, but users must approve it. Publish packages with deterministic bytes so the SHA-256 identifies the exact installed content. Release records must bind plugin ID, version, channel, build ID, sequence, size, URL and SHA-256 in the signed payload.

This document describes the host feature and local signed test service. It does not claim that a production remote feed is online.

## Signed wire format (schema 1)

All payloads are UTF-8 JSON without a BOM. The envelope contains exactly `keyId`, `payload`, and `signature`; the last two use standard padded Base64, not Base64URL. The payload is decoded once and its original bytes are verified. Whitespace and property order are significant to the signature. Neither side reserializes a payload before verification.

An individual release payload has **flat** release fields:

```json
{
  "pluginId": "org.example.music",
  "version": "1.2.0",
  "channel": "stable",
  "buildId": "20261027.1",
  "releaseSequence": 17,
  "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "size": 123456,
  "url": "https://releases.example.org/music-1.2.0.yaqmc-plugin"
}
```

The signature message is the UTF-8 bytes `YAQMC-PLUGIN-RELEASE-v1` followed by one zero byte, followed by the raw release payload. The feed payload is:

```json
{
  "schemaVersion": 1,
  "pluginId": "org.example.music",
  "sequence": 42,
  "expiresAtMs": 1800000000000,
  "releases": [
    {
      "keyId": "publisher-2026",
      "payload": "<base64 release bytes>",
      "signature": "<base64 signature>"
    }
  ]
}
```

The feed uses `YAQMC-PLUGIN-FEED-v1`, one zero byte, and the raw feed payload. Serve the signed **feed envelope**, not the unsigned payload. Both signatures are Ed25519 (32-byte public key, 64-byte signature). Integers must be positive JavaScript safe integers; `expiresAtMs` is a Unix millisecond timestamp strictly in the future. A feed may contain at most 256 releases. Feed and release sequences must not be reused for different content; sequences span channels. The host remembers high-water marks even when the user changes sources. Expired metadata is rejected again before installation.

The embedded trusted source contains `id`, `pluginId`, `name`, `repository`, `feedUrl`, `keyId`, `publicKey` (raw 32 bytes in Base64), and `downloadOrigins` (exact HTTPS origins including a non-default port). A changed key, URL or source requires a YAQMC release and renewed user confirmation; a package cannot supply this authority. The package's optional `release` object contains `channel`, `buildId`, and `releaseSequence`. If present, all three must match the signed record.

Publisher sequence:

```text
node scripts/plugin-release.mjs hash music-1.2.0.yaqmc-plugin
node scripts/plugin-release.mjs public-key publisher-public.pem
node scripts/plugin-release.mjs sign release release.json publisher-private.pem publisher-2026 release.envelope.json
node scripts/plugin-release.mjs verify release release.envelope.json publisher-public.pem publisher-2026
```

Place the resulting release envelope in `feed.json.releases`, increment the feed sequence and set its expiry, then run the `sign feed` and `verify feed` commands above. Output files must not already exist. Keep private keys outside the repository. The deterministic cross-language fixture in `crates/yaqmc-core/tests/fixtures/plugin-release-vector.json` uses a public test key and must never be trusted in production. The verification helper checks cryptographic integrity; the host additionally enforces trust, expiry, replay, URL, package and compatibility rules.

## Transport and recovery

The Rust updater uses system proxy settings and a dedicated client without provider cookies, bearer tokens, or authorization headers. Every redirect (maximum three) must remain HTTPS and within the relevant origin allowlist; private, loopback, link-local and transition-address targets are rejected. The proxy is part of the user's network trust boundary. There are at most two concurrent package downloads, a 10-second connection timeout, a 30-second no-data timeout and a five-minute package timeout. The whole signed feed is limited to 1 MiB. Existing package quotas still apply (8 MiB compressed for legacy packages, 32 MiB for components, plus existing file-count and expanded-size quotas). Package bytes stream to disk and into SHA-256. Cancellation removes the partial download.

`prepared` is a fixed review, not permission to reopen an arbitrary path. Applying accepts only its operation ID, explicit grants and confirmations. A changed installation generation, permissions or policy invalidates that review. Updates, enable/disable, uninstall and settings writes share a per-plugin lifecycle lock; actual installation is globally serial. Preparation and compilation leave the previous plugin running. Only the affected worker/providers are stopped.

The automatic path requires a trusted higher SemVer in the selected channel, unchanged session identity, no new permissions, and 30 seconds continuously idle, including paused playback-source ownership. Startup checks are delayed 30 seconds; successful checks recur after 24 hours, failures back off to at most one hour. A failed installation release is not automatically retried until a different signed release appears; a user can prepare it again. Manual updates may wait or explicitly stop the target plugin's playback and login. Once quiescing begins, cancellation is refused so commit or recovery can finish.

Before commit, failures restore the previous package, enabled state, grants and local data. After the durable commit marker, failures retain the new package and finish cleanup on restart. `update-committed-restart-required`, `update-committed-cleanup-pending` and `update-recovery-required` require a restart; an incomplete recovery blocks further mutations for that plugin. A corrupt policy disables remote checking without discarding replay history or blocking local replacement. Unverified local replacement retains source configuration but requires rebinding before automatic updates resume.

SDK `activate` may return a promise. Resolve it after local initialization; rejection or failure to become ready within the host timeout rolls back. During validation only local storage, settings reads, logging and UI registration are available; UI effects are held until commit. Do not require outbound account operations to complete activation. Sessions restore after commit, and expired login/network failures do not roll back or erase credentials. No custom migration script runs. The transaction covers host-local state and cannot undo third-party service changes.
