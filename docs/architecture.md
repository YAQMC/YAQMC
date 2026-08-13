# Architecture

> [简体中文](zh-CN/architecture.md) | **English**

The desktop runtime keeps transport, persistence, playback, and presentation independently replaceable:

```text
React pages/components
        |
MusicProvider + optional AccountMusicProvider + player projection
   |                                        |
QQMusicProvider (main WebView/Tauri)         | player://snapshot + api://event
FakeMusicProvider                            |
   |                                        |
QQMusicService ------------------------> PlayerService <-------- LocalApiService
   |          account/auth/entitlement    queue/state machine       127.0.0.1 + SSE
   |                                        |
direct account transport + public HTTP   MediaPreparer
   |                                        |
QQ compatibility endpoints              HTTP Range source + bounded file cache
                                            |
                                      AudioEngine worker
                                        Rodio / CPAL

StorageService: SQLite metadata, settings, history, queue state, and file-cache index
CredentialStore: OS keychain/credential vault for provider sessions and the local API token
Platform adapters: MPRIS 2.2 / SMTC / tray / shortcuts -> PlayerService
```

## Ownership rules

- UI code consumes normalized entities from `src/domain/music.ts`; it never handles provider DTOs, signed media
  URLs, cookies, QRC ciphertext, or cache paths.
- `QQMusicService` owns endpoint calls, DTO tolerance, normalization, retry classification, entitlement decisions,
  source selection, and session state. Account commands require both the `main-window` Tauri capability and a Rust
  `main` caller-label check; lyric WebViews receive neither account data nor account command access.
- `PlayerService` is the single owner of the active queue index, playback lifecycle, actual engine position,
  playback duration, volume, mute, repeat, shuffle, failure state, and lyric cursor.
- `AudioEngine` is a synchronous command boundary backed by a dedicated thread that owns Rodio/CPAL objects.
  Neither React nor the async runtime owns the audio device.
- `StorageService` owns all SQLite connections and cache file bookkeeping. Signed URLs are never database keys.
- `LocalApiService` owns only listener configuration/lifecycle and authentication. HTTP and Tauri commands invoke
  the same `PlayerService`; there is no second playback clock. The loopback API has no account or credential route.

## Data and event flow

1. A page calls the public provider contract, or the account extension after an authenticated snapshot, and receives
   normalized catalog/account entities. Provider cursors and credentials never cross that boundary.
2. A play intention sends normalized tracks to `PlayerService`.
3. The player resolves a fresh provider source, reuses a complete cache entry or prepares an initial HTTP range,
   then asks the audio worker to decode and play it while remaining ranges fill the bounded cache.
4. The player's 50 ms poll reads Rodio's actual position and end state. Position events are throttled to 250 ms;
   track, playback, queue, mode, error, lyric-line, and lyric-word transitions emit only on change.
5. React projects `player://snapshot`. The local API publishes the same state as JSON and SSE.
6. Queue/mode/volume/track transitions persist a `PlayerSnapshot` in SQLite and restore on the next launch.

Account login is a separate lifecycle. The main account dialog owns a native QR lease and heartbeat; loss of that
owner cancels polling. A confirmed candidate is validated, written to a staging keyring slot, read back, validated
again, promoted to the active slot, read back, and only then published. One lifecycle mutex plus generation/scope
checks prevent logout or a replacement session from accepting stale completions.

Browser-only Vite development composes `FakeMusicProvider` and the existing simulated adapter because native IPC,
audio, secure storage, and disk caches do not exist there. The fake path is intentional and permanent; native
builds select QQ Music unless `?provider=fake` is explicitly supplied.

## Failure boundaries

- Provider failures become stable codes such as `offline`, `timeout`, `rate-limited`, `authentication-expired`,
  `entitlement-unavailable`, and `schema-changed`.
- Media and audio failures become recoverable or fatal `PlaybackFailure` values. URL expiry is re-resolved once;
  unbounded retries are prohibited.
- Generation IDs discard stale load completions during rapid track changes.
- Account reads and writes capture an authentication generation plus opaque cache scope. Logout or account
  replacement cancels transport and prevents stale projection/cache commits.
- A missing output device starts an `UnavailableAudioEngine` so catalog/settings/cache features still work and
  playback returns a stable device error instead of crashing the application.
- Cache writes use random `.part` files and atomic rename. Startup removes abandoned partial files.

See [provider contract](provider-contract.md), [playback](playback.md), [authentication](authentication.md), and
[caching](caching.md) for the detailed boundaries.
