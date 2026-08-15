# 首页推荐

> **简体中文** | [English](../home-recommendations.md)

首页是一个基于 QQ 音乐登录会话的个性化发现界面。各区段只在数据可用时渲染，并且每个区段在无个性化数据时
降级为通用内容，而不是留下一片空白。

## 区段布局

第一行是一个三列 hero 网格。点击即播放的**猜你喜欢**卡片在最左侧，后面是两张可点开歌单的卡片：

- **猜你喜欢**（`guessSonglist`）——电台式个性化精选，用独特的 hero 样式渲染。点击立即开始播放，并开启
  连续猜你喜欢会话（见下文）。
- **每日30首**（`dailySonglist`）——个性化每日精选（disstid `5505165762`），以宽卡片呈现，点击进入歌单页。
- **新歌推荐**（`newSongSonglist`）——官方客户端“为你打造”楼层里的“新歌推荐”卡片；其 feed `500/511`
  disstid 通过 `CgiGetDiss` 解析为三十首近期新发行。以宽卡片呈现，点击进入歌单页。

hero 行下方，在有数据时展示两个区段：

- **听过的也会喜欢**（`radarSongs`）——基于用户最近听过的一首歌的相似推荐。首页构建时取本地播放历史的前几首
  （无历史时回退到猜你喜欢批次），把它们的数字歌曲 id 作为 `EntranceSongs` 传给 `GetRadarSong`，并用第一首
  基础歌曲作为区段标题：“听《标题》也会喜欢”。参考（入口）歌曲本身会从结果中过滤掉，列表只展示真正的
  推荐。没有可用的入口歌曲时隐藏该区段。
- **推荐歌单**（`recommendedSonglists`）——个性化 feed 中的 dissid 卡片网格。

卡片标题与副标题通过 `i18n` 本地化（`home.trackCount`、`home.playImmediately` 等），绝不在后端载荷里硬编码。

## 数据源

每个区段在可用时使用登录会话，否则使用通用降级：

| 区段         | 登录态数据源                                                  | 未登录降级                          |
| ------------ | ------------------------------------------------------------- | ----------------------------------- |
| 猜你喜欢     | `music.radioProxy.MbTrackRadioSvr/get_radio_track`             | `newsong.NewSongServer/get_new_song_info` |
| 每日30首     | 带 disstid `5505165762` 的 `CgiGetDiss`                        | `newsong.NewSongServer/get_new_song_info` |
| 新歌推荐     | feed `500/511` disstid，然后 `CgiGetDiss`                      | `newsong.NewSongServer/get_new_song_info` |
| 推荐歌单     | feed `500/0` dissid 卡片（翻页收集）                           | `music.playlist.PlaylistSquare/GetRecommendFeed` |
| 雷达         | `music.recommend.TrackRelationServer/GetRadarSong`，`EntranceSongs` = 最近听过歌曲的数字 id | 空                                  |

feed 可能返回一页没有任何歌单卡片的内容；加载器会继续翻页，并且若个性化 feed 没有结果，则回退到通用歌单
读取，保证区段永不为空。

## 连续猜你喜欢

点击猜你喜欢卡片会开启一个记录在播放器 store 中的“猜你喜欢会话”。当当前批次最后一首播放完毕时，
`useGuessContinuation` 通过 `qqmusic_guess_next` 命令请求下一批，追加到队列并播放追加后的第一首。当提供器
不再返回歌曲时会话结束。播放其他任何内容都会重置该标记。

## 缓存与刷新

首页 feed 以 `qqmusic:home:v3` 为 key 缓存 15 分钟。缓存 key 带版本号，序列化结构的变更会使旧缓存失效。
首页构建在异步互斥锁下串行执行，避免并发首次加载触发 QQ 音乐限流（`req_code 700000`）。启动时前端先读取
缓存以便快速首屏，然后主动发一次强制刷新（`qqmusic_home` 带 `refresh=true`），让最新个性化区段替换旧缓存；
之后继续每 15 分钟定时刷新。
