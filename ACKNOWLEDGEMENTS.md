# 鸣谢

> **简体中文** | [English](ACKNOWLEDGEMENTS-EN.md)

YAQMC 是独立实现的非官方 QQ 音乐桌面客户端。感谢下面的个人、项目与工具提供公开知识、协议行为参考、
测试方法或工程协助。出现在此处不代表其作者认可、参与发布或为 YAQMC 提供支持。

## 特别感谢

- **Flechazo** — 感谢公开分享 QMC/MFLAC、臻品音质取源与本地流式解密链路的研究和工程思路。
  `Flechazo/qmc` 在核对时没有仓库许可证，因此 YAQMC 只将其作为行为参考，未复制、vendoring 或改写其
  源代码；YAQMC 的 Rust 实现与测试独立完成。
- **OpenAI Codex / GPT-5.6 Sol** — 协助工程实现、测试设计、代码审查、文档整理和发布流程。

## 互操作研究

- `L-1124/QQMusicApi`
- `wxuyu/QQMusicApi`
- `RethinkQAQ/allmusic-qqmusicapi`
- `tlyanyu/multiPlatformMusicApi`
- `wangwalk/qqm`

以上项目仅用于在固定提交上核对可观察协议行为。精确提交、GitHub 检出的许可证与使用边界见
[QQ 音乐提供器账本](docs/zh-CN/qqmusic-provider.md)。这些项目没有为 YAQMC 背书。

## QMC / mflac 基础

YAQMC 还在各自许可证允许的范围内独立适配了以下项目公开的互操作行为：

- [QMCDecode](https://github.com/gongjiehong/QMCDecode)
- [Unlock Music](https://github.com/ix64/unlock-music)
- [miaosic](https://github.com/AynaLivePlayer/miaosic)

实际复用依赖、版权与完整许可证文本见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 核心生态

感谢 Rust、Tauri、React、Rodio/CPAL、i18next、WebKitGTK、WebView2 及其维护者。没有这些可持续维护的
开放生态，YAQMC 的跨平台原生边界无法成立。

如有遗漏或归属不准确，请提交 Issue，但不要在 Issue 中粘贴账号 Cookie、token、ekey 或其他秘密。
