# YAQMC 文档

> **简体中文** | [English](../README.md)

这里是 YAQMC 面向用户、测试者和贡献者的公开文档。`docs/plans/` 与 `docs/superpowers/` 中的文件是开发
过程记录，不属于用户指南，也不代表所有计划都已经交付。

## 从这里开始

- [整体架构](architecture.md)
- [播放系统](playback.md)与[渐进式流媒体](streaming.md)
- [QQ 音乐提供器](qqmusic-provider.md)、[登录与安全存储](authentication.md)、
  [首页推荐](home-recommendations.md)、[账号音乐库](account-library.md)、[会员模型](account-membership.md)
  与[播放权益](entitlement.md)
- [官方客户端互操作](qqmusic-official-interoperability.md)、[音质分类](audio-quality.md)、
  [封面选择](artwork.md)与[外部 URI 安全](deep-link.md)
- [歌词架构](lyrics.md)、[桌面歌词 / 歌词岛](lyrics-surfaces.md)、
  [歌词预设](lyrics-presets.md)与[歌词编排器](lyrics-composer.md)
- [外观个性化](appearance.md)、[设计系统](design-system.md)与[国际化](i18n.md)
- [插件平台](plugin-platform.md)、[清单](plugin-manifest.md)、[安全](plugin-security.md)、
  [开发](plugin-development.md)、[示例插件](plugin-examples.md)、
  [样式 API](plugin-style-api.md)与[场景 API](plugin-scene-api.md)
- [Linux 运行与测试](linux.md)、[Linux 图形策略](linux-graphics.md)与[桌面平台集成](platform-integration.md)
- [本地 HTTP API](local-api.md)及其 [OpenAPI 3.1 定义](../local-api.openapi.yaml)
- [日志系统](logging.md)、[诊断快照与诊断包](diagnostics.md)、
  [GitHub Issue 报告](issue-reporting.md)与[安全与隐私](security.md)
- [CI、缓存与可下载产物](ci.md)

## 验收记录

- [Windows 验收](windows-acceptance.md)
- [Linux 验收](linux-acceptance.md)

验收记录会明确区分自动化测试、本机检查、真实账号测试和真实 Linux 设备测试。没有按文档产生证据的
项目不能写成“已验证”。
