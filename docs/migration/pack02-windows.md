# PACK-02: Windows NSIS / portable install, upgrade, uninstall

Maintainer script: `node scripts/migration/pack02-windows.mjs`

This is the Windows packaging rehearsal for per-user NSIS (`oneClick: false`,
`perMachine: false`) and the electron-builder **portable exe** (not Tauri's
`YAQMC-windows-{arch}-portable.zip`). **PACK-02 is not green.** Every row stays
unchecked until a maintainer runs it on a **clean VM** or a scratch Windows
user. **LIVE VERIFY / clean-VM pending** — do not treat a local `pack:win` as
matrix sign-off.

Do **not** run the installer against the daily-driver profile: `appId`
`org.yaqmc.desktop` shares `%APPDATA%\org.yaqmc.desktop` with the Tauri build.

Unsigned (**R-9**). SmartScreen / Defender warnings are expected.
Notify-only `electron-updater` **6.8.6** (UPD-01) is wired; the A→B upgrade
rehearsal is still **pending**. Electron stays **43.4.0**. Builder stays
**26.15.7**. Do not start `qm-api-rs`. Provenance remains **BLOCKED**. The
32 MiB protocol hard cap is unchanged.

## Local pack

```bash
npm run pack:win -w @yaqmc/desktop
```

That is `electron-builder --projectDir . --config electron-builder.yml --win --x64`
from `apps/desktop`. It does **not** build arm64.

arm64 (CI-03):

```bash
npx electron-builder --projectDir apps/desktop --config electron-builder.yml --win --arm64
```

`npm run pack:dir -w @yaqmc/desktop` already exists. Artifacts: gitignored
`release-electron/YAQMC-windows-{arch}-setup.exe` and
`YAQMC-windows-{arch}-portable.exe`.

### Local pack on this checkpoint (2026-08-17)

Not a clean-VM matrix.

| Artifact | This host |
| -------- | --------- |
| `YAQMC-windows-x64-setup.exe` | **not produced** — `--win nsis --x64` failed `getaddrinfo ENOTFOUND github.com` (NSIS tool fetch) |
| `YAQMC-windows-x64-portable.exe` | skipped (same GitHub fetch; not attempted after NSIS failure) |
| arm64 NSIS / portable | not produced (x64 host; CI-03) |

`win-unpacked` packaging **did** run (Electron **43.4.0**, fuses, `oneClick: false`,
`perMachine: false`). NSIS tooling download from GitHub failed DNS. Documented
skip, not sign-off.

## NSIS per-user install

`oneClick: false`, `perMachine: false`. Default dir `%LOCALAPPDATA%\Programs\YAQMC`.

```powershell
& "release-electron\YAQMC-windows-x64-setup.exe" /S /D=$env:LOCALAPPDATA\Programs\YAQMC
```

No admin. Data: `%APPDATA%\org.yaqmc.desktop`.

## Portable exe

```powershell
.\release-electron\YAQMC-windows-x64-portable.exe
```

Core paths still `%APPDATA%\org.yaqmc.desktop`. Not a zip.

## Upgrade (install A then B)

1. Install A (`/S`).
2. Marker `%APPDATA%\org.yaqmc.desktop\pack02-upgrade-marker.txt`.
3. Install B over A.
4. Marker/SQLite survive. Notify-only updater; A→B rehearsal pending.

## Uninstall

```powershell
& "$env:LOCALAPPDATA\Programs\YAQMC\Uninstall YAQMC.exe" /S
```

Programs gone; app data remains.

## Checklist

**LIVE VERIFY / clean-VM pending.** Leave boxes empty. Do not claim the matrix green.

| Check | x64 NSIS | x64 portable | arm64 NSIS | arm64 portable |
| ----- | -------- | ------------ | ---------- | -------------- |
| Artifact exists | [ ] | [ ] | [ ] | [ ] |
| Per-user install, no admin (`perMachine: false`) | [ ] | n/a | [ ] | n/a |
| Directory chooser / `/D=` (`oneClick: false`) | [ ] | n/a | [ ] | n/a |
| App launches; core extraResource present | [ ] | [ ] | [ ] | [ ] |
| Data under `%APPDATA%\org.yaqmc.desktop` | [ ] | [ ] | [ ] | [ ] |
| Upgrade A then B; marker/SQLite survives | [ ] | n/a | [ ] | n/a |
| Uninstall removes Programs, keeps app data | [ ] | n/a | [ ] | n/a |
| Unsigned (R-9) SmartScreen expected | [ ] | [ ] | [ ] | [ ] |
| Clean VM | [ ] LIVE VERIFY pending | [ ] LIVE VERIFY pending | [ ] LIVE VERIFY pending | [ ] LIVE VERIFY pending |