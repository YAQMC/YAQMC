# 账号音乐库

> **简体中文** | [English](../account-library.md)

QQ 音乐账号页面和写操作已经实现，但真实账号验收仍待完成。公开首页、搜索和发现始终可以在访客模式
使用，不依赖账号子系统。

## 界面与状态

主窗口提供收藏、账号歌单、服务端声明支持时的最近播放，以及自有歌单详情。账号接口
`AccountMusicProvider` 与公开目录 `MusicProvider` 分离，桌面歌词和歌词岛没有账号权限。

每个列表都显式区分 idle、loading、ready、empty、stale、需要账号、需要重新认证和 error。加载下一页
不会清空已有一致数据。网络/协议错误可以显示明确标记 stale 的合格缓存；认证错误绝不回退旧账号数据。
React generation 与 AbortSignal 防止旧路由、旧分页或旧会话覆盖当前页面。

## 分页与投影

原生层把提供器 cursor 转成随机 outward cursor，并放在有大小上限、绑定 generation/resource 的内存
注册表。原始 cursor 和身份字段不会进入 React/SQLite。收藏缓存 2 分钟，歌单和最近播放 5 分钟；键只
含随机账号 scope 和 cursor 摘要。

首页刷新会开启投影 epoch，后续页只累积不丢前页，抵达终页后才原子替换完整投影。重启后若缓存首页
还有下一页，先重新请求首页再发新 cursor；离线 stale 回退必须是终页，不能暴露已经失效的 cursor。

## 写操作结果

收藏和歌单写操作带不透明 client operation ID，仅返回：

- `applied`：响应明确确认成功；
- `rejected`：提供器明确拒绝；
- `reconciled`：响应不确定，但安全回读证明目标状态；
- `outcome-unknown`：有限回读仍无法证明结果。

写操作不自动重试。同一实体串行写；并发重复 operation ID 在网络前拒绝；有限的已完成缓存让重复 ID
直接返回旧结果而不重复写入。只有自建歌单可修改；收藏的歌单不能重命名、编辑或删除。重命名只有在
详情含有无损保留描述、图片和标签所需全部字段时才启用。

投影与受影响页面缓存通过一个 SQLite batch 更新，失败整体回滚。网络、回读和提交前后均复查 auth
generation 与账号 scope，所以注销/换号后旧结果不能重新写入音乐库。

## 真实验收安全

真实测试只能创建一个名字唯一的临时歌单，验证增删改后移除测试歌曲并删除歌单。收藏测试先记录原始
状态，切换一次、回读，再恢复原状态。只有认证能力快照明确不提供最近播放时，才能记为“不支持”。
记录器不能保存任意备注、URL、资料值、歌单名、Cookie 或响应体。

相关文档：[登录](authentication.md)、[缓存](caching.md)、[权益](entitlement.md)和
[QQ 音乐协议记录](qqmusic-provider.md)。
