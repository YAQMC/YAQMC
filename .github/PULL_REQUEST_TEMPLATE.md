## 变更目的

<!-- 说明问题、用户影响和为什么需要现在修改。关联 Issue：Closes #... -->

## 实现与边界

<!-- 说明关键实现、没有改变的边界、平台差异和 trade-off。 -->

## 验证证据

- [ ] `npm run docs:check`
- [ ] `npm run format:check`
- [ ] `npm run check`
- [ ] `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --all-targets`
- [ ] 行为变化有回归测试；界面变化有截图/无障碍检查（如适用）

## 安全与隐私

- [ ] 未提交 Cookie、OAuth code、token、vkey/ekey、签名 URL、真实账号资料或原始诊断包
- [ ] 未扩大 OAuth/歌词 WebView/Tauri capability 权限
- [ ] 未实现会员、地区、版权、DRM 或 VMP 绕过

## 文档与发布影响

- [ ] 中文与英文文档/文案已同步，或说明无需修改的理由
- [ ] 列出迁移、兼容性、回滚和发布说明影响
