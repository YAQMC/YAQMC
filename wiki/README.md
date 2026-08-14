# Wiki 发布说明

本目录是 `YAQMC/YAQMC.wiki.git` 的受版本控制源文件，不是另一套技术文档。

GitHub Wiki 目前不是交付目标。本目录仅保留历史源文件；项目网站由 `.github/workflows/pages.yml` 从
`site/` 构建。若以后启用 Wiki，可以在 GitHub 创建第一张页面后运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/publish-wiki.ps1
```

脚本只同步本目录列出的 Markdown 文件到 Wiki，不复制 `docs/` 的协议表或验收账本。
