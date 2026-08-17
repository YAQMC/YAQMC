use crate::{
    app_preferences::{self, ManagedBackgroundImage},
    audio::AudioOutputDevice,
    command_guard::require_main_window,
    desktop_integration::{DesktopIntegration, DesktopIntegrationStatus},
    diagnostics::{self, AppSection, BundleExportResult, BundleOptions, DiagnosticsSnapshot},
    issue_reporter::{self, IssueDraft, IssuePreview},
    local_api::{LocalApiService, LocalApiStatus},
    logging::{
        self, ErrorRecord, LogLevel, LoggingHandle, LOG_LEVEL_SETTING_KEY as LOGGING_LEVEL_SETTING,
    },
    lyrics_surface::{
        close_surface, surface_statuses, LyricsSurfaceManager, SurfaceCapabilities,
        SurfaceInteraction, SurfaceKind, SurfaceRuntimeMap,
    },
    platform::{self, PlatformDiagnostics},
    player::{
        LyricDocument, LyricSurfaceProjection, PlayTracksRequest, PlayerService, PlayerSnapshot,
        PrimaryPlaybackMode, RepeatMode, Song,
    },
    qqmusic::{
        account::{
            AccountPlaylistDetail, AccountPlaylistSummary, AccountSnapshot, CollectPlaylistRequest,
            CreatePlaylistRequest, DeletePlaylistRequest, FavoriteMutationRequest,
            FavoriteMutationResult, Page, PlaylistMutationResult, PlaylistTrackMutationRequest,
            RemotePlayHistoryItem, RenamePlaylistRequest,
        },
        Album, AreaFeed, AudioQualityPreference, DiscoverFeed, HomeFeed, LibrarySnapshot,
        OAuthLoginProvider, Playlist, ProviderResult, ProviderStatus, QQMusicService, SearchResult,
    },
    storage::{CacheStats, StorageService},
    system_media::SystemMediaIntegration,
};
use std::{path::PathBuf, sync::Arc};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

type CommandResult<T> = Result<T, String>;
#[allow(dead_code)]
pub const AUDIO_OUTPUT_SETTING: &str = "audio-output-device";

pub use yaqmc_core::server::{
    DebugPerfSample, DiagnosticsBundleRequest, DiagnosticsRequest, FrontendLogEntry,
    RecordErrorRequest,
};

/// Load the configured log level from persistent storage. Falls back to the debug
/// default (Debug) if the setting is absent or malformed.
#[allow(dead_code)]
pub fn load_persisted_log_level(storage: &Arc<StorageService>) -> LogLevel {
    logging::persisted_log_level(
        storage
            .get_setting(LOGGING_LEVEL_SETTING)
            .ok()
            .flatten()
            .as_deref(),
    )
}

fn build_app_section(app: &AppHandle) -> AppSection {
    AppSection {
        name: "YAQMC",
        version: app.package_info().version.to_string(),
        commit: option_env!("YAQMC_BUILD_COMMIT").map(String::from),
        channel: std::env::var("YAQMC_RELEASE_CHANNEL").unwrap_or_else(|_| "development".into()),
        build_type: if cfg!(debug_assertions) {
            "debug".into()
        } else {
            "release".into()
        },
    }
}

async fn assemble_snapshot(
    app: &AppHandle,
    player: &Arc<PlayerService>,
    system_media: &Arc<SystemMediaIntegration>,
    desktop: &Arc<DesktopIntegration>,
    logging: &Arc<LoggingHandle>,
    provider: &Arc<QQMusicService>,
    request: DiagnosticsRequest,
) -> DiagnosticsSnapshot {
    yaqmc_core::server::ops::assemble_diagnostics_snapshot(
        player,
        provider,
        logging,
        app.try_state::<Arc<crate::plugin::ExtensionHost>>()
            .as_deref()
            .map(std::ops::Deref::deref),
        platform::collect(app, player, system_media.status(), desktop.status()),
        build_app_section(app),
        request,
    )
    .await
}

#[tauri::command]
pub async fn diagnostics_snapshot(
    app: AppHandle,
    player: State<'_, Arc<PlayerService>>,
    system_media: State<'_, Arc<SystemMediaIntegration>>,
    desktop: State<'_, Arc<DesktopIntegration>>,
    logging: State<'_, Arc<LoggingHandle>>,
    provider: State<'_, Arc<QQMusicService>>,
    request: DiagnosticsRequest,
) -> CommandResult<DiagnosticsSnapshot> {
    Ok(assemble_snapshot(
        &app,
        &player,
        &system_media,
        &desktop,
        &logging,
        &provider,
        request,
    )
    .await)
}

#[tauri::command]
pub async fn diagnostics_export_bundle(
    app: AppHandle,
    player: State<'_, Arc<PlayerService>>,
    system_media: State<'_, Arc<SystemMediaIntegration>>,
    desktop: State<'_, Arc<DesktopIntegration>>,
    logging: State<'_, Arc<LoggingHandle>>,
    provider: State<'_, Arc<QQMusicService>>,
    request: DiagnosticsBundleRequest,
) -> CommandResult<BundleExportResult> {
    let dest = app
        .path()
        .download_dir()
        .map_err(|error| error.to_string())?;
    let snapshot = assemble_snapshot(
        &app,
        &player,
        &system_media,
        &desktop,
        &logging,
        &provider,
        request.base,
    )
    .await;
    let options = BundleOptions {
        include_logs: request.include_logs.unwrap_or(true),
        override_unresolved: request.override_unresolved.unwrap_or(false),
        description: request.description.as_deref(),
        issue_category: request.issue_category.as_deref(),
    };
    diagnostics::export_bundle(&dest, &snapshot, logging.log_dir(), options)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn diagnostics_reveal_bundle(
    app: AppHandle,
    logging: State<'_, Arc<LoggingHandle>>,
    path: String,
) -> CommandResult<()> {
    let target = PathBuf::from(&path);
    let downloads = app
        .path()
        .download_dir()
        .map_err(|error| error.to_string())?;
    let inside_downloads = target.starts_with(&downloads);
    let inside_logs = target.starts_with(logging.log_dir());
    if !inside_downloads && !inside_logs {
        return Err("path is outside diagnostic download/log directories".into());
    }
    reveal_in_file_manager(&target).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn diagnostics_open_log_folder(
    logging: State<'_, Arc<LoggingHandle>>,
) -> CommandResult<String> {
    let dir = logging.log_dir().to_path_buf();
    open_folder_in_file_manager(&dir).map_err(|error| error.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn diagnostics_clear_logs(logging: State<'_, Arc<LoggingHandle>>) -> CommandResult<usize> {
    Ok(yaqmc_core::server::ops::diagnostics_clear_logs(&logging))
}

#[tauri::command]
pub fn diagnostics_set_log_level(
    storage: State<'_, Arc<StorageService>>,
    level: LogLevel,
) -> CommandResult<LogLevel> {
    yaqmc_core::server::ops::diagnostics_set_log_level(&storage, level)
}

#[tauri::command]
pub fn diagnostics_current_level(logging: State<'_, Arc<LoggingHandle>>) -> LogLevel {
    logging.level()
}

#[tauri::command]
pub fn diagnostics_recent_errors(logging: State<'_, Arc<LoggingHandle>>) -> Vec<ErrorRecord> {
    logging.recent_errors()
}

#[tauri::command]
pub fn diagnostics_record_error(
    logging: State<'_, Arc<LoggingHandle>>,
    request: RecordErrorRequest,
) -> CommandResult<()> {
    yaqmc_core::server::ops::diagnostics_record_error(&logging, request);
    Ok(())
}

#[tauri::command]
pub fn diagnostics_log_frontend(
    logging: State<'_, Arc<LoggingHandle>>,
    entries: Vec<FrontendLogEntry>,
) -> CommandResult<()> {
    yaqmc_core::server::ops::diagnostics_log_frontend(&logging, entries);
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn issue_reporter_preview(
    app: AppHandle,
    player: State<'_, Arc<PlayerService>>,
    system_media: State<'_, Arc<SystemMediaIntegration>>,
    desktop: State<'_, Arc<DesktopIntegration>>,
    logging: State<'_, Arc<LoggingHandle>>,
    provider: State<'_, Arc<QQMusicService>>,
    draft: IssueDraft,
    request: DiagnosticsRequest,
) -> CommandResult<IssuePreview> {
    let snapshot = assemble_snapshot(
        &app,
        &player,
        &system_media,
        &desktop,
        &logging,
        &provider,
        request,
    )
    .await;
    Ok(issue_reporter::prepare_preview(&draft, &snapshot))
}

#[tauri::command]
pub fn issue_reporter_validate_url(url: String) -> CommandResult<()> {
    issue_reporter::validate_open_url(&url).map_err(|reason| reason.to_owned())
}

fn open_folder_in_file_manager(path: &std::path::Path) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(path)
            .spawn()?;
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open").arg(path).spawn()?;
        Ok(())
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        std::process::Command::new("open").arg(path).spawn()?;
        Ok(())
    }
}

fn reveal_in_file_manager(path: &std::path::Path) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg("/select,")
            .arg(path)
            .spawn()?;
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        let parent = path.parent().unwrap_or(path);
        std::process::Command::new("xdg-open").arg(parent).spawn()?;
        Ok(())
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(path)
            .spawn()?;
        Ok(())
    }
}

#[tauri::command]
pub fn platform_diagnostics(
    app: AppHandle,
    player: State<'_, Arc<PlayerService>>,
    system_media: State<'_, Arc<SystemMediaIntegration>>,
    desktop: State<'_, Arc<DesktopIntegration>>,
) -> PlatformDiagnostics {
    platform::collect(&app, &player, system_media.status(), desktop.status())
}

#[tauri::command]
pub fn platform_export_diagnostics(
    app: AppHandle,
    player: State<'_, Arc<PlayerService>>,
    system_media: State<'_, Arc<SystemMediaIntegration>>,
    desktop: State<'_, Arc<DesktopIntegration>>,
) -> CommandResult<String> {
    let diagnostics = platform::collect(&app, &player, system_media.status(), desktop.status());
    platform::export_bundle(&app, &diagnostics).map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn system_integration_status(
    desktop: State<'_, Arc<DesktopIntegration>>,
) -> DesktopIntegrationStatus {
    desktop.status()
}

#[tauri::command]
pub fn system_shortcuts_set_enabled(
    app: AppHandle,
    desktop: State<'_, Arc<DesktopIntegration>>,
    enabled: bool,
) -> CommandResult<DesktopIntegrationStatus> {
    desktop.set_shortcuts_enabled(&app, enabled)?;
    Ok(desktop.status())
}

#[tauri::command]
pub async fn audio_output_devices(
    player: State<'_, Arc<PlayerService>>,
) -> CommandResult<Vec<AudioOutputDevice>> {
    player.output_devices().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn audio_set_output_device(
    player: State<'_, Arc<PlayerService>>,
    storage: State<'_, Arc<StorageService>>,
    device_id: String,
) -> CommandResult<Vec<AudioOutputDevice>> {
    yaqmc_core::server::ops::audio_set_output_device(&player, &storage, &device_id)
}

#[tauri::command]
pub async fn qqmusic_status(
    provider: State<'_, Arc<QQMusicService>>,
) -> CommandResult<ProviderStatus> {
    Ok(provider.status().await)
}

#[tauri::command]
pub async fn qqmusic_home(
    provider: State<'_, Arc<QQMusicService>>,
    refresh: bool,
) -> ProviderResult<HomeFeed> {
    provider.home(refresh).await.map_err(Into::into)
}

#[tauri::command]
pub async fn qqmusic_discover(
    provider: State<'_, Arc<QQMusicService>>,
    refresh: bool,
) -> ProviderResult<DiscoverFeed> {
    provider.discover(refresh).await.map_err(Into::into)
}

#[tauri::command]
pub async fn qqmusic_area(
    provider: State<'_, Arc<QQMusicService>>,
    enc_area: String,
) -> ProviderResult<AreaFeed> {
    provider.area(enc_area).await.map_err(Into::into)
}

#[tauri::command]
pub async fn qqmusic_guess_next(
    provider: State<'_, Arc<QQMusicService>>,
    limit: u32,
) -> ProviderResult<Vec<Song>> {
    provider.guess_next(limit).await.map_err(Into::into)
}

#[tauri::command]
pub async fn qqmusic_library(
    provider: State<'_, Arc<QQMusicService>>,
) -> CommandResult<LibrarySnapshot> {
    Ok(provider.library())
}

#[tauri::command]
pub async fn qqmusic_search(
    provider: State<'_, Arc<QQMusicService>>,
    query: String,
    page: u32,
    limit: u32,
) -> ProviderResult<SearchResult> {
    provider
        .search(query, page, limit)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn qqmusic_album(
    provider: State<'_, Arc<QQMusicService>>,
    id: String,
) -> ProviderResult<Album> {
    provider.album(id).await.map_err(Into::into)
}

#[tauri::command]
pub async fn qqmusic_playlist(
    provider: State<'_, Arc<QQMusicService>>,
    id: String,
) -> ProviderResult<Playlist> {
    provider.playlist(id).await.map_err(Into::into)
}

#[tauri::command]
pub async fn qqmusic_lyrics(
    provider: State<'_, Arc<QQMusicService>>,
    song_id: String,
) -> ProviderResult<Option<LyricDocument>> {
    provider.lyrics(song_id).await.map_err(Into::into)
}

#[tauri::command]
pub async fn qqmusic_cache_artwork(
    provider: State<'_, Arc<QQMusicService>>,
    url: String,
) -> ProviderResult<String> {
    provider.artwork_data_uri(url).await.map_err(Into::into)
}

#[tauri::command]
pub async fn qqmusic_set_preferred_quality(
    provider: State<'_, Arc<QQMusicService>>,
    player: State<'_, Arc<PlayerService>>,
    quality: AudioQualityPreference,
) -> ProviderResult<ProviderStatus> {
    yaqmc_core::server::ops::qqmusic_set_preferred_quality(&provider, &player, quality).await
}

#[tauri::command]
pub async fn qqmusic_set_current_quality(
    provider: State<'_, Arc<QQMusicService>>,
    player: State<'_, Arc<PlayerService>>,
    quality: AudioQualityPreference,
) -> ProviderResult<PlayerSnapshot> {
    yaqmc_core::server::ops::qqmusic_set_current_quality(&provider, &player, quality).await
}

#[tauri::command]
pub async fn qqmusic_account_snapshot(
    window: tauri::WebviewWindow,
    provider: State<'_, Arc<QQMusicService>>,
) -> ProviderResult<AccountSnapshot> {
    require_main_window(&window)?;
    Ok(provider.account_snapshot().await)
}

#[tauri::command]
pub async fn qqmusic_favorite_songs(
    window: tauri::WebviewWindow,
    provider: State<'_, Arc<QQMusicService>>,
    cursor: Option<String>,
    limit: u32,
) -> ProviderResult<Page<Song>> {
    require_main_window(&window)?;
    provider
        .favorite_songs(cursor, limit)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn qqmusic_account_playlists(
    window: tauri::WebviewWindow,
    provider: State<'_, Arc<QQMusicService>>,
    cursor: Option<String>,
    limit: u32,
) -> ProviderResult<Page<AccountPlaylistSummary>> {
    require_main_window(&window)?;
    provider
        .account_playlists(cursor, limit)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn qqmusic_account_playlist_tracks(
    window: tauri::WebviewWindow,
    provider: State<'_, Arc<QQMusicService>>,
    playlist: AccountPlaylistSummary,
    cursor: Option<String>,
    limit: u32,
) -> ProviderResult<AccountPlaylistDetail> {
    require_main_window(&window)?;
    provider
        .account_playlist_tracks(playlist, cursor, limit)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn qqmusic_account_recently_played(
    window: tauri::WebviewWindow,
    provider: State<'_, Arc<QQMusicService>>,
    cursor: Option<String>,
    limit: u32,
) -> ProviderResult<Page<RemotePlayHistoryItem>> {
    require_main_window(&window)?;
    provider
        .account_recently_played(cursor, limit)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn qqmusic_set_favorite(
    window: tauri::WebviewWindow,
    provider: State<'_, Arc<QQMusicService>>,
    request: FavoriteMutationRequest,
) -> ProviderResult<FavoriteMutationResult> {
    require_main_window(&window)?;
    provider.set_favorite(request).await.map_err(Into::into)
}

#[tauri::command]
pub async fn qqmusic_create_playlist(
    window: tauri::WebviewWindow,
    provider: State<'_, Arc<QQMusicService>>,
    request: CreatePlaylistRequest,
) -> ProviderResult<PlaylistMutationResult> {
    require_main_window(&window)?;
    provider.create_playlist(request).await.map_err(Into::into)
}

#[tauri::command]
pub async fn qqmusic_rename_playlist(
    window: tauri::WebviewWindow,
    provider: State<'_, Arc<QQMusicService>>,
    request: RenamePlaylistRequest,
) -> ProviderResult<PlaylistMutationResult> {
    require_main_window(&window)?;
    provider.rename_playlist(request).await.map_err(Into::into)
}

#[tauri::command]
pub async fn qqmusic_add_playlist_track(
    window: tauri::WebviewWindow,
    provider: State<'_, Arc<QQMusicService>>,
    request: PlaylistTrackMutationRequest,
) -> ProviderResult<PlaylistMutationResult> {
    require_main_window(&window)?;
    provider
        .add_playlist_track(request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn qqmusic_remove_playlist_track(
    window: tauri::WebviewWindow,
    provider: State<'_, Arc<QQMusicService>>,
    request: PlaylistTrackMutationRequest,
) -> ProviderResult<PlaylistMutationResult> {
    require_main_window(&window)?;
    provider
        .remove_playlist_track(request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn qqmusic_delete_playlist(
    window: tauri::WebviewWindow,
    provider: State<'_, Arc<QQMusicService>>,
    request: DeletePlaylistRequest,
) -> ProviderResult<PlaylistMutationResult> {
    require_main_window(&window)?;
    provider.delete_playlist(request).await.map_err(Into::into)
}

#[tauri::command]
pub async fn qqmusic_set_playlist_collected(
    window: tauri::WebviewWindow,
    provider: State<'_, Arc<QQMusicService>>,
    request: CollectPlaylistRequest,
) -> ProviderResult<PlaylistMutationResult> {
    require_main_window(&window)?;
    provider
        .set_playlist_collected(request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn qqmusic_auth_start(
    window: tauri::WebviewWindow,
    provider: State<'_, Arc<QQMusicService>>,
) -> ProviderResult<AccountSnapshot> {
    require_main_window(&window)?;
    provider.start_qr_login().await.map_err(Into::into)
}

#[tauri::command]
pub async fn qqmusic_auth_oauth_start(
    app: AppHandle,
    window: tauri::WebviewWindow,
    provider: State<'_, Arc<QQMusicService>>,
    login_provider: OAuthLoginProvider,
) -> ProviderResult<AccountSnapshot> {
    require_main_window(&window)?;
    crate::qqmusic_oauth_host::open_window(
        &app,
        &window,
        Arc::clone(provider.inner()),
        login_provider,
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub async fn qqmusic_auth_heartbeat(
    app: AppHandle,
    window: tauri::WebviewWindow,
    provider: State<'_, Arc<QQMusicService>>,
    attempt_id: String,
    owner_lease_id: String,
) -> ProviderResult<AccountSnapshot> {
    require_main_window(&window)?;
    yaqmc_core::server::ops::qqmusic_auth_heartbeat(
        &provider,
        attempt_id.clone(),
        owner_lease_id,
        crate::qqmusic_oauth_host::window_is_live(&app, &attempt_id),
    )
    .await
}

#[tauri::command]
pub async fn qqmusic_auth_cancel(
    app: AppHandle,
    window: tauri::WebviewWindow,
    provider: State<'_, Arc<QQMusicService>>,
    attempt_id: String,
) -> ProviderResult<AccountSnapshot> {
    require_main_window(&window)?;
    let result = provider.cancel_qr_login(attempt_id.clone()).await;
    crate::qqmusic_oauth_host::close_window_for_attempt(&app, &attempt_id);
    let snapshot = match result {
        Ok(snapshot) => snapshot,
        Err(error) => return Err(error.into()),
    };
    Ok(snapshot)
}

#[tauri::command]
pub async fn qqmusic_auth_refresh(
    window: tauri::WebviewWindow,
    provider: State<'_, Arc<QQMusicService>>,
    attempt_id: Option<String>,
) -> ProviderResult<AccountSnapshot> {
    require_main_window(&window)?;
    provider
        .refresh_qr_login(attempt_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn qqmusic_sign_out(
    window: tauri::WebviewWindow,
    provider: State<'_, Arc<QQMusicService>>,
) -> ProviderResult<AccountSnapshot> {
    require_main_window(&window)?;
    provider.sign_out().await.map_err(Into::into)
}

#[cfg(test)]
mod account_command_tests {
    use crate::command_guard::require_main_window_label;

    const GUARDED_ACCOUNT_COMMANDS: [&str; 18] = [
        "qqmusic_account_snapshot",
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
        "qqmusic_auth_start",
        "qqmusic_auth_oauth_start",
        "qqmusic_auth_heartbeat",
        "qqmusic_auth_cancel",
        "qqmusic_auth_refresh",
        "qqmusic_sign_out",
    ];

    #[test]
    fn every_account_command_uses_the_main_window_guard_contract() {
        let source = include_str!("commands.rs");
        for command in GUARDED_ACCOUNT_COMMANDS {
            let marker = format!("pub async fn {command}(");
            let block = source
                .split_once(&marker)
                .and_then(|(_, remainder)| {
                    remainder
                        .split_once("\n#[tauri::command]")
                        .map(|(block, _)| block)
                })
                .expect("guarded account command source block");
            assert!(
                block.contains("window: tauri::WebviewWindow"),
                "{command} must receive the invoking window"
            );
            assert!(
                block.contains("require_main_window(&window)?;"),
                "{command} must call the main-window guard"
            );
            assert!(
                require_main_window_label("main").is_ok(),
                "{command} must allow the main window"
            );
            let error = require_main_window_label("lyrics-desktop")
                .expect_err("lyrics window must be denied");
            assert_eq!(error.code, "caller-not-authorized", "{command}");
            assert!(!error.retryable, "{command}");
        }
    }
}

#[cfg(test)]
mod lyrics_window_command_tests {
    const WINDOW_MUTATING_COMMANDS: [&str; 6] = [
        "lyrics_surfaces_unlock_all",
        "lyrics_surface_unlock",
        "lyrics_surface_close",
        "lyrics_surface_set_interaction",
        "lyrics_surface_reset_position",
        "lyrics_surface_show_settings",
    ];

    #[test]
    fn lyric_window_mutations_do_not_run_on_the_tauri_main_thread() {
        let source = include_str!("commands.rs");
        for command in WINDOW_MUTATING_COMMANDS {
            assert!(
                source.contains(&format!("pub async fn {command}(")),
                "{command} must be async because it creates, closes, or mutates native windows"
            );
        }
    }
}

#[tauri::command]
pub async fn qqmusic_cache_stats(
    provider: State<'_, Arc<QQMusicService>>,
) -> ProviderResult<CacheStats> {
    provider.cache_stats().map_err(Into::into)
}

#[tauri::command]
pub async fn qqmusic_clear_cache(
    provider: State<'_, Arc<QQMusicService>>,
) -> ProviderResult<CacheStats> {
    provider.clear_cache().map_err(Into::into)
}

#[tauri::command]
pub async fn player_snapshot(
    player: State<'_, Arc<PlayerService>>,
) -> CommandResult<PlayerSnapshot> {
    Ok(player.snapshot().await)
}

#[tauri::command]
pub async fn player_hydrate_queue(
    player: State<'_, Arc<PlayerService>>,
    tracks: Vec<Song>,
) -> CommandResult<PlayerSnapshot> {
    Ok(player.hydrate_queue(tracks).await)
}

#[tauri::command]
pub async fn player_play_tracks(
    player: State<'_, Arc<PlayerService>>,
    request: PlayTracksRequest,
) -> CommandResult<PlayerSnapshot> {
    player
        .play_tracks(request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn player_play_from_queue(
    player: State<'_, Arc<PlayerService>>,
    index: usize,
) -> CommandResult<PlayerSnapshot> {
    player
        .play_from_queue(index)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn player_play_queue_entry(
    player: State<'_, Arc<PlayerService>>,
    entry_id: String,
) -> CommandResult<PlayerSnapshot> {
    player
        .play_queue_entry(&entry_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn player_play(player: State<'_, Arc<PlayerService>>) -> CommandResult<PlayerSnapshot> {
    player.play().await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn player_pause(player: State<'_, Arc<PlayerService>>) -> CommandResult<PlayerSnapshot> {
    player.pause().await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn player_toggle(player: State<'_, Arc<PlayerService>>) -> CommandResult<PlayerSnapshot> {
    player.toggle().await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn player_next(player: State<'_, Arc<PlayerService>>) -> CommandResult<PlayerSnapshot> {
    player.next().await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn player_previous(
    player: State<'_, Arc<PlayerService>>,
) -> CommandResult<PlayerSnapshot> {
    player.previous().await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn player_seek(
    player: State<'_, Arc<PlayerService>>,
    position_ms: u64,
) -> CommandResult<PlayerSnapshot> {
    player
        .seek(position_ms)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn player_set_volume(
    player: State<'_, Arc<PlayerService>>,
    volume: f64,
) -> CommandResult<PlayerSnapshot> {
    player
        .set_volume(volume)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn player_toggle_muted(
    player: State<'_, Arc<PlayerService>>,
) -> CommandResult<PlayerSnapshot> {
    player
        .toggle_muted()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn player_toggle_shuffle(
    player: State<'_, Arc<PlayerService>>,
) -> CommandResult<PlayerSnapshot> {
    Ok(player.toggle_shuffle().await)
}

#[tauri::command]
pub async fn player_set_shuffle(
    player: State<'_, Arc<PlayerService>>,
    enabled: bool,
) -> CommandResult<PlayerSnapshot> {
    Ok(player.set_shuffle(enabled).await)
}

#[tauri::command]
pub async fn player_cycle_repeat(
    player: State<'_, Arc<PlayerService>>,
) -> CommandResult<PlayerSnapshot> {
    Ok(player.cycle_repeat().await)
}

#[tauri::command]
pub async fn player_set_repeat(
    player: State<'_, Arc<PlayerService>>,
    mode: RepeatMode,
) -> CommandResult<PlayerSnapshot> {
    Ok(player.set_repeat(mode).await)
}

#[tauri::command]
pub async fn player_set_primary_playback_mode(
    player: State<'_, Arc<PlayerService>>,
    mode: PrimaryPlaybackMode,
) -> CommandResult<PlayerSnapshot> {
    Ok(player.set_primary_playback_mode(mode).await)
}

#[tauri::command]
pub async fn player_add_to_queue(
    player: State<'_, Arc<PlayerService>>,
    track: Song,
) -> CommandResult<PlayerSnapshot> {
    Ok(player.add_to_queue(track).await)
}

#[tauri::command]
pub async fn player_add_tracks_to_queue(
    player: State<'_, Arc<PlayerService>>,
    tracks: Vec<Song>,
) -> CommandResult<PlayerSnapshot> {
    Ok(player.add_tracks_to_queue(tracks).await)
}

#[tauri::command]
pub async fn player_remove_from_queue(
    player: State<'_, Arc<PlayerService>>,
    index: usize,
) -> CommandResult<PlayerSnapshot> {
    player
        .remove_from_queue(index)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn player_remove_queue_entry(
    player: State<'_, Arc<PlayerService>>,
    entry_id: String,
) -> CommandResult<PlayerSnapshot> {
    player
        .remove_queue_entry(&entry_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn player_reorder_queue_entry(
    player: State<'_, Arc<PlayerService>>,
    entry_id: String,
    target_index: usize,
) -> CommandResult<PlayerSnapshot> {
    player
        .reorder_queue_entry(&entry_id, target_index)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn player_play_next_queue_entry(
    player: State<'_, Arc<PlayerService>>,
    entry_id: String,
) -> CommandResult<PlayerSnapshot> {
    player
        .play_next_queue_entry(&entry_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn player_set_lyrics(
    player: State<'_, Arc<PlayerService>>,
    document: Option<LyricDocument>,
) -> CommandResult<()> {
    player.set_lyrics(document).await;
    Ok(())
}

#[tauri::command]
pub async fn player_lyrics(
    player: State<'_, Arc<PlayerService>>,
) -> CommandResult<Option<LyricDocument>> {
    Ok(player.lyrics().await)
}

#[tauri::command]
pub async fn lyrics_surface_projection(
    player: State<'_, Arc<PlayerService>>,
) -> CommandResult<LyricSurfaceProjection> {
    Ok(player.lyric_surface_projection().await)
}

#[tauri::command]
pub fn app_preferences_get(
    storage: State<'_, Arc<crate::storage::StorageService>>,
) -> CommandResult<Option<String>> {
    app_preferences::get_preferences(&storage)
}

#[tauri::command]
pub fn app_preferences_set(
    app: AppHandle,
    storage: State<'_, Arc<crate::storage::StorageService>>,
    value: String,
) -> CommandResult<()> {
    app_preferences::set_preferences(&app, &storage, value)
}

#[tauri::command]
pub async fn appearance_pick_background(
    app: AppHandle,
) -> CommandResult<Option<ManagedBackgroundImage>> {
    app_preferences::pick_background(app).await
}

#[tauri::command]
pub async fn appearance_background_load(
    app: AppHandle,
    reference: String,
) -> CommandResult<Option<ManagedBackgroundImage>> {
    app_preferences::load_background(&app, reference).await
}

#[tauri::command]
pub async fn lyrics_surfaces_reconcile(
    app: AppHandle,
    storage: State<'_, Arc<crate::storage::StorageService>>,
    manager: State<'_, Arc<LyricsSurfaceManager>>,
    surfaces: SurfaceRuntimeMap,
) -> CommandResult<SurfaceCapabilities> {
    manager.reconcile(&app, &storage, surfaces).await
}

#[tauri::command]
pub fn lyrics_surface_capabilities(app: AppHandle) -> SurfaceCapabilities {
    LyricsSurfaceManager::capabilities(&app)
}

#[tauri::command]
pub fn lyrics_surface_status(app: AppHandle) -> std::collections::HashMap<&'static str, bool> {
    surface_statuses(&app)
}

#[tauri::command]
pub async fn lyrics_surfaces_unlock_all(
    app: AppHandle,
    storage: State<'_, Arc<StorageService>>,
    manager: State<'_, Arc<LyricsSurfaceManager>>,
) -> CommandResult<usize> {
    app_preferences::unlock_all_lyrics_surfaces(&app, &storage, &manager)
}

#[tauri::command]
pub async fn lyrics_surface_unlock(
    app: AppHandle,
    window: WebviewWindow,
    storage: State<'_, Arc<StorageService>>,
    manager: State<'_, Arc<LyricsSurfaceManager>>,
    kind: String,
) -> CommandResult<()> {
    let kind = SurfaceKind::parse(&kind)?;
    if window.label() != kind.unlock_label() {
        return Err("lyrics unlock caller does not match the requested surface".to_owned());
    }
    app_preferences::unlock_lyrics_surface(&app, &storage, &manager, kind)
}

#[tauri::command]
pub async fn lyrics_surface_close(
    app: AppHandle,
    storage: State<'_, Arc<crate::storage::StorageService>>,
    kind: String,
) -> CommandResult<()> {
    close_surface(&app, &storage, SurfaceKind::parse(&kind)?)
}

#[tauri::command]
pub async fn lyrics_surface_set_interaction(
    app: AppHandle,
    storage: State<'_, Arc<StorageService>>,
    manager: State<'_, Arc<LyricsSurfaceManager>>,
    kind: String,
    interaction: SurfaceInteraction,
    value: String,
) -> CommandResult<String> {
    let kind = SurfaceKind::parse(&kind)?;
    let previous = manager.interaction(kind);
    manager.set_interaction(&app, kind, interaction)?;
    match app_preferences::set_surface_interaction(
        &app,
        &storage,
        kind.value(),
        interaction.value(),
        value,
    ) {
        Ok(value) => Ok(value),
        Err(error) => {
            let _ = manager.set_interaction(&app, kind, previous);
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn lyrics_surface_reset_position(
    app: AppHandle,
    storage: State<'_, Arc<crate::storage::StorageService>>,
    manager: State<'_, Arc<LyricsSurfaceManager>>,
    kind: String,
) -> CommandResult<()> {
    manager.reset_geometry(&app, &storage, SurfaceKind::parse(&kind)?)
}

#[tauri::command]
pub async fn lyrics_surface_show_settings(app: AppHandle) -> CommandResult<()> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_owned())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    app.emit("app://open-settings", ())
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn local_api_status(
    api: State<'_, Arc<LocalApiService>>,
) -> CommandResult<LocalApiStatus> {
    Ok(api.status().await)
}

#[tauri::command]
pub async fn local_api_set_enabled(
    api: State<'_, Arc<LocalApiService>>,
    enabled: bool,
) -> CommandResult<LocalApiStatus> {
    api.set_enabled(enabled)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn local_api_set_port(
    api: State<'_, Arc<LocalApiService>>,
    port: u16,
) -> CommandResult<LocalApiStatus> {
    yaqmc_core::server::ops::local_api_set_port(&api, port).await
}

#[tauri::command]
pub async fn local_api_reveal_token(api: State<'_, Arc<LocalApiService>>) -> CommandResult<String> {
    Ok(api.reveal_token().await)
}

#[tauri::command]
pub async fn local_api_regenerate_token(
    api: State<'_, Arc<LocalApiService>>,
) -> CommandResult<LocalApiStatus> {
    api.regenerate_token()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn debug_perf_sample(app: AppHandle, sample: DebugPerfSample) -> CommandResult<()> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|error| error.to_string())?;
    yaqmc_core::server::write_perf_sample(&dir, &sample)
}

#[cfg(test)]
mod debug_perf_sample_tests {
    use super::*;
    use yaqmc_core::server::{perf_sample_header, perf_sample_line};

    #[test]
    fn perf_log_line_rejects_invalid_samples() {
        assert!(perf_sample_line(&DebugPerfSample {
            fps: 60,
            average_ms: f64::NAN,
            p95_ms: 17.0,
            max_ms: 40.0,
            long_tasks: 0,
        })
        .is_none());
        assert!(perf_sample_line(&DebugPerfSample {
            fps: u32::MAX,
            average_ms: 17.0,
            p95_ms: 17.0,
            max_ms: 40.0,
            long_tasks: 0,
        })
        .is_none());
    }

    #[test]
    fn perf_log_line_matches_the_csv_header() {
        let line = perf_sample_line(&DebugPerfSample {
            fps: 60,
            average_ms: 16.7,
            p95_ms: 17.0,
            max_ms: 40.0,
            long_tasks: 2,
        })
        .expect("valid sample");
        let columns = line.split(',').count();
        assert_eq!(perf_sample_header().split(',').count(), columns);
        assert!(line.contains("60,16.70,17.00,40.00,2"));
    }
}

#[cfg(test)]
mod diagnostics_dto_mapping_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn host_provider_and_plugin_diagnostics_map_to_the_core_wire_fixture() {
        let provider = ProviderStatus {
            provider_id: "qqmusic".into(),
            display_name: "QQ Music".into(),
            connection: "online".into(),
            message: "ready".into(),
            preferred_quality: AudioQualityPreference::Automatic,
            capabilities: crate::qqmusic::CatalogProviderCapabilities {
                search: true,
                album: true,
                artist: true,
                playlist: true,
                lyrics: true,
                word_timed_lyrics: true,
                streaming: true,
                quality_selection: true,
            },
        };
        let request = DiagnosticsRequest {
            account_state: Some("authenticated".into()),
            membership_tier: Some("green-diamond".into()),
            membership_status: Some("active".into()),
            lyrics_preset: None,
        };
        assert_eq!(
            serde_json::to_value(yaqmc_core::server::map_provider_section_for_test(
                provider, &request
            ))
            .expect("provider JSON"),
            json!({
                "id": "qqmusic",
                "connection": "online",
                "accountState": "authenticated",
                "membershipTier": "green-diamond",
                "membershipStatus": "active"
            })
        );

        let plugin = crate::plugin::PluginDiagnostic {
            id: "visualizer".into(),
            version: "1.2.3".into(),
            enabled: true,
            status: crate::plugin::PluginStatus::Active,
            entrypoint_kinds: vec!["scene".into()],
            api_version: 1,
            package_sha256: "a".repeat(64),
            permissions: vec!["ui.scene".into()],
            risk_rating: "low".into(),
        };
        assert_eq!(
            serde_json::to_value(yaqmc_core::server::map_plugin_diagnostic_for_test(plugin))
                .expect("plugin JSON"),
            json!({
                "id": "visualizer",
                "version": "1.2.3",
                "enabled": true,
                "status": "active",
                "entrypointKinds": ["scene"],
                "apiVersion": 1,
                "packageSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "permissions": ["ui.scene"],
                "riskRating": "low"
            })
        );
    }
}
