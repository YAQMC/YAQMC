# QQ 音乐提供器

> **简体中文解读** | [English protocol ledger（唯一精确账本）](../qqmusic-provider.md)

这份中文页说明边界和当前能力。所有精确 host/path、module/method、请求键、结果码、固定提交、许可证检测
以及核对日期，以英文 [协议账本](../qqmusic-provider.md)为唯一事实源，避免复制两张高频变化的协议表后
产生不一致。

## 定位

腾讯公开 Open Platform 没有为此类桌面客户端提供通用 QQ 音乐目录/播放 API；腾讯云音乐素材是独立商业
产品。YAQMC 使用腾讯托管的 QQ/微信 OAuth 和当前 QQ 音乐网页兼容接口，因此它是可能随时变化的兼容层，
不是受支持的第三方 SDK。

YAQMC 不渲染密码框、不读取腾讯页面中输入的凭据、不导入浏览器 Cookie、不绕过 DRM/会员/地区权益，
也不嵌入第一方私密客户端 secret。账号功能已实现，但真实账号写入验收仍显式 pending。

## 公开与账号能力

当前规范化能力包括歌曲/专辑搜索、专辑详情、访客歌单、榜单、QRC/LRC、清晰 vkey、账号授权 EVkey、
封面缓存；账号扩展包括 OAuth、资料、收藏、自建/收藏歌单、条件性最近播放、权益和播放 vkey。

QQ 和微信登录在受限制无痕 WebView 打开 `graph.qq.com` 或 `open.weixin.qq.com`，只接受注册的
`y.qq.com/portal/wx_redirect.html` 回调。Rust 校验 provider 类型、return URL、唯一 CSRF state 和 code，
再交换会话。OAuth WebView 无账号命令权限、拒绝 popup，也不读取 cookie/password。手机号登录和浏览器
会话导入不支持。

账号 transport 只允许精确审核的腾讯 HTTPS host，禁系统代理和自动重定向，响应 `Set-Cookie` 按秘密处理。
“参考源码相关、真实验收 pending”不能被宣传成官方或已稳定协议。

## 身份、权益与音质

规范 ID 带实体前缀，如 `qqmusic:track:<MID>`；原生不透明引用另存数字 ID/media MID，UI 不能替换。
目录 availability 和播放 capability 分开：有完整权限时进入音质候选；付费歌曲有官方片段时可试听；
仅目录标注为付费时仍可进入队列，由认证解析器最终允许、回退或拒绝。

音质顺序：自动取已授权最高完整音源；标准为 MP3/AAC；高品质先 320k；无损先 FLAC；臻品先账号授权
mflac，再向无损/高品质/标准/试听回退。实际 vkey/EVkey 响应决定候选存在，不能只拼文件名。

加密 `AIM0…mflac` / `F0M0…mflac` 只有当前规范化权益允许时才请求 `GetEVkey/CgiGetEVkey`。空/拒绝
结果是 unavailable，不是权益证明。ekey 只在原生内存中使用并可清零；缓存保存密文，decoder 读取/seek
时解密。项目不生成 vkey、ekey、订阅、账号特权或 VMP 签名。

## 研究与许可边界

协议行为研究使用固定提交并记录 GitHub 检出的许可证。GPL/LGPL 或无许可证仓库只用于定位和独立观察，
没有复制或 vendoring。Flechazo/qmc 是用户提供的 QMC/mflac 行为与流式解密思路参考，仓库未提供许可证，
因此 YAQMC 只核对行为并独立实现。实际复用的许可文本见
[THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)，人类致谢见
[ACKNOWLEDGEMENTS.md](../../ACKNOWLEDGEMENTS.md)。

## 稳定性

公开元数据缓存 15 分钟或 24 小时，歌词 30 天；账号页面使用短 TTL 且认证错误不跨会话 stale 回退。
确定性 fixture 不含秘密。真实 provider ignored tests 覆盖公开搜索、专辑、榜单、歌词、封面、音源、下载、
解码、真实时钟、暂停、seek 与输出；所有者控制的 OAuth/收藏/歌单矩阵仍待执行。

接口变化时应只修改边界 DTO/parser 和脱敏 fixture，不能把上游字段直接推入 React。
