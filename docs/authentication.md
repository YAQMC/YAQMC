# Authentication and secret storage

## Current product state

Guest mode remains the startup fallback. QQ and WeChat authorization now open Tencent-hosted OAuth pages in a
restricted, incognito application WebView; live account acceptance is pending. The registered QQ Music callback URL
is intercepted before navigation, its single-use code and CSRF state are validated in Rust, and the code is exchanged
for the normalized QQ Music session. This is still a compatibility integration rather than a supported third-party
QQ Music SDK contract. YAQMC never renders its own password form, reads credentials entered into the hosted page,
copies WebView cookies, or asks the user to paste session data.

The normalized state machine includes guest, restoring, authorization waiting, authenticated,
cancelled/expired/rejected, network/protocol failure, reauthentication-required, and secure-store-unavailable. React
receives only opaque attempt/lease IDs, cadence/expiry, masked profile data, normalized entitlement, capabilities,
and a revision number. The legacy QR projection remains internal compatibility code and is not the selected UI path.

## Secure storage boundary

`CredentialStore` is the only persistence interface for secrets. `PlatformCredentialStore` uses the Rust `keyring`
crate and the operating system's credential service under application service name `org.yaqmc.desktop`.
Existing secrets under the legacy `dev.music-client.desktop` service name are migrated once on read.
There is no plaintext file, SQLite, browser storage, environment-variable, or log fallback.

Secure-store account names are separate:

- `qqmusic-session-staging` — transactional candidate slot
- `qqmusic-session` — reserved serialized provider session
- `local-api-bearer-token` — random 32-byte loopback API token

The local API configuration file contains only `enabled` and `port`. Builds predating this boundary may have a
`token` property; startup attempts a one-time move to the OS store and always removes the plaintext field. If the OS
store is unavailable, listener startup fails closed and the secret is not written back to disk.

## OAuth ownership and session promotion

Only the `main` WebView has the `qqmusic-account` capability, and every Rust command independently checks the caller
label. Desktop Lyrics, Lyrics Island, and the remote OAuth WebView cannot call account commands. The WebView permits
only the exact HTTPS hosts required by the selected QQ or WeChat flow, denies popups, disables autofill/devtools,
uses an incognito profile, and validates the callback origin, path, login type, return URL, unique state, and bounded
code. The visible account dialog renews an opaque native owner lease; closing/reloading the owner, closing or losing
the OAuth WebView, or missing the lease deadline cancels the attempt. Each attempt is bounded to five minutes.

After confirmation, the native service follows a transactional sequence:

1. validate the candidate session;
2. load the prior active record;
3. save and read back the staging record;
4. validate the staged record;
5. save and read back the active record;
6. delete staging and the prior account cache;
7. publish the masked authenticated snapshot.

A single lifecycle mutex serializes promotion, restore, and logout. Generation and opaque-scope checks occur around
awaited storage/network boundaries. Failure before activation clears staging; failure after activation restores and
reads back the prior active value. Logout cancels the generation, removes staging and active records, clears the
account cache and playback epoch, then publishes guest state.

## Native transport boundary

Account traffic uses a dedicated direct client with OS/system proxies disabled, exact HTTPS host/path validation,
explicit cancellation, and no automatic redirects. At most three reviewed redirect hops are followed; every hop is
revalidated. Cross-origin secret headers are stripped, and authenticated body-preserving cross-origin redirects are
rejected. Account writes are never automatically retried. Logs keep only redacted URL/header/body shapes.

## Threat model

OS-backed storage protects secrets at rest from ordinary file inspection and accidental inclusion in backups or
bug reports. It does not defend against malware executing as the same signed-in OS user and able to access that
user's credential service or process memory.

The loopback bearer token prevents unauthenticated local web pages and ordinary processes from using `/v1` by
accident. The API also binds only `127.0.0.1`, does not enable CORS, caps bodies at 16 KiB, compares bearer tokens in
constant time, and exposes no generic command/filesystem endpoint. This is defense in depth, not a sandbox against a
fully compromised user session.

Tracked documentation/fixtures are scanned on Windows and Linux before packaging. Deterministic tests are complete;
no live OAuth code, account profile, cookie, token, playlist name, or response body is committed as evidence.
