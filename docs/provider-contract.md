# Music provider contract

`MusicProvider` exposes public catalog operations rather than upstream payloads:

- home feed and guest library snapshot
- paginated search
- album and playlist/toplist lookup
- normalized lyrics

`AccountMusicProvider` is a separate runtime-checked extension for account snapshot/QR lifecycle, favorites,
account playlists, recent history, and typed mutations. Public Home/Search/Explore code depends only on
`MusicProvider`; enabling account features cannot make catalog rendering require a session.

All values crossing into React use `src/domain/music.ts`. Song identity distinguishes the provider track MID,
numeric song ID, album MID/ID, and media MID; those identifiers are not treated as interchangeable.

## Normalized playback metadata

A song may include:

- `audioFormats`: codec, nominal quality/bitrate, sample rate, bit depth, and lossless flag when known
- `playbackCapability`: full, bounded official preview, or unavailable
- `availability`: available, unavailable, or entitlement required
- `provider`: stable provider ID plus opaque IDs needed by the native resolver

Catalog quality is not proof of entitlement. The native resolver requests a legitimate URL at play time and maps
the provider response into full/preview/unavailable without exposing the URL to the frontend.

## Implementations

### QQMusicProvider

The desktop default is a thin Tauri adapter. Rust owns HTTP, response parsing, artwork caching, lyrics decryption,
source signing, secret storage, and error mapping. Abort signals prevent stale React results from winning after a
new query even though an already-dispatched native command cannot cancel its underlying HTTP request.

Public capabilities include search, album and artist metadata, playlist/toplist read, lyrics, word-timed lyrics,
streaming, and quality selection. The native adapter also implements the account extension. Its capability snapshot
is session-derived: QR login is exposed only to the main WebView; favorites and owned-playlist operations require an
authenticated account; recent history is called only when the provider advertises it. Status remains
`implemented; live account acceptance pending` until the explicit QR acceptance gate completes.

### FakeMusicProvider

The fake provider remains a permanent deterministic sibling. It deep-clones fixtures, supports cancellation and
typed missing-entity failures, and covers every lyric renderer state. It is used by browser development, unit tests,
screenshots, and offline provider-independent UI work.

## Error contract

Provider errors include a stable `code`, restrained user-facing `message`, and `retryable` flag. Network outage,
timeout, and rate limiting are retryable; authentication expiry, entitlement, missing items, malformed data, and
schema changes are not blindly retried. Pages must keep the last coherent content when possible and must ignore
responses belonging to an obsolete query or route.

Raw DTOs, cookie headers, signed URLs, upstream lyric syntax, and cache paths must never enter this contract.
Account mutations return only `applied`, `rejected`, `reconciled`, or `outcome-unknown`; a timeout is not presented
as success until an operation-specific read confirms it. See [QQ Music provider](qqmusic-provider.md) and
[account library](account-library.md) for the current compatibility surface.
