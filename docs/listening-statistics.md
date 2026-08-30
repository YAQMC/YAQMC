# Listening statistics

> [简体中文](zh-CN/listening-statistics.md) | **English**

YAQMC calculates listening statistics locally from the Core playback engine. It does not upload these records or
call a music-provider analytics endpoint. Open **Statistics** in the application sidebar to choose a rolling 7-day,
30-day, 365-day, or all-time view.

## What is counted

The recorder advances only when the same playback session is in `playing` state and the engine position moves
forward normally. Pausing, buffering, seeking, source recovery, and wall-clock time do not add listening time.

A session is qualified after the earlier of 30 seconds or half of its known playable duration. An official preview
uses its actual playable duration. Reaching the engine's end-of-stream is an authoritative completion even when the
threshold was not reached. Before the threshold, an explicit next/jump is a skip, while queue replacement, shutdown,
or stop is recorded as stopped. A fatal playback error is recorded separately unless the session had already
qualified. Repeat One creates a new completed record for every end-of-stream cycle.

The page reports qualified listening time, qualified plays, completions, skip rate, daily trend, top songs/artists/
albums, resolved audio quality, and provider distribution. `playback_history` remains the bounded recent-song cache;
statistics use a separate `listening_sessions` dataset.

## Export and deletion

**Export JSON** produces a versioned document containing the current summary and its session records. **Export CSV**
contains one summary row followed by session rows. The native save dialog authorizes one exact destination, format,
and renderer window for a single export; the renderer cannot use this flow to write an arbitrary path.

**Clear statistics** requires a second confirmation and deletes only listening-statistics rows. Preferences, account
library data, provider caches, the current queue, and recent playback snapshots are preserved. Clearing while a song
is active starts a new zeroed statistics record so pre-clear time cannot reappear.

The SQLite database and its active WAL/SHM sidecars are included in the displayed database size. See
[data locations](data-locations.md) for the platform-specific application-data directory.

## Contributor contract

Statistics are owned by Core and exposed through typed `statistics_snapshot`, `statistics_clear`, and the
dialog-split `statistics_export_to` continuation. The renderer listens for throttled `statistics.changed` events on
the existing `api://event` channel. Provider implementations and the Electron host must not infer plays or duplicate
upstream routes.

Recorder work per player event is O(1). Range aggregation scans qualifying local rows and uses indexes for end time,
provider/track, album, and artist lookup. The automated storage gate exercises the aggregate query with 100,000
sessions.
