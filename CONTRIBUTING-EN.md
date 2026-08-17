# Contributing

> [简体中文](CONTRIBUTING.md) | **English**

Search existing issues and pull requests first. Small, focused fixes may be submitted directly; discuss broad
architecture, compatibility protocol, account mutations, or major UI work in an issue before implementation.

Use Node.js 24, Rust 1.88 or newer, and the platform-specific Tauri 2 prerequisites. Install and run with:

```powershell
npm ci
npm run tauri dev
```

Electron host (parallel until P13): `npm run dev:desktop`.

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

CI (`.github/workflows/ci.yml`) packages Windows x86_64 and Linux x86_64 on pull requests, and the full
Windows/Linux matrix on `main` pushes and manual dispatch. Artifacts are retained for 14 days. CI uses ThinLTO;
tagged production packages still come from `build.yml` with the repository Fat LTO profile. Events, caches,
artifact names, and build-accepted vs runtime-tested are documented in [CI](docs/ci.md). You can also run **CI**
manually on the current branch from the Actions tab.

Security reports belong in the private channel described by [SECURITY.md](SECURITY.md), not a public issue.

Contributions must be made by someone entitled to contribute them and are submitted under
[GPL-3.0-or-later](LICENSE). The dual-maintainer approval required before this licensing change is merged or
released is tracked in [LICENSING_CONSENT.md](LICENSING_CONSENT.md). See the
[corresponding-source policy](CORRESPONDING_SOURCE_POLICY.md) for binary-release obligations.
