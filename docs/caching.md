# Persistence and caching

> [简体中文](zh-CN/caching.md) | **English**

`StorageService` separates durable structured state from disposable response files.

## SQLite

The platform application-data directory contains `library.sqlite3`. Migrations use SQLite `user_version`; WAL and
foreign keys are enabled at open. Current tables cover:

- provider metadata/lyrics JSON with expiry
- file-cache index and LRU timestamps
- application settings
- recent searches (bounded to 100)
- playback history (bounded to 2,000)
- one persisted queue/player snapshot
- account pages and one complete account-library projection under an opaque per-session scope

Provider cache entries are bounded to 5,000 rows. Home/search metadata uses a 15-minute TTL, album/playlist entities
24 hours, and lyrics 30 days. Account favorites use a two-minute TTL; account playlists, playlist detail, and recent
history use five minutes. During a provider outage, eligible reads may return an expired coherent value explicitly
marked stale. Authentication expiry never falls back to stale account data. Media URLs and secrets are never stored
in SQLite.

Every authenticated session receives a cryptographically random opaque cache scope. Keys contain that scope plus
hashed outward cursors, never UIN, raw provider cursors, or credentials. Provider cursors live only in a bounded
in-memory registry tied to the current auth generation/resource. After restart, a cached nonterminal first page is
refetched before a new outward cursor is issued; offline stale pages are terminal. Full refreshes accumulate pages
in an epoch and atomically replace the complete favorites/playlist projection. Logout or account replacement deletes
the entire `qqmusic-account` cache kind.

## File caches

The platform cache directory contains indexed `media/` and `artwork/` files:

| Kind    | Total limit | Per-file limit | Eviction            |
| ------- | ----------: | -------------: | ------------------- |
| media   |     256 MiB |        128 MiB | least recently used |
| artwork |      64 MiB |          5 MiB | least recently used |

At most four downloads run concurrently. Cache filenames are SHA-256 digests of stable provider/media identity,
not signed URLs. Downloads stream to a random `.part` file, enforce both advertised and observed size, flush, and
atomically rename. A failed stream or database update removes its partial/target file. Startup removes abandoned
`.part` files.

All paths recorded in SQLite are validated as safe relative cache paths before read, eviction, or deletion. Cache
clear removes only indexed, validated files and provider response rows; it does not remove settings, history, queue
state, or OS-stored secrets.

Artwork is fetched only from allowlisted HTTPS hosts, cached as bytes, and returned to the renderer as a data URI.
The frontend adds a small in-memory promise cache to coalesce concurrent requests and ignores results after an
aborted view.

## Playback trade-off

Range-capable sources now use a bounded sparse cache: playback can start after the first 512 KiB segment,
decoder-requested seeks outrank three-segment read-ahead, and overlapping readers share segment work. Exact
200/206/416 validation prevents corrupt sparse files. A completed sparse source is atomically promoted into the
normal provider-aware media cache. Servers without reliable Range behavior retain the bounded full-download path.
Signed URL expiry is refreshed once, and neither URL nor account scope becomes a stable filename.

The trade-off is additional range coordination and host-dependent startup behavior in exchange for lower startup
latency and avoiding a mandatory full transfer for short listens. Both paths retain per-file/total limits,
cancellation, safe relative paths, and atomic completion.

## Operational controls

Settings reports media/artwork bytes and entry counts plus metadata/lyric counts. **Clear cache** is immediately
effective for disposable content; subsequent catalog or playback requests repopulate it. Queue and preference
state survive restarts independently of cache eviction.
