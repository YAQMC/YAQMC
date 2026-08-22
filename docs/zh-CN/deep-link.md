# 外部 URI 与 Deep link 安全

> **简体中文** | [English](../deep-link.md)

所有外部 URI 都是不可信输入。当前没有 QQ 音乐接管处理器，因为本机 Windows 22.52 官方客户端没有提供
已验证的公开实体 scheme。证据见[官方客户端互操作](qqmusic-official-interoperability.md)。

打包应用没有注册自定义 URI scheme，也不会把启动参数解析成目录或播放命令。因此
“Deep link”是明确延期的能力，不是隐藏或部分可用的功能。

未来实现必须由用户主动开启且可以完整回滚；精确白名单 scheme、动作、实体、长度和标识符语法；只规范化
成提供器领域引用；拒绝未知或注入式输入。URI 内容绝不能成为 Shell 参数、文件路径、HTML 片段、SQL 或
任意 host/Core IPC 命令。歌词辅助渲染器不能获得这一能力。

关于页请求 Electron Main 调用 `shell.openExternal`；`apps/desktop/main/open-external.ts` 的白名单只允许
集中配置的 YAQMC 链接，不接收用户输入 URL。
