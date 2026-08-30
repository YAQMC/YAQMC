# Contributing

> [简体中文](CONTRIBUTING.md) | **English**

Search existing issues and pull requests first. Small, focused fixes may be submitted directly; discuss broad
architecture, compatibility protocol, account mutations, or major UI work in an issue before implementation.

Use Node.js 26.7.0, Rust 1.88 or newer, and the platform dependencies required by native audio and the selected
package format. A public checkout can run the deterministic fake-provider renderer directly:

```powershell
npm ci
npm run dev
```

The full Electron desktop and Rust workspace link the public `qm-api-rs` crate (`qqmusic-api`) as an unconditional
production dependency, pinned at
`2ef9182732e02db23788175dbe5b7d9d937e328f`. A sibling checkout at `../qm-api-rs`
is checked against that pin by `node scripts/ci/qm-api-rs-access.mjs --check`.
See [provider readiness](docs/release/provider-readiness.md) and [CI](docs/ci.md) for the production boundary and
release gates.

Run the complete desktop with:

```powershell
npm run dev:desktop
```

See [development](docs/development.md) for the layered build, packaging, and QA-profile rules, and
[data locations](docs/data-locations.md) for upgrade and uninstall behavior.

Before a pull request, run:

```powershell
npm run docs:check
npm run format:check
npm run check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --all-targets --locked
```

Keep changes focused, add regression coverage, update both documentation languages, and include risks plus evidence
in the pull request. Never commit cookies, OAuth codes, tokens, vkeys/ekeys, signed media URLs, real profile data,
or unredacted diagnostics. Do not implement subscription, regional, copyright, or proprietary VMP bypasses.

CI (`.github/workflows/ci.yml`) packages Electron for Windows x64 and Linux x64 on pull requests, and expands to
the Windows/Linux x64/arm64 matrix on `main` pushes and manual dispatch. Artifacts are retained for 14 days. CI uses ThinLTO;
`v*` production drafts come from `electron-release.yml` with the repository Fat LTO profile. Events, caches,
artifact names, and build-accepted vs runtime-tested are documented in [CI](docs/ci.md). You can also run **CI**
manually on the current branch from the Actions tab.

Security reports belong in the private channel described by [SECURITY.md](SECURITY.md), not a public issue.

Contributions must be made by someone entitled to contribute them and are submitted under
[GPL-3.0-or-later](LICENSE). The dual-maintainer approval required before this licensing change is merged or
released is tracked in [LICENSING_CONSENT.md](LICENSING_CONSENT.md). See the
[corresponding-source policy](CORRESPONDING_SOURCE_POLICY.md) for binary-release obligations.
