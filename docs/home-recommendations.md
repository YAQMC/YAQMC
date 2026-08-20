# Home recommendations

> [简体中文](zh-CN/home-recommendations.md) | **English**

The home page is a personalized discovery surface backed by the QQ Music account session. Sections resolve only when
their data is available, and each one degrades to a non-personalized fallback instead of leaving an empty gap.

## Section layout

The first row is a three-column hero grid. The play-on-tap **Guess you like** card sits on the left, followed by two
tappable playlist cards:

- **Guess you like** (`guessSonglist`) — a radio-style personalized pick rendered with a distinct hero style. Tapping
  it starts playback immediately and opens a continuous guess session (see below).
- **Daily 30** (`dailySonglist`) — a personalized daily mix (disstid `5505165762`) presented as a wide card that opens
  the playlist page.
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
| Daily 30              | `CgiGetDiss` with disstid `5505165762`                                                                           | `newsong.NewSongServer/get_new_song_info`        |
| New song picks        | feed `500/511` disstid, then `CgiGetDiss`                                                                        | `newsong.NewSongServer/get_new_song_info`        |
| Recommended playlists | feed `500/0` dissid cards (paged)                                                                                | `music.playlist.PlaylistSquare/GetRecommendFeed` |
| Radar                 | `music.recommend.TrackRelationServer/GetRadarSong` with `EntranceSongs` = numeric ids of recently listened songs | empty                                            |

The feed can return a page without any songlist card; the loader keeps paging and, if the personalized feed yields
nothing, falls back to the general playlist read so the section is never empty.

## Continuous guess-you-like

Tapping the guess-you-like card starts a "guess session" tracked in the player store. When the last track of the
current batch finishes, `useGuessContinuation` requests the next batch through the `qqmusic_guess_next` command,
appends it to the queue, and plays the first appended track. The session ends when the provider returns no more songs.
Playing anything else resets the flag.

## Caching and refresh

The home feed is cached under `qqmusic:home:v3` for 15 minutes. The cache key is versioned so structural changes to
the serialized feed invalidate stale copies. The home build is serialized under an async mutex so concurrent first
loads cannot trip QQ Music rate limiting (`req_code 700000`). On startup the frontend loads the cached feed first for
a fast first paint, then issues one forced refresh (`qqmusic_home` with `refresh=true`) so the latest personalized
sections replace stale cache data; the periodic 15-minute refresh continues afterwards.
