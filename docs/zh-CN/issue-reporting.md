# GitHub Issue 报告

> **简体中文** | [English](../issue-reporting.md)

Issue Reporter 会把用户的问题描述整理成一个已预填的 GitHub Issue 表单，
过程中永远不持有 GitHub 令牌。**提交动作永远由用户在浏览器里点击。**

## 入口

- **设置 → 诊断与日志 → 报告问题**：一般反馈和维护者引导流程的入口，
  紧挨诊断包按钮。
- **错误提示 → 报告此问题**：以关联的错误码与关联 ID 预填 Reporter。

关于页只展示产品身份和项目链接，不再重复打开 Issue Reporter。

对话框实现于 `src/components/IssueReporterDialog.tsx`。使用原生 HTML
`<dialog>` 保证模态与焦点管理。

## 流程

```
报告问题
    ↓
选择分类（Bug / Linux / 播放 / QQ 音乐 / 歌词 / 界面 / 其他）
    ↓
填写简短标题 + 复现步骤
    ↓
查看预览（Rust 生成的 title + body）
    ↓
可选：生成诊断 ZIP
    ↓
打开 GitHub（默认浏览器）
    ↓
YAQMC 在文件管理器中定位 ZIP
    ↓
用户自己复查 & 点击 Submit
```

每个箭头都是独立的用户动作。**YAQMC 永远不会自动 Submit**。整条链路里
唯一的网络行为，是浏览器访问 `github.com`。

## 分类

初始分类刻意精简（一个下拉框，七个选项）：

| Slug       | 显示名         | 模板                      |
| ---------- | -------------- | ------------------------- |
| `bug`      | Bug 报告       | `bug-report.yml`          |
| `linux`    | Linux 兼容性   | `linux-compatibility.yml` |
| `playback` | 播放 / 音频    | `bug-report.yml`          |
| `provider` | QQ 音乐 / 账号 | `bug-report.yml`          |
| `lyrics`   | 歌词           | `bug-report.yml`          |
| `ui`       | 界面 / 外观    | `bug-report.yml`          |
| `other`    | 其他           | `bug-report.yml`          |

后续加入 Scene 分类是预期内的操作，只需要向 `IssueCategory::ALL` 追加
和映射对应模板即可。

## GitHub URL 预填

Rust 侧在 `src-tauri/src/issue_reporter.rs::compose_url` 组装 URL，只
使用 GitHub Issue Form 官方支持的 query 参数：

- `template=`：目标 Issue Form 文件。
- `title=`：本地化标题，带分类前缀 (`[Bug]`、`[Linux]`)。
- `labels=`：`needs-triage,reporter:<slug>`，方便触发维护者的分类规则。
- 正文字段 ID：bug-report 用 `diagnostics=`，Linux 兼容性用 `evidence=`；
  分别对应两份 Issue Form 里的字段。
- `area=`：命中分类时，为 bug-report 表单的下拉框预选值。

生成的 URL 上限 6 000 字符。若正文太长把 URL 顶穿这个上限，对话框会给出
警告，用户可以退回到“复制 Issue 文本”，手动粘贴到浏览器。

## 预填字段

生成的正文包含：

- 简短标题，
- 复现步骤 / 详情，
- YAQMC 版本 + 短提交 SHA，
- 构建通道 + 构建类型，
- 操作系统 + 架构，
- 渲染器（Windows 上 WebView2；Linux 上 `WebKitGTK <version>`），
- 音频后端 + 已选策略 + host，
- provider 模式 + 连接 + 会员等级（不含密钥），
- 日志级别 + Session ID，
- 若存在，附带关联错误码与关联 ID，
- 若已生成诊断包，附带文件名。

**日志内容不会出现在 URL 里**。诊断包附件由用户在浏览器手动上传。

## 预览与“复制 Issue 文本”

打开浏览器之前，对话框展示：

- 渲染后的标题，
- 渲染后的正文，
- 将使用的 Issue Form 模板名，
- 将被预填的字段列表，
- URL 超长时的警告 banner。

“复制 Issue 文本”会把 `title` + `\n\n` + `body` 写到剪贴板，即使
`openUrl` 或浏览器打不开，流程也能继续。

## 诊断包附加流程

Issue Form 不能通过 query 参数上传文件，因此流程是：

1. `handleGenerateBundle` 调 `diagnostics_export_bundle`。
2. `handleOpen` 先通过 `openIssueUrl` 验证 URL，再打开浏览器。
3. 随后调用 `diagnostics_reveal_bundle`，在文件管理器中定位 ZIP
   （Windows `explorer /select`，Linux `xdg-open`）。
4. 一条简短提示提醒用户把 ZIP 拖入 Issue 附件区域。

**不会** 有任何浏览器 DOM 自动化，**不会** 尝试自动点击 GitHub 的
Submit 按钮。

## 浏览器打开安全

`openIssueUrl` 先在 Rust 侧调 `issue_reporter_validate_url`，再调用 Tauri
opener 插件。Rust 侧校验：

- URL 必须以 `https://github.com/YAQMC/YAQMC/issues/new` 开头，
- 不允许出现空白字符，
- 长度不超过 6 000。

opener 权限声明位于 `src-tauri/capabilities/main-window.json`
（`opener:allow-open-url` 附带 URL 白名单），只允许上述 GitHub Issues
路径。两层检查都通过后浏览器才能拿到 URL。

不使用 GitHub OAuth。YAQMC 不会读取浏览器 Cookie。如果用户在浏览器里
本来就登录了 GitHub，浏览器会自动复用那次会话，仅此而已。

## 错误码

关联到应用错误时会预填一个稳定错误码。分类定义在
`src-tauri/src/error_codes.rs`，形如 `YAQMC-<DOMAIN>-<REASON>`，例如：

```
YAQMC-QQ-AUTH-COOKIES-INVALID
YAQMC-QQ-SOURCE-NO-MATCH
YAQMC-AUDIO-OUTPUT-OPEN-FAILED
YAQMC-AUDIO-DECODE-UNSUPPORTED
YAQMC-LYRICS-FETCH-FAILED
YAQMC-NETWORK-RANGE-STALLED
YAQMC-UI-EVENT
```

前端 logger 会给所有 `logger.error(...)` 调用附上 `YAQMC-UI-EVENT`，
即便旧调用点也能进入环形缓冲。

## 明确不做

- 索要 GitHub 令牌。
- 保存或读取 GitHub 凭据。
- 自动点 Submit。
- 自动上传诊断包。
- 联系任何第三方服务。
- 发送遥测。
