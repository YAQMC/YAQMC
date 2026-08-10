# Persistence and caching

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

Provider cache entries are bounded to 5,000 rows. Home/search metadata uses a 15-minute TTL, album/playlist entities
24 hours, and lyrics 30 days. During a provider outage, entity/home reads may return an expired coherent value as a
stale fallback. Media URLs and secrets are never stored in SQLite.

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

Artwork is fetched only from allowlisted HTTPS hosts, cached as bytes, and returned to the WebView as a data URI.
The frontend adds a small in-memory promise cache to coalesce concurrent requests and ignores results after an
aborted view.

## Playback trade-off

The current media preparer completes the bounded disk download before decode. Advantages are deterministic seek,
simple expiry handling, stable decoder input, and no unbounded memory buffer. Costs are startup latency, full file
transfer for a short listen, and disk pressure.

Progressive Range-backed playback is the next performance step. It must remain bounded, verify Range behavior,
support random access for seeks, coordinate overlapping reads, and retain the one-time URL refresh rule. Until that
exists, the UI's `loading` and `buffering` states represent source resolution and complete preparation rather than a
claim of progressive startup.

## Operational controls

Settings reports media/artwork bytes and entry counts plus metadata/lyric counts. **Clear cache** is immediately
effective for disposable content; subsequent catalog or playback requests repopulate it. Queue and preference
state survive restarts independently of cache eviction.
