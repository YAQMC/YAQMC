# 登录与秘密存储

> **简体中文** | [English](../authentication.md)

## 当前状态

应用默认以访客模式启动。QQ 和微信登录会打开受限制、无痕的腾讯 OAuth WebView。Rust 在跳转前拦截
已注册 QQ 音乐回调，校验一次性 code 与 CSRF state，再交换为规范化会话。YAQMC 不渲染密码表单、不读
用户在腾讯页面输入的凭据、不复制 WebView Cookie，也不要求粘贴会话。该集成属于兼容接口，不是腾讯
公开支持的第三方 QQ 音乐 SDK；真实账号完整验收仍待完成。

状态机区分访客、恢复中、等待授权、已认证、取消/过期/拒绝、网络/协议错误、需要重新认证和安全存储
不可用。React 只收到不透明 attempt/lease ID、节奏/过期时间、脱敏资料、权益、能力和 revision。

## 安全存储

`CredentialStore` 是秘密唯一持久化接口。`PlatformCredentialStore` 通过 Rust `keyring` 使用操作系统
凭据服务，服务名为 `org.yaqmc.desktop`，并一次性迁移旧的 `dev.music-client.desktop` 数据。不存在
明文文件、SQLite、浏览器存储、环境变量或日志回退。

- `qqmusic-session-staging`：事务候选槽；
- `qqmusic-session`：当前提供器会话；
- `local-api-bearer-token`：本地 API 随机 32 字节 token。

若旧配置含明文本地 API token，启动会尝试迁入系统凭据服务并无条件移除明文字段。安全存储不可用时
监听器 fail closed，绝不把秘密写回文件。

## OAuth 所有权和会话提升

只有标签精确为 `main` 的 WebView 拥有 `qqmusic-account` capability，Rust 命令还会再次检查调用者。
歌词窗口和远程 OAuth WebView 无法调用账号命令。OAuth 只允许所需 HTTPS 域名，禁止 popup、自动填充和
devtools，并验证回调 origin/path、登录类型、return URL、唯一 state 和 code 长度。主窗口对话框用不透明
lease 保持所有权；所有者关闭/重载、OAuth 窗口丢失或 lease 超时会取消，单次最长五分钟。

确认后的事务顺序是：验证候选；读取旧 active；写入并回读 staging；验证 staging；写入并回读 active；
删除 staging/旧账号缓存；发布脱敏资料。promotion、restore、logout 由同一生命周期互斥锁串行，并在每个
异步存储/网络边界复查 generation/scope。激活前失败清 staging；激活后失败恢复并回读旧 active。

## 网络与威胁边界

账号流量使用禁用系统代理、精确 host/path 白名单、显式取消且不自动重定向的专用客户端。最多手动跟随
三次审核后的重定向；跨源移除秘密 header，带认证 body 的跨源保留方法重定向直接拒绝。账号写不重试，
日志只保留脱敏结构。

操作系统安全存储可以防止普通文件检查和误上传，不抵御以同一用户权限运行、能访问凭据服务或进程内存
的恶意软件。确定性测试不会把 OAuth code、资料、Cookie、token、歌单名或响应体提交为证据。
