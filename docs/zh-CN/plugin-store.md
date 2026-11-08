# 插件页面与插件商店

> **简体中文** | [English](../plugin-store.md)

**插件**是一级入口：桌面侧栏“应用”分组中位于**设置**之前，Android 底部导航和平板侧栏中为第五项。它取代了原先位于设置中的插件管理区域。页面包含**插件管理**（默认）和**插件商店**两个页签。页签属于路由，返回键会回到上一个页签；两个面板首次打开后保持挂载，切换页签不会丢失搜索和筛选。页面不依赖当前音源，平台离线、未登录或被禁用时仍可使用。

插件自定义的 API v4 页面继续使用独立的 `plugin-page` 路由，在侧栏的**插件页面**分组中显示（Android 现在也显示），并作为快捷入口出现在插件管理顶部，没有侧栏的手机也能进入。

## 插件管理

工具栏可搜索已安装插件（名称、ID、描述、作者），按状态筛选（运行中、已禁用、需要处理），安装本地 `.yaqmc-plugin`，检查**签名**更新并刷新。“检查签名更新”只会检查绑定了[插件更新](plugin-updates.md)中可信来源的插件，不代表商店安装包会自动更新。

卡片以文字显示状态；失败或不兼容的插件显示宿主给出的原因。启用/禁用与**详情**是主要操作；替换、诊断和卸载位于卡片的次级菜单。详情包含权限、API 与平台、来源（本地文件、插件商店仓库、可信来源）、仓库链接、发布信息、哈希、诊断以及插件自身的设置表单，例如音乐插件的 `isolated` / `aggregate` 工作模式。安全模式、开发者模式和未打包文件夹位于**高级**中；加载未打包文件夹仅限桌面端。

## 插件商店

发现过程由 Core（而非渲染进程）匿名、只读地调用 GitHub REST：

- `GET /search/repositories`，始终带有强制限定 `topic:yaqmc-plugin`。用户输入会被分词，限定符、布尔运算、取反和分组会被移除，因此输入只能缩小结果。搜索范围对应 GitHub 语义：默认字段、`in:name`、`in:description`、`user:<login>` 或 `repo:<owner>/<repo>`。
- 按需对每个仓库调用 `GET /repos/{owner}/{repo}/releases`，每页 10 个发布。草稿永不显示；勾选“包含预发布”后才显示预发布。商店最多为前 12 张卡片预取发布摘要，并发 2 个请求，遇到速率限制即停止。

结果有界（每页 20 个，最多 10 页），按仓库 ID 去重，并再次校验主题。响应在内存中缓存 5 分钟并用 `ETag` 重新验证；GitHub 离线或限流时显示上次成功的结果并标注为已保存。`incomplete_results` 会提示给用户。403/429 显示本地化提示及 `Retry-After` 或 `X-RateLimit-Reset` 给出的恢复时间，不硬编码配额。旧搜索结果不会覆盖新搜索。

只有名称精确（不区分大小写）以 `.yaqmc-plugin` 结尾且状态为 `uploaded` 的发布附件才是候选安装包。源码压缩包、校验文件、`.yaqmc-plugin.sig`、安装程序、APK 和 Actions 产物都不是候选。仓库不等于插件 ID：一个发布含多个安装包时由用户选择；商店只在唯一安装包、或唯一一个名称指向当前平台的安装包时预选。名称只是提示，插件 ID、API 和平台以下载后的清单为准。

`YAQMC` GitHub 组织拥有的仓库会单独标注，其它所有者标注为**社区**。两种标注都不代表签名已验证。

## 安装与信任边界

**下载并审核**会把 `{ owner, repo, releaseId, assetId }` 作为 `github` 传给 `plugin_update_prepare`，渲染进程从不传递 URL 或路径。随后 Core：

1. 重新读取仓库（必须仍带主题）、发布（不是草稿）和附件（安装包后缀、已上传、大小不超过 32 MiB 组件包上限）；
2. 通过既有更新 HTTP 客户端下载 `https://api.github.com/repos/{owner}/{repo}/releases/assets/{id}`：仅 HTTPS，最多 3 次重定向，每一跳仅允许 `api.github.com`、`github.com`、`release-assets.githubusercontent.com` 或 `objects.githubusercontent.com`，固定 DNS 结果并拒绝私有、回环和过渡地址，不发送凭据或 Cookie，具备连接、无数据和总超时，可取消；
3. 流式写入该操作的私有暂存目录，精确校验大小，并在 GitHub 提供摘要时比对 SHA-256；
4. 执行常规的安装包检查与准备（路径、文件数、大小和压缩比限制、清单、兼容性、权限），然后显示审核。

应用时只使用这个已准备的操作，审核的字节即安装的字节。商店安装始终视为**未验证**：审核需要确认，敏感权限需要逐项授予，插件来源记录为 `github:<owner>/<repo>/releases/<id>`。替换来自其他仓库、本地文件或可信来源的同一插件 ID 时会增加 **source-change** 确认。商店安装不会进入可信更新源，也不会自动更新。同一附件的操作仍在进行时再次点击会复用该操作。进度和最终状态以 Core 的操作记录为准，离开页面后再回来会重新连接。

`plugin_store_search` 和 `plugin_store_releases` 仅主窗口可用。错误为稳定代码，例如 `store-rate-limited:<resetMs>`、`store-offline`、`store-timeout`、`store-not-found`、`store-not-a-plugin-repository`、`store-asset-unavailable`、`store-asset-too-large` 和 `store-asset-digest-mismatch`。

## 发布插件

为仓库添加 `yaqmc-plugin` 主题，并把构建好的 `.yaqmc-plugin` 作为 GitHub Release 附件发布。商店看不到 Actions 产物。`YAQMC/yaqmc-music-providers` 为此提供了标签/手动触发的发布工作流。截至 2026-11-06，其公开发布列表为空，因此在维护者发布之前，商店会如实显示“暂无发布”。
