# Discover page

> [简体中文](zh-CN/discover.md) | **English**

The Discover (Explore) page is the non-personalized browsing surface. It surfaces charts, fresh releases, and
popular playlists that every user sees regardless of whether they are signed in. Unlike the home feed it does not
depend on the QQ Music session, so every section resolves with the public catalog alone.

## Section layout

All sections render as card grids; every section appears only when it has data, and failed sources leave the
section empty instead of breaking the page.

- **Charts** (`charts`) — a grid of editorial ranking playlists fetched from the QQ Music toplist server. The
  sections uses the same `musicToplist.ToplistInfoServer/GetDetail` contract as the home chart but pulls eight
  distinct ranking ids: hot songs (`26`), new songs (`27`), trending index (`4`), global (`3`), mainland (`5`),
  HK/TW (`6`), rising (`62`), and electronic (`57`). Each card opens the toplist as a playlist.
- **New songs** (`newSongs`) — a general (non-personalized) list of recent releases from
  `newsong.NewSongServer/get_new_song_info` (`type: 5`), rendered as song cards with a play-all action.
- **New albums** (`newAlbums`) — album cards grouped from the tracks of the new-song chart (`topId 27`).
- **Categories** (`categories`) — the official category shelf from
  `music.area.CategoryArea/getCategoryAreaInCategoryPlaylist`, listing 25+ music areas (国潮, 经典, 轻音乐,
  影视, …). Tapping a category opens its dedicated **area page**.
- **New MVs** (`newMvs`) — recent music videos from `MvService.MvInfoProServer/GetNewMv`, shown as cover cards
  (MV playback is not yet wired up).
- **Podcasts** (`podcasts`) — radio/podcast shows from `music.longRadio.recommend/getRadioList`, shown as cover
  cards.
- **Featured** (`featured`) — the music hall spotlight shelf from
  `music.musicHall.MusicHallPlatformSvr/GetFocus`.
- **Popular playlists** (`popularSonglists`) — non-personalized songlists from
  `music.playlist.PlaylistSquare/GetRecommendFeed`.

### Area pages

Each category card opens a dedicated area page (`qqmusic_area`), which resolves the category's shelf via
`music.area.AreaHome/getAreaHomePage` (`encArea` code) and renders its songlists (type `700`), playlists
(type `500`), and artists (type `600`) as cards.

## Data source

All discover sections use the guest path (no session):

| Section           | Source                                                      |
| ----------------- | ----------------------------------------------------------- |
| Charts            | `musicToplist.ToplistInfoServer/GetDetail` (8 topIds)       |
| New songs         | `newsong.NewSongServer/get_new_song_info`                   |
| New albums        | grouped tracks from the `topId 27` chart                    |
| Categories        | `music.area.CategoryArea/getCategoryAreaInCategoryPlaylist` |
| New MVs           | `MvService.MvInfoProServer/GetNewMv`                        |
| Podcasts          | `music.longRadio.recommend/getRadioList`                    |
| Featured          | `music.musicHall.MusicHallPlatformSvr/GetFocus`             |
| Popular playlists | `music.playlist.PlaylistSquare/GetRecommendFeed`            |
| Area page         | `music.area.AreaHome/getAreaHomePage`                       |

The discovery feed is intentionally distinct from the home feed: home keeps personalized picks (guess-you-like,
daily 30, radar, personalized songlists, and the personalized new-song picks card), while Discover shows the same
content for every user.

## Caching and refresh

The discover feed is cached under `qqmusic:discover:v1` for 15 minutes and rebuilt when refreshed. The frontend
loads the cached feed first for a fast first paint, then issues one forced refresh (`qqmusic_discover` with
`refresh=true`), and continues a periodic 15-minute refresh while the page is mounted. A failed background refresh
keeps the current feed and retries on the next interval.
