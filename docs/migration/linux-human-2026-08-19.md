# HUMAN 台账 — 从 PLAY-01 起（含交接已测）

工作会话从交接 **§13 / PLAY-01** 起算（本聊天 2026-08-18 21:06 起：先工作树，再测卡住的播放器）。  
**以前的也计入：** [`HANDOFF_2026-08-18.md`](HANDOFF_2026-08-18.md) **§4** 里、PLAY-01 之前已经 PASS-HUMAN 的宿主操作（Windows，`1d6b535` 当时）。那份交接的 **§5 失败格子和 HEAD 不要当今天的现状**。

**不是阶段签字。** 口头 OK、有代码、PASS-AUTO 都不能把 PLAY-01 / PLAT-* 标成仓库验收通过。[`p7-playback-checklist.md`](p7-playback-checklist.md) 勾选框保持空。  
**Current Status（2026-08-20）** 以 [`acceptance-p12.md`](acceptance-p12.md) 为准：PLAY-01 / PLAY-02 / SOAK-01 首次 4h / SURF-02 / 桌面歌词 / 歌词岛 / SURF-03 / PLAT-01 / PLAT-05 / PLAT-07 / ACCT-01..03 已 **PASS-HUMAN**。下面本会话口头台账是历史，不能盖过 Current Status。

Windows 代理 AUTO/LIVE 台账（不覆盖本文件口头结果）：[`qa-agent-2026-08-19.md`](qa-agent-2026-08-19.md)。

| 字段                | 值                                                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 分支                | `feat/electron-migration`（`main` 冻结）                                                                                                           |
| 实现 HEAD（已提交） | `07f87f2` MPRIS 进度                                                                                                                               |
| 工作区              | 未提交：PLAT-03 托盘语言；PLAT-07 live `platform_diagnostics` + 窗口后端探测（Ozone + fd）；PLAY-03 应用内歌词钟不再因 `document.hidden` 停        |
| 本会话              | Linux **Wayland**（维护者默认测试环境，2026-08-19 起）。不要改去 X11 会话补测。`dev:desktop` + debug Core；维护者 Osilvfe                          |
| 应用窗口后端        | 默认仍是 ADR-008 的 X11/XWayland ozone。会话 Wayland ≠ 应用 native-Wayland。不要为了出 SURF-06 横幅去设 `YAQMC_LINUX_RENDERER`，除非维护者明确要求 |
| 交接已测            | Windows `dev:desktop`；维护者见交接；HEAD 当时 `1d6b535`                                                                                           |
| 本机 Windows        | **整机跳过**（含 PLAT-04 SMTC、SURF-04）                                                                                                           |
| PLAT-02             | **本机 Wayland 无法测试**（2026-08-19）。Windows 维护者 2026-08-19 记为 PASS-HUMAN。媒体键 ≠ PLAT-02                                               |
| SURF-03             | **本机 Wayland 暂时不测**（2026-08-19）。不当 FAIL。X11/Windows 另测                                                                               |

词汇：

| 标记                | 含义                                                                           |
| ------------------- | ------------------------------------------------------------------------------ |
| **交接 PASS**       | 交接 §4 已人工通过。平台是 **Windows**。本 Linux 机未复测，但计入台账。        |
| **测过（口头 OK）** | 本 Linux 会话维护者明确说过可用。仍不是阶段绿。                                |
| **测过（有缺陷）**  | 本会话测到失败或只修了一部分。                                                 |
| **未测**            | 没有按这条做。                                                                 |
| **跳过**            | 本机会不上。跳过 ≠ 失败，也不等于已测通过。                                    |
| **未开始**          | 本会话当时未做。2026-08-20 起 ACC-01..04 已按豁免开台账；ACC-05 / P13 仍禁止。 |

---

## 指针（测到哪）

本文件 2026-08-19 会话停在 **SURF-06 native-wayland 口头 OK**。那是历史。  
**Current Status：** [`acceptance-p12.md`](acceptance-p12.md)。不要把 PLAY-01 / SURF-02 / SURF-03 / 桌面歌词 / 歌词岛 / PLAT-01/05/07 / ACCT 再当「下一格」。

1. 交接 §4 宿主/窗口操作：**已计入**（Windows）。本 Linux 机未复测那些铬/ZIP/背景行。
2. PLAY-01 **Current Status = PASS-HUMAN**（含 Repeat / EOS / seek）。本会话口头 OK 是前史。
3. SURF-02 / 桌面歌词 / 歌词岛 / SURF-03：**PASS-HUMAN**（`27d10b0`）。本会话「不复测 / Wayland 暂时不测」是前史。
4. **SURF-06** xwayland 说明仍 **未测**。native-wayland 口头 OK 未升格进 2026-08-20 PASS-HUMAN 集合。
5. **P12 ACC-01** 剩余是 §29.5 发行版矩阵（Ubuntu X11 / Fedora / Arch+Hyprland / KDE），不是切 X11 去补 PLAT-02。PLAT-02 本机 Wayland **跳过** 仍成立。
6. 不要做 ACC-05 / P13。

维护者默认 HUMAN 平台是 **Wayland**。不要建议切 X11 只为补 PLAT-02。

禁止：ACC-05 / `pre-tauri-removal`、P13–P15、`qm-api-rs`、provenance 补救、GitHub Actions 派发、改 `main`、在代理里跑 4h soak、编造 PLAY-02 p95。  
P12 ACC-01..04 已按 [`p12-conditional-entry.md`](p12-conditional-entry.md) 开台账（[`acceptance-p12.md`](acceptance-p12.md)）。Actions 配额耗尽是 **BLOCKED-EXTERNAL**，不是产品失败。P11 不标 PASS。

---

## 全程一览（PLAY-01 前已测 + 本会话）

| ID / 项                                              | 交接（Windows，§4）                                                  | 本会话（Linux）                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| ELEC 原生宿主能起来                                  | **交接 PASS**                                                        | 本会话一直在 `dev:desktop` 上跑，未单独再签一条                              |
| SUP Core ready / `host.log` 二进制                   | **交接 PASS**（`bf43c53` 后）                                        | 本会话多次按 debug Core 排过陈旧二进制                                       |
| FE-04 最小化 / 最大化 / 关闭（关到托盘）             | **交接 PASS**                                                        | **未复测**                                                                   |
| FE-04 GitHub 外链 / 打开日志目录                     | **交接 PASS**                                                        | **未复测**                                                                   |
| FE-04 诊断 ZIP 取消 / 保存                           | **交接 PASS**                                                        | **未复测**                                                                   |
| FE-04 大背景图 PNG/JPEG                              | **交接 PASS**（`c992653`）                                           | **未复测**                                                                   |
| PLUG-01 从文件安装（越过 ACL，进到插件逻辑）         | **交接 PASS**（仅这条路径）                                          | **未复测**；全套电池仍 **未测**                                              |
| SURF-02 点击穿透 / 锁定                              | **交接 PASS**（窗口行为，不是歌词内容）                              | **不复测**（交接已计入）                                                     |
| SURF-04 全屏隐藏歌词浮层                             | **交接 PASS**                                                        | **不复测**（交接已计入；本机也是 Windows 项）                                |
| PLAY-01 播放器卡住（EOS / 单曲循环 / 随后控件死）    | **FAIL-HUMAN**（`1d6b535`）                                          | **测过（有缺陷）→ 已修后再测过**                                             |
| PLAY-01 §13 循环 / seek / 歌词钟 / 桌面歌词 / 歌词岛 | 交接时未再验或 FAIL                                                  | **测过（口头 OK）**                                                          |
| PLAY-01 封面 / 首页 / 音量 / Shuffle / 队列重启      | 交接未再验或次优先                                                   | **测过（口头 OK）**                                                          |
| PLAY-01 QQ LIVE 登录接续 / 收藏 / 浏览 / 歌词 / QMC  | 交接 NOT TESTED                                                      | **测过（口头 OK）**                                                          |
| PLAY-02 p95 / SOAK-01                                | NOT TESTED                                                           | **未测**（不要编 p95；不要跑 4h）                                            |
| PLAY-03 挡住窗口后歌词钟                             | NOT TESTED                                                           | **测过（口头 OK）** 本机盖窗；可能与平台有关。Windows / Tauri 节拍未测       |
| 本地文件播放入口                                     | 无 UI，不要发明                                                      | **未测**                                                                     |
| PLAT-01 托盘                                         | OS 图标 NOT TESTED；E2E 只点菜单                                     | **测过（口头 OK）**                                                          |
| PLAT-02 全局快捷键                                   | **Windows PASS-HUMAN（2026-08-19）**                                 | **跳过（Wayland 无法测试）**                                                 |
| PLAT-03 托盘跟语言                                   | NOT TESTED                                                           | **测过（口头 OK）**（先失败，修后再过）                                      |
| PLAT-04 SMTC                                         | NOT TESTED                                                           | **跳过**                                                                     |
| PLAT-05 MPRIS                                        | NOT TESTED                                                           | **测过（口头 OK）**                                                          |
| PLAT-06 Local API SSE                                | NOT TESTED（仅 mock 脚本）                                           | **测过（口头 OK）** LIVE 脚本 2026-08-19                                     |
| PLAT-07 linux-graphics / 平台诊断                    | NOT TESTED                                                           | **测过（口头 OK）** 默认 Wayland 检测到 wayland（2026-08-19 01:45）          |
| SURF-01 桌面歌词 + 歌词岛窗口                        | 渲染过；内容 FAIL                                                    | **不复测窗口创建**（交接已渲染；本会话同步口头 OK）                          |
| SURF-03 几何持久化                                   | NOT TESTED                                                           | **跳过（Wayland 暂时不测）**                                                 |
| SURF-05 表面 ACL                                     | PASS-AUTO                                                            | 不要改 ACL                                                                   |
| SURF-06 Wayland 能力横幅                             | NOT TESTED                                                           | **测过（口头 OK）** native-wayland 出横幅（2026-08-19 02:28）。xwayland 未测 |
| ACCT-01/02/03 OAuth / 扫码 / 钥匙串改名              | NOT TESTED                                                           | **未测**（本会话是已有会话登录，不是那些清单）                               |
| PACK / CI 直播 / UPD / ACC / P12+                    | CI/UPD = **BLOCKED-EXTERNAL**（配额）；PACK/PLUG 全套 = **DEFERRED** | ACC-01 已开台账（本文件口头结果计入）；ACC-05 / P13 **未开始**               |

---

## 交接已计入（PLAY-01 之前，Windows §4）

来源：交接 2026-08-18，`19dec97` → `c992653` 链。不证明 PLAY-01。本 Linux 机没有重做这些行。

| 项                                          | 交接 HUMAN                                             |
| ------------------------------------------- | ------------------------------------------------------ |
| Electron 原生宿主启动                       | PASS                                                   |
| 当前 debug Core 起来并 ready                | PASS（始终核对 `host.log` `supervisor start binary=`） |
| 最小化                                      | PASS                                                   |
| 最大化 / 还原                               | PASS                                                   |
| 关闭（关到托盘路径）                        | PASS                                                   |
| 设置里打开 GitHub                           | PASS                                                   |
| 打开日志目录                                | PASS                                                   |
| 诊断导出取消                                | PASS                                                   |
| 诊断导出保存出 ZIP                          | PASS                                                   |
| 背景 PNG/JPEG（含大图）                     | PASS                                                   |
| 从文件安装插件进到业务逻辑（不是 ACL 挡掉） | PASS（仅该路径）                                       |
| SURF-02 点击穿透 / 锁定解锁                 | PASS（窗口，不是歌词内容）                             |
| SURF-04 Windows 全屏隐藏/恢复歌词表面       | PASS                                                   |

交接 §4.3 里 `1d6b535` **之前** 的播放/暂停、音量、静音、队列改动：当时算控件能用，**不能**当作 PLAY-01 通过；已被 §5 EOS 失败覆盖。本会话已按 §13 重测播放器。

---

## PLAY-01 / 交接 §13（本 Linux 会话）

本聊天的起点。实现从 `1d6b535` 卡播放器修到当前 `07f87f2`。

| #    | 项                                       | 本会话                           | 依据                                                                         |
| ---- | ---------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------- |
| 缺陷 | EOS 后单曲循环不重播、控件假死           | **测过（有缺陷）→ 已修后再测过** | 进度条不动 / 单曲不循环；修 Electron 时钟 + 官方试听文件时钟后「此次正常了」 |
| 1    | Repeat One / All / Off（含最后一首停住） | **测过（口头 OK）**              | 「1–3 应当无问题」含 Repeat Off                                              |
| 2    | 曲终后 seek                              | **测过（口头 OK）**              | 「拖动应当也没有问题」                                                       |
| 3    | 切歌从 0:00、无暂停闪一下                | **测过（口头 OK）**              | 「现在切换下一首会从 0 开始」「不会闪暂停」                                  |
| 4    | 全屏歌词时钟                             | **测过（有缺陷）→ 再测过**       | 先不对齐；跟文件时钟对齐后未再报失败                                         |
| 5    | 桌面歌词                                 | **测过（口头 OK）**              | 「桌面歌词 / 歌词岛歌词同步没有问题」                                        |
| 6    | 歌词岛                                   | **测过（口头 OK）**              | 同步 + 「歌词岛的进度没有问题」                                              |
| 7    | 封面 / 首页                              | **测过（口头 OK）**              | 「热门歌单无问题了」「首页没问题」                                           |
| 8    | 音量条                                   | **测过（口头 OK）**              | 「此次音量调节没有问题了」。静音未单独点名                                   |
| 9    | Shuffle                                  | **测过（口头 OK）**              | 「1–3 应当无问题」；后来说 shuffle 已经测过                                  |
| 10a  | PLAT-04 SMTC                             | **跳过**                         | Windows                                                                      |
| 10b  | QQ LIVE 登录 / 重启接续                  | **测过（口头 OK）**              | 先掉登录；修 `restore_session` 后「首页和账号的接续应该已经没有问题了」      |
| 10c  | 收藏                                     | **测过（口头 OK）**              | 「收藏无问题」                                                               |
| 10d  | 加到歌单                                 | **测过（口头 OK）**              | 歌单页加号曾失败；三点菜单「添加到」后「1–5 应该无大问题」                   |
| 10e  | 搜索 / 发现 / 专辑 / 歌单                | **测过（口头 OK）**              | 含在 1–5；发现封面单独复测 OK                                                |
| 10f  | 在线歌词                                 | **测过（口头 OK）**              | 含在 1–5                                                                     |
| 10g  | HQ / QMC 听完                            | **测过（口头 OK）**              | 含在 1–5                                                                     |
| —    | 队列重启仍在                             | **测过（口头 OK）**              | 「队列还在」                                                                 |
| —    | 官方试听长度 1 分钟                      | **测过（口头 OK）**              | 「现在是 1 分钟了」                                                          |
| —    | 界面不透明度滑块                         | **测过（口头 OK）**              | 85%–100% 一档一格，不是卡顿                                                  |
| —    | 本地文件播放入口                         | **未测**                         | 没有 UI 入口                                                                 |
| —    | PLAY-02 / SOAK-01                        | **未测**                         | 不要编 p95；不要跑 4h                                                        |
| —    | PLAY-03 挡住窗口后歌词钟                 | **测过（口头 OK）**              | 2026-08-19 01:58 本机盖窗没问题。可能与平台有关。不签绿                      |

## PLAY-03（本会话）

应用内 `LyricsViewport` 以前在 `document.hidden` 时停行界定时器和逐字 rAF。已改成只跟 `isPlaying`。桌面歌词 / 歌词岛本来就不看 hidden。主窗口和歌词表面 `backgroundThrottling: false` 没改。单元测试：隐藏播放仍排定时器、写词进度；隐藏时 seek 立刻跳行。

本机盖窗 **口头 OK**（2026-08-19 01:58）。维护者认为可能与平台有关：本机 Linux Wayland 上用别的窗口盖住主窗口，不一定会触发 Page Visibility（`document.hidden` 更常见于最小化 / 切工作区）。Windows 挡住或最小化仍 **未测**。相对 Tauri 的节拍仍未测。

**不是 PLAY-03 通过。** PLAY-02 p95 不要编。4h soak 不要跑。

---

访客态首页曾报过、**登录后没有再点名**（不当作仍失败，也不当作已复测）：

- 「听 XXX 也会喜欢」不显示
- 新歌推荐点开「此项目不可用」
- 每日 30 首下面显示 55 首

---

## SURF（本 Linux 会话）

| ID          | 测什么                     | 本会话                                                        | 下一步                      |
| ----------- | -------------------------- | ------------------------------------------------------------- | --------------------------- |
| **SURF-01** | 创建/显示桌面歌词 + 歌词岛 | **不复测**（交接已渲染；本会话同步口头 OK）                   |                             |
| **SURF-02** | 锁定 / 点击穿透            | **不复测**（交接 PASS）                                       |                             |
| **SURF-03** | 几何持久化 / 重启恢复      | **跳过（Wayland 暂时不测）**                                  | 不当 FAIL。X11/Windows 另测 |
| **SURF-04** | Windows 全屏隐藏           | **不复测**（交接 PASS）                                       |                             |
| **SURF-05** | 表面 ACL                   | PASS-AUTO                                                     | 不要改 ACL                  |
| **SURF-06** | 设置能力横幅               | **测过（口头 OK）** native-wayland 出横幅（2026-08-19 02:28） | 不签绿。xwayland 说明未测   |

---

## PLAT（本 Linux 会话）

| ID          | 测什么                                  | 本会话                       | 下一步                                                              |
| ----------- | --------------------------------------- | ---------------------------- | ------------------------------------------------------------------- |
| **PLAT-01** | 托盘图标 / 菜单 / 显示隐藏              | **测过（口头 OK）**          | 设置诊断行归 PLAT-07，已过                                          |
| **PLAT-02** | `Ctrl+Alt+空格 / ← / →`                 | **跳过（Wayland 无法测试）** | 不当 FAIL。X11/Windows 另测。Windows 已 PASS-HUMAN（2026-08-19）    |
| **PLAT-03** | 托盘菜单跟界面语言                      | **测过（口头 OK）**          | 先失败后修过。未提交。不签绿                                        |
| **PLAT-04** | Windows SMTC                            | **跳过**                     |                                                                     |
| **PLAT-05** | MPRIS 媒体键 / 进度 / Raise / Quit      | **测过（口头 OK）**          | 脚本 `--execute`、GNOME/KDE 小部件 **未记**                         |
| **PLAT-06** | Local API + SSE                         | **测过（口头 OK）**          | LIVE 脚本 2026-08-19。不签绿。token 曾在聊天出现，设置里应重新生成  |
| **PLAT-07** | linux-graphics / `platform_diagnostics` | **测过（口头 OK）**          | 默认 Wayland 正确检测到 wayland（2026-08-19 01:45）。不签绿。未提交 |

---

## 开放缺陷

本段是 2026-08-19 会话当时的开放项。PLAY-01 / PLAT-05 / PLAT-07 / SURF-03 的
**Current Status** 已是 PASS-HUMAN，见 [`acceptance-p12.md`](acceptance-p12.md)。

1. 访客首页三条登录后未再点名。
2. PLAT-03 托盘语言仍是本会话口头 OK，未列入 2026-08-20 PASS-HUMAN 集合。PLAY-03 仍只是盖窗口头 OK。
3. PLAT-02 本机 Wayland **跳过**（不当 FAIL）。Windows 已 PASS-HUMAN。
4. `LyricsPanel` native remote artwork 单元测试已在代理 AUTO 修过；仍不是单独的 HUMAN 封面验收。

---

## 不要做的下一格

- 不要在本机 Wayland 上补测 PLAT-02。SURF-03 Current Status 已是 PASS-HUMAN，不要当失败项重测。
- 不要让维护者切到 X11 会话来补 PLAT-02（默认测试环境就是 Wayland）。
- 不要把台账抄进 `p7-playback-checklist.md` 当勾选通过。
- 不要改写 `HANDOFF_2026-08-18.md` 冒充当天 HEAD。
- 不要把 ACC-01 / ACC-02 整行标 PASS（目录 ID 过了 ≠ 矩阵签绿）。
- 不要把默认启动看不到 SURF-06 横幅当成失败。
- 不要编 PLAY-02 毫秒数。不要在代理里跑 4h soak（第一次 4h 已 PASS-HUMAN；P12 第二次 soak 仍开）。
- 不要把 Actions 配额写成产品失败。不要把 P11 标 PASS。不要做 ACC-05 / P13。
