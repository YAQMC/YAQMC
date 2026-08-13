# Contributing

> [简体中文](CONTRIBUTING.md) | **English**

Search existing issues and pull requests first. Small, focused fixes may be submitted directly; discuss broad
architecture, compatibility protocol, account mutations, or major UI work in an issue before implementation.

Use Node.js 24, Rust 1.88 or newer, and the platform-specific Tauri 2 prerequisites. Install and run with:

```powershell
npm ci
npm run tauri dev
```

Before a pull request, run:

```powershell
npm run docs:check
npm run format:check
npm run check
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-targets
```

Keep changes focused, add regression coverage, update both documentation languages, and include risks plus evidence
in the pull request. Never commit cookies, OAuth codes, tokens, vkeys/ekeys, signed media URLs, real profile data,
or unredacted diagnostics. Do not implement subscription, regional, copyright, or proprietary VMP bypasses.

Security reports belong in the private channel described by [SECURITY.md](SECURITY.md), not a public issue.

The repository does not yet have a project license. Before accepting outside contributions, the maintainer must
choose a license and contribution policy; public source visibility alone grants no general permission to copy,
modify, or redistribute it.
