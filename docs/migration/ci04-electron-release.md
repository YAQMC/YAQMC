# CI-04: Electron release workflow draft

This checkpoint adds `.github/workflows/electron-release.yml`. It does **not**
replace `.github/workflows/build.yml` (Tauri tagged releases stay live until
P13).

Electron stays **43.4.0**. Builder stays **26.15.7**. Packs still pass
`--publish never`. The draft job uses `gh release create --draft`. Unsigned
(**R-9**). Provenance remains **BLOCKED**. The 32 MiB protocol hard cap is
unchanged. Do not start `qm-api-rs`.

## Why a second tag

Tauri `build.yml` already publishes a **live** GitHub Release for `v*`. An
Electron draft on the same tag would collide. During coexistence the Electron
workflow creates:

| Trigger             | GitHub Release tag                                |
| ------------------- | ------------------------------------------------- |
| `v*` push           | `electron-v*` (draft, target = the tagged commit) |
| `workflow_dispatch` | `electron-draft-<run_id>` (draft)                 |

That is a rehearsal, not an A→B updater proof.

## Pipeline

1. Frontend dist once (`YAQMC_PREBUILT_FRONTEND=1` on pack jobs).
2. Full Electron matrix (or dispatch OS filter) with **production** LTO.
3. `scripts/ci/assemble-electron-release.mjs` flattens installers, copies the
   **x64** `latest.yml` / `latest-linux.yml` feeds, writes combined checksums
   and `RELEASE-NOTES-ELECTRON.md`.
4. Draft GitHub Release. Not `--latest`. Not electron-builder publish.

Arm64 installers may be attached. They are not merged into the updater yml.

## What this is not

- Not a replacement for Tauri `build.yml`.
- Not a clean-VM install (PACK-02 / PACK-03).
- Not an A→B upgrade rehearsal (UPD-01).
- Not provenance green.

## Related

- Public [CI docs](../ci.md)
- [CI-02 package matrix](ci02-electron-package.md)
- Plan §33.4
