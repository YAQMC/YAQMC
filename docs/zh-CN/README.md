# YAQMC 文档

> **简体中文** | [English](../README.md)

这里是 YAQMC 面向用户、测试者、贡献者和发布维护者的公开文档。

## 用户

- 开始使用：[数据位置、升级及卸载](data-locations.md)、[外观个性化](appearance.md)和
  [Linux 运行环境](linux.md)
- 浏览与账号：[登录与安全存储](authentication.md)、[账号音乐库](account-library.md)、
  [会员模型](account-membership.md)、[首页推荐](home-recommendations.md)和[发现页](discover.md)
- 播放：[播放系统](playback.md)、[渐进式流媒体](streaming.md)、[音质分类](audio-quality.md)和
  [封面选择](artwork.md)
- 歌词：[歌词架构](lyrics.md)、[桌面歌词 / 歌词岛](lyrics-surfaces.md)、
  [歌词预设](lyrics-presets.md)和[歌词编排器](lyrics-composer.md)
- 求助：[GitHub Issue 报告](issue-reporting.md)、[诊断快照与诊断包](diagnostics.md)和
  [安全与隐私](security.md)

## 贡献者

- 先读[开发环境](development.md)、[整体架构](architecture.md)、[设计系统](design-system.md)和
  [国际化](i18n.md)
- 核心边界：[音乐提供器契约](provider-contract.md)、[QQ 音乐提供器](qqmusic-provider.md)、
  [播放权益](entitlement.md)、[持久化与缓存](caching.md)和[桌面平台集成](platform-integration.md)
- 互操作：[QQ 音乐封面证据](qqmusic-artwork.md)、
  [官方客户端互操作证据](qqmusic-official-interoperability.md)和[外部 URI 安全](deep-link.md)
- 集成：[本地 HTTP API](local-api.md)及其 [OpenAPI 3.1 定义](../local-api.openapi.yaml)

## 插件开发者

- [插件平台](plugin-platform.md)、[清单](plugin-manifest.md)、[安全](plugin-security.md)和
  [开发](plugin-development.md)
- [示例插件](plugin-examples.md)、[样式 API](plugin-style-api.md)和[场景 API](plugin-scene-api.md)

## 测试与发布

- [CI、缓存与产物](ci.md)、[日志系统](logging.md)和[Linux 图形策略](linux-graphics.md)
- [Windows 验收](windows-acceptance.md)和[Linux 验收](linux-acceptance.md)
- [发布与合规记录](../release/README.md)

验收记录会区分自动化检查、真实账号和真实设备证据。没有满足相应验收记录的项目不能写成“已验证”。
