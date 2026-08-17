# Command inventory

This is the authoritative P2 inventory of the 117 commands registered by `tauri::generate_handler!`.

## Generation contract

The inventory is generated mechanically from the handler block in `src-tauri/src/lib.rs`, joined to each
`#[tauri::command] pub fn` declaration in `src-tauri/src/commands.rs` or `src-tauri/src/plugin/commands.rs`.
`Params` omits Tauri injection arguments (`AppHandle`, `State`, `WebviewWindow`, `Window`). `Result` unwraps
`CommandResult<T>` to the serde payload type `T`. `Renderer ref` is a literal single-quoted method-name scan over
non-test `src/**/*.ts(x)` files.

- Handler entries: 117; unique handler names: 117.
- Function attributes: 117 unique command functions. Textual `#[tauri::command]` matches:
  118. The extra match is the test string in `src-tauri/src/commands.rs`, not a command
  definition, and is not registered.
- Renderer refs: 112 yes, 5 no — `system_integration_status`, `player_play`, `player_pause`, `lyrics_surface_status`, `plugin_diagnostics`.
- `After` is the planned v1 owner. Electron Main entries retain the public method during coexistence; the three
  dialog paths are the approved future split described below.

| # | Method | Params | Result | Current declaration / registration | Renderer ref | After | Notes |
|---:|---|---|---|---|---|---|---|
| 1 | `platform_diagnostics` | — | `PlatformDiagnostics` | `commands.rs:481`; `lib.rs:405` | yes | Core | — |
| 2 | `platform_export_diagnostics` | — | `String` | `commands.rs:491`; `lib.rs:406` | yes | Core | — |
| 3 | `system_integration_status` | — | `DesktopIntegrationStatus` | `commands.rs:502`; `lib.rs:407` | no | Electron Main | Keep; renderer source strings do not invoke it. Host/tray/plugin/local-API callers remain valid. |
| 4 | `system_shortcuts_set_enabled` | `enabled: bool` | `DesktopIntegrationStatus` | `commands.rs:509`; `lib.rs:408` | yes | Electron Main | — |
| 5 | `audio_output_devices` | — | `Vec<AudioOutputDevice>` | `commands.rs:519`; `lib.rs:409` | yes | Core | — |
| 6 | `audio_set_output_device` | `device_id: String` | `Vec<AudioOutputDevice>` | `commands.rs:526`; `lib.rs:410` | yes | Core | — |
| 7 | `qqmusic_status` | — | `ProviderStatus` | `commands.rs:548`; `lib.rs:411` | yes | Core | — |
| 8 | `qqmusic_home` | `refresh: bool` | `ProviderResult<HomeFeed>` | `commands.rs:555`; `lib.rs:412` | yes | Core | — |
| 9 | `qqmusic_discover` | `refresh: bool` | `ProviderResult<DiscoverFeed>` | `commands.rs:563`; `lib.rs:413` | yes | Core | — |
| 10 | `qqmusic_area` | `enc_area: String` | `ProviderResult<AreaFeed>` | `commands.rs:571`; `lib.rs:414` | yes | Core | — |
| 11 | `qqmusic_guess_next` | `limit: u32` | `ProviderResult<Vec<Song>>` | `commands.rs:579`; `lib.rs:415` | yes | Core | — |
| 12 | `qqmusic_library` | — | `LibrarySnapshot` | `commands.rs:587`; `lib.rs:416` | yes | Core | — |
| 13 | `qqmusic_search` | `query: String, page: u32, limit: u32` | `ProviderResult<SearchResult>` | `commands.rs:594`; `lib.rs:417` | yes | Core | — |
| 14 | `qqmusic_album` | `id: String` | `ProviderResult<Album>` | `commands.rs:607`; `lib.rs:418` | yes | Core | — |
| 15 | `qqmusic_playlist` | `id: String` | `ProviderResult<Playlist>` | `commands.rs:615`; `lib.rs:419` | yes | Core | — |
| 16 | `qqmusic_lyrics` | `song_id: String` | `ProviderResult<Option<LyricDocument>>` | `commands.rs:623`; `lib.rs:420` | yes | Core | — |
| 17 | `qqmusic_cache_artwork` | `url: String` | `ProviderResult<String>` | `commands.rs:631`; `lib.rs:421` | yes | Core | — |
| 18 | `qqmusic_set_preferred_quality` | `quality: AudioQualityPreference` | `ProviderResult<ProviderStatus>` | `commands.rs:639`; `lib.rs:422` | yes | Core | — |
| 19 | `qqmusic_set_current_quality` | `quality: AudioQualityPreference` | `ProviderResult<PlayerSnapshot>` | `commands.rs:666`; `lib.rs:423` | yes | Core | — |
| 20 | `qqmusic_account_snapshot` | — | `ProviderResult<AccountSnapshot>` | `commands.rs:693`; `lib.rs:424` | yes | Core | — |
| 21 | `qqmusic_favorite_songs` | `cursor: Option<String>, limit: u32` | `ProviderResult<Page<Song>>` | `commands.rs:702`; `lib.rs:425` | yes | Core | — |
| 22 | `qqmusic_account_playlists` | `cursor: Option<String>, limit: u32` | `ProviderResult<Page<AccountPlaylistSummary>>` | `commands.rs:716`; `lib.rs:426` | yes | Core | — |
| 23 | `qqmusic_account_playlist_tracks` | `playlist: AccountPlaylistSummary, cursor: Option<String>, limit: u32` | `ProviderResult<AccountPlaylistDetail>` | `commands.rs:730`; `lib.rs:427` | yes | Core | — |
| 24 | `qqmusic_account_recently_played` | `cursor: Option<String>, limit: u32` | `ProviderResult<Page<RemotePlayHistoryItem>>` | `commands.rs:745`; `lib.rs:428` | yes | Core | — |
| 25 | `qqmusic_set_favorite` | `request: FavoriteMutationRequest` | `ProviderResult<FavoriteMutationResult>` | `commands.rs:759`; `lib.rs:429` | yes | Core | — |
| 26 | `qqmusic_create_playlist` | `request: CreatePlaylistRequest` | `ProviderResult<PlaylistMutationResult>` | `commands.rs:769`; `lib.rs:430` | yes | Core | — |
| 27 | `qqmusic_rename_playlist` | `request: RenamePlaylistRequest` | `ProviderResult<PlaylistMutationResult>` | `commands.rs:779`; `lib.rs:431` | yes | Core | — |
| 28 | `qqmusic_add_playlist_track` | `request: PlaylistTrackMutationRequest` | `ProviderResult<PlaylistMutationResult>` | `commands.rs:789`; `lib.rs:432` | yes | Core | — |
| 29 | `qqmusic_remove_playlist_track` | `request: PlaylistTrackMutationRequest` | `ProviderResult<PlaylistMutationResult>` | `commands.rs:802`; `lib.rs:433` | yes | Core | — |
| 30 | `qqmusic_delete_playlist` | `request: DeletePlaylistRequest` | `ProviderResult<PlaylistMutationResult>` | `commands.rs:815`; `lib.rs:434` | yes | Core | — |
| 31 | `qqmusic_set_playlist_collected` | `request: CollectPlaylistRequest` | `ProviderResult<PlaylistMutationResult>` | `commands.rs:825`; `lib.rs:435` | yes | Core | — |
| 32 | `qqmusic_auth_start` | — | `ProviderResult<AccountSnapshot>` | `commands.rs:838`; `lib.rs:436` | yes | Core | — |
| 33 | `qqmusic_auth_oauth_start` | `login_provider: OAuthLoginProvider` | `ProviderResult<AccountSnapshot>` | `commands.rs:847`; `lib.rs:437` | yes | Electron Main | — |
| 34 | `qqmusic_auth_heartbeat` | `attempt_id: String, owner_lease_id: String` | `ProviderResult<AccountSnapshot>` | `commands.rs:865`; `lib.rs:438` | yes | Core | — |
| 35 | `qqmusic_auth_cancel` | `attempt_id: String` | `ProviderResult<AccountSnapshot>` | `commands.rs:888`; `lib.rs:439` | yes | Core | — |
| 36 | `qqmusic_auth_refresh` | `attempt_id: Option<String>` | `ProviderResult<AccountSnapshot>` | `commands.rs:905`; `lib.rs:440` | yes | Core | — |
| 37 | `qqmusic_sign_out` | — | `ProviderResult<AccountSnapshot>` | `commands.rs:918`; `lib.rs:441` | yes | Core | — |
| 38 | `qqmusic_cache_stats` | — | `ProviderResult<CacheStats>` | `commands.rs:1008`; `lib.rs:442` | yes | Core | — |
| 39 | `qqmusic_clear_cache` | — | `ProviderResult<CacheStats>` | `commands.rs:1015`; `lib.rs:443` | yes | Core | — |
| 40 | `player_snapshot` | — | `PlayerSnapshot` | `commands.rs:1022`; `lib.rs:444` | yes | Core | — |
| 41 | `player_hydrate_queue` | `tracks: Vec<Song>` | `PlayerSnapshot` | `commands.rs:1029`; `lib.rs:445` | yes | Core | — |
| 42 | `player_play_tracks` | `request: PlayTracksRequest` | `PlayerSnapshot` | `commands.rs:1037`; `lib.rs:446` | yes | Core | — |
| 43 | `player_play_from_queue` | `index: usize` | `PlayerSnapshot` | `commands.rs:1048`; `lib.rs:447` | yes | Core | — |
| 44 | `player_play_queue_entry` | `entry_id: String` | `PlayerSnapshot` | `commands.rs:1059`; `lib.rs:448` | yes | Core | — |
| 45 | `player_play` | — | `PlayerSnapshot` | `commands.rs:1070`; `lib.rs:449` | no | Core | Keep; renderer source strings do not invoke it. Host/tray/plugin/local-API callers remain valid. |
| 46 | `player_pause` | — | `PlayerSnapshot` | `commands.rs:1075`; `lib.rs:450` | no | Core | Keep; renderer source strings do not invoke it. Host/tray/plugin/local-API callers remain valid. |
| 47 | `player_toggle` | — | `PlayerSnapshot` | `commands.rs:1080`; `lib.rs:451` | yes | Core | — |
| 48 | `player_next` | — | `PlayerSnapshot` | `commands.rs:1085`; `lib.rs:452` | yes | Core | — |
| 49 | `player_previous` | — | `PlayerSnapshot` | `commands.rs:1090`; `lib.rs:453` | yes | Core | — |
| 50 | `player_seek` | `position_ms: u64` | `PlayerSnapshot` | `commands.rs:1097`; `lib.rs:454` | yes | Core | — |
| 51 | `player_set_volume` | `volume: f64` | `PlayerSnapshot` | `commands.rs:1108`; `lib.rs:455` | yes | Core | — |
| 52 | `player_toggle_muted` | — | `PlayerSnapshot` | `commands.rs:1119`; `lib.rs:456` | yes | Core | — |
| 53 | `player_toggle_shuffle` | — | `PlayerSnapshot` | `commands.rs:1129`; `lib.rs:457` | yes | Core | — |
| 54 | `player_set_shuffle` | `enabled: bool` | `PlayerSnapshot` | `commands.rs:1136`; `lib.rs:458` | yes | Core | — |
| 55 | `player_cycle_repeat` | — | `PlayerSnapshot` | `commands.rs:1144`; `lib.rs:459` | yes | Core | — |
| 56 | `player_set_repeat` | `mode: RepeatMode` | `PlayerSnapshot` | `commands.rs:1151`; `lib.rs:460` | yes | Core | — |
| 57 | `player_set_primary_playback_mode` | `mode: PrimaryPlaybackMode` | `PlayerSnapshot` | `commands.rs:1159`; `lib.rs:461` | yes | Core | — |
| 58 | `player_add_to_queue` | `track: Song` | `PlayerSnapshot` | `commands.rs:1167`; `lib.rs:462` | yes | Core | — |
| 59 | `player_add_tracks_to_queue` | `tracks: Vec<Song>` | `PlayerSnapshot` | `commands.rs:1175`; `lib.rs:463` | yes | Core | — |
| 60 | `player_remove_from_queue` | `index: usize` | `PlayerSnapshot` | `commands.rs:1183`; `lib.rs:464` | yes | Core | — |
| 61 | `player_remove_queue_entry` | `entry_id: String` | `PlayerSnapshot` | `commands.rs:1194`; `lib.rs:465` | yes | Core | — |
| 62 | `player_reorder_queue_entry` | `entry_id: String, target_index: usize` | `PlayerSnapshot` | `commands.rs:1205`; `lib.rs:466` | yes | Core | — |
| 63 | `player_play_next_queue_entry` | `entry_id: String` | `PlayerSnapshot` | `commands.rs:1217`; `lib.rs:467` | yes | Core | — |
| 64 | `player_set_lyrics` | `document: Option<LyricDocument>` | `()` | `commands.rs:1228`; `lib.rs:468` | yes | Core | — |
| 65 | `player_lyrics` | — | `Option<LyricDocument>` | `commands.rs:1237`; `lib.rs:469` | yes | Core | — |
| 66 | `lyrics_surface_projection` | — | `LyricSurfaceProjection` | `commands.rs:1244`; `lib.rs:470` | yes | Core | — |
| 67 | `app_preferences_get` | — | `Option<String>` | `commands.rs:1251`; `lib.rs:471` | yes | Core | — |
| 68 | `app_preferences_set` | `value: String` | `()` | `commands.rs:1258`; `lib.rs:472` | yes | Core | — |
| 69 | `appearance_pick_background` | — | `Option<ManagedBackgroundImage>` | `commands.rs:1267`; `lib.rs:473` | yes | Electron Main | Approved P13 split: host picks path, Core IO becomes `preferences_set_background_from`. |
| 70 | `appearance_background_load` | `reference: String` | `Option<ManagedBackgroundImage>` | `commands.rs:1274`; `lib.rs:474` | yes | Core | — |
| 71 | `lyrics_surfaces_reconcile` | `surfaces: SurfaceRuntimeMap` | `SurfaceCapabilities` | `commands.rs:1282`; `lib.rs:475` | yes | Electron Main | — |
| 72 | `lyrics_surface_capabilities` | — | `SurfaceCapabilities` | `commands.rs:1292`; `lib.rs:476` | yes | Electron Main | — |
| 73 | `lyrics_surface_status` | — | `std::collections::HashMap<&'static str, bool>` | `commands.rs:1297`; `lib.rs:477` | no | Electron Main | Keep; renderer source strings do not invoke it. Host/tray/plugin/local-API callers remain valid. |
| 74 | `lyrics_surfaces_unlock_all` | — | `usize` | `commands.rs:1302`; `lib.rs:478` | yes | Electron Main | — |
| 75 | `lyrics_surface_unlock` | `kind: String` | `()` | `commands.rs:1311`; `lib.rs:479` | yes | Electron Main | — |
| 76 | `lyrics_surface_close` | `kind: String` | `()` | `commands.rs:1326`; `lib.rs:480` | yes | Electron Main | — |
| 77 | `lyrics_surface_set_interaction` | `kind: String, interaction: SurfaceInteraction, value: String` | `String` | `commands.rs:1335`; `lib.rs:481` | yes | Electron Main | — |
| 78 | `lyrics_surface_reset_position` | `kind: String` | `()` | `commands.rs:1362`; `lib.rs:482` | yes | Electron Main | — |
| 79 | `lyrics_surface_show_settings` | — | `()` | `commands.rs:1372`; `lib.rs:483` | yes | Electron Main | — |
| 80 | `local_api_status` | — | `LocalApiStatus` | `commands.rs:1384`; `lib.rs:484` | yes | Core | — |
| 81 | `local_api_set_enabled` | `enabled: bool` | `LocalApiStatus` | `commands.rs:1391`; `lib.rs:485` | yes | Core | — |
| 82 | `local_api_set_port` | `port: u16` | `LocalApiStatus` | `commands.rs:1401`; `lib.rs:486` | yes | Core | — |
| 83 | `local_api_reveal_token` | — | `String` | `commands.rs:1412`; `lib.rs:487` | yes | Core | — |
| 84 | `local_api_regenerate_token` | — | `LocalApiStatus` | `commands.rs:1417`; `lib.rs:488` | yes | Core | — |
| 85 | `debug_perf_sample` | `sample: DebugPerfSample` | `()` | `commands.rs:1460`; `lib.rs:489` | yes | Core | — |
| 86 | `diagnostics_snapshot` | `request: DiagnosticsRequest` | `DiagnosticsSnapshot` | `commands.rs:225`; `lib.rs:490` | yes | Core | — |
| 87 | `diagnostics_export_bundle` | `request: DiagnosticsBundleRequest` | `BundleExportResult` | `commands.rs:247`; `lib.rs:491` | yes | Core | Approved P13 split: host picks path, Core IO becomes `diagnostics_export_bundle_to`. |
| 88 | `diagnostics_reveal_bundle` | `path: String` | `()` | `commands.rs:281`; `lib.rs:492` | yes | Electron Main | — |
| 89 | `diagnostics_open_log_folder` | — | `String` | `commands.rs:300`; `lib.rs:493` | yes | Electron Main | — |
| 90 | `diagnostics_clear_logs` | — | `usize` | `commands.rs:309`; `lib.rs:494` | yes | Core | — |
| 91 | `diagnostics_set_log_level` | `level: LogLevel` | `LogLevel` | `commands.rs:330`; `lib.rs:495` | yes | Core | — |
| 92 | `diagnostics_current_level` | — | `LogLevel` | `commands.rs:341`; `lib.rs:496` | yes | Core | — |
| 93 | `diagnostics_recent_errors` | — | `Vec<ErrorRecord>` | `commands.rs:346`; `lib.rs:497` | yes | Core | — |
| 94 | `diagnostics_record_error` | `request: RecordErrorRequest` | `()` | `commands.rs:351`; `lib.rs:498` | yes | Core | — |
| 95 | `diagnostics_log_frontend` | `entries: Vec<FrontendLogEntry>` | `()` | `commands.rs:364`; `lib.rs:499` | yes | Core | — |
| 96 | `issue_reporter_preview` | `draft: IssueDraft, request: DiagnosticsRequest` | `IssuePreview` | `commands.rs:406`; `lib.rs:500` | yes | Core | — |
| 97 | `issue_reporter_validate_url` | `url: String` | `()` | `commands.rs:431`; `lib.rs:501` | yes | Core | — |
| 98 | `plugin_list` | — | `Vec<PluginRecord>` | `plugin/commands.rs:87`; `lib.rs:502` | yes | Core | — |
| 99 | `plugin_pick_package` | — | `Option<String>` | `plugin/commands.rs:96`; `lib.rs:503` | yes | Electron Main | Approved P13 split: host picks path, Core IO becomes `plugin_install_from`. |
| 100 | `plugin_inspect_path` | `path: String` | `PluginInspectResult` | `plugin/commands.rs:120`; `lib.rs:504` | yes | Core | — |
| 101 | `plugin_install` | `request: PluginInstallRequest` | `PluginRecord` | `plugin/commands.rs:143`; `lib.rs:505` | yes | Core | — |
| 102 | `plugin_set_enabled` | `request: PluginEnableRequest` | `PluginRecord` | `plugin/commands.rs:181`; `lib.rs:506` | yes | Core | — |
| 103 | `plugin_uninstall` | `request: PluginUninstallRequest` | `()` | `plugin/commands.rs:197`; `lib.rs:507` | yes | Core | — |
| 104 | `plugin_set_safe_mode` | `enabled: bool` | `bool` | `plugin/commands.rs:211`; `lib.rs:508` | yes | Core | — |
| 105 | `plugin_set_developer_mode` | `enabled: bool` | `bool` | `plugin/commands.rs:225`; `lib.rs:509` | yes | Core | — |
| 106 | `plugin_active_resources` | — | `ActivePluginResources` | `plugin/commands.rs:338`; `lib.rs:510` | yes | Core | — |
| 107 | `plugin_diagnostics` | — | `Vec<PluginDiagnostic>` | `plugin/commands.rs:347`; `lib.rs:511` | no | Core | Keep; renderer source strings do not invoke it. Host/tray/plugin/local-API callers remain valid. |
| 108 | `plugin_runtime_start` | `plugin_id: String` | `String` | `plugin/commands.rs:356`; `lib.rs:512` | yes | Core | — |
| 109 | `plugin_runtime_stop` | `token: String` | `()` | `plugin/commands.rs:369`; `lib.rs:513` | yes | Core | — |
| 110 | `plugin_mark_failed` | `id: String, reason: String` | `PluginRecord` | `plugin/commands.rs:380`; `lib.rs:514` | yes | Core | — |
| 111 | `plugin_bridge` | `request: PluginBridgeRequest` | `Value` | `plugin/commands.rs:396`; `lib.rs:515` | yes | Core | — |
| 112 | `plugin_pick_directory` | — | `Option<String>` | `plugin/commands.rs:239`; `lib.rs:516` | yes | Electron Main | — |
| 113 | `plugin_install_unpacked` | `request: PluginInstallRequest` | `PluginRecord` | `plugin/commands.rs:258`; `lib.rs:517` | yes | Core | — |
| 114 | `plugin_reload` | `id: String` | `PluginRecord` | `plugin/commands.rs:274`; `lib.rs:518` | yes | Core | — |
| 115 | `plugin_read_asset` | `plugin_id: String, path: String` | `Value` | `plugin/commands.rs:287`; `lib.rs:519` | yes | Core | — |
| 116 | `plugin_settings_get` | `id: String` | `Value` | `plugin/commands.rs:312`; `lib.rs:520` | yes | Core | — |
| 117 | `plugin_settings_set` | `request: PluginSettingsWrite` | `Value` | `plugin/commands.rs:323`; `lib.rs:521` | yes | Core | — |

## Planned host and dialog disposition

Electron Main owns the listed platform integration, shortcut, OAuth-window, diagnostic file-manager, picker, and lyrics-surface methods. Core retains all stateful provider, player, preferences, local API, diagnostics, and plugin operations. Main must derive the renderer origin from `webContents.id`; renderer-supplied origin is never trusted, and Core repeats method-ACL checks before dispatch.

The three approved dialog splits are `diagnostics_export_bundle` → `diagnostics_export_bundle_to`, `appearance_pick_background` → `preferences_set_background_from`, and `plugin_pick_package` → `plugin_install_from`. Main selects the path; Core performs IO. Existing public dialog methods remain only through the planned P13 retirement.

The five renderer-unreferenced methods stay in the v1 registry. `player_play` and `player_pause` remain Core playback methods; `plugin_diagnostics` remains a Core plugin method; `system_integration_status` and `lyrics_surface_status` remain Electron Main host methods. They are not retired because host-side callers and the 117-name identity contract still require them.

The 118th textual `#[tauri::command]` occurrence is a test string inside `every_account_command_uses_the_main_window_guard_contract`, not an unregistered command function, and must not be added to the protocol registry.
