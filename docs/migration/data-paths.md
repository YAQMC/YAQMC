# Data-path and persistence baseline

This is the P0 continuity baseline for the current Tauri host. The rows marked **SOURCE-VERIFIED** come from the current identifier and path-resolution code; they are not substitutes for a live desktop measurement. No Windows or Linux diagnostics snapshot was supplied to this worktree, so every live result remains **PENDING — manual measurement required**.

## Resolved directories

The identifier is `org.yaqmc.desktop` (`src-tauri/tauri.conf.json`). Startup obtains app data, cache, and log directories from Tauri's path resolver (`src-tauri/src/lib.rs`). The paths below are the expected Tauri resolution recorded in the migration plan; target Electron core resolution must remain byte-identical after P4.

| Platform | Purpose                           | Expected current/target path                                                                                | Evidence        | Live result                           |
| -------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------- |
| Windows  | App data (SQLite, plugins, queue) | `%APPDATA%\org.yaqmc.desktop`                                                                               | SOURCE-VERIFIED | PENDING — manual measurement required |
| Windows  | Cache                             | `%LOCALAPPDATA%\org.yaqmc.desktop`                                                                          | SOURCE-VERIFIED | PENDING — manual measurement required |
| Windows  | Logs                              | `%LOCALAPPDATA%\org.yaqmc.desktop\logs`                                                                     | SOURCE-VERIFIED | PENDING — manual measurement required |
| Linux    | App data (SQLite, plugins, queue) | `$XDG_DATA_HOME/org.yaqmc.desktop` (fallback `~/.local/share/org.yaqmc.desktop`)                            | SOURCE-VERIFIED | PENDING — manual measurement required |
| Linux    | Cache                             | `$XDG_CACHE_HOME/org.yaqmc.desktop` (fallback `~/.cache/org.yaqmc.desktop`)                                 | SOURCE-VERIFIED | PENDING — manual measurement required |
| Linux    | Logs                              | `$XDG_DATA_HOME/org.yaqmc.desktop/logs` (fallback `~/.local/share/org.yaqmc.desktop/logs`)                  | SOURCE-VERIFIED | PENDING — manual measurement required |
| Windows  | Local API config                  | `%APPDATA%\org.yaqmc.desktop\local-api.json`                                                                | SOURCE-VERIFIED | PENDING — manual measurement required |
| Linux    | Local API config                  | `$XDG_CONFIG_HOME/org.yaqmc.desktop/local-api.json` (fallback `~/.config/org.yaqmc.desktop/local-api.json`) | SOURCE-VERIFIED | PENDING — manual measurement required |

## Persisted data and keys

| Store                      | Current key or location                           | Target rule      | Evidence        |
| -------------------------- | ------------------------------------------------- | ---------------- | --------------- |
| SQLite                     | `library.sqlite3` under app data; WAL enabled     | Keep in place    | SOURCE-VERIFIED |
| Queue                      | `queue_state` singleton row (`value_json`)        | Keep in place    | SOURCE-VERIFIED |
| Audio output               | `app_settings['audio-output-device']`             | Keep exact key   | SOURCE-VERIFIED |
| Logging level              | `app_settings['logging.level']`                   | Keep exact key   | SOURCE-VERIFIED |
| Preferred playback quality | `app_settings['preferred-quality']`               | Keep exact key   | SOURCE-VERIFIED |
| Preferences                | `app_settings['ui-preferences-v1']`               | Keep exact key   | SOURCE-VERIFIED |
| Preference schema marker   | `app_settings['preferences-schema-version']`      | Keep exact key   | SOURCE-VERIFIED |
| Desktop lyric geometry     | `app_settings['lyrics-surface-geometry:desktop']` | Keep exact key   | SOURCE-VERIFIED |
| Lyrics-island geometry     | `app_settings['lyrics-surface-geometry:island']`  | Keep exact key   | SOURCE-VERIFIED |
| Local API token            | Keyring entry `local-api-bearer-token`            | Keep exact entry | SOURCE-VERIFIED |
| QQ active session          | Keyring entry `qqmusic-session`                   | Keep exact entry | SOURCE-VERIFIED |
| QQ staging session         | Keyring entry `qqmusic-session-staging`           | Keep exact entry | SOURCE-VERIFIED |

The current keyring service is `org.yaqmc.desktop`; the legacy read-migration service is `dev.music-client.desktop`. Values are never exported into this document or diagnostics.

## Required live capture

On each primary development machine, run the current Tauri application with a fresh diagnostics export, record the actual resolved app-data/cache/log/config paths, and attach the redacted export location or checksum to the migration evidence. Do not promote a SOURCE-VERIFIED row to live-verified from an inferred path, an empty directory, or a manually edited value.
