# PACK-03: Linux AppImage / deb / rpm / tar.gz

Maintainer script: `node scripts/migration/pack03-linux.mjs`

This is the Linux packaging rehearsal for **AppImage** (updater-bearing per
plan §32), **deb**, **rpm**, and **tar.gz**, each declared for **x64 and
arm64** in `apps/desktop/electron-builder.yml` (PACK-01). **PACK-03 is not
green.** Every row stays unchecked until a maintainer runs it on a **clean
VM** or a scratch Linux user. **LIVE VERIFY / clean-VM pending** — do not
treat a local dry-run, or a pack produced elsewhere, as matrix sign-off.

This Windows worktree cannot produce Linux artifacts. The script is a dry-run:
it parses the yml, prints `electron-builder --linux` commands, and exits 0
even when `release-electron/` is empty. Do **not** install against the
daily-driver profile: `appId` `org.yaqmc.desktop` shares
`$XDG_DATA_HOME/org.yaqmc.desktop` with the Tauri build.

Unsigned (**R-9**). Notify-only `electron-updater` (UPD-01) is wired; the
A→B upgrade rehearsal is still pending. Electron stays **43.4.0**.
Builder stays **26.15.7**. Do not start `qm-api-rs`. Provenance remains
**BLOCKED**. The 32 MiB protocol hard cap is unchanged.

## Local pack (Linux builder)

PACK-01 already lists the four Linux targets. There is no `pack:linux` script
in `apps/desktop/package.json` (PACK-02 owns that file). From `apps/desktop`:

x64 AppImage + deb + rpm + tar.gz:

```bash
electron-builder --projectDir . --config electron-builder.yml --linux AppImage deb rpm tar.gz --x64
```

arm64 (CI-03; needs `aarch64-unknown-linux-gnu` core + a Linux arm64 host or
cross pack):

```bash
electron-builder --projectDir . --config electron-builder.yml --linux AppImage deb rpm tar.gz --arm64
```

`--linux` without target names uses the same four from the yml. Artifacts land
in gitignored `release-electron/`:

| Target   | Artifact                         | Notes                                      |
| -------- | -------------------------------- | ------------------------------------------ |
| AppImage | `YAQMC-linux-{arch}.AppImage`    | Updater-bearing target (§32). Notify-only; A→B pending. |
| deb      | `YAQMC-linux-{arch}.deb`         | `libayatana-appindicator3-1` as Recommends |
| rpm      | `YAQMC-linux-{arch}.rpm`         | weak `Recommends: libayatana-appindicator-gtk3` |
| tar.gz   | `YAQMC-linux-{arch}.tar.gz`      | Portable tree; not an in-place updater     |

Read the package name from the artifact (`dpkg-deb -f … Package` /
`rpm -qp --queryformat '%{NAME}\n' …`) before remove/erase. Do not assume a
hard-coded Debian/RPM name.

### Local pack on this checkpoint (2026-08-17)

Attempted as a dry-run parse on a Windows host. Result is recorded in the
plan-delta; this table is **not** a clean-VM matrix.

| Artifact                          | This host                                      |
| --------------------------------- | ---------------------------------------------- |
| `YAQMC-linux-x64.AppImage`        | not produced (Windows host; dry-run only)      |
| `YAQMC-linux-x64.deb`             | not produced (Windows host; dry-run only)      |
| `YAQMC-linux-x64.rpm`             | not produced (Windows host; dry-run only)      |
| `YAQMC-linux-x64.tar.gz`          | not produced (Windows host; dry-run only)      |
| arm64 AppImage / deb / rpm / tar.gz | not produced (x64 Windows host; CI-03)       |

## AppImage

Updater-bearing target (plan §32): a future in-place update can replace the
file. UPD-01 wires notify-only `electron-updater`; this checklist still does
**not** run that A→B rehearsal. Upgrade here is still replace-the-AppImage
until a maintainer ticks the LIVE VERIFY row.

```bash
chmod +x release-electron/YAQMC-linux-x64.AppImage
./release-electron/YAQMC-linux-x64.AppImage
```

No system package. Core data is `$XDG_DATA_HOME/org.yaqmc.desktop` (fallback
`~/.local/share/org.yaqmc.desktop`), not Electron `userData`. Uninstall is
deleting the AppImage; app data must remain.

## deb

Depends are whatever electron-builder computes (libgtk-3, libnss3 — standard
set). **No WebKitGTK.** Tray: `libayatana-appindicator3-1` is **Recommends**,
not Depends. Missing indicator libraries must not fail the package install;
tray init failure is non-fatal (logged only).

```bash
sudo apt install ./release-electron/YAQMC-linux-x64.deb
```

`dpkg -i` is equivalent; `apt install ./…` pulls Depends. Upgrade is install B
over A (same `appId`). Uninstall:

```bash
pkg="$(dpkg-deb -f release-electron/YAQMC-linux-x64.deb Package)"
sudo apt remove "$pkg"
```

The package must go. `$XDG_DATA_HOME/org.yaqmc.desktop` must **remain**.

## rpm

Same Depends policy as deb (builder-computed; no WebKitGTK). Tray is a weak
`Recommends: libayatana-appindicator-gtk3` fpm tag, not a hard Requires. Tray
failure stays non-fatal.

```bash
sudo dnf install ./release-electron/YAQMC-linux-x64.rpm
```

Upgrade: `dnf upgrade ./…` or `rpm -U`. Uninstall:

```bash
pkg="$(rpm -qp --queryformat '%{NAME}\n' release-electron/YAQMC-linux-x64.rpm)"
sudo dnf remove "$pkg"
```

App data must remain.

## tar.gz

```bash
tar -xzf release-electron/YAQMC-linux-x64.tar.gz
```

No installer. Run the extracted executable. Core data still uses
`$XDG_DATA_HOME/org.yaqmc.desktop`. Uninstall is deleting the extracted tree;
app data must remain. tar.gz is **not** updater-bearing (§32).

## Upgrade (install A then B)

Same `appId`. Version need not be bumped in git for an overwrite rehearsal.

1. Install A (current x64 AppImage / deb / rpm — pick one channel).
2. Drop `$XDG_DATA_HOME/org.yaqmc.desktop/pack03-upgrade-marker.txt` (and/or
   note `library.sqlite3`).
3. Install B over A (replace AppImage, or install the newer deb/rpm).
4. Marker and SQLite must still be there. Updater notify-flow is out of scope
   (this is package-over-package). AppImage is still the channel that will
   self-update once UPD-01 lands.

## Tray (`libayatana-appindicator`)

Plan §29.4: tray needs `libayatana-appindicator` on some distros. It is
declared as **Recommends** (deb `libayatana-appindicator3-1`, rpm
`libayatana-appindicator-gtk3`). A missing package must not fail install.
Tray creation failure is non-fatal (parity with today's logged-only tray init).
Do not treat a missing indicator as a packaging blocker.

## Checklist

**LIVE VERIFY / clean-VM pending.** Leave boxes empty until a maintainer ticks
them on a clean VM. This checkpoint does not claim the matrix green.

| Check | x64 AppImage | x64 deb | x64 rpm | x64 tar.gz | arm64 AppImage | arm64 deb | arm64 rpm | arm64 tar.gz |
| ----- | ------------ | ------- | ------- | ---------- | -------------- | --------- | --------- | ------------ |
| Artifact exists in `release-electron/` | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| Install (AppImage chmod+run / apt / dnf / extract) | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| App launches; core extraResource present | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| Data under `$XDG_DATA_HOME/org.yaqmc.desktop` | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| Tray missing `libayatana-appindicator` is non-fatal | [ ] | [ ] | [ ] | n/a | [ ] | [ ] | [ ] | n/a |
| Upgrade A then B; marker/SQLite survives | [ ] | [ ] | [ ] | n/a | [ ] | [ ] | [ ] | n/a |
| Uninstall removes package/binary, keeps app data | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| No WebKitGTK Depends | n/a | [ ] | [ ] | n/a | n/a | [ ] | [ ] | n/a |
| Clean VM | [ ] LIVE VERIFY pending | [ ] LIVE VERIFY pending | [ ] LIVE VERIFY pending | [ ] LIVE VERIFY pending | [ ] LIVE VERIFY pending | [ ] LIVE VERIFY pending | [ ] LIVE VERIFY pending | [ ] LIVE VERIFY pending |

Related: [PACK-01 builder pin](plan-deltas.md), [PACK-02 Windows](pack02-windows.md),
[data paths](data-paths.md), [release asset names](release-assets.md). CI-03
owns arm64 core cross-build. CI-02 owns the package matrix jobs. UPD-01 owns
A→B via updater on AppImage.
