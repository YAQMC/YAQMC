# 外观与个性化

> **简体中文** | [English](../appearance.md)

外观是可版本化、可序列化的偏好领域，不接受任意 CSS/JavaScript。保存模型分别描述颜色模式、主副色、
背景、材质、主歌词样式和各歌词窗口设置，未来可以安全导入导出。

## 主题 token

`src/application/theme-tokens.ts` 接收最终浅/深模式、主色、副色、表面不透明度和材质，验证 3/6 位
十六进制颜色并派生 hover、active、selection、focus、次要色、可读的强调色前景和各层表面透明度。
组件只消费 `--accent-primary`、`--accent-ink`、`--surface` 等 token，不逐按钮写颜色。

表面不透明度限制在 85–100%，只改变表面背景 alpha，文本、图标和封面保持清晰。系统模式实时订阅
`prefers-color-scheme`。预设包括默认、Apple 红、海洋、紫罗兰、樱花、薄荷、单色和自定义。错误颜色
不会覆盖上一个合法值；重置只重置外观部分。

## 背景

- 默认：主题基础背景；
- 专辑封面：安全封面 data URI 加可读性 tint；
- 自定义颜色：已验证本地颜色；
- 自定义图片：由系统文件选择器导入并托管的本地图片，可 Cover/Contain。

图片真实路径不进入 Web 层。Rust 只接受 24 MiB 以内 PNG/JPEG/WebP/BMP/GIF，校验文件魔数后复制到
应用数据 `backgrounds`，只保存受约束相对引用，通过窄命令返回 data URI。丢失/损坏时给出可恢复通知。

沉浸歌词沿用同一安全模型，绝不插入原始远程封面 URL。只允许审核后的安全 data URI；加载失败或旧
曲目结果会退回主题底色。Windows 已完成记录在 [Windows 验收](windows-acceptance.md)中的本机视觉矩阵，
但该证据不是最终安装包验收。

透明材质只在安全范围降低表面 alpha 并启用克制的 CSS backdrop 回退。Linux 合成器差异较大，因此
优先保证 resize 稳定，不依赖私有模糊 API。偏好以 `ui-preferences-v1` 持久化并广播给各应用窗口。
