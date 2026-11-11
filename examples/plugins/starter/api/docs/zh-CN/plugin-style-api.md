# 插件样式 API

> **简体中文** | [English](../plugin-style-api.md)

稳定的 CSS 个性化使用 `data-yaqmc` 与 `--yaqmc-*`。内部生成的 class 名称**不受支持**，前端重构可以改这些 class 而不
提升插件 API 版本。

## 选择器（v1）

`[data-yaqmc="sidebar"]`、`[data-yaqmc="player-bar"]`、`[data-yaqmc="queue"]`、`[data-yaqmc="track-title"]`。

## 自定义属性（v1）

`--yaqmc-primary`、`--yaqmc-secondary`、`--yaqmc-radius-card`、`--yaqmc-player-height`、`--yaqmc-surface-alpha`。

它们是应用 token 的别名。编写插件时优先使用这些变量，而不是未文档化的 `--accent` 内部实现。

## 层叠

已启用的样式插件按持久化的 `style_order`（启用顺序）注入，后启用的优先。样式包在 `@layer yaqmc-plugin-style.<id>`。
停用会立即移除样式表。

## CSS 安全

远程 `@import`、远程 `url(http…)` 和 `url(file:…)` 会被阻止。插件本地资源必须位于已安装包内。v1 不允许网络字体。

CSS 仍可能隐藏控件或仿冒界面，因此样式插件也受安全模式约束。
