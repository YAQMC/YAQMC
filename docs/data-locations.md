# Data locations, upgrades, and uninstall

> [简体中文](zh-CN/data-locations.md) | **English**

YAQMC deliberately separates durable Rust Core data from Chromium's disposable
profile. Host upgrades keep the Core identifier `org.yaqmc.desktop`; Electron's
`userData` directory is not used for the music library, queue, plugins, media
cache, logs, or credentials.

## Core-owned paths

| Purpose                           | Windows                                      | Linux                                                                                                       |
| --------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Library, queue, settings, plugins | `%APPDATA%\org.yaqmc.desktop`                | `$XDG_DATA_HOME/org.yaqmc.desktop` (fallback `~/.local/share/org.yaqmc.desktop`)                            |
| Media/artwork cache               | `%LOCALAPPDATA%\org.yaqmc.desktop`           | `$XDG_CACHE_HOME/org.yaqmc.desktop` (fallback `~/.cache/org.yaqmc.desktop`)                                 |
| Core and host logs                | `%LOCALAPPDATA%\org.yaqmc.desktop\logs`      | `$XDG_DATA_HOME/org.yaqmc.desktop/logs` (fallback `~/.local/share/org.yaqmc.desktop/logs`)                  |
| Local API config                  | `%APPDATA%\org.yaqmc.desktop\local-api.json` | `$XDG_CONFIG_HOME/org.yaqmc.desktop/local-api.json` (fallback `~/.config/org.yaqmc.desktop/local-api.json`) |

The SQLite database is `library.sqlite3` under the Core data directory. Never
copy or delete it while YAQMC or a leftover `yaqmc-core` process is running;
WAL sidecars may still be active.

## Electron/Chromium profile

Packaged Electron stores Chromium session data under `%APPDATA%\YAQMC` on
Windows or `$XDG_CONFIG_HOME/YAQMC` (fallback `~/.config/YAQMC`) on Linux.
Unpackaged development uses `@yaqmc/desktop` instead of `YAQMC`. These folders
contain Chromium cache, GPU cache, Local Storage, and other renderer state;
they are not the authoritative Core database.

Electron defines `userData` as the platform `appData` directory plus the app
name, and keeps Chromium session data there by default. See the
[official Electron `app.getPath` documentation](https://www.electronjs.org/docs/latest/api/app/).

## Credentials

Secrets are stored by the operating-system credential service under service
name `org.yaqmc.desktop`, including the local API bearer token and QQ Music
session slots. The legacy `qqmusic-session` entry is still a bounded
cross-release migration/rollback fallback; `qqmusic-credential-v2` is the
production primary. Credential values are never copied into the directories
above or into diagnostics.

## Upgrade and uninstall behavior

- Installing a newer build with the same `appId` keeps Core data and the
  credential-service identity in place.
- The Windows NSIS configuration does not request application-data deletion;
  electron-builder's deletion option defaults to `false`. Linux package
  removal and deleting a portable binary likewise do not erase the user's
  home-directory data. See the
  [electron-builder NSIS option](https://www.electron.build/docs/api/app-builder-lib.interface.nsisoptions/#deleteappdataonuninstall).
- To keep the library and settings for a reinstall, uninstall only the program
  package and leave the paths above untouched.
- For a full removal, first log out if the application still starts, quit all
  YAQMC/Core processes, uninstall or delete the program, remove both the Core
  directories and Electron profile listed above, then remove any remaining
  `org.yaqmc.desktop` entries with the operating system's credential manager.
  This is intentionally a manual, destructive choice.

Diagnostics can reveal the resolved paths without exposing credential values.
See [logging](logging.md), [diagnostics](diagnostics.md), and
[local API](local-api.md).
