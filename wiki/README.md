# Wiki 发布说明

本目录是 `YAQMC/YAQMC.wiki.git` 的受版本控制源文件，不是另一套技术文档。

当前仓库为组织 GitHub Free 的私有仓库，GitHub Wiki/Pages 不能对外发布。维护者选择项目许可证、将仓库
公开并在 GitHub 创建第一张 Wiki 页面后，运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/publish-wiki.ps1
```

脚本只同步本目录列出的 Markdown 文件到 Wiki，不复制 `docs/` 的协议表或验收账本。
