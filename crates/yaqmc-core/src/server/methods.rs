use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};

use yaqmc_protocol::{
    authorize, AclDenied, CoreError, ErrorCode, MethodOwner, PlatformAttach, WindowOrigin,
};

use crate::player::PlayTracksRequest;
use crate::plugin::api::{
    PluginBridgeRequest, PluginEnableRequest, PluginInstallRequest, PluginSettingsWrite,
    PluginUninstallRequest,
};
use crate::qqmusic::account::{
    CollectPlaylistRequest, CreatePlaylistRequest, DeletePlaylistRequest, FavoriteMutationRequest,
    PlaylistTrackMutationRequest, RenamePlaylistRequest,
};
use crate::qqmusic::{ProviderCommandError, ProviderResult};
use crate::CoreHandle;

use super::ops;
use super::types::{
    AttemptIdParams, AuthHeartbeatParams, CursorPageParams, DeviceIdParams,
    DiagnosticsExportToParams, EnabledParams, EncAreaParams, EntryIdParams, FrontendLogParams,
    IdParams, IndexParams, IssueReporterPreviewParams, LevelParams, LimitParams,
    LyricsDocumentParams, NamedRequest, OAuthCompleteParams, OAuthPrepareParams,
    OptionalAttemptParams, PathParams, PlaylistTracksParams, PluginIdParams,
    PluginMarkFailedParams, PluginReadAssetParams, PortParams, PrimaryModeParams, QualityParams,
    RecordErrorRequest, ReferenceParams, ReorderParams, RepeatParams, SampleParams, SearchParams,
    SeekParams, SettingKeyParams, SettingWriteParams, SongIdParams, TokenParams, TrackParams,
    TracksParams, UrlParams, ValueParams, VolumeParams,
};
use super::HostDispatchHooks;

pub const CORE_DISPATCH_METHODS: &[&str] = &[
    "platform_diagnostics",
    "platform_export_diagnostics",
    "audio_output_devices",
    "audio_set_output_device",
    "qqmusic_status",
    "qqmusic_home",
    "qqmusic_discover",
    "qqmusic_area",
    "qqmusic_guess_next",
    "qqmusic_library",
    "qqmusic_search",
    "qqmusic_album",
    "qqmusic_playlist",
    "qqmusic_lyrics",
    "qqmusic_cache_artwork",
    "qqmusic_set_preferred_quality",
    "qqmusic_set_current_quality",
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
    "qqmusic_auth_heartbeat",
    "qqmusic_auth_cancel",
    "qqmusic_auth_refresh",
    "qqmusic_sign_out",
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
    "appearance_background_load",
    "local_api_status",
    "local_api_set_enabled",
    "local_api_set_port",
    "local_api_reveal_token",
    "local_api_regenerate_token",
    "debug_perf_sample",
    "diagnostics_snapshot",
    "diagnostics_export_bundle",
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
    "plugin_install_unpacked",
    "plugin_reload",
    "plugin_read_asset",
    "plugin_settings_get",
    "plugin_settings_set",
    "core_ping",
    "platform_attach",
    "core_shutdown_prepare",
    "auth_oauth_prepare",
    "auth_oauth_complete",
    "auth_oauth_cancel",
    "app_settings_get",
    "app_settings_set",
    "app_settings_remove",
    "diagnostics_export_bundle_to",
    "preferences_set_background_from",
    "plugin_install_from",
];

#[derive(Debug)]
pub enum DispatchError {
    Denied(AclDenied),
    HostOwned {
        method: String,
    },
    PayloadTooLarge {
        length: u32,
        limit: u32,
    },
    InvalidParams(String),
    Command {
        message: String,
        retryable: bool,
        details: Option<Value>,
    },
}

impl DispatchError {
    pub fn into_core_error(self) -> CoreError {
        match self {
            Self::Denied(denied) => CoreError {
                code: denied.code().as_str().to_owned(),
                message: denied.to_string(),
                details: None,
                retryable: denied.retryable(),
            },
            Self::HostOwned { method } => CoreError {
                code: ErrorCode::Denied.as_str().to_owned(),
                message: format!("{method} is implemented by the host"),
                details: None,
                retryable: false,
            },
            Self::PayloadTooLarge { length, limit } => CoreError {
                code: ErrorCode::Protocol.as_str().to_owned(),
                message: format!("payload length {length} exceeds cap {limit}"),
                details: None,
                retryable: false,
            },
            Self::InvalidParams(message) => CoreError {
                code: ErrorCode::Protocol.as_str().to_owned(),
                message,
                details: None,
                retryable: false,
            },
            Self::Command {
                message,
                retryable,
                details,
            } => CoreError {
                code: ErrorCode::CommandError.as_str().to_owned(),
                message,
                details,
                retryable,
            },
        }
    }
}

impl From<AclDenied> for DispatchError {
    fn from(value: AclDenied) -> Self {
        Self::Denied(value)
    }
}

pub fn core_dispatch_methods() -> &'static [&'static str] {
    CORE_DISPATCH_METHODS
}

fn params_object(params: Option<&Value>) -> Value {
    match params {
        None | Some(Value::Null) => json!({}),
        Some(value) => value.clone(),
    }
}

fn parse<T: DeserializeOwned>(params: &Value) -> Result<T, DispatchError> {
    serde_json::from_value(params.clone())
        .map_err(|error| DispatchError::InvalidParams(error.to_string()))
}

fn ok<T: Serialize>(value: T) -> Result<Value, DispatchError> {
    serde_json::to_value(value).map_err(|error| DispatchError::Command {
        message: error.to_string(),
        retryable: false,
        details: None,
    })
}

fn cmd<T: Serialize>(result: Result<T, String>) -> Result<Value, DispatchError> {
    ok(result.map_err(|message| DispatchError::Command {
        message,
        retryable: false,
        details: None,
    })?)
}

fn provider<T: Serialize>(result: ProviderResult<T>) -> Result<Value, DispatchError> {
    match result {
        Ok(value) => ok(value),
        Err(error) => Err(provider_error(error)),
    }
}

fn provider_error(error: ProviderCommandError) -> DispatchError {
    DispatchError::Command {
        message: error.message.clone(),
        retryable: error.retryable,
        details: serde_json::to_value(&error).ok(),
    }
}

fn payload_len(value: &Value) -> u32 {
    serde_json::to_vec(value)
        .map(|bytes| u32::try_from(bytes.len()).unwrap_or(u32::MAX))
        .unwrap_or(u32::MAX)
}

fn apply_platform_attach(
    core: &CoreHandle,
    attach: PlatformAttach,
) -> Result<Value, DispatchError> {
    if let Some(handle) = attach
        .main_window_handle
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let hwnd = crate::system_media::parse_window_handle_hex(handle)
            .map_err(DispatchError::InvalidParams)?;
        core.start_system_media().attach_hwnd(
            hwnd,
            core.player(),
            core.host_command_publisher(),
            tokio::runtime::Handle::current(),
        );
    } else {
        // Linux: MPRIS needs no HWND. Windows with no handle keeps the
        // current unavailable SMTC status. A hidden message-window fallback
        // is not implemented (plan R-3, NEEDS ACCEPTANCE TEST).
        let _ = attach.platform_kind;
        let _ = attach.display_backend;
    }
    ok(json!({ "ok": true }))
}

#[allow(clippy::too_many_lines)]
pub async fn dispatch(
    core: &CoreHandle,
    host: &dyn HostDispatchHooks,
    origin: WindowOrigin,
    method_name: &str,
    params: Option<Value>,
) -> Result<Value, DispatchError> {
    let spec = authorize(origin, method_name)?;
    if spec.owner == MethodOwner::Host {
        return Err(DispatchError::HostOwned {
            method: method_name.to_owned(),
        });
    }
    let params = params_object(params.as_ref());
    let request_len = payload_len(&params);
    if !spec.accepts_request_bytes(request_len) {
        return Err(DispatchError::PayloadTooLarge {
            length: request_len,
            limit: spec.request_cap,
        });
    }
    let result = invoke_core(core, host, method_name, params).await?;
    let response_len = payload_len(&result);
    if !spec.accepts_response_bytes(response_len) {
        return Err(DispatchError::PayloadTooLarge {
            length: response_len,
            limit: spec.response_cap,
        });
    }
    Ok(result)
}

#[allow(clippy::too_many_lines)]
async fn invoke_core(
    core: &CoreHandle,
    host: &dyn HostDispatchHooks,
    method_name: &str,
    params: Value,
) -> Result<Value, DispatchError> {
    let notify_plugin = || host.notify_plugin_changed();
    match method_name {
        "platform_diagnostics" => ok(host.platform_diagnostics()),
        "platform_export_diagnostics" => cmd(ops::platform_export_diagnostics(host)),
        "audio_output_devices" => cmd(ops::audio_output_devices(&core.player())),
        "audio_set_output_device" => {
            let DeviceIdParams { device_id } = parse(&params)?;
            cmd(ops::audio_set_output_device(
                &core.player(),
                &core.storage(),
                &device_id,
            ))
        }
        "qqmusic_status" => ok(core.qq_music().status().await),
        "qqmusic_home" => {
            let super::types::RefreshParams { refresh } = parse(&params)?;
            provider(core.qq_music().home(refresh).await.map_err(Into::into))
        }
        "qqmusic_discover" => {
            let super::types::RefreshParams { refresh } = parse(&params)?;
            provider(core.qq_music().discover(refresh).await.map_err(Into::into))
        }
        "qqmusic_area" => {
            let EncAreaParams { enc_area } = parse(&params)?;
            provider(core.qq_music().area(enc_area).await.map_err(Into::into))
        }
        "qqmusic_guess_next" => {
            let LimitParams { limit } = parse(&params)?;
            provider(core.qq_music().guess_next(limit).await.map_err(Into::into))
        }
        "qqmusic_library" => ok(core.qq_music().library()),
        "qqmusic_search" => {
            let SearchParams { query, page, limit } = parse(&params)?;
            provider(
                core.qq_music()
                    .search(query, page, limit)
                    .await
                    .map_err(Into::into),
            )
        }
        "qqmusic_album" => {
            let IdParams { id } = parse(&params)?;
            provider(core.qq_music().album(id).await.map_err(Into::into))
        }
        "qqmusic_playlist" => {
            let IdParams { id } = parse(&params)?;
            provider(core.qq_music().playlist(id).await.map_err(Into::into))
        }
        "qqmusic_lyrics" => {
            let SongIdParams { song_id } = parse(&params)?;
            provider(core.qq_music().lyrics(song_id).await.map_err(Into::into))
        }
        "qqmusic_cache_artwork" => {
            let UrlParams { url } = parse(&params)?;
            provider(
                core.qq_music()
                    .artwork_data_uri(url)
                    .await
                    .map_err(Into::into),
            )
        }
        "qqmusic_set_preferred_quality" => {
            let QualityParams { quality } = parse(&params)?;
            provider(
                ops::qqmusic_set_preferred_quality(&core.qq_music(), &core.player(), quality).await,
            )
        }
        "qqmusic_set_current_quality" => {
            let QualityParams { quality } = parse(&params)?;
            provider(
                ops::qqmusic_set_current_quality(&core.qq_music(), &core.player(), quality).await,
            )
        }
        "qqmusic_account_snapshot" => ok(core.qq_music().account_snapshot().await),
        "qqmusic_favorite_songs" => {
            let CursorPageParams { cursor, limit } = parse(&params)?;
            provider(
                core.qq_music()
                    .favorite_songs(cursor, limit)
                    .await
                    .map_err(Into::into),
            )
        }
        "qqmusic_account_playlists" => {
            let CursorPageParams { cursor, limit } = parse(&params)?;
            provider(
                core.qq_music()
                    .account_playlists(cursor, limit)
                    .await
                    .map_err(Into::into),
            )
        }
        "qqmusic_account_playlist_tracks" => {
            let PlaylistTracksParams {
                playlist,
                cursor,
                limit,
            } = parse(&params)?;
            provider(
                core.qq_music()
                    .account_playlist_tracks(playlist, cursor, limit)
                    .await
                    .map_err(Into::into),
            )
        }
        "qqmusic_account_recently_played" => {
            let CursorPageParams { cursor, limit } = parse(&params)?;
            provider(
                core.qq_music()
                    .account_recently_played(cursor, limit)
                    .await
                    .map_err(Into::into),
            )
        }
        "qqmusic_set_favorite" => {
            let NamedRequest::<FavoriteMutationRequest> { request } = parse(&params)?;
            provider(
                core.qq_music()
                    .set_favorite(request)
                    .await
                    .map_err(Into::into),
            )
        }
        "qqmusic_create_playlist" => {
            let NamedRequest::<CreatePlaylistRequest> { request } = parse(&params)?;
            provider(
                core.qq_music()
                    .create_playlist(request)
                    .await
                    .map_err(Into::into),
            )
        }
        "qqmusic_rename_playlist" => {
            let NamedRequest::<RenamePlaylistRequest> { request } = parse(&params)?;
            provider(
                core.qq_music()
                    .rename_playlist(request)
                    .await
                    .map_err(Into::into),
            )
        }
        "qqmusic_add_playlist_track" => {
            let NamedRequest::<PlaylistTrackMutationRequest> { request } = parse(&params)?;
            provider(
                core.qq_music()
                    .add_playlist_track(request)
                    .await
                    .map_err(Into::into),
            )
        }
        "qqmusic_remove_playlist_track" => {
            let NamedRequest::<PlaylistTrackMutationRequest> { request } = parse(&params)?;
            provider(
                core.qq_music()
                    .remove_playlist_track(request)
                    .await
                    .map_err(Into::into),
            )
        }
        "qqmusic_delete_playlist" => {
            let NamedRequest::<DeletePlaylistRequest> { request } = parse(&params)?;
            provider(
                core.qq_music()
                    .delete_playlist(request)
                    .await
                    .map_err(Into::into),
            )
        }
        "qqmusic_set_playlist_collected" => {
            let NamedRequest::<CollectPlaylistRequest> { request } = parse(&params)?;
            provider(
                core.qq_music()
                    .set_playlist_collected(request)
                    .await
                    .map_err(Into::into),
            )
        }
        "qqmusic_auth_start" => {
            provider(core.qq_music().start_qr_login().await.map_err(Into::into))
        }
        "qqmusic_auth_heartbeat" => {
            let AuthHeartbeatParams {
                attempt_id,
                owner_lease_id,
            } = parse(&params)?;
            let live = host.oauth_window_is_live(&attempt_id);
            provider(
                ops::qqmusic_auth_heartbeat(&core.qq_music(), attempt_id, owner_lease_id, live)
                    .await,
            )
        }
        "qqmusic_auth_cancel" => {
            let AttemptIdParams { attempt_id } = parse(&params)?;
            let result = core.qq_music().cancel_qr_login(attempt_id.clone()).await;
            host.close_oauth_window(&attempt_id);
            provider(result.map_err(Into::into))
        }
        "qqmusic_auth_refresh" => {
            let OptionalAttemptParams { attempt_id } = parse(&params)?;
            provider(
                core.qq_music()
                    .refresh_qr_login(attempt_id)
                    .await
                    .map_err(Into::into),
            )
        }
        "qqmusic_sign_out" => provider(core.qq_music().sign_out().await.map_err(Into::into)),
        "qqmusic_cache_stats" => provider(core.qq_music().cache_stats().map_err(Into::into)),
        "qqmusic_clear_cache" => provider(core.qq_music().clear_cache().map_err(Into::into)),
        "player_snapshot" => ok(core.player().snapshot().await),
        "player_hydrate_queue" => {
            let TracksParams { tracks } = parse(&params)?;
            ok(core.player().hydrate_queue(tracks).await)
        }
        "player_play_tracks" => {
            let NamedRequest::<PlayTracksRequest> { request } = parse(&params)?;
            cmd(core
                .player()
                .play_tracks(request)
                .await
                .map_err(|error| error.to_string()))
        }
        "player_play_from_queue" => {
            let IndexParams { index } = parse(&params)?;
            cmd(core
                .player()
                .play_from_queue(index)
                .await
                .map_err(|error| error.to_string()))
        }
        "player_play_queue_entry" => {
            let EntryIdParams { entry_id } = parse(&params)?;
            cmd(core
                .player()
                .play_queue_entry(&entry_id)
                .await
                .map_err(|error| error.to_string()))
        }
        "player_play" => cmd(core
            .player()
            .play()
            .await
            .map_err(|error| error.to_string())),
        "player_pause" => cmd(core
            .player()
            .pause()
            .await
            .map_err(|error| error.to_string())),
        "player_toggle" => cmd(core
            .player()
            .toggle()
            .await
            .map_err(|error| error.to_string())),
        "player_next" => cmd(core
            .player()
            .next()
            .await
            .map_err(|error| error.to_string())),
        "player_previous" => cmd(core
            .player()
            .previous()
            .await
            .map_err(|error| error.to_string())),
        "player_seek" => {
            let SeekParams { position_ms } = parse(&params)?;
            cmd(core
                .player()
                .seek(position_ms)
                .await
                .map_err(|error| error.to_string()))
        }
        "player_set_volume" => {
            let VolumeParams { volume } = parse(&params)?;
            cmd(core
                .player()
                .set_volume(volume)
                .await
                .map_err(|error| error.to_string()))
        }
        "player_toggle_muted" => cmd(core
            .player()
            .toggle_muted()
            .await
            .map_err(|error| error.to_string())),
        "player_toggle_shuffle" => ok(core.player().toggle_shuffle().await),
        "player_set_shuffle" => {
            let EnabledParams { enabled } = parse(&params)?;
            ok(core.player().set_shuffle(enabled).await)
        }
        "player_cycle_repeat" => ok(core.player().cycle_repeat().await),
        "player_set_repeat" => {
            let RepeatParams { mode } = parse(&params)?;
            ok(core.player().set_repeat(mode).await)
        }
        "player_set_primary_playback_mode" => {
            let PrimaryModeParams { mode } = parse(&params)?;
            ok(core.player().set_primary_playback_mode(mode).await)
        }
        "player_add_to_queue" => {
            let TrackParams { track } = parse(&params)?;
            ok(core.player().add_to_queue(track).await)
        }
        "player_add_tracks_to_queue" => {
            let TracksParams { tracks } = parse(&params)?;
            ok(core.player().add_tracks_to_queue(tracks).await)
        }
        "player_remove_from_queue" => {
            let IndexParams { index } = parse(&params)?;
            cmd(core
                .player()
                .remove_from_queue(index)
                .await
                .map_err(|error| error.to_string()))
        }
        "player_remove_queue_entry" => {
            let EntryIdParams { entry_id } = parse(&params)?;
            cmd(core
                .player()
                .remove_queue_entry(&entry_id)
                .await
                .map_err(|error| error.to_string()))
        }
        "player_reorder_queue_entry" => {
            let ReorderParams {
                entry_id,
                target_index,
            } = parse(&params)?;
            cmd(core
                .player()
                .reorder_queue_entry(&entry_id, target_index)
                .await
                .map_err(|error| error.to_string()))
        }
        "player_play_next_queue_entry" => {
            let EntryIdParams { entry_id } = parse(&params)?;
            cmd(core
                .player()
                .play_next_queue_entry(&entry_id)
                .await
                .map_err(|error| error.to_string()))
        }
        "player_set_lyrics" => {
            let LyricsDocumentParams { document } = parse(&params)?;
            core.player().set_lyrics(document).await;
            Ok(Value::Null)
        }
        "player_lyrics" => ok(core.player().lyrics().await),
        "lyrics_surface_projection" => ok(core.player().lyric_surface_projection().await),
        "app_preferences_get" => cmd(ops::app_preferences_get(&core.storage())),
        "app_preferences_set" => {
            let ValueParams { value } = parse(&params)?;
            cmd(ops::app_preferences_set(&core.storage(), value, |stored| {
                host.notify_preferences_changed(stored);
            }))
        }
        "appearance_background_load" => {
            let ReferenceParams { reference } = parse(&params)?;
            cmd(ops::appearance_background_load(&core.config().paths.data_dir, reference).await)
        }
        "local_api_status" => ok(core.local_api().status().await),
        "local_api_set_enabled" => {
            let EnabledParams { enabled } = parse(&params)?;
            cmd(core
                .local_api()
                .set_enabled(enabled)
                .await
                .map_err(|error| error.to_string()))
        }
        "local_api_set_port" => {
            let PortParams { port } = parse(&params)?;
            cmd(ops::local_api_set_port(&core.local_api(), port).await)
        }
        "local_api_reveal_token" => ok(core.local_api().reveal_token().await),
        "local_api_regenerate_token" => cmd(core
            .local_api()
            .regenerate_token()
            .await
            .map_err(|error| error.to_string())),
        "debug_perf_sample" => {
            let SampleParams { sample } = parse(&params)?;
            cmd(ops::write_perf_sample(core.logging().log_dir(), &sample))
        }
        "diagnostics_snapshot" => {
            let NamedRequest::<super::types::DiagnosticsRequest> { request } = parse(&params)?;
            ok(ops::assemble_diagnostics_snapshot(
                &core.player(),
                &core.qq_music(),
                &core.logging(),
                Some(&core.plugins()),
                host.platform_diagnostics(),
                host.app_section(),
                request,
            )
            .await)
        }
        "diagnostics_export_bundle" => {
            let NamedRequest::<super::types::DiagnosticsBundleRequest> { request } =
                parse(&params)?;
            cmd(ops::diagnostics_export_bundle(core, host, request).await)
        }
        "diagnostics_clear_logs" => ok(ops::diagnostics_clear_logs(&core.logging())),
        "diagnostics_set_log_level" => {
            let LevelParams { level } = parse(&params)?;
            cmd(ops::diagnostics_set_log_level(&core.storage(), level))
        }
        "diagnostics_current_level" => ok(core.logging().level()),
        "diagnostics_recent_errors" => ok(core.logging().recent_errors()),
        "diagnostics_record_error" => {
            let NamedRequest::<RecordErrorRequest> { request } = parse(&params)?;
            ops::diagnostics_record_error(&core.logging(), request);
            Ok(Value::Null)
        }
        "diagnostics_log_frontend" => {
            let FrontendLogParams { entries } = parse(&params)?;
            ops::diagnostics_log_frontend(&core.logging(), entries);
            Ok(Value::Null)
        }
        "issue_reporter_preview" => {
            let IssueReporterPreviewParams { draft, request } = parse(&params)?;
            ok(ops::issue_reporter_preview(core, host, draft, request).await)
        }
        "issue_reporter_validate_url" => {
            let UrlParams { url } = parse(&params)?;
            cmd(crate::issue_reporter::validate_open_url(&url).map_err(str::to_owned))
        }
        "plugin_list" => ok(ops::plugin_list(&core.plugins())),
        "plugin_inspect_path" => {
            let PathParams { path } = parse(&params)?;
            cmd(ops::plugin_inspect_path(&core.plugins(), path))
        }
        "plugin_install" => {
            let NamedRequest::<PluginInstallRequest> { request } = parse(&params)?;
            cmd(ops::plugin_install(&core.plugins(), request, notify_plugin))
        }
        "plugin_set_enabled" => {
            let NamedRequest::<PluginEnableRequest> { request } = parse(&params)?;
            cmd(ops::plugin_set_enabled(
                &core.plugins(),
                request,
                notify_plugin,
            ))
        }
        "plugin_uninstall" => {
            let NamedRequest::<PluginUninstallRequest> { request } = parse(&params)?;
            cmd(ops::plugin_uninstall(
                &core.plugins(),
                request,
                notify_plugin,
            ))
        }
        "plugin_set_safe_mode" => {
            let EnabledParams { enabled } = parse(&params)?;
            cmd(ops::plugin_set_safe_mode(
                &core.plugins(),
                enabled,
                notify_plugin,
            ))
        }
        "plugin_set_developer_mode" => {
            let EnabledParams { enabled } = parse(&params)?;
            cmd(ops::plugin_set_developer_mode(
                &core.plugins(),
                enabled,
                notify_plugin,
            ))
        }
        "plugin_active_resources" => ok(ops::plugin_active_resources(&core.plugins())),
        "plugin_diagnostics" => ok(ops::plugin_diagnostics(&core.plugins())),
        "plugin_runtime_start" => {
            let PluginIdParams { plugin_id } = parse(&params)?;
            cmd(ops::plugin_runtime_start(&core.plugins(), &plugin_id))
        }
        "plugin_runtime_stop" => {
            let TokenParams { token } = parse(&params)?;
            ops::plugin_runtime_stop(&core.plugins(), &token);
            Ok(Value::Null)
        }
        "plugin_mark_failed" => {
            let PluginMarkFailedParams { id, reason } = parse(&params)?;
            cmd(ops::plugin_mark_failed(
                &core.plugins(),
                &id,
                &reason,
                notify_plugin,
            ))
        }
        "plugin_bridge" => {
            let NamedRequest::<PluginBridgeRequest> { request } = parse(&params)?;
            cmd(ops::plugin_bridge(&core.plugins(), &core.player(), request).await)
        }
        "plugin_install_unpacked" => {
            let NamedRequest::<PluginInstallRequest> { request } = parse(&params)?;
            cmd(ops::plugin_install_unpacked(
                &core.plugins(),
                request,
                notify_plugin,
            ))
        }
        "plugin_reload" => {
            let IdParams { id } = parse(&params)?;
            cmd(ops::plugin_reload(&core.plugins(), &id, notify_plugin))
        }
        "plugin_read_asset" => {
            let PluginReadAssetParams { plugin_id, path } = parse(&params)?;
            cmd(ops::plugin_read_asset(&core.plugins(), &plugin_id, &path))
        }
        "plugin_settings_get" => {
            let IdParams { id } = parse(&params)?;
            cmd(ops::plugin_settings_get(&core.plugins(), &id))
        }
        "plugin_settings_set" => {
            let NamedRequest::<PluginSettingsWrite> { request } = parse(&params)?;
            cmd(ops::plugin_settings_set(
                &core.plugins(),
                request,
                notify_plugin,
            ))
        }
        "core_ping" => ok(json!({})),
        "platform_attach" => apply_platform_attach(core, parse(&params)?),
        "core_shutdown_prepare" => {
            let snapshot = core.player().snapshot().await;
            core.storage()
                .save_queue(&snapshot)
                .map_err(|error| DispatchError::Command {
                    message: error.to_string(),
                    retryable: false,
                    details: None,
                })?;
            ok(json!({ "ok": true }))
        }
        "auth_oauth_prepare" => {
            let OAuthPrepareParams { provider_kind } = parse(&params)?;
            provider(ops::auth_oauth_prepare(&core.qq_music(), provider_kind).await)
        }
        "auth_oauth_complete" => {
            let OAuthCompleteParams {
                attempt_id,
                callback_url,
            } = parse(&params)?;
            let callback_url = reqwest::Url::parse(&callback_url)
                .map_err(|error| DispatchError::InvalidParams(error.to_string()))?;
            provider(ops::auth_oauth_complete(&core.qq_music(), &attempt_id, callback_url).await)
        }
        "auth_oauth_cancel" => {
            let AttemptIdParams { attempt_id } = parse(&params)?;
            provider(ops::auth_oauth_cancel(&core.qq_music(), &attempt_id).await)
        }
        "app_settings_get" => {
            let SettingKeyParams { key } = parse(&params)?;
            cmd(ops::app_settings_get(&core.storage(), &key))
        }
        "app_settings_set" => {
            let SettingWriteParams { key, value } = parse(&params)?;
            cmd(ops::app_settings_set(&core.storage(), &key, &value))
        }
        "app_settings_remove" => {
            let SettingKeyParams { key } = parse(&params)?;
            cmd(ops::app_settings_remove(&core.storage(), &key))
        }
        "diagnostics_export_bundle_to" => {
            let DiagnosticsExportToParams { path, request } = parse(&params)?;
            cmd(ops::diagnostics_export_bundle_to(core, host, path, request).await)
        }
        "preferences_set_background_from" => {
            let PathParams { path } = parse(&params)?;
            cmd(ops::preferences_set_background_from(&core.config().paths.data_dir, path).await)
        }
        "plugin_install_from" => {
            let NamedRequest::<PluginInstallRequest> { request } = parse(&params)?;
            cmd(ops::plugin_install_from(
                &core.plugins(),
                request,
                notify_plugin,
            ))
        }
        other => {
            debug_assert!(
                !CORE_DISPATCH_METHODS.contains(&other),
                "missing dispatch arm for {other}"
            );
            Err(DispatchError::Denied(AclDenied {
                method: other.to_owned(),
                origin: WindowOrigin::Host,
            }))
        }
    }
}
