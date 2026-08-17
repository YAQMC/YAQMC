# 桌面平台集成

> **简体中文** | [English](../platform-integration.md)

Tauri 命令、本地 HTTP、托盘、快捷键、MPRIS 和 SMTC 都只是 Rust `PlayerService` 的适配器，不持有
独立队列或播放状态。

原生 MPRIS/SMTC 由 Core 持有。Tauri 在启用任何原生回调前订阅封闭的 Core `HostCommand` 总线，并注入不透明的
可选 Win32 HWND 与 Tokio runtime handle。Core 不依赖 Tauri、WebKit、`raw-window-handle`、provider、Node、Electron
或 N-API；`Raise`/`Quit` 只能发布 host command，显示/聚焦窗口和退出进程仍由 Tauri 执行。

## Linux MPRIS 2.2

通过 `mpris-server`/zbus 在 `/org/mpris/MediaPlayer2` 提供标准 Root 与 Player 接口，支持播放、暂停、
停止、上下首、seek、音量、循环和随机。元数据只含稳定哈希 TrackId、标题、艺人、专辑、时长和安全
封面 URL，绝不导出签名播放地址。`Raise`/`Quit` 发布 host command，由 Tauri 显示主窗口或退出。

Arch 基线只证明服务成功启动，尚未记录 `playerctl` 或桌面 shell 的真实控制结果；这仍是 HUMAN/platform gate。

## Windows SMTC

SMTC 通过 Tauri 注入的、不透明的主窗口 HWND 绑定。系统的播放、暂停、上下首、停止、相对/绝对 seek 与音量回调
使用注入的 runtime handle 进入同一 `PlayerService`；`Raise`/`Quit` 发布 host command。曲目、时长、封面和状态
再投影给 Windows。进度更新会节流；真实 SMTC 硬件交互仍是 HUMAN/platform gate。

## 托盘、关闭与歌词恢复

托盘菜单提供显示、播放/暂停、上下首、解锁歌词窗口和退出。主窗口默认关闭到托盘，也可在设置中
改为完全退出。锁定歌词窗口后，内容窗口完全点击穿透；右上方另有只具备单条解锁命令权限的小窗口。
设置页和托盘仍保留恢复入口。

## 快捷键与输出设备

可选全局快捷键默认关闭：`Ctrl+Alt+Space`、`Ctrl+Alt+Left`、`Ctrl+Alt+Right`。注册是事务式的，
任一冲突会撤销已注册部分。Linux 原生 Wayland 不宣传 X11 全局快捷键，媒体键通过 MPRIS 处理。

输出设备使用稳定哈希 ID。切换时先打开新 sink，再恢复已准备音源、真实位置、音量和播放/暂停状态，
成功后才交换；失败不破坏旧设备。设备消失时有限次尝试系统默认设备。

`SystemDefault` 是策略，不是缓存的设备身份。每次首次打开和恢复都会重新向 CPAL 查询当前原生默认设备，
再通过 Rodio 的 device sink builder 打开该设备。诊断会同时显示持久化选择类型和当前解析出的设备、驱动、
host。恢复最多重试五次、间隔两秒，并保留最后一次输出错误，不能把无声失败伪装成健康状态。
