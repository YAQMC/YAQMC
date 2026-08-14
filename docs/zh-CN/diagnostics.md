# 诊断快照与诊断包

> **简体中文** | [English](../diagnostics.md)

诊断子系统会把 YAQMC 的状态整理成一个脱敏的结构化快照，并与最近的滚动日志
一起打包为 ZIP，方便维护者复盘。

诊断 **默认本地**：不会上传，只有用户显式请求时才会生成诊断包。

## 诊断快照包含什么

`DiagnosticsSnapshot` 由 `src-tauri/src/diagnostics.rs::snapshot_from_handle`
构造，分四块：

- **`app`**：应用版本、短提交 SHA（由 `src-tauri/build.rs` 在构建时嵌入）、
  构建通道 (`stable`/`beta`/`dev`)、构建类型 (`release`/`debug`)、本次
  运行的 Session ID。
- **`platform`**：`PlatformDiagnostics`（操作系统、版本、架构、渲染器）、
  音频实现、已选输出策略、MPRIS/SMTC/托盘状态；Linux 下还包含可检测到
  的 XDG session 类型与 WebKitGTK 版本。
- **`provider`**：QQ 音乐模式 (`guest`/`authenticated`)、连接状态、账号
  状态、会员等级——绝不包含 Cookie、Session Token、uin、QR 登录密钥。
- **`playback`**：当前播放状态、已选音质代码、源分类
  (`direct-http`/`qmc-encrypted`/`local-file`)、解码器类型、简短歌曲 ID、
  播放顺序、循环模式，以及播放栏主模式（`sequential` / `shuffle` /
  `repeat-one`）——绝不包含签名后的媒体 URL。

快照还携带：

- 最近错误的环形缓冲（见下方“错误环形缓冲”一节），
- 当前日志级别，
- 当前 Session ID，
- 预留给未来 Scene Engine 的元数据字段（今日 `scene: null`，模式会累加式
  演进）。

## 诊断包

**设置 → 诊断与日志 → 导出诊断包** 调用 `diagnostics_export_bundle`，
产生：

```
YAQMC-diagnostics-YYYYMMDD-HHMMSS.zip
├── manifest.json
├── diagnostics.json
├── diagnostics.txt
├── redaction-report.txt
└── logs/
    ├── yaqmc-current.log
    ├── yaqmc-current.log.YYYY-MM-DD
    └── …（有上限；只包含当前 + 已滚动的文件）
```

- **`manifest.json`**：诊断包 schema 版本、YAQMC 版本、时间戳、平台、
  架构、包含的日志文件列表、脱敏扫描器版本、Session ID。
- **`diagnostics.json`**：机读版快照。
- **`diagnostics.txt`**：`DiagnosticsSnapshot::to_plain_text` 生成的
  人类可读版本。
- **`redaction-report.txt`**：二次安全扫描的报告。
- **`logs/`**：当前日志与滚动日志的副本，每个文件在放入 ZIP 前都会
  再扫描一次。

### 诊断包永远不会包含

- Cookie、`qm_keyst`、`qrsig`、`ekey`、`vkey`、OAuth code、Bearer Token。
- 本地 API 密钥。
- 签名后的媒体 URL。
- 已认证 HTTP 抓包。
- 真实用户名——家目录会在写入前替换为 `<USER_HOME>`。

### 二次安全扫描

尽管运行时 logger 已在触盘前脱敏，导出流水线仍会对每个即将放入 ZIP 的
文本文件再扫一遍。命中高风险模式的值会被替换为 `[REDACTED]`，事件计入
`redaction-report.txt`。若扫描后仍有未处理的高风险模式，导出会拒绝
输出“安全”诊断包，除非用户明确覆盖。

`redaction-report.txt` 不会写入敏感值本身，只记录文件名和数量。

示例：

```
Redaction scanner: v1
Files scanned: 4
Values automatically redacted: 3
Unresolved high-risk patterns: 0
```

## 错误环形缓冲

`LoggingHandle` 维护一个 `VecDeque<ErrorRecord>`（容量 64）的有界内存
环形缓冲，每条记录包含：

- 稳定错误码（见 [issue-reporting.md](issue-reporting.md#错误码)），
- 领域 (`qqmusic.auth`、`audio.output`…)，
- 若附带则包含关联 ID，
- 时间戳，
- 已脱敏的简短用户可读消息。

即使日志还没落盘，诊断快照也会带上环形缓冲的内容，所以“出错后立刻打开
报告问题”依然能拿到相关上下文。

## 用户可见错误与诊断

用户可见的错误界面只显示本地化短文本，例如 `无法打开音频输出设备`，
**绝不会** 展示 Rust `Debug` 输出。完整技术链路（栈、关联 ID、解码器
提示）留在日志与诊断快照里。用户可以在错误提示中点击“报告此问题”，
Reporter 会以预填的错误码打开。

## 设置界面

用户操作全部集中在 **设置 → 诊断与日志**：

- **日志级别**（`Info` / `Debug` / `Trace`）。
- **打开日志文件夹**：调起系统文件管理器定位日志目录。
- **导出诊断包**：生成 ZIP 并显示路径。
- **定位诊断包**：在文件管理器中定位最近一次生成的 ZIP。
- **清理旧日志**：只删除滚动文件，当前日志保留。
- **报告问题**：打开 Issue Reporter。

刻意 **不** 提供领域级别的一堆开关：日常用户不需要配置日志，维护者需要时
可以打开 `TRACE`。

## 面向未来 Scene Engine 的扩展

诊断 schema 有意向前扩展。等到 Scene Engine 落地，`diagnostics.json` 会新增
`scene` 块，包含 scene 名、版本、SHA-256、权限位。使用者必须忽略未知字段
以保证兼容性。
