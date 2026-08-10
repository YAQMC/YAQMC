# Authentication and secret storage

## Current product state

QQ Music runs in guest mode. Account capability is reported as unavailable because no approved QQ Music
third-party authorization flow was identified for this desktop client. The application does not display a password
form, intercept first-party login, import browser cookies, or persist an unofficial credential.

The normalized account state still supports:

- `guest`
- `authenticated` with a masked account label
- `reauthentication-required`
- `secure-store-unavailable`

This keeps UI and provider boundaries ready for a legitimate browser/QR authorization callback without pretending
one exists today.

## Secure storage boundary

`CredentialStore` is the only persistence interface for secrets. `PlatformCredentialStore` uses the Rust `keyring`
crate and the operating system's credential service under application service name `org.yaqmc.desktop`.
Existing secrets under the legacy `dev.music-client.desktop` service name are migrated once on read.
There is no plaintext file, SQLite, browser storage, environment-variable, or log fallback.

Current secure-store accounts are separate:

- `qqmusic-session` — reserved serialized provider session
- `local-api-bearer-token` — random 32-byte loopback API token

The local API configuration file contains only `enabled` and `port`. Builds predating this boundary may have a
`token` property; startup attempts a one-time move to the OS store and always removes the plaintext field. If the OS
store is unavailable, listener startup fails closed and the secret is not written back to disk.

## Future QQ authorization flow

A legitimate integration must satisfy all of the following before `account` capability becomes true:

1. use an approved QQ/Tencent authorization surface and callback owned by this application;
2. validate state/nonce and exact redirect origin;
3. exchange short-lived authorization material only in the native process;
4. store the minimum refresh/session secret through `CredentialStore`;
5. add session material only to allowlisted QQ Music requests;
6. detect explicit expiry and provider authentication errors, then transition to
   `reauthentication-required` without retry loops;
7. make sign-out delete secure storage and invalidate in-memory session state;
8. never expose cookies, refresh tokens, vkeys, or signed media URLs to React, the local API, telemetry, or logs.

Password capture and first-party cookie scraping are not acceptable substitutes.

## Threat model

OS-backed storage protects secrets at rest from ordinary file inspection and accidental inclusion in backups or
bug reports. It does not defend against malware executing as the same signed-in OS user and able to access that
user's credential service or process memory.

The loopback bearer token prevents unauthenticated local web pages and ordinary processes from using `/v1` by
accident. The API also binds only `127.0.0.1`, does not enable CORS, caps bodies at 16 KiB, compares bearer tokens in
constant time, and exposes no generic command/filesystem endpoint. This is defense in depth, not a sandbox against a
fully compromised user session.
