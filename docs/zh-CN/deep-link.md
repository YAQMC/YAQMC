# 歌曲分享与 Deep link

> **简体中文** | [English](../deep-link.md)

歌曲页、Player Bar、歌词页和曲目菜单提供一致的提供器中立分享动作：

- **复制歌曲公开链接**只使用提供器返回的 HTTPS URL。React 不拼接平台网站路由；提供器没有公开 URL
  时，应用会说明该动作不可用，而不是猜测链接。
- **复制 YAQMC 链接**生成
  `yaqmc://catalog/<provider>/song?id=<percent-encoded-id>`。
- **复制歌曲与歌手**是纯文本降级，不会伪装成可点击链接。

安装版桌面应用会注册 `yaqmc` 协议。有效链接只会聚焦已有主窗口（或启动唯一实例）并导航到歌曲详情，
不会自动播放、登录、修改账号、打开歌词辅助窗口或把输入交给外部 Shell。可在**设置 → 桌面集成**中关闭
Deep link；同一位置会显示操作系统是否接受协议注册。开发构建与 portable 版本不会把自己注册成系统处理器，
避免协议指向已经清理的临时可执行文件。

## 允许的格式

Electron Main 只接受上面的目录歌曲格式。解析器把完整 URI 限制为 2,048 字节，把解码后的实体 ID 限制为
256 字节，并拒绝凭据、端口、片段、未知或重复查询参数、控制字符、错误百分号编码、不支持的实体和非法
provider ID。Windows/Linux 的 `second-instance`、macOS 的 `open-url` 与冷启动参数共用同一个纯解析器。

外部 URI 始终是不可信输入。解析结果只会变成类型化的“打开歌曲详情”渲染事件，不会成为 Shell 参数、
文件路径、HTML 片段、SQL 或任意 host/Core 命令。歌词辅助窗口不会收到该事件。关于页打开的产品链接仍由
`apps/desktop/main/open-external.ts` 单独执行白名单校验。

实现遵循 Electron 官方的 [Deep Links](https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app)
single-instance 指南。
