# Playback contract

> [简体中文](zh-CN/playback.md) | **English**

`PlayerService` in `crates/yaqmc-core/src/player.rs` is the authoritative desktop player. It owns the queue, selected
track, actual engine position and duration, lifecycle state, repeat/shuffle semantics, volume/mute, current lyrics,
and structured playback failure.

## Native engine

`RodioAudioEngine` runs on a dedicated thread. The worker owns the CPAL output stream and Rodio `Player`, accepts
load/play/pause/stop/seek/volume/device-list commands, and exposes an immutable snapshot. The application remains
usable with `UnavailableAudioEngine` when no output device can be opened.

Enabled decoder/container paths are:

| Provider format | Engine format        | Status                                                  |
| --------------- | -------------------- | ------------------------------------------------------- |
| MP3             | MP3                  | enabled and exercised with a live QQ track              |
| AAC in MP4/M4A  | AAC                  | enabled; not yet exercised in the native acceptance run |
| FLAC            | FLAC                 | enabled; lossless selection is opt-in                   |
| QQ mflac        | streamed FLAC        | enabled for account-authorized URL + ekey sources       |
| PCM WAV         | WAV                  | enabled and exercised by the deterministic native test  |
| ALAC            | domain metadata only | not emitted or claimed as supported                     |

The clock polls the engine every 50 ms. UI/SSE position publication is capped at four events per second, while
line/word lyric events occur only when the cursor changes. Pause, seek, end-of-stream, and output errors are read
from the engine; there is no native frontend timer.

## Load state machine

```text
idle/stopped/ended
        |
     loading       resolve fresh provider source
        |
    buffering      initial range/cache + decode
        |
     playing <----> paused
        |
      ended ------> repeat/next/idle

any stage -------> recoverable-error or fatal-error
```

Every load gets a generation ID. A completion from an older generation is ignored, which prevents a slow request
from replacing a newer selection. A source URL that returns 401/403/404/410 is classified as expired and resolved
once more. The retry count is deliberately bounded at one. Queue progression skips failed tracks only within one
bounded pass through the queue.

## Playback session and seek coalescing

Each time the authoritative current queue entry is loaded, `PlayerService` starts a new `sessionId`. Async source
resolution, decoder load, HTTP Range work, quality fallback, URL recovery, position ticks, EOS, and lyric
projection all carry that session (and a `sourceGeneration` on the audio engine). A result from session 41 must
not mutate session 42, even when both entries are the same song ID.

Within a session, seek intents use a latest-wins mailbox (`lastSeekRevision`). Rapid progress-bar drags do not
enqueue an unbounded FIFO of native seeks: the frontend previews locally while the pointer is down, the command
adapter coalesces in-flight seeks, and the Rodio worker keeps a single pending seek slot. Control commands such as
Play/Pause/Next/Stop are not queued behind hundreds of Seek entries. Pointer-up commits the final position; an
older seek completion cannot restore an earlier time or the previous track.

Player snapshots also carry a monotonic `snapshotRevision`. The React projection ignores an older session, or an
older revision in the same session, so a lagged `player://snapshot` event cannot roll the Player Bar or Lyrics
surface back to a previous song. If the UI event subscriber lags, it resynchronizes from the authoritative
snapshot instead of exiting.

Repeat One still reloads the current queue entry on a current-session EOS. A stale EOS from before a seek or track
change is ignored. Shuffle traversal and history are orthogonal to seek.

Account-bound QQ Music sources additionally carry a nonserializable playback epoch guard. The guard contains only
an opaque account scope, auth generation, cancellation token, and a shared epoch clock. It is checked after provider
resolution, around media preparation, inside synchronous decoder/load and play operations, and immediately before
the authoritative Playing commit. Logout or account replacement cancels the old token and clears/replaces the clock
before the old source can resume. The audio worker also drops a loaded source when its guard becomes stale.

Only `sourceSelection` crosses the native/frontend boundary. It contains requested and resolved quality, a typed
fallback reason, and the preview flag; it never contains a URL, vkey, cookie, cache scope, signature, or guard.

The selected source may describe a preview timeline. `timelineOffsetMs` maps engine time to the song timeline and
`timelineEndMs` limits the available preview. `playbackDurationMs` reports the decoded source duration separately
from catalog `durationMs`.

## Source preparation and seeking

Range-capable HTTP sources are exposed as a sparse, progressively filled `Read + Seek` source. Rodio can initialize
after the first 512 KiB range; a missing seek range is prioritized over three-segment read-ahead. Exact 200/206/416
handling, cancellation, URL-expiry recovery and cache promotion are documented in [streaming](streaming.md).
Servers without reliable Range support retain the bounded atomic full-download path.

## Account entitlement projection

Preferred quality is a request, not proof of rights. The QQ resolver intersects the catalog formats, normalized
account entitlement, and the live vkey/evkey response before the existing media path runs. Automatic selects the
highest entitled available full source; explicit High/Lossless/Master preferences may fall back with a typed
`account-rights`, `source-unavailable`, or `preview-only` reason. Unknown/failed entitlement validation is
conservative and permits only Standard. The PlayerBar selector is scoped to the current song and reloads it at the
same position/play state; the Settings preference remains the default for later songs. See
[entitlement](entitlement.md) for the matrix.

Paid catalog rows are queue-admissible when they require account resolution: catalog metadata alone cannot know the
current secure-session entitlement. The resolver remains the authoritative allow/fallback/deny boundary. Rows the
provider explicitly marks unavailable (for example a removed-copyright item) are still rejected before resolution.

The account layer does not introduce a second player. It supplies a guarded source to the same `PlayerService`,
Range/cache path, Rodio worker, queue, lyrics clock, MPRIS/SMTC adapters, and tray controls. The loopback local API
continues to expose player operations only and never account/session data.

## Queue semantics

- `playTracks` replaces the queue and selects a requested playable ID.
- Removing the active item selects and loads the correct successor; it never continues stale audio.
- `previous` restarts the current track after the normal threshold, otherwise selects the previous queue item.
- The player bar exposes three exclusive modes — Sequential, Shuffle, and Repeat One — as a projection of
  `PlaybackOrder` + `RepeatMode`. Repeat All remains a first-class repeat value for the HTTP API, MPRIS
  `LoopStatus=Playlist`, persistence, and an advanced menu row; it is not a fourth primary mode.
- Selecting Sequential or Shuffle sets `repeat=off`. Repeat One keeps the previous order so leaving it restores
  Sequential or Shuffle without rebuilding the shuffle traversal. Mode changes do not restart the current track.
- Repeat One reloads the current queue entry at position 0 on engine end-of-stream; explicit Next/Previous still
  advance. The current track is not duplicated in the queue list.
- repeat-all wraps; shuffle chooses from valid queue indices.
- engine end-of-stream, not catalog duration arithmetic, triggers automatic advancement.
- queue, selected index, playback state, position, volume, mute, repeat, shuffle, and error state are restored from
  SQLite. A restored track remains paused until explicitly resumed.

Core protocol methods, the Electron renderer bridge, synchronized lyrics, the React projection, and the loopback
HTTP API all use this contract.
