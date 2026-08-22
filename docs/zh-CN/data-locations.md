# 数据位置、升级与卸载

> **简体中文** | [English](../data-locations.md)

YAQMC 将 Rust Core 的持久数据与 Chromium 的可丢弃 profile 分开。宿主升级后
Core 标识仍是 `org.yaqmc.desktop`；Electron `userData` 不存音乐库、队列、
插件、媒体缓存、日志或凭据。

## Core 管理的路径

| 用途                     | Windows                                      | Linux                                                                                                    |
| ------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 音乐库、队列、设置、插件 | `%APPDATA%\org.yaqmc.desktop`                | `$XDG_DATA_HOME/org.yaqmc.desktop`（回退 `~/.local/share/org.yaqmc.desktop`）                            |
| 媒体/封面缓存            | `%LOCALAPPDATA%\org.yaqmc.desktop`           | `$XDG_CACHE_HOME/org.yaqmc.desktop`（回退 `~/.cache/org.yaqmc.desktop`）                                 |
| Core 与 host 日志        | `%LOCALAPPDATA%\org.yaqmc.desktop\logs`      | `$XDG_DATA_HOME/org.yaqmc.desktop/logs`（回退 `~/.local/share/org.yaqmc.desktop/logs`）                  |
| 本地 API 配置            | `%APPDATA%\org.yaqmc.desktop\local-api.json` | `$XDG_CONFIG_HOME/org.yaqmc.desktop/local-api.json`（回退 `~/.config/org.yaqmc.desktop/local-api.json`） |

SQLite 数据库名为 `library.sqlite3`，位于 Core 数据目录。YAQMC 或残留
`yaqmc-core` 进程运行时不得复制或删除它，WAL sidecar 可能仍在使用。

## Electron/Chromium profile

打包后的 Electron 在 Windows 使用 `%APPDATA%\YAQMC`，Linux 使用
`$XDG_CONFIG_HOME/YAQMC`（回退 `~/.config/YAQMC`）。未打包开发模式把
`YAQMC` 换成 `@yaqmc/desktop`。这些目录包含 Chromium/GPU cache、Local
Storage 等 renderer 状态，不是权威 Core 数据库。

Electron 将 `userData` 默认定义为平台 `appData` 加应用名，Chromium session
数据也默认位于此处；见
[Electron `app.getPath` 官方文档](https://www.electronjs.org/zh/docs/latest/api/app/)。

## 凭据

秘密由操作系统凭据服务保存，服务名为 `org.yaqmc.desktop`，包括本地 API
bearer token 与 QQ 音乐 session 槽。`qqmusic-credential-v2` 是生产主槽；旧
`qqmusic-session` 仍作为有界的跨版本迁移/回滚备用。凭据值不会复制进上述
目录或诊断包。

## 升级与卸载

- 使用同一 `appId` 安装新版会保留 Core 数据与凭据服务标识。
- Windows NSIS 配置没有要求删除应用数据；electron-builder 的对应选项默认
  为 `false`。Linux 包卸载与删除 portable 二进制同样不会删除用户 home 中的
  数据。见
  [electron-builder NSIS 选项](https://www.electron.build/docs/api/app-builder-lib.interface.nsisoptions/#deleteappdataonuninstall)。
- 若要保留音乐库与设置供重装使用，只卸载程序包，不要删除上述路径。
- 若要彻底清除：应用仍能启动时先注销账号，退出全部 YAQMC/Core 进程，卸载
  或删除程序，再删除 Core 目录与 Electron profile，最后在操作系统凭据管理器
  中删除剩余 `org.yaqmc.desktop` 项。这是显式、手动且不可恢复的操作。

诊断功能可以显示实际解析路径，但不会暴露凭据值。继续阅读：[日志](logging.md)、
[诊断包](diagnostics.md)与[本地 API](local-api.md)。
