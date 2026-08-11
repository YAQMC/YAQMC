# Playback contract

`PlayerService` in `src-tauri/src/player.rs` is the authoritative desktop player. It owns the queue, selected
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
account entitlement, and the live vkey response before the existing media path runs. Automatic selects the highest
entitled available full source; explicit High/Lossless preferences may fall back with a typed `account-rights`,
`source-unavailable`, or `preview-only` reason. Unknown/failed entitlement validation is conservative and permits
only Standard. See [entitlement](entitlement.md) for the matrix.

The account layer does not introduce a second player. It supplies a guarded source to the same `PlayerService`,
Range/cache path, Rodio worker, queue, lyrics clock, MPRIS/SMTC adapters, and tray controls. The loopback local API
continues to expose player operations only and never account/session data.

## Queue semantics

- `playTracks` replaces the queue and selects a requested playable ID.
- Removing the active item selects and loads the correct successor; it never continues stale audio.
- `previous` restarts the current track after the normal threshold, otherwise selects the previous queue item.
- repeat-one reloads the current item; repeat-all wraps; shuffle chooses from valid queue indices.
- engine end-of-stream, not catalog duration arithmetic, triggers automatic advancement.
- queue, selected index, playback state, position, volume, mute, repeat, shuffle, and error state are restored from
  SQLite. A restored track remains paused until explicitly resumed.

Tauri commands, synchronized lyrics, the React projection, and the loopback HTTP API all use this contract.
