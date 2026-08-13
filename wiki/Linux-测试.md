# Linux 测试

正式测试只使用 release/workflow 提供的扁平 tester bundle，不需要 checkout 仓库。先运行：

```bash
sha256sum -c SHA256SUMS
node verify-lyrics-acceptance.mjs --platform linux --identity-only \
  --build-identity "$PWD/BUILD-IDENTITY.json"
```

在同一个验收根目录依次采集 `auto`、`native-wayland` 和 `x11`。只有前面的原生模式复现图形故障后，
才能使用带 `YAQMC_ALLOW_SOFTWARE=confirmed-native-failure` 的 `software` 对照。

测试应覆盖播放、seek/暂停/恢复、滚动/resize、歌词 Normal/Focus/原生全屏、桌面歌词、歌词岛、锁定/
直接解锁、设置/托盘兜底解锁和关闭。完整命令、证据字段与平台能力矩阵见
[Linux 中文文档](https://github.com/YAQMC/YAQMC/blob/main/docs/zh-CN/linux.md)。
