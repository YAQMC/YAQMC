# 插件页面 API（API v4）

> **简体中文** | [English](../plugin-pages-api.md)

插件 API v4 允许脚本插件添加**页面**、添加打开这些页面的**导航入口**，并调整受支持的 YAQMC 页面上由宿主定义的**布局选项**。
v4 扩展的是组合式清单（manifest v1）：API v2 的全部能力仍然可用，v1、v2、v3 插件包保持不变。

插件不提供 HTML、这些界面的 CSS、图片或 URL。页面是一份声明式的区块文档，由 YAQMC 用自己的组件、在自己的布局中渲染，
并显示“由 … 提供”的来源标注。

## 清单

```json
{
  "manifestVersion": 1,
  "id": "dev.example.pages",
  "name": "Listening log",
  "version": "1.0.0",
  "apiVersion": 4,
  "entrypoints": { "script": "dist/main.js" },
  "permissions": ["track.read", "ui.pages", "ui.navigation", "ui.layout"]
}
```

| 权限            | 桥接方法                                                      | 敏感 |
| --------------- | ------------------------------------------------------------- | ---- |
| `ui.pages`      | `ui.pages.register`、`ui.pages.render`、`ui.pages.unregister` | 否   |
| `ui.navigation` | `ui.navigation.register`、`ui.navigation.unregister`          | 否   |
| `ui.layout`     | `ui.layout.set`、`ui.layout.clear`                            | 否   |

这些权限只能与 `apiVersion: 4` 一起使用；在 API v1–v3 中声明会使清单无效。Provider Component（manifest v2）不能使用
API v4。声明了本宿主不支持的 API 版本的插件包会保持已安装但**不兼容**的状态，且永不激活，即使其中声明了本宿主未知的权限。

## 脚本 API

```ts
await ctx.pages.register({ id: 'log', title: 'Listening log' });
await ctx.navigation.register({ id: 'open-log', label: 'Listening log', pageId: 'log' });
await ctx.pages.render('log', [
  { type: 'stats', items: [{ label: 'Tracks', value: '12' }] },
  { type: 'actions', items: [{ id: 'clear', label: 'Clear', variant: 'primary' }] },
]);
ctx.pages.onMount('log', () => void refresh());
ctx.events.on('ui.action', (event) => {
  // { id: 'clear', slot: 'page', pageId: 'log' }
});
await ctx.layout.set({
  target: 'home',
  order: ['radar', 'for-you'],
  hidden: ['recommended-playlists'],
});
```

类型定义见 `sdk/plugin/src/index.ts`（`PluginPageBlock`、`PluginHomeLayout`、`PluginPageActionEvent`）。完整示例为
[`script-pages`](plugin-examples.md)。

### 区块

| 区块      | 字段                                                         | 限制         |
| --------- | ------------------------------------------------------------ | ------------ |
| `heading` | `text`                                                       | 60 个字符    |
| `text`    | `text`、`tone?: 'default' \| 'secondary'`                    | 1,000 个字符 |
| `notice`  | `text`、`level?: 'info' \| 'warning' \| 'error'`             | 1,000 个字符 |
| `stats`   | `items: { label, value }[]`                                  | 8 项         |
| `list`    | `items: { id, title, subtitle?, actionId? }[]`               | 50 项        |
| `actions` | `items: { id, label, variant?: 'primary' \| 'secondary' }[]` | 4 个按钮     |
| `divider` | —                                                            |              |

一份文档最多 40 个区块；单次页面、导航或布局调用超过 64 KiB 时 Core 会拒绝。文本始终作为文本渲染，类似标记的字符串会原样显示。
未知区块类型、类型错误的字段，或不符合 `[A-Za-z0-9][A-Za-z0-9._-]{0,39}` 的 id，会在到达 Core 之前以稳定的错误码拒绝整次调用
（`invalid-page`、`invalid-page-blocks`、`invalid-navigation-entry`、`invalid-layout`、`unsupported-layout-target`）。

## 生命周期与路由

- 页面以插件为作用域：`dev.example.pages/log` 与其他插件的 `log` 是不同页面。插件只能渲染、注销或链接**自己的**页面。
- 每个插件最多注册 4 个页面和 4 个导航入口。导航入口显示在侧栏的“Plugins”分组中，打开路由
  `{ page: 'plugin-page', pluginId, pageId }`，并参与前进/后退历史。
- 页面显示或离开时，仅向所属插件发送 `page.mounted` / `page.unmounted`；建议在挂载时再渲染。
- 停用、更新、失败或卸载插件时，会立即移除其页面、导航入口和布局调整。已打开的插件页面会显示“不可用”状态，导航历史不受影响。
- 注销页面时，指向该页面的导航入口也会被移除。

## 布局

布局调整是宿主定义的词汇，而不是样式。API v4 支持一个目标：

| 目标   | 分区                                        | 选项              |
| ------ | ------------------------------------------- | ----------------- |
| `home` | `for-you`、`radar`、`recommended-playlists` | `order`、`hidden` |

多个插件同时调整首页时，合并结果与激活顺序无关：

- 按插件 id 排序依次应用；
- `hidden` 取并集；
- 按 id 第一个声明了 `order` 的插件决定顺序；
- 未提及的分区保持默认相对顺序。

首页会显示是哪些插件调整了布局。新增目标或分区属于 v4 的增量变更，删除则需要新的 API 版本。

## 安全边界

API v4 不增加新的数据访问能力。页面内容来自插件原本已获准读取的数据（例如 `track.read`），按钮操作只会通知插件本身。
[插件安全](plugin-security.md)中描述的 Worker 隔离、权限检查桥、速率限制与包目录隔离均保持不变。
