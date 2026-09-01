# Home recommendations

> [简体中文](zh-CN/home-recommendations.md) | **English**

The home page is a personalized discovery surface backed by the QQ Music account session. Sections resolve only when
their data is available. Public sections can degrade to non-personalized data; account-only sections remain hidden
when no authenticated source is available.

## Section layout

The first row is a three-column hero grid. The play-on-tap **Guess you like** card sits on the left, followed by two
tappable playlist cards:

- **Guess you like** (`guessSonglist`) — a radio-style personalized pick rendered with a distinct hero style. Tapping
  it starts playback immediately and opens a continuous guess session (see below).
- **Daily mix** (`dailySonglist`) — a personalized playlist presented as a wide card that opens the playlist page.
  Its title, description, artwork, creator, and tracks come from the typed qm-api-rs songlist response. YAQMC does not
  replace the provider title with a fixed “Daily 30” label; the displayed count is the number of tracks actually
  returned.
- **New song picks** (`newSongSonglist`) — the "新歌推荐" card from the official client's "为你打造" shelf; its feed
  `500/511` disstid resolves to thirty recent releases via `CgiGetDiss`. Presented as a wide card that opens the
  playlist page.

Below the hero row, two further sections follow when populated:

- **Because you listen to** (`radarSongs`) — similarity picks derived from a song the user recently listened to.
  The home build takes the first few songs from the local playback history (falling back to the guess-you-like
  batch), passes their numeric song ids as `EntranceSongs` to `GetRadarSong`, and labels the section with the first
  base song: "If you like “title”". The reference (entrance) songs themselves are filtered out of the result so the
  list only shows actual recommendations. When no entrance song is available the section is hidden.
- **Recommended playlists** (`recommendedSonglists`) — a grid of dissid cards from the personalized feed.

Card titles and subtitles are localized through `i18n` (`home.trackCount`, `home.playImmediately`, …), never
hard-coded in the backend payloads.

## Data sources

Each section uses the signed-in session when available and a general fallback otherwise:

| Section               | Authenticated source                                                                                             | Guest fallback                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Guess you like        | `music.radioProxy.MbTrackRadioSvr/get_radio_track`                                                               | `newsong.NewSongServer/get_new_song_info`        |
| Daily mix             | qm-api-rs resolves the current account's `data-rid`, then calls typed `songlist.get_detail`                      | hidden                                           |
| New song picks        | feed `500/511` disstid, then `CgiGetDiss`                                                                        | `newsong.NewSongServer/get_new_song_info`        |
| Recommended playlists | feed `500/0` dissid cards (paged)                                                                                | `music.playlist.PlaylistSquare/GetRecommendFeed` |
| Radar                 | `music.recommend.TrackRelationServer/GetRadarSong` with `EntranceSongs` = numeric ids of recently listened songs | empty                                            |

The feed can return a page without any songlist card; the loader keeps paging and, if the personalized feed yields
nothing, falls back to the general playlist read so the section is never empty.

## Continuous recommendations

Playing the **Guess you like** card or the **Because you listen to** section starts a recommendation session owned by
Rust Core. Selecting a radar row starts at that song and keeps the rows that follow it. React sends one typed start
intent; it does not observe end-of-stream or fetch recommendation pages.

`ContinuationService` prefetches five songs when at most two playable recommendation entries remain after the current
track. It validates the session, request, provider, and account generations before atomically appending a response,
deduplicates by provider plus track ID, and bounds the session to 500 seen tracks. Network and rate-limit failures use
bounded jittered retries while the existing queue keeps playing. The session stops on explicit stop, queue/provider/
account replacement, provider completion, three deduplicated empty batches, or exhausted retries. Pause, seek, queue
reorder, manual append, Shuffle, and Repeat All preserve it; Repeat One suppresses prefetch until that mode is left.

QQ recommendation paging is exposed to YAQMC only through the pinned `qm-api-rs` typed API. Upstream request routes,
credentials, cursors, and raw response shapes do not cross into React or Electron Main.

## Caching and refresh

The home feed is cached for 15 minutes under `qqmusic:home:v5:guest` for guests or an account-scoped opaque key for an
authenticated session. Account cache keys contain no QQ identifier and are cleared on account revalidation or
sign-out, so one account's personalized feed cannot be served to another account. The home build is serialized under
an async mutex so concurrent first loads cannot trip QQ Music rate limiting (`req_code 700000`). On startup the
frontend loads the applicable cached feed first for a fast first paint, then issues one forced refresh
(`qqmusic_home` with `refresh=true`). Account snapshot changes trigger the same refresh immediately; the periodic
15-minute refresh continues afterwards.
