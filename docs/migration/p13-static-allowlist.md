# P13 legacy-host static-search allowlist

This is the review draft requested by REM-02/REM-04. A case-insensitive repository search for `tauri` is intentionally broader than the executable-code guard and therefore needs the categories below.

## Executable-code policy

- `rg -l "tauri" crates/` must return no files.
- `rg -l "@tauri-apps" src/` must return no files.
- `eslint.config.js` intentionally contains `@tauri-apps` only as a no-exceptions restricted-import rule.
- `scripts/ci/legacy-host-imports.mjs` constructs the forbidden package prefix from string fragments so the checker can enforce the ban without becoming a search hit itself.

## Identifier false positives

Case-insensitive matching sees the substring `tauri` across the boundary in `dataUri` and `qrImageDataUri`. These are existing wire-field names and must not be renamed:

- `apps/desktop/main/managed-background.ts`
- `apps/desktop/main/ipc/host-handlers.ts`
- `crates/yaqmc-core/src/server/ops.rs`
- `crates/yaqmc-provider-qqmusic/src/qqmusic/account.rs`
- `packages/yaqmc-client/src/protocol/dto.ts`
- `src/application/account-runtime.ts`
- `src/application/artwork-cache.ts`
- `src/application/artwork-source.ts`
- `src/application/blurred-artwork.ts`
- `src/application/lyrics-appearance.ts`
- `src/application/playback-ui-probe.ts`
- `src/application/preferences.ts`
- `src/components/AccountDialog.tsx`
- `src/domain/music.ts`
- `src/pages/SettingsPage.tsx`

Tests that assert these wire names are allowed for the same reason.

## Historical and migration records

These files intentionally preserve the retired host name because they document old evidence, the migration decision, or superseded implementation plans:

- `YAQMC_ELECTRON_MIGRATION_PLAN.md`
- `docs/migration/**`
- `docs/plans/**`
- `docs/superpowers/**`
- `docs/windows-acceptance.md`
- `docs/zh-CN/windows-acceptance.md`
- `ACKNOWLEDGEMENTS.md`
- `ACKNOWLEDGEMENTS-EN.md`

Architecture/reference pages outside those paths still containing legacy-host descriptions belong to the later P15 documentation rewrite. They are not executable setup instructions; current build, contribution, and CI instructions were corrected in P13. Terra should report any non-historical hit outside this allowlist instead of silently expanding it.
