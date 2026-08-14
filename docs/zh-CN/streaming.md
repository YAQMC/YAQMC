# 渐进式 HTTP Range 流媒体

> **简体中文** | [English](../streaming.md)

```text
稳定的提供器缓存键
        │
完整缓存命中 ──> 本地文件解码
        │
解析一次性 URL
        │
Range: bytes=0-524287
        │
 206 ──> 稀疏可 seek 文件 ──> 解码器
        │                   ├─ seek 缺段优先
        │                   ├─ 向前预读三段
        │                   └─ 完整后原子提升到缓存
 200 / 合法 416 ──> 有上限的完整下载回退
```

HTTP 逻辑集中在 `streaming.rs`，Rodio 只接收 `Read + Seek`。段大小 512 KiB，向前预读三段（1.5 MiB）。
清晰音源单文件上限 128 MiB，完整媒体缓存总上限 256 MiB。

## 授权 mflac

仅当 QQ 音乐为当前账号返回加密 URL 和 ekey 时启用。稀疏缓存只保存加密 `.mflac`；
`QmcReader<Read + Seek>` 按偏移应用 Map/分段 RC4 变换，Rodio 看到可 seek 的普通 FLAC，不产生明文
缓存文件。ekey 使用可清零、禁止日志输出的原生类型，不进入播放快照、缓存标识或诊断数据。

这条链路不会生成或伪造 vkey/ekey、VMP 签名、订阅或账号权益。服务端未返回已授权 EVkey 时，系统
只能选择其他合法音源或给出结构化权益/音源错误。

### QMC 密码选择与 Map 旋转

`QmcDecryptor::new` 从 ekey 派生流密钥（`derive_key`，含存在时的 `QQMusic EncV2,Key:` 双层 TEA 包装），
再按派生密钥长度选择密码：长度超过 300 用分段 RC4，否则用 Map 密码。Map 加密的无损曲目必须使用精确的
掩码形式 `(key << rot) | (key >> rot)`，其中 `rot = ((key_index & 7) + 4) % 8` —— 这是一种非循环组合，
与 `u8::rotate_left` 不同。早期误用循环旋转会对所有 Map 加密源产生错误的掩码流（解密头部为 `714b6c4d`
而不是 `fLaC`）；因为 RC4 曲目不受影响，所以只在固定 Map 曲目上暴露。两种密码都按偏移可寻址，因此稀疏
`Range` 读取和 seek 会在绝对文件偏移处正确解密。

诊断区分失败层次：

- `qmc` 构造解密器成功时的 info 记录 `ekey_length`、`ekey_v2`、`derived_key_length` 和 `cipher`。
- `media` 构造失败时的 warn 记录 ekey 形态和具体 `QmcError`
  （`KeyNotBase64`、`InvalidV2Wrapper`、`InvalidDerivedKeyLength`、`TeaPaddingMismatch`、`EmptyCipherKey`）。
- `audio` 对 FLAC 签名探测失败时的 warn 记录 `cipher`、`derived_key_length` 和解密后的魔数，
  可区分“密钥错误”与“流偏移错位”。

## 正确性约束

- 206 必须包含精确、不反转且总长度一致的 `Content-Range`；
- 后续 Range 被服务器忽略并返回 200 时，只接受内容长度完全匹配的完整源；
- 同一文件只有一个下载 worker，重叠读取不会重复下载同一段；
- seek 缺段优先于预读，单段最多等待 20 秒；
- 稀疏临时文件使用随机名，最后一个 reader 释放后删除；
- 完成文件经随机 staging、原子提升和 LRU 限额处理；签名 URL 不是缓存键；
- 换歌会取消 worker；后续 Range 遇到过期 URL 只刷新一次，并从真实旧位置重建解码器。

确定性本地 HTTP fixture 覆盖 206、200 回退、416、重叠读取、未缓存 seek、取消、临时文件清理、
缓存提升和 403 过期。外部 `.mflac` + ekey 测试文件不会提交到仓库。
