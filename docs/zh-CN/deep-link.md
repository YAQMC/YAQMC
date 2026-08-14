# 外部 URI 与 Deep link 安全

> **简体中文** | [English](../deep-link.md)

所有外部 URI 都是不可信输入。当前没有 QQ 音乐接管处理器，因为本机 Windows 22.52 官方客户端没有提供
已验证的公开实体 scheme。证据见[官方客户端互操作](qqmusic-official-interoperability.md)。

未来实现必须由用户主动开启且可以完整回滚；精确白名单 scheme、动作、实体、长度和标识符语法；只规范化
成提供器领域引用；拒绝未知或注入式输入。URI 内容绝不能成为 Shell 参数、文件路径、HTML 片段、SQL 或
任意 Tauri 命令。歌词辅助 WebView 不能获得这一能力。

关于页使用 Tauri 官方 opener 插件，capability 只允许集中配置的 YAQMC GitHub 仓库链接；不接收用户输入
URL。
