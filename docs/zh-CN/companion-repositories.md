# 独立插件与网站仓库

> **简体中文** | [English](../companion-repositories.md)

- [YAQMC/yaqmc-plugins](https://github.com/YAQMC/yaqmc-plugins)：维护全部可编辑插件示例、插件包、可直接复制的 starter、SDK 类型与离线中英文 API 文档。
- [YAQMC/yaqmc.github.io](https://github.com/YAQMC/yaqmc.github.io)：维护中英文网站、在线演示入口和歌曲，以及 [yaqmc.github.io](https://yaqmc.github.io/) 的 GitHub Pages 部署。

客户端保留宿主实现、原始 SDK/WIT 和 API 技术文档。`tests/fixtures/plugins` 只是用于离线回归测试的冻结运行时输入，不承担插件源码仓库功能。网站与插件构建各自在独立仓库运行。

客户端在相关 `main` 更新后校验 API 导出。两个独立仓库每 15 分钟检查公开客户端分支，验证 API 镜像或演示构建后才提交新版本；GitHub 定时任务可能延迟。工作流仅使用各自仓库的 `GITHUB_TOKEN`，不保存个人令牌或跨仓库凭据。`UPSTREAM.json` 记录来源提交，starter 的 API 契约记录来源哈希；也可手动运行工作流立即同步。

本地将两个仓库克隆到客户端旁边，运行 `npm run plugin:example:sync` 和 `node scripts/sync-companion-website.mjs` 即可同步。插件仓库中的 `npm run api:sync` 会从记录的公开客户端提交重建镜像。每个仓库负责自己的构建检查。
