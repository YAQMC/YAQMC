# CI-02: Electron package matrix jobs

> **P15 historical-evidence overlay:** this phase record describes the former
> dual-host CI period. The Tauri job and blocked-provenance statements below are
> superseded. Use [`../ci.md`](../ci.md) and
> [`p14c-readiness.md`](p14c-readiness.md) for current state.

This checkpoint **adds** Electron package jobs to `.github/workflows/ci.yml`.
It does **not** replace the Tauri `package` job (§33.2 coexistence through P12).

Electron stays **43.4.0**. Builder stays **26.15.7**. Local and CI packs pass
`--publish never`. Unsigned (**R-9**). Provenance remains **BLOCKED**. The 32 MiB
protocol hard cap is unchanged. Do not start `qm-api-rs`.

## Matrix

| OS      | Arch  | Runner             | `yaqmc-core` triple         | Notes                                      |
| ------- | ----- | ------------------ | --------------------------- | ------------------------------------------ |
| windows | x64   | `windows-2025`     | `x86_64-pc-windows-msvc`    | PR smoke                                   |
| windows | arm64 | `windows-2025`     | `aarch64-pc-windows-msvc`   | Cross; not `windows-11-arm`                |
| linux   | x64   | `ubuntu-22.04`     | `x86_64-unknown-linux-gnu`  | PR smoke                                   |
| linux   | arm64 | `ubuntu-22.04-arm` | `aarch64-unknown-linux-gnu` | Native FACT runner; not `ubuntu-24.04-arm` |

Windows i686 is **dropped** (R-13). Pull requests pack only the smoke rows.
Pushes to `main` and `workflow_dispatch` `all` pack the full four cells.
`workflow_dispatch` can still limit to `windows` or `linux`.

Live GitHub evidence is **BLOCKED-EXTERNAL** (org Actions quota exhausted), not a product FAIL. Do **not** dispatch this workflow while the freeze holds. YAML on disk ≠ live-green. Local packs are not CI-02.

Plan §33.1 named `ubuntu-24.04-arm`. This repo's working Linux arm runner is
`ubuntu-22.04-arm` (same as Tauri). CI-03's 24.04 ARM row stays hardware pending.

## Pipeline (per cell)

1. Download `yaqmc-frontend-dist-<sha>` (`YAQMC_PREBUILT_FRONTEND=1` verifies
   `dist/yaqmc-frontend-build.json` against the current commit; Vite is not
   rebuilt).
2. `cargo build -p yaqmc-core --release --locked --target <triple>`
3. `scripts/stage-core.mjs --profile release --rust-target <triple>`
4. `npm run build -w @yaqmc/client` and `npm run build -w @yaqmc/desktop`
5. `electron-builder --win nsis portable` or `--linux AppImage deb rpm tar.gz`
   plus `--x64`/`--arm64` and **`--publish never`**.
6. Stage installers (not `*-unpacked/`) into
   `release-electron/YAQMC-electron-<os>-<arch>/` and upload
   `YAQMC-electron-<os>-<arch>-<sha>`.

Windows arm64 clears yml `electronDist` so builder downloads Electron **43.4.0**
for `win32-arm64` instead of wrapping the host x64 `node_modules/electron/dist`.
Same-arch cells keep the workspace dist pin.

Linux pack installs `rpm` and `fakeroot` only. It does **not** use
`.github/actions/linux-tauri-deps` (no WebKitGTK).

Cargo cache keys match Tauri packaging (`setup-packaging` + the rust triple) so
registry/`target` restores can be shared. Saves stay on `main` and manual
dispatch.

## What this is not

- Not a clean-VM install (PACK-02 / PACK-03).
- Not an A→B updater rehearsal (UPD-01 / CI-04).
- Not a tagged GitHub Release (`build.yml` remains the Tauri release workflow
  until CI-04).
- Not PLAY-01 / SMTC / MPRIS / provenance green.

## Related

- Public [CI docs](../ci.md)
- [CI-03 arm64 commands](ci03-arm64.md) (still not boot-test green)
- [CI-04 Electron release draft](ci04-electron-release.md)
- Plan §33.1 / §33.2 in `YAQMC_ELECTRON_MIGRATION_PLAN.md`
