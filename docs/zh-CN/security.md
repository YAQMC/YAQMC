# 安全与隐私

> **简体中文** | [English](../security.md)

本文写明 YAQMC 的隐私契约以及支撑这份契约的分层防护。每一条承诺都是
可测试的行为，仓库里都有对应的自动化测试。

## 运行时隐私契约

- **零遥测**：应用不 phone home。没有分析 ID、崩溃 beacon 或“使用统计”
  开关。真正的网络行为只有用户面对的音乐 provider，以及用户主动打开 Issue
  时启动的浏览器。
- **凭据只存 OS keyring**：QQ 音乐 Cookie 保存在
  `credentials/PlatformCredentialStore`，绝不接触日志、诊断快照或诊断包。
- **不引入第三方 CDN**：前端只随包本地资源。
- **用户自持身份**：`logging.rs` 生成的 Session ID 每次启动重生成、不持久化，
  跨安装无法关联同一位用户。

## 脱敏

`RedactingWriter` 包裹 tracing 的 file sink。任何写入磁盘的行都先经
`scrub_high_risk_patterns` 处理，被脱敏的模式包括：

- `Cookie` 请求头、`Authorization` 请求头的值，
- OAuth code、Bearer Token，
- QQ 音乐 `qm_keyst`、`qrsig`、`ekey`、`vkey`、`p_skey`、`p_uin`、`uin`，
- 播放 URL 中的 `authenticated=`、`vkey=` 参数，
- 密码类值 (`password=`、`passwd=`、`secret=`、`token=`)，
- 本地 API 密钥，
- 家目录路径（重写为 `<USER_HOME>`）。

优先使用结构化 tracing 字段，避免通过字符串插值 `tracing::info!("...{token}")`
漏出敏感数据。

`src-tauri/src/logging.rs` 的自动化测试把所有代表性敏感模式喂进
writer，断言输出只剩 `[REDACTED]`。

## 诊断包安全

`src-tauri/src/diagnostics.rs::export_bundle` 会对每一个即将放入 ZIP
的文本文件跑一遍第二次扫描。`RedactionReport` 写入
`redaction-report.txt`，记录：

- 扫描器版本（今日 `v1`），
- 扫描文件数量，
- 已脱敏值数量，
- 未处理高风险模式列表（正常情况下为空）。

若有高风险模式在二次扫描后仍然存在，导出会拒绝生成“安全”诊断包，
除非用户显式覆盖。UI 上刻意不放出该覆盖开关，需要时由维护者手动
构造原始命令负载。

诊断包永远不会包含：

- Cookie、`qm_keyst`、`qrsig`、`ekey`、`vkey`、OAuth code、Bearer Token；
- 账号 session 文件或 SQLite 二进制；
- 已认证 HTTP 抓包；
- 本地 API 密钥；
- QR 登录密钥；
- 真实用户名——家目录已被替换为 `<USER_HOME>`。

诊断包的 SHA-256 会在 UI 上展示，方便收到副本的维护者校验完整性。

## Issue Reporter 安全

- **永远不索要 GitHub 令牌**：Reporter 不会请求 Personal Access Token、
  不保存任何凭据、不调用 GitHub API。
- **只由用户手动提交**：YAQMC 在用户默认浏览器中打开预填的 Issue Form，
  用户复查后自己点 Submit。
- **限定 opener 权限**：`openIssueUrl` 先调 Rust 的 `validate_open_url`
  校验，再调用 Tauri opener 插件，插件权限
  (`capabilities/main-window.json`) 只允许
  `https://github.com/YAQMC/YAQMC/issues/new*`。
- **不访问浏览器 Cookie**：不读系统浏览器 Cookie 存储、不嵌套 WebView、
  不做 DOM 自动化。

## 日志与诊断包的威胁面

- 用户把日志内容贴到公开论坛：由写入前脱敏、导出二次扫描、`[REDACTED]`
  哨兵三层缓解。
- 用户换凭据后又附了旧滚动日志：由同一次二次扫描缓解。
- 用户无意间附错诊断包：由 SHA-256 展示与“定位诊断包”动作缓解。
- 用户被引导打开伪装的 Reporter URL：不可能；opener 权限只允许固定的
  GitHub Issues 路径。

## 协同披露

安全类问题不走 Issue Reporter。请通过
`.github/ISSUE_TEMPLATE/config.yml` 与 `SECURITY.md` 中提供的“安全咨询”
链接私下报告。
