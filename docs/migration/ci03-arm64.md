# CI-03: arm64 core and Electron pack commands (hardware pending)

Maintainer script: `node scripts/migration/ci03-arm64.mjs`

This checkpoint **prints** the cargo and electron-builder commands. It does **not**
run cargo, rustup, or electron-builder. It is not a live arm runner. This host
may be x64 Windows; do not treat a local print as an arm64 boot test.

**CI-03 is not green.** Live arm boot evidence is **BLOCKED-EXTERNAL** (Actions
quota / runner), not a product FAIL. Arm artifacts are **boot-test pending**.
Do not edit `.github/workflows/ci.yml` here (FE-06 / CI-02 own that file).
PACK-01 already declares x64 and arm64 in `apps/desktop/electron-builder.yml`.

Electron stays **43.4.0**. Builder stays **26.15.7**. Do not start `qm-api-rs`.
Provenance remains **BLOCKED**. The 32 MiB protocol hard cap is unchanged.

## Windows: cross-build `yaqmc-core` for `aarch64-pc-windows-msvc`

Plan §33.1: `windows-latest` packs arm64 via electron-builder; Core is
cross-compiled with the `aarch64-pc-windows-msvc` toolchain. Today's Tauri
`build.yml` still uses a native `windows-11-arm` runner for that triple. The
Electron story is the **cross** path from an x64 Windows host.

Prerequisites (x64 Windows):

1. Rust 1.88+ (`rust-version` in the workspace `Cargo.toml`).
2. `rustup target add aarch64-pc-windows-msvc`
3. Visual Studio ARM64 C++ tools (MSVC `link.exe` for ARM64 / ARM64EC) plus a
   Windows SDK that includes ARM64 libraries. The host linker is not the x64
   `link.exe` by itself.

Commands (dry; do not run on this checkpoint):

```powershell
rustup target add aarch64-pc-windows-msvc
cargo build -p yaqmc-core --release --target aarch64-pc-windows-msvc
```

Binary path:

`target/aarch64-pc-windows-msvc/release/yaqmc-core.exe`

`scripts/stage-core.mjs` accepts `--rust-target <triple>` and looks at
`target/<triple>/{release,debug}/` first, then `target/{release,debug}/`. After a
cross-build:

```powershell
node scripts/stage-core.mjs --profile release --rust-target aarch64-pc-windows-msvc
```

Then pack (PACK-01 yml already lists `win.target` nsis/portable `arch: arm64`):

```powershell
npx electron-builder --projectDir apps/desktop --config electron-builder.yml --win --arm64
```

`npm run pack:win -w @yaqmc/desktop` stays `--win --x64` (PACK-02). Do not fold
`--arm64` into that script here.

Artifacts (gitignored `release-electron/`):

| Target   | Name                               |
| -------- | ---------------------------------- |
| NSIS     | `YAQMC-windows-arm64-setup.exe`    |
| Portable | `YAQMC-windows-arm64-portable.exe` |

Unsigned (**R-9**). No `electron-updater`.

## Linux: native `ubuntu-24.04-arm`

Plan §33.1: Linux arm64 uses `ubuntu-24.04-arm` (native), not a Windows-hosted
cross to GNU. Today's Tauri matrix still uses `ubuntu-22.04-arm`; the Electron
row is the 24.04 ARM runner **when hardware/CI allows**. This checkpoint does
not add that job to `ci.yml`.

On `ubuntu-24.04-arm` (already aarch64):

```bash
cargo build -p yaqmc-core --release
# equivalent explicit triple:
cargo build -p yaqmc-core --release --target aarch64-unknown-linux-gnu
```

Native (no `--target`) lands at `target/release/yaqmc-core` and
`node scripts/stage-core.mjs` can copy it. The explicit triple lands at
`target/aarch64-unknown-linux-gnu/release/yaqmc-core` — copy into
`apps/desktop/resources/core/yaqmc-core` the same way as Windows.

Then:

```bash
npx electron-builder --projectDir apps/desktop --config electron-builder.yml --linux --arm64
```

PACK-01 already lists AppImage/deb/rpm/tar.gz `arch: arm64`. Artifact pattern:
`YAQMC-linux-arm64.${ext}`.

Do not cross-compile `aarch64-unknown-linux-gnu` from this Windows x64 host as
a substitute for the native runner.

## Boot-test pending

| Check                                      | Windows arm64         | Linux arm64 (`ubuntu-24.04-arm`) |
| ------------------------------------------ | --------------------- | -------------------------------- |
| `yaqmc-core` builds for the triple         | [ ] hardware pending  | [ ] hardware pending             |
| Staged into `apps/desktop/resources/core`  | [ ] hardware pending  | [ ] hardware pending             |
| electron-builder arm64 artifacts exist     | [ ] hardware pending  | [ ] hardware pending             |
| Packaged app boots; core handshake `ready` | [ ] boot-test pending | [ ] boot-test pending            |

Leave the boxes empty. This machine is not an arm64 proof host. CI-02 wires these
commands into the Electron package matrix on `ubuntu-22.04-arm` / `windows-2025`
cross. PACK-02/PACK-03 own the clean-VM install matrices once artifacts exist.
CI-03 remains **not green**.

## Related

- [PACK-01 builder pin](plan-deltas.md) (`apps/desktop/electron-builder.yml`)
- [PACK-02 Windows NSIS / portable](pack02-windows.md) (x64 `pack:win`; arm64 is this file)
- [CI-02 Electron package matrix](ci02-electron-package.md)
- Plan §33.1 / P11 CI-03 in `YAQMC_ELECTRON_MIGRATION_PLAN.md`
