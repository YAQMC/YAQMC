const APP_COMMANDS: &[&str] = &[
    "platform_diagnostics",
    "platform_export_diagnostics",
    "system_integration_status",
    "system_shortcuts_set_enabled",
    "audio_output_devices",
    "audio_set_output_device",
    "qqmusic_status",
    "qqmusic_home",
    "qqmusic_library",
    "qqmusic_search",
    "qqmusic_album",
    "qqmusic_playlist",
    "qqmusic_lyrics",
    "qqmusic_cache_artwork",
    "qqmusic_set_preferred_quality",
    "qqmusic_set_current_quality",
    "qqmusic_account_snapshot",
    "qqmusic_auth_start",
    "qqmusic_auth_oauth_start",
    "qqmusic_auth_heartbeat",
    "qqmusic_auth_cancel",
    "qqmusic_auth_refresh",
    "qqmusic_sign_out",
    "qqmusic_favorite_songs",
    "qqmusic_account_playlists",
    "qqmusic_account_playlist_tracks",
    "qqmusic_account_recently_played",
    "qqmusic_set_favorite",
    "qqmusic_create_playlist",
    "qqmusic_rename_playlist",
    "qqmusic_add_playlist_track",
    "qqmusic_remove_playlist_track",
    "qqmusic_delete_playlist",
    "qqmusic_set_playlist_collected",
    "qqmusic_cache_stats",
    "qqmusic_clear_cache",
    "player_snapshot",
    "player_hydrate_queue",
    "player_play_tracks",
    "player_play_from_queue",
    "player_play_queue_entry",
    "player_play",
    "player_pause",
    "player_toggle",
    "player_next",
    "player_previous",
    "player_seek",
    "player_set_volume",
    "player_toggle_muted",
    "player_toggle_shuffle",
    "player_set_shuffle",
    "player_cycle_repeat",
    "player_set_repeat",
    "player_set_primary_playback_mode",
    "player_add_to_queue",
    "player_add_tracks_to_queue",
    "player_remove_from_queue",
    "player_remove_queue_entry",
    "player_reorder_queue_entry",
    "player_play_next_queue_entry",
    "player_set_lyrics",
    "player_lyrics",
    "lyrics_surface_projection",
    "app_preferences_get",
    "app_preferences_set",
    "appearance_pick_background",
    "appearance_background_load",
    "lyrics_surfaces_reconcile",
    "lyrics_surface_capabilities",
    "lyrics_surface_status",
    "lyrics_surfaces_unlock_all",
    "lyrics_surface_unlock",
    "lyrics_surface_close",
    "lyrics_surface_set_interaction",
    "lyrics_surface_reset_position",
    "lyrics_surface_show_settings",
    "local_api_status",
    "local_api_set_enabled",
    "local_api_set_port",
    "local_api_reveal_token",
    "local_api_regenerate_token",
    "debug_perf_sample",
    "diagnostics_snapshot",
    "diagnostics_export_bundle",
    "diagnostics_reveal_bundle",
    "diagnostics_open_log_folder",
    "diagnostics_clear_logs",
    "diagnostics_set_log_level",
    "diagnostics_current_level",
    "diagnostics_recent_errors",
    "diagnostics_record_error",
    "diagnostics_log_frontend",
    "issue_reporter_preview",
    "issue_reporter_validate_url",
    "plugin_list",
    "plugin_inspect_path",
    "plugin_install",
    "plugin_set_enabled",
    "plugin_uninstall",
    "plugin_set_safe_mode",
    "plugin_set_developer_mode",
    "plugin_active_resources",
    "plugin_diagnostics",
    "plugin_runtime_start",
    "plugin_runtime_stop",
    "plugin_mark_failed",
    "plugin_bridge",
];

fn embed_build_metadata() {
    // Best-effort git commit — matches vite.config.ts. Never fails the build.
    let commit = std::env::var("YAQMC_BUILD_COMMIT")
        .ok()
        .or_else(|| std::env::var("GITHUB_SHA").ok())
        .or_else(|| {
            std::process::Command::new("git")
                .args(["rev-parse", "HEAD"])
                .output()
                .ok()
                .filter(|output| output.status.success())
                .and_then(|output| String::from_utf8(output.stdout).ok())
                .map(|value| value.trim().to_owned())
        })
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=YAQMC_BUILD_COMMIT={commit}");
    println!("cargo:rerun-if-env-changed=YAQMC_BUILD_COMMIT");
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");
    println!("cargo:rerun-if-changed=../.git/HEAD");
}

fn main() {
    embed_build_metadata();
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("Tauri build metadata must be generated");
}
