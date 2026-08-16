# Command inventory

This is the authoritative P0 inventory of the 117 commands registered by `tauri::generate_handler!` at `bc55b7ddd2a57cde8987c96c7c20f0b7d4a2e742`.

## Generation contract

The inventory is derived from the handler block in `src-tauri/src/lib.rs`, then joined to its `#[tauri::command] pub fn` declaration in either `src-tauri/src/commands.rs` or `src-tauri/src/plugin/commands.rs`. `Renderer ref` is a literal single-quoted method-name scan over non-test `src/**/*.ts(x)` files.

- Handler entries: 117; unique handler names: 117.
- Function attributes: 117 unique command functions. `rg -F '#[tauri::command]' src-tauri/src/commands.rs src-tauri/src/plugin/commands.rs` reports 118 textual occurrences because `src-tauri/src/commands.rs:906` contains a test string.
- Renderer refs: 112 yes, 5 no — `system_integration_status`, `player_play`, `player_pause`, `lyrics_surface_status`, and `plugin_diagnostics`.
- `After` is the planned v1 owner. Electron Main entries retain the public method during coexistence; the three dialog paths are the approved future split described below.

| # | Method | Current declaration / registration | Renderer ref | After |
|---:|---|---|---|---|
| 1 | `platform_diagnostics` | `commands.rs:433`; `lib.rs:318` | yes | Core |
| 2 | `platform_export_diagnostics` | `commands.rs:443`; `lib.rs:319` | yes | Core |
| 3 | `system_integration_status` | `commands.rs:454`; `lib.rs:320` | no | Electron Main |
| 4 | `system_shortcuts_set_enabled` | `commands.rs:461`; `lib.rs:321` | yes | Electron Main |
| 5 | `audio_output_devices` | `commands.rs:471`; `lib.rs:322` | yes | Core |
| 6 | `audio_set_output_device` | `commands.rs:478`; `lib.rs:323` | yes | Core |
| 7 | `qqmusic_status` | `commands.rs:500`; `lib.rs:324` | yes | Core |
| 8 | `qqmusic_home` | `commands.rs:507`; `lib.rs:325` | yes | Core |
| 9 | `qqmusic_discover` | `commands.rs:515`; `lib.rs:326` | yes | Core |
| 10 | `qqmusic_area` | `commands.rs:523`; `lib.rs:327` | yes | Core |
| 11 | `qqmusic_guess_next` | `commands.rs:531`; `lib.rs:328` | yes | Core |
| 12 | `qqmusic_library` | `commands.rs:539`; `lib.rs:329` | yes | Core |
| 13 | `qqmusic_search` | `commands.rs:546`; `lib.rs:330` | yes | Core |
| 14 | `qqmusic_album` | `commands.rs:559`; `lib.rs:331` | yes | Core |
| 15 | `qqmusic_playlist` | `commands.rs:567`; `lib.rs:332` | yes | Core |
| 16 | `qqmusic_lyrics` | `commands.rs:575`; `lib.rs:333` | yes | Core |
| 17 | `qqmusic_cache_artwork` | `commands.rs:583`; `lib.rs:334` | yes | Core |
| 18 | `qqmusic_set_preferred_quality` | `commands.rs:591`; `lib.rs:335` | yes | Core |
| 19 | `qqmusic_set_current_quality` | `commands.rs:618`; `lib.rs:336` | yes | Core |
| 20 | `qqmusic_account_snapshot` | `commands.rs:645`; `lib.rs:337` | yes | Core |
| 21 | `qqmusic_favorite_songs` | `commands.rs:654`; `lib.rs:338` | yes | Core |
| 22 | `qqmusic_account_playlists` | `commands.rs:668`; `lib.rs:339` | yes | Core |
| 23 | `qqmusic_account_playlist_tracks` | `commands.rs:682`; `lib.rs:340` | yes | Core |
| 24 | `qqmusic_account_recently_played` | `commands.rs:697`; `lib.rs:341` | yes | Core |
| 25 | `qqmusic_set_favorite` | `commands.rs:711`; `lib.rs:342` | yes | Core |
| 26 | `qqmusic_create_playlist` | `commands.rs:721`; `lib.rs:343` | yes | Core |
| 27 | `qqmusic_rename_playlist` | `commands.rs:731`; `lib.rs:344` | yes | Core |
| 28 | `qqmusic_add_playlist_track` | `commands.rs:741`; `lib.rs:345` | yes | Core |
| 29 | `qqmusic_remove_playlist_track` | `commands.rs:754`; `lib.rs:346` | yes | Core |
| 30 | `qqmusic_delete_playlist` | `commands.rs:767`; `lib.rs:347` | yes | Core |
| 31 | `qqmusic_set_playlist_collected` | `commands.rs:777`; `lib.rs:348` | yes | Core |
| 32 | `qqmusic_auth_start` | `commands.rs:790`; `lib.rs:349` | yes | Core |
| 33 | `qqmusic_auth_oauth_start` | `commands.rs:799`; `lib.rs:350` | yes | Electron Main |
| 34 | `qqmusic_auth_heartbeat` | `commands.rs:812`; `lib.rs:351` | yes | Core |
| 35 | `qqmusic_auth_cancel` | `commands.rs:833`; `lib.rs:352` | yes | Core |
| 36 | `qqmusic_auth_refresh` | `commands.rs:850`; `lib.rs:353` | yes | Core |
| 37 | `qqmusic_sign_out` | `commands.rs:863`; `lib.rs:354` | yes | Core |
| 38 | `qqmusic_cache_stats` | `commands.rs:953`; `lib.rs:355` | yes | Core |
| 39 | `qqmusic_clear_cache` | `commands.rs:960`; `lib.rs:356` | yes | Core |
| 40 | `player_snapshot` | `commands.rs:967`; `lib.rs:357` | yes | Core |
| 41 | `player_hydrate_queue` | `commands.rs:974`; `lib.rs:358` | yes | Core |
| 42 | `player_play_tracks` | `commands.rs:982`; `lib.rs:359` | yes | Core |
| 43 | `player_play_from_queue` | `commands.rs:993`; `lib.rs:360` | yes | Core |
| 44 | `player_play_queue_entry` | `commands.rs:1004`; `lib.rs:361` | yes | Core |
| 45 | `player_play` | `commands.rs:1015`; `lib.rs:362` | no | Core |
| 46 | `player_pause` | `commands.rs:1020`; `lib.rs:363` | no | Core |
| 47 | `player_toggle` | `commands.rs:1025`; `lib.rs:364` | yes | Core |
| 48 | `player_next` | `commands.rs:1030`; `lib.rs:365` | yes | Core |
| 49 | `player_previous` | `commands.rs:1035`; `lib.rs:366` | yes | Core |
| 50 | `player_seek` | `commands.rs:1042`; `lib.rs:367` | yes | Core |
| 51 | `player_set_volume` | `commands.rs:1053`; `lib.rs:368` | yes | Core |
| 52 | `player_toggle_muted` | `commands.rs:1064`; `lib.rs:369` | yes | Core |
| 53 | `player_toggle_shuffle` | `commands.rs:1074`; `lib.rs:370` | yes | Core |
| 54 | `player_set_shuffle` | `commands.rs:1081`; `lib.rs:371` | yes | Core |
| 55 | `player_cycle_repeat` | `commands.rs:1089`; `lib.rs:372` | yes | Core |
| 56 | `player_set_repeat` | `commands.rs:1096`; `lib.rs:373` | yes | Core |
| 57 | `player_set_primary_playback_mode` | `commands.rs:1104`; `lib.rs:374` | yes | Core |
| 58 | `player_add_to_queue` | `commands.rs:1112`; `lib.rs:375` | yes | Core |
| 59 | `player_add_tracks_to_queue` | `commands.rs:1120`; `lib.rs:376` | yes | Core |
| 60 | `player_remove_from_queue` | `commands.rs:1128`; `lib.rs:377` | yes | Core |
| 61 | `player_remove_queue_entry` | `commands.rs:1139`; `lib.rs:378` | yes | Core |
| 62 | `player_reorder_queue_entry` | `commands.rs:1150`; `lib.rs:379` | yes | Core |
| 63 | `player_play_next_queue_entry` | `commands.rs:1162`; `lib.rs:380` | yes | Core |
| 64 | `player_set_lyrics` | `commands.rs:1173`; `lib.rs:381` | yes | Core |
| 65 | `player_lyrics` | `commands.rs:1182`; `lib.rs:382` | yes | Core |
| 66 | `lyrics_surface_projection` | `commands.rs:1189`; `lib.rs:383` | yes | Core |
| 67 | `app_preferences_get` | `commands.rs:1196`; `lib.rs:384` | yes | Core |
| 68 | `app_preferences_set` | `commands.rs:1203`; `lib.rs:385` | yes | Core |
| 69 | `appearance_pick_background` | `commands.rs:1212`; `lib.rs:386` | yes | Electron Main |
| 70 | `appearance_background_load` | `commands.rs:1219`; `lib.rs:387` | yes | Core |
| 71 | `lyrics_surfaces_reconcile` | `commands.rs:1227`; `lib.rs:388` | yes | Electron Main |
| 72 | `lyrics_surface_capabilities` | `commands.rs:1237`; `lib.rs:389` | yes | Electron Main |
| 73 | `lyrics_surface_status` | `commands.rs:1242`; `lib.rs:390` | no | Electron Main |
| 74 | `lyrics_surfaces_unlock_all` | `commands.rs:1247`; `lib.rs:391` | yes | Electron Main |
| 75 | `lyrics_surface_unlock` | `commands.rs:1256`; `lib.rs:392` | yes | Electron Main |
| 76 | `lyrics_surface_close` | `commands.rs:1271`; `lib.rs:393` | yes | Electron Main |
| 77 | `lyrics_surface_set_interaction` | `commands.rs:1280`; `lib.rs:394` | yes | Electron Main |
| 78 | `lyrics_surface_reset_position` | `commands.rs:1307`; `lib.rs:395` | yes | Electron Main |
| 79 | `lyrics_surface_show_settings` | `commands.rs:1317`; `lib.rs:396` | yes | Electron Main |
| 80 | `local_api_status` | `commands.rs:1329`; `lib.rs:397` | yes | Core |
| 81 | `local_api_set_enabled` | `commands.rs:1336`; `lib.rs:398` | yes | Core |
| 82 | `local_api_set_port` | `commands.rs:1346`; `lib.rs:399` | yes | Core |
| 83 | `local_api_reveal_token` | `commands.rs:1357`; `lib.rs:400` | yes | Core |
| 84 | `local_api_regenerate_token` | `commands.rs:1362`; `lib.rs:401` | yes | Core |
| 85 | `debug_perf_sample` | `commands.rs:1405`; `lib.rs:402` | yes | Core |
| 86 | `diagnostics_snapshot` | `commands.rs:177`; `lib.rs:403` | yes | Core |
| 87 | `diagnostics_export_bundle` | `commands.rs:199`; `lib.rs:404` | yes | Core |
| 88 | `diagnostics_reveal_bundle` | `commands.rs:233`; `lib.rs:405` | yes | Electron Main |
| 89 | `diagnostics_open_log_folder` | `commands.rs:252`; `lib.rs:406` | yes | Electron Main |
| 90 | `diagnostics_clear_logs` | `commands.rs:261`; `lib.rs:407` | yes | Core |
| 91 | `diagnostics_set_log_level` | `commands.rs:282`; `lib.rs:408` | yes | Core |
| 92 | `diagnostics_current_level` | `commands.rs:293`; `lib.rs:409` | yes | Core |
| 93 | `diagnostics_recent_errors` | `commands.rs:298`; `lib.rs:410` | yes | Core |
| 94 | `diagnostics_record_error` | `commands.rs:303`; `lib.rs:411` | yes | Core |
| 95 | `diagnostics_log_frontend` | `commands.rs:316`; `lib.rs:412` | yes | Core |
| 96 | `issue_reporter_preview` | `commands.rs:358`; `lib.rs:413` | yes | Core |
| 97 | `issue_reporter_validate_url` | `commands.rs:383`; `lib.rs:414` | yes | Core |
| 98 | `plugin_list` | `plugin/commands.rs:87`; `lib.rs:415` | yes | Core |
| 99 | `plugin_pick_package` | `plugin/commands.rs:96`; `lib.rs:416` | yes | Electron Main |
| 100 | `plugin_inspect_path` | `plugin/commands.rs:120`; `lib.rs:417` | yes | Core |
| 101 | `plugin_install` | `plugin/commands.rs:143`; `lib.rs:418` | yes | Core |
| 102 | `plugin_set_enabled` | `plugin/commands.rs:181`; `lib.rs:419` | yes | Core |
| 103 | `plugin_uninstall` | `plugin/commands.rs:197`; `lib.rs:420` | yes | Core |
| 104 | `plugin_set_safe_mode` | `plugin/commands.rs:211`; `lib.rs:421` | yes | Core |
| 105 | `plugin_set_developer_mode` | `plugin/commands.rs:225`; `lib.rs:422` | yes | Core |
| 106 | `plugin_active_resources` | `plugin/commands.rs:338`; `lib.rs:423` | yes | Core |
| 107 | `plugin_diagnostics` | `plugin/commands.rs:347`; `lib.rs:424` | no | Core |
| 108 | `plugin_runtime_start` | `plugin/commands.rs:356`; `lib.rs:425` | yes | Core |
| 109 | `plugin_runtime_stop` | `plugin/commands.rs:369`; `lib.rs:426` | yes | Core |
| 110 | `plugin_mark_failed` | `plugin/commands.rs:380`; `lib.rs:427` | yes | Core |
| 111 | `plugin_bridge` | `plugin/commands.rs:396`; `lib.rs:428` | yes | Core |
| 112 | `plugin_pick_directory` | `plugin/commands.rs:239`; `lib.rs:429` | yes | Electron Main |
| 113 | `plugin_install_unpacked` | `plugin/commands.rs:258`; `lib.rs:430` | yes | Core |
| 114 | `plugin_reload` | `plugin/commands.rs:274`; `lib.rs:431` | yes | Core |
| 115 | `plugin_read_asset` | `plugin/commands.rs:287`; `lib.rs:432` | yes | Core |
| 116 | `plugin_settings_get` | `plugin/commands.rs:312`; `lib.rs:433` | yes | Core |
| 117 | `plugin_settings_set` | `plugin/commands.rs:323`; `lib.rs:434` | yes | Core |

## Planned host and dialog disposition

Electron Main owns the listed platform integration, shortcut, OAuth-window, diagnostic file-manager, picker, and lyrics-surface methods. Core retains all stateful provider, player, preferences, local API, diagnostics, and plugin operations. Main must derive the renderer origin from `webContents.id`; renderer-supplied origin is never trusted, and Core repeats method-ACL checks before dispatch.

The three approved dialog splits are `diagnostics_export_bundle` → `diagnostics_export_bundle_to`, `appearance_pick_background` → `preferences_set_background_from`, and `plugin_pick_package` → `plugin_install_from`. Main selects the path; Core performs IO. Existing public dialog methods remain only through the planned P13 retirement.
