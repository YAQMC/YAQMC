# 发现页

> [English](../discover.md) | **简体中文**

发现页（Explore）是非个性化的浏览页面。它展示排行榜、新发行与热门歌单——无论是否登录，每位用户看到的
内容都一样。与首页不同，它不依赖 QQ 音乐会话，每个区段仅凭公开目录即可加载。

## 区段布局

所有区段都以卡片网格呈现；每个区段仅在数据存在时渲染，失败的来源会留空该区段，而不是让整页出错。

- **排行榜**（`charts`）——编辑精选的榜单歌单网格，从 QQ 音乐榜单服务器拉取。与首页榜单使用相同的
  `musicToplist.ToplistInfoServer/GetDetail` 契约，但覆盖八个不同的榜单 id：热歌榜（`26`）、新歌榜（`27`）、
  流行指数榜（`4`）、欧美榜（`3`）、内地榜（`5`）、港台榜（`6`）、飙升榜（`62`）、电音榜（`57`）。
  每张卡片把榜单当作歌单打开。
- **新歌**（`newSongs`）——来自 `newsong.NewSongServer/get_new_song_info`（`type: 5`）的通用（非个性化）
  近期新发行，以歌曲卡片呈现，并带“播放全部”操作。
- **新专辑**（`newAlbums`）——从新歌榜（`topId 27`）的歌曲按专辑分组生成的专辑卡片。
- **分类**（`categories`）——来自 `music.area.CategoryArea/getCategoryAreaInCategoryPlaylist` 的官方分类
  楼层，列出 25+ 个音乐专区（国潮、经典、轻音乐、影视等）。点击分类会打开对应的**专区详情页**。
- **新MV**（`newMvs`）——来自 `MvService.MvInfoProServer/GetNewMv` 的近期音乐视频，以封面卡片呈现
  （MV 播放暂未接入）。
- **播客**（`podcasts`）——来自 `music.longRadio.recommend/getRadioList` 的电台/播客节目，以封面卡片呈现。
- **焦点**（`featured`）——来自 `music.musicHall.MusicHallPlatformSvr/GetFocus` 的音乐馆焦点推荐楼层。
- **热门歌单**（`popularSonglists`）——来自 `music.playlist.PlaylistSquare/GetRecommendFeed` 的非个性化歌单。

### 专区详情页

每个分类卡片打开一个专区详情页（`qqmusic_area`），通过 `music.area.AreaHome/getAreaHomePage`（`encArea` 码）
解析该分类的楼层，并把其中的电台歌单（type `700`）、歌单（type `500`）与歌手（type `600`）渲染为卡片。

## 数据源

发现页各区段全部走访客路径（无会话）：

| 区段       | 数据源                                                      |
| ---------- | ----------------------------------------------------------- |
| 排行榜     | `musicToplist.ToplistInfoServer/GetDetail`（8 个 topId）    |
| 新歌       | `newsong.NewSongServer/get_new_song_info`                   |
| 新专辑     | `topId 27` 榜单歌曲按专辑分组                               |
| 分类       | `music.area.CategoryArea/getCategoryAreaInCategoryPlaylist` |
| 新MV       | `MvService.MvInfoProServer/GetNewMv`                        |
| 播客       | `music.longRadio.recommend/getRadioList`                    |
| 焦点       | `music.musicHall.MusicHallPlatformSvr/GetFocus`             |
| 热门歌单   | `music.playlist.PlaylistSquare/GetRecommendFeed`            |
| 专区详情页 | `music.area.AreaHome/getAreaHomePage`                       |

发现页刻意与首页保持独立：首页保留个性化精选（猜你喜欢、供应商命名的每日歌单、雷达、个性化歌单，以及个性化新歌推荐
卡片），而发现页对所有用户展示相同内容。

## 缓存与刷新

发现页数据缓存在 `qqmusic:discover:v2` 下，有效期 15 分钟，刷新时重建。前端先读取缓存以获得快速首屏，
然后发起一次强制刷新（`qqmusic_discover` 传 `refresh=true`），并在页面挂载期间每 15 分钟周期刷新一次。
后台刷新失败会保留当前数据，并在下一个周期重试。
