mod app_preferences;
mod audio;
mod command_guard;
mod commands;
mod credentials;
mod desktop_integration;
mod diagnostics;
mod error_codes;
mod issue_reporter;
mod local_api;
mod logging;
mod lyrics_surface;
mod media;
mod platform;
mod player;
mod qmc;
mod qqmusic;
mod storage;
mod streaming;
mod system_media;

use audio::{AudioEngine, RodioAudioEngine, UnavailableAudioEngine};
use credentials::{CredentialStore, PlatformCredentialStore};
use desktop_integration::DesktopIntegration;
use local_api::LocalApiService;
use lyrics_surface::LyricsSurfaceManager;
use media::{CachedMediaPreparer, MediaPreparer, PlaybackSourceResolver};
use player::{PlayerService, PlayerSnapshot};
use qqmusic::QQMusicService;
use std::sync::Arc;
use storage::StorageService;
use system_media::SystemMediaIntegration;
use tauri::{Emitter, Manager};

#[derive(Clone, Copy)]
enum MainOwnerLifecycleEvent {
    CloseRequested,
    Destroyed,
    PageLoadStarted,
    PageLoadFinished,
}

fn owner_loss_reason(event: MainOwnerLifecycleEvent) -> Option<&'static str> {
    match event {
        MainOwnerLifecycleEvent::CloseRequested => Some("main-window-close-requested"),
        MainOwnerLifecycleEvent::Destroyed => Some("main-window-destroyed"),
        MainOwnerLifecycleEvent::PageLoadStarted => Some("main-webview-page-load-started"),
        MainOwnerLifecycleEvent::PageLoadFinished => None,
    }
}

fn cancel_login_owner(app: &tauri::AppHandle, event: MainOwnerLifecycleEvent) {
    let Some(reason) = owner_loss_reason(event) else {
        return;
    };
    if let Some(provider) = app.try_state::<Arc<QQMusicService>>() {
        provider.cancel_login_owner(reason);
    }
    qqmusic::oauth::close_all_windows(app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let process_started = std::time::Instant::now();
    platform::apply_startup_graphics_policy();
    let builder = tauri::Builder::default();
    #[cfg(target_os = "linux")]
    let builder = if std::env::var_os("DISPLAY").is_some() {
        builder.plugin(desktop_integration::global_shortcut_plugin())
    } else {
        builder
    };
    #[cfg(not(target_os = "linux"))]
    let builder = builder.plugin(desktop_integration::global_shortcut_plugin());
    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .on_page_load(|webview, payload| {
            if webview.label() != "main" {
                return;
            }
            let event = match payload.event() {
                tauri::webview::PageLoadEvent::Started => {
                    MainOwnerLifecycleEvent::PageLoadStarted
                }
                tauri::webview::PageLoadEvent::Finished => {
                    MainOwnerLifecycleEvent::PageLoadFinished
                }
            };
            cancel_login_owner(webview.app_handle(), event);
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    let app = window.app_handle();
                    cancel_login_owner(app, MainOwnerLifecycleEvent::CloseRequested);
                    let should_hide = app
                        .try_state::<Arc<StorageService>>()
                        .is_none_or(|storage| app_preferences::close_hides_to_tray(&storage));
                    if should_hide {
                        api.prevent_close();
                        if let Err(error) = window.hide() {
                            tracing::warn!(target: "tray", error = %error, "main window could not hide to tray");
                        }
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    cancel_login_owner(
                        window.app_handle(),
                        MainOwnerLifecycleEvent::Destroyed,
                    );
                }
                _ => {}
            }
        })
        .setup(move |app| {
            let log_dir = app.path().app_log_dir().unwrap_or_else(|_| {
                app.path()
                    .app_data_dir()
                    .map(|dir| dir.join("logs"))
                    .unwrap_or_else(|_| std::env::temp_dir().join("YAQMC/logs"))
            });

            let data_root = app.path().app_data_dir()?;
            let cache_root = app.path().app_cache_dir()?;
            let storage = Arc::new(StorageService::open(data_root.clone(), cache_root.clone())?);
            let level = std::env::var("YAQMC_LOG_LEVEL")
                .ok()
                .and_then(|value| logging::LogLevel::parse(&value))
                .unwrap_or_else(|| commands::load_persisted_log_level(&storage));
            let logging_handle = Arc::new(logging::init(log_dir, level).unwrap_or_else(|_| {
                logging::init(std::env::temp_dir().join("YAQMC/logs"), level)
                    .expect("secondary log directory")
            }));
            let credentials: Arc<dyn CredentialStore> = Arc::new(PlatformCredentialStore::new());
            let qq_music = Arc::new(QQMusicService::new(
                Arc::clone(&storage),
                Arc::clone(&credentials),
                cache_root.join("fixture-media"),
            )?);
            let audio: Arc<dyn AudioEngine> = match RodioAudioEngine::open_default() {
                Ok(engine) => Arc::new(engine),
                Err(error) => {
                    tracing::warn!(target: "audio", error = %error, "starting without an audio output device");
                    Arc::new(UnavailableAudioEngine)
                }
            };
            if let Ok(Some(device_id)) = storage.get_setting(commands::AUDIO_OUTPUT_SETTING) {
                if let Err(error) = audio.set_output_device(&device_id) {
                    tracing::warn!(target: "audio", error = %error, "saved output device is unavailable; using the system default");
                }
            }
            let resolver: Arc<dyn PlaybackSourceResolver> = qq_music.clone();
            let preparer: Arc<dyn MediaPreparer> = Arc::new(CachedMediaPreparer::new(
                qq_music.http_client(),
                Arc::clone(&storage),
            ));
            let player = Arc::new(PlayerService::with_runtime(audio, resolver, preparer));
            if let Ok(Some(snapshot)) = storage.load_queue::<PlayerSnapshot>() {
                tauri::async_runtime::block_on(qq_music.remember_songs(&snapshot.queue));
                tauri::async_runtime::block_on(player.restore(snapshot));
            }
            let config_path = app.path().app_config_dir()?.join("local-api.json");
            let local_api =
                LocalApiService::new(config_path, Arc::clone(&player), credentials)?;
            let lyrics_surfaces = Arc::new(LyricsSurfaceManager::new());
            let system_media = SystemMediaIntegration::start(app.handle(), Arc::clone(&player));
            let desktop_integration =
                DesktopIntegration::start(app.handle(), Arc::clone(&player));
            if app_preferences::global_shortcuts_enabled(&storage) {
                if let Err(error) = desktop_integration.set_shortcuts_enabled(app.handle(), true) {
                    tracing::warn!(target: "shortcut", error = %error, "saved global shortcuts could not be enabled");
                }
            }

            let initial_snapshot = tauri::async_runtime::block_on(player.snapshot());
            system_media.update(&initial_snapshot, false);
            let diagnostics = platform::collect(
                app.handle(),
                &player,
                system_media.status(),
                desktop_integration.status(),
            );
            platform::log_startup(&diagnostics);
            tracing::info!(
                target: "app.startup",
                setup_elapsed_ms = process_started.elapsed().as_millis() as u64,
                "desktop setup complete"
            );

            player.start_clock();

            let app_handle = app.handle().clone();
            let mut event_receiver = player.subscribe();
            let persistence = Arc::clone(&storage);
            let snapshot_source = Arc::clone(&player);
            let media_projection = Arc::clone(&system_media);
            tauri::async_runtime::spawn(async move {
                while let Ok(event) = event_receiver.recv().await {
                    let _ = app_handle.emit("api://event", &event);
                    if matches!(
                        event.event_type.as_str(),
                        "queue.changed"
                            | "player.track"
                            | "player.playback"
                            | "player.position"
                            | "player.seeked"
                            | "player.volume"
                            | "player.mode"
                            | "player.error"
                    ) {
                        let _ = app_handle.emit("player://snapshot", &event.data);
                    }
                    if matches!(
                        event.event_type.as_str(),
                        "player.position"
                            | "player.seeked"
                            | "player.track"
                            | "player.playback"
                            | "player.error"
                            | "lyrics.changed"
                            | "lyrics.line"
                            | "lyrics.word"
                    ) {
                        let projection = snapshot_source.lyric_surface_projection().await;
                        let _ = app_handle.emit("lyrics://projection", &projection);
                    }
                    if event.event_type == "lyrics.changed" {
                        let document = snapshot_source.lyrics().await;
                        let _ = app_handle.emit("lyrics://document", &document);
                    }
                    if matches!(
                        event.event_type.as_str(),
                        "queue.changed"
                            | "player.track"
                            | "player.playback"
                            | "player.position"
                            | "player.seeked"
                            | "player.volume"
                            | "player.mode"
                            | "player.error"
                    ) {
                        let snapshot = snapshot_source.snapshot().await;
                        media_projection.update(&snapshot, event.event_type == "player.seeked");
                    }
                    if matches!(
                        event.event_type.as_str(),
                        "queue.changed"
                            | "player.track"
                            | "player.playback"
                            | "player.volume"
                            | "player.mode"
                            | "player.error"
                    ) {
                        let snapshot = snapshot_source.snapshot().await;
                        if let Err(error) = persistence.save_queue(&snapshot) {
                            tracing::warn!(target: "storage", error = %error, "queue persistence failed");
                        }
                    }
                }
            });

            let api_to_start = Arc::clone(&local_api);
            tauri::async_runtime::spawn(async move {
                let _ = api_to_start.start_if_enabled().await;
            });

            app.manage(player);
            app.manage(local_api);
            app.manage(lyrics_surfaces);
            app.manage(system_media);
            app.manage(desktop_integration);
            app.manage(storage);
            app.manage(Arc::clone(&logging_handle));
            app.manage(Arc::clone(&qq_music));
            let account_restore = Arc::clone(&qq_music);
            tauri::async_runtime::spawn(async move {
                account_restore.restore_session().await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::platform_diagnostics,
            commands::platform_export_diagnostics,
            commands::system_integration_status,
            commands::system_shortcuts_set_enabled,
            commands::audio_output_devices,
            commands::audio_set_output_device,
            commands::qqmusic_status,
            commands::qqmusic_home,
            commands::qqmusic_library,
            commands::qqmusic_search,
            commands::qqmusic_album,
            commands::qqmusic_playlist,
            commands::qqmusic_lyrics,
            commands::qqmusic_cache_artwork,
            commands::qqmusic_set_preferred_quality,
            commands::qqmusic_set_current_quality,
            commands::qqmusic_account_snapshot,
            commands::qqmusic_favorite_songs,
            commands::qqmusic_account_playlists,
            commands::qqmusic_account_playlist_tracks,
            commands::qqmusic_account_recently_played,
            commands::qqmusic_set_favorite,
            commands::qqmusic_create_playlist,
            commands::qqmusic_rename_playlist,
            commands::qqmusic_add_playlist_track,
            commands::qqmusic_remove_playlist_track,
            commands::qqmusic_delete_playlist,
            commands::qqmusic_set_playlist_collected,
            commands::qqmusic_auth_start,
            commands::qqmusic_auth_oauth_start,
            commands::qqmusic_auth_heartbeat,
            commands::qqmusic_auth_cancel,
            commands::qqmusic_auth_refresh,
            commands::qqmusic_sign_out,
            commands::qqmusic_cache_stats,
            commands::qqmusic_clear_cache,
            commands::player_snapshot,
            commands::player_hydrate_queue,
            commands::player_play_tracks,
            commands::player_play_from_queue,
            commands::player_play_queue_entry,
            commands::player_play,
            commands::player_pause,
            commands::player_toggle,
            commands::player_next,
            commands::player_previous,
            commands::player_seek,
            commands::player_set_volume,
            commands::player_toggle_muted,
            commands::player_toggle_shuffle,
            commands::player_set_shuffle,
            commands::player_cycle_repeat,
            commands::player_set_repeat,
            commands::player_set_primary_playback_mode,
            commands::player_add_to_queue,
            commands::player_add_tracks_to_queue,
            commands::player_remove_from_queue,
            commands::player_remove_queue_entry,
            commands::player_reorder_queue_entry,
            commands::player_play_next_queue_entry,
            commands::player_set_lyrics,
            commands::player_lyrics,
            commands::lyrics_surface_projection,
            commands::app_preferences_get,
            commands::app_preferences_set,
            commands::appearance_pick_background,
            commands::appearance_background_load,
            commands::lyrics_surfaces_reconcile,
            commands::lyrics_surface_capabilities,
            commands::lyrics_surface_status,
            commands::lyrics_surfaces_unlock_all,
            commands::lyrics_surface_unlock,
            commands::lyrics_surface_close,
            commands::lyrics_surface_set_interaction,
            commands::lyrics_surface_reset_position,
            commands::lyrics_surface_show_settings,
            commands::local_api_status,
            commands::local_api_set_enabled,
            commands::local_api_set_port,
            commands::local_api_reveal_token,
            commands::local_api_regenerate_token,
            commands::debug_perf_sample,
            commands::diagnostics_snapshot,
            commands::diagnostics_export_bundle,
            commands::diagnostics_reveal_bundle,
            commands::diagnostics_open_log_folder,
            commands::diagnostics_clear_logs,
            commands::diagnostics_set_log_level,
            commands::diagnostics_current_level,
            commands::diagnostics_recent_errors,
            commands::diagnostics_record_error,
            commands::diagnostics_log_frontend,
            commands::issue_reporter_preview,
            commands::issue_reporter_validate_url,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build desktop application");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let surfaces = Arc::clone(app_handle.state::<Arc<LyricsSurfaceManager>>().inner());
            let storage = Arc::clone(app_handle.state::<Arc<StorageService>>().inner());
            surfaces.save_all_geometry(app_handle, &storage);
            let player = Arc::clone(app_handle.state::<Arc<PlayerService>>().inner());
            let snapshot = tauri::async_runtime::block_on(player.snapshot());
            let storage = app_handle.state::<Arc<StorageService>>();
            let _ = storage.save_queue(&snapshot);
            player.stop_clock();
            let api = Arc::clone(app_handle.state::<Arc<LocalApiService>>().inner());
            tauri::async_runtime::block_on(async move {
                let _ = api.stop().await;
            });
        }
    });
}

#[cfg(test)]
mod account_owner_lifecycle_tests {
    use super::*;

    #[test]
    fn close_destroy_and_navigation_start_are_owner_loss_events() {
        for event in [
            MainOwnerLifecycleEvent::CloseRequested,
            MainOwnerLifecycleEvent::Destroyed,
            MainOwnerLifecycleEvent::PageLoadStarted,
        ] {
            assert!(owner_loss_reason(event).is_some());
        }
        assert!(owner_loss_reason(MainOwnerLifecycleEvent::PageLoadFinished).is_none());
    }
}

#[cfg(test)]
mod handler_registration_tests {
    #[test]
    fn restored_queue_rehydrates_provider_track_references_before_player_restore() {
        let source = include_str!("lib.rs");
        let remember = source
            .find("qq_music.remember_songs(&snapshot.queue)")
            .expect("restored queue provider-reference hydration");
        let restore = source
            .find("player.restore(snapshot)")
            .expect("player queue restoration");
        assert!(remember < restore);
    }

    #[test]
    fn account_mutation_commands_are_registered_exactly_once() {
        let source = include_str!("lib.rs");
        let handler = source
            .split_once(".invoke_handler(tauri::generate_handler![")
            .and_then(|(_, remainder)| remainder.split_once("])").map(|(block, _)| block))
            .expect("generate_handler block");
        for command in [
            "commands::qqmusic_set_favorite",
            "commands::qqmusic_create_playlist",
            "commands::qqmusic_rename_playlist",
            "commands::qqmusic_add_playlist_track",
            "commands::qqmusic_remove_playlist_track",
            "commands::qqmusic_delete_playlist",
            "commands::qqmusic_set_playlist_collected",
        ] {
            assert_eq!(handler.matches(command).count(), 1, "{command}");
        }
    }

    #[test]
    fn every_registered_app_command_is_declared_for_fine_grained_permissions() {
        let source = include_str!("lib.rs");
        let handler = source
            .split_once(".invoke_handler(tauri::generate_handler![")
            .and_then(|(_, remainder)| remainder.split_once("])").map(|(block, _)| block))
            .expect("generate_handler block");
        let build = include_str!("../build.rs");
        let commands = handler.lines().filter_map(|line| {
            line.trim()
                .strip_prefix("commands::")
                .map(|command| command.trim_end_matches(','))
        });

        for command in commands {
            assert!(
                build.contains(&format!("\"{command}\"")),
                "{command} is registered but absent from the fine-grained Tauri command manifest"
            );
        }

        let main_capability = include_str!("../capabilities/main-window.json");
        assert!(main_capability.contains("\"main-application\""));
        assert!(main_capability.contains("\"qqmusic-account\""));
        assert!(!main_capability.contains("qqmusic-oauth-"));

        let lyrics_capability = include_str!("../capabilities/default.json");
        assert!(lyrics_capability.contains("\"lyrics-surface-application\""));
        let lyrics_permissions = include_str!("../permissions/lyrics-surface-application.toml");
        for permission in [
            "allow-app-preferences-get",
            "allow-app-preferences-set",
            "allow-appearance-background-load",
            "allow-lyrics-surface-projection",
            "allow-lyrics-surface-close",
            "allow-lyrics-surface-set-interaction",
            "allow-lyrics-surface-show-settings",
            "allow-player-lyrics",
            "allow-player-previous",
            "allow-player-toggle",
            "allow-player-next",
        ] {
            assert!(lyrics_permissions.contains(permission), "{permission}");
        }
        assert!(!lyrics_permissions.contains("qqmusic-account"));
        assert!(!lyrics_permissions.contains("qqmusic-auth"));

        let unlock_capability = include_str!("../capabilities/lyrics-unlock.json");
        assert!(unlock_capability.contains("\"lyrics-desktop-unlock\""));
        assert!(unlock_capability.contains("\"lyrics-island-unlock\""));
        assert!(unlock_capability.contains("\"lyrics-surface-unlock-control\""));
        let unlock_permissions = include_str!("../permissions/lyrics-surface-unlock-control.toml");
        assert!(unlock_permissions.contains("allow-lyrics-surface-unlock"));
        assert!(!unlock_permissions.contains("app-preferences"));
        assert!(!unlock_permissions.contains("player-"));
        assert!(!unlock_permissions.contains("qqmusic-"));
    }
}
