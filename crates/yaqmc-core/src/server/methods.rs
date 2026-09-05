use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};

use yaqmc_protocol::{
    authorize, AclDenied, CoreError, ErrorCode, MethodOwner, PlatformAttach, WindowOrigin,
};

use crate::continuation::{ContinuationStartRequest, ContinuationTerminalReason};
use crate::player::PlayTracksRequest;
#[cfg(feature = "plugins")]
use crate::plugin::api::{
    PluginBridgeRequest, PluginEnableRequest, PluginInstallRequest, PluginSettingsWrite,
    PluginUninstallRequest,
};
use crate::statistics::{StatisticsChanged, StatisticsExportRequest};
use crate::CoreHandle;
use yaqmc_provider_api::{
    CollectPlaylistRequest, CreatePlaylistRequest, DeletePlaylistRequest, FavoriteMutationRequest,
    PlaylistTrackMutationRequest, ProviderCommandError, ProviderResult, RenamePlaylistRequest,
};

use super::ops;
use super::types::{
    ArtistCatalogParams, AttemptIdParams, AuthHeartbeatParams, CursorPageParams, DeviceIdParams,
    DiagnosticsExportToParams, EnabledParams, EncAreaParams, EntryIdParams, FrontendLogParams,
    IdParams, IndexParams, IssueReporterPreviewParams, LevelParams, LyricsDocumentParams,
    NamedRequest, OAuthCompleteParams, OAuthPrepareParams, OptionalAttemptParams, PathParams,
    PlaylistTracksParams, PluginIdParams, PluginMarkFailedParams, PluginReadAssetParams,
    PortParams, PrimaryModeParams, ProviderAreaParams, ProviderArtistCatalogParams,
    ProviderAttemptParams, ProviderAuthHeartbeatParams, ProviderAuthStartParams,
    ProviderCursorPageParams, ProviderEntityParams, ProviderIdParams, ProviderNamedRequest,
    ProviderOAuthCompleteParams, ProviderOAuthPrepareParams, ProviderOptionalAttemptParams,
    ProviderPlaylistTracksParams, ProviderQualityParams, ProviderRefreshParams,
    ProviderSearchParams, ProviderUrlParams, QualityParams, RecordErrorRequest, ReferenceParams,
    ReorderParams, RepeatParams, SampleParams, SearchParams, SeekParams, SettingKeyParams,
    SettingWriteParams, ShareSongParams, SongIdParams, StatisticsRangeParams, TokenParams,
    TrackParams, TracksParams, UrlParams, ValueParams, VolumeParams,
};
use super::HostDispatchHooks;

pub const CORE_DISPATCH_METHODS: &[&str] = &[
    "platform_diagnostics",
    "platform_export_diagnostics",
    "audio_output_devices",
    "audio_set_output_device",
    "provider_list",
    "provider_status",
    "provider_home",
    "provider_discover",
    "provider_area",
    "provider_library",
    "provider_search",
    "provider_song",
    "provider_album",
    "provider_artist",
    "provider_artist_catalog",
    "provider_playlist",
    "provider_lyrics",
    "provider_recommendation_next",
    "provider_cache_artwork",
    "provider_set_preferred_quality",
    "provider_set_current_quality",
    "provider_account_login_methods",
    "provider_account_snapshot",
    "provider_account_refresh",
    "provider_favorite_songs",
    "provider_account_playlists",
    "provider_account_playlist_tracks",
    "provider_account_recently_played",
    "provider_set_favorite",
    "provider_create_playlist",
    "provider_rename_playlist",
    "provider_add_playlist_track",
    "provider_remove_playlist_track",
    "provider_delete_playlist",
    "provider_set_playlist_collected",
    "provider_auth_start",
    "provider_auth_heartbeat",
    "provider_auth_cancel",
    "provider_auth_refresh",
    "provider_sign_out",
    "provider_cache_stats",
    "provider_clear_cache",
    "qqmusic_status",
    "qqmusic_home",
    "qqmusic_discover",
    "qqmusic_area",
    "qqmusic_library",
    "qqmusic_search",
    "qqmusic_song",
    "qqmusic_album",
    "qqmusic_artist",
    "qqmusic_artist_catalog",
    "qqmusic_playlist",
    "qqmusic_lyrics",
    "catalog_share_song",
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
    "continuation_snapshot",
    "continuation_start",
    "continuation_end",
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
    "local_api_set_token",
    "local_api_reveal_token",
    "local_api_regenerate_token",
    "debug_perf_sample",
    "diagnostics_snapshot",
    "diagnostics_clear_logs",
    "diagnostics_set_log_level",
    "diagnostics_current_level",
    "diagnostics_recent_errors",
    "diagnostics_record_error",
    "diagnostics_log_frontend",
    "statistics_snapshot",
    "statistics_clear",
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
    "provider_auth_oauth_prepare",
    "provider_auth_oauth_complete",
    "provider_auth_oauth_cancel",
    "app_settings_get",
    "app_settings_set",
    "app_settings_remove",
    "diagnostics_export_bundle_to",
    "statistics_export_to",
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
    Unavailable {
        feature: &'static str,
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
            Self::Unavailable { feature } => CoreError {
                code: ErrorCode::Unavailable.as_str().to_owned(),
                message: format!("{feature} is unavailable in this Core build"),
                details: None,
                retryable: false,
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

fn provider_command<T>(result: ProviderResult<T>) -> Result<T, DispatchError> {
    result.map_err(provider_error)
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
    #[cfg(not(feature = "system-media"))]
    {
        let _ = (core, attach);
        return Err(DispatchError::Unavailable {
            feature: "system media",
        });
    }
    #[cfg(feature = "system-media")]
    {
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
        "platform_diagnostics" => ok(ops::live_platform_diagnostics(core, host)),
        "platform_export_diagnostics" => cmd(ops::platform_export_diagnostics(core, host)),
        "audio_output_devices" => cmd(ops::audio_output_devices(&core.player())),
        "audio_set_output_device" => {
            let DeviceIdParams { device_id } = parse(&params)?;
            cmd(ops::audio_set_output_device(
                &core.player(),
                &core.storage(),
                &device_id,
            ))
        }
        "provider_list" => ok(core.providers().descriptors()),
        "provider_status" => {
            let ProviderIdParams { provider_id } = parse(&params)?;
            let catalog =
                provider_command(core.providers().require_catalog_provider(&provider_id))?;
            ok(catalog.catalog_status().await)
        }
        "provider_home" => {
            let ProviderRefreshParams {
                provider_id,
                refresh,
            } = parse(&params)?;
            let catalog =
                provider_command(core.providers().require_catalog_provider(&provider_id))?;
            provider(catalog.catalog_home(refresh).await)
        }
        "provider_discover" => {
            let ProviderRefreshParams {
                provider_id,
                refresh,
            } = parse(&params)?;
            let catalog =
                provider_command(core.providers().require_catalog_provider(&provider_id))?;
            provider(catalog.catalog_discover(refresh).await)
        }
        "provider_area" => {
            let ProviderAreaParams {
                provider_id,
                enc_area,
            } = parse(&params)?;
            let catalog =
                provider_command(core.providers().require_catalog_provider(&provider_id))?;
            provider(catalog.catalog_area(enc_area).await)
        }
        "provider_library" => {
            let ProviderIdParams { provider_id } = parse(&params)?;
            let catalog =
                provider_command(core.providers().require_catalog_provider(&provider_id))?;
            ok(catalog.catalog_library())
        }
        "provider_search" => {
            let ProviderSearchParams {
                provider_id,
                query,
                kind,
                page,
                limit,
            } = parse(&params)?;
            let catalog =
                provider_command(core.providers().require_catalog_provider(&provider_id))?;
            provider(catalog.catalog_search(query, kind, page, limit).await)
        }
        "provider_song" => {
            let ProviderEntityParams { provider_id, id } = parse(&params)?;
            let catalog =
                provider_command(core.providers().require_catalog_provider(&provider_id))?;
            provider(catalog.catalog_song(id).await)
        }
        "provider_album" => {
            let ProviderEntityParams { provider_id, id } = parse(&params)?;
            let catalog =
                provider_command(core.providers().require_catalog_provider(&provider_id))?;
            provider(catalog.catalog_album(id).await)
        }
        "provider_artist" => {
            let ProviderEntityParams { provider_id, id } = parse(&params)?;
            let catalog =
                provider_command(core.providers().require_catalog_provider(&provider_id))?;
            provider(catalog.catalog_artist(id).await)
        }
        "provider_artist_catalog" => {
            let ProviderArtistCatalogParams {
                provider_id,
                id,
                kind,
                page,
                limit,
            } = parse(&params)?;
            let catalog =
                provider_command(core.providers().require_catalog_provider(&provider_id))?;
            provider(catalog.catalog_artist_page(id, kind, page, limit).await)
        }
        "provider_playlist" => {
            let ProviderEntityParams { provider_id, id } = parse(&params)?;
            let catalog =
                provider_command(core.providers().require_catalog_provider(&provider_id))?;
            provider(catalog.catalog_playlist(id).await)
        }
        "provider_lyrics" => {
            let ProviderEntityParams { provider_id, id } = parse(&params)?;
            let lyrics = provider_command(core.providers().require_lyrics_provider(&provider_id))?;
            provider(lyrics.lyrics_for_song(id).await)
        }
        "provider_recommendation_next" => {
            let ProviderNamedRequest::<yaqmc_provider_api::RecommendationRequest> {
                provider_id,
                request,
            } = parse(&params)?;
            provider(
                core.providers()
                    .recommendation_next(&provider_id, request)
                    .await,
            )
        }
        "provider_cache_artwork" => {
            let ProviderUrlParams { provider_id, url } = parse(&params)?;
            let catalog =
                provider_command(core.providers().require_catalog_provider(&provider_id))?;
            provider(catalog.catalog_artwork_data_uri(url).await)
        }
        "provider_set_preferred_quality" => {
            let ProviderQualityParams {
                provider_id,
                quality,
            } = parse(&params)?;
            let playback =
                provider_command(core.providers().require_playback_provider(&provider_id))?;
            provider(
                ops::provider_set_preferred_quality(
                    &provider_id,
                    playback.as_ref(),
                    &core.player(),
                    quality,
                )
                .await,
            )
        }
        "provider_set_current_quality" => {
            let ProviderQualityParams {
                provider_id,
                quality,
            } = parse(&params)?;
            let playback =
                provider_command(core.providers().require_playback_provider(&provider_id))?;
            provider(
                ops::provider_set_current_quality(
                    &provider_id,
                    playback.as_ref(),
                    &core.player(),
                    quality,
                )
                .await,
            )
        }
        "provider_account_login_methods" => {
            let ProviderIdParams { provider_id } = parse(&params)?;
            let account =
                provider_command(core.providers().require_account_provider(&provider_id))?;
            provider(account.account_login_methods().await)
        }
        "provider_account_snapshot" => {
            let ProviderIdParams { provider_id } = parse(&params)?;
            let capability =
                provider_command(core.providers().require_account_provider(&provider_id))?;
            ok(capability.provider_account().account_snapshot().await)
        }
        "provider_account_refresh" => {
            let ProviderIdParams { provider_id } = parse(&params)?;
            let capability =
                provider_command(core.providers().require_account_provider(&provider_id))?;
            provider(capability.provider_account().refresh_account().await)
        }
        "provider_favorite_songs" => {
            let ProviderCursorPageParams {
                provider_id,
                cursor,
                limit,
            } = parse(&params)?;
            let capability =
                provider_command(core.providers().require_account_provider(&provider_id))?;
            provider(
                capability
                    .provider_account()
                    .favorite_songs(cursor, limit)
                    .await,
            )
        }
        "provider_account_playlists" => {
            let ProviderCursorPageParams {
                provider_id,
                cursor,
                limit,
            } = parse(&params)?;
            let capability =
                provider_command(core.providers().require_account_provider(&provider_id))?;
            provider(
                capability
                    .provider_account()
                    .account_playlists(cursor, limit)
                    .await,
            )
        }
        "provider_account_playlist_tracks" => {
            let ProviderPlaylistTracksParams {
                provider_id,
                playlist,
                cursor,
                limit,
            } = parse(&params)?;
            let capability =
                provider_command(core.providers().require_account_provider(&provider_id))?;
            provider(
                capability
                    .provider_account()
                    .account_playlist_tracks(playlist, cursor, limit)
                    .await,
            )
        }
        "provider_account_recently_played" => {
            let ProviderCursorPageParams {
                provider_id,
                cursor,
                limit,
            } = parse(&params)?;
            let capability =
                provider_command(core.providers().require_account_provider(&provider_id))?;
            provider(
                capability
                    .provider_account()
                    .account_recently_played(cursor, limit)
                    .await,
            )
        }
        "provider_set_favorite" => {
            let ProviderNamedRequest::<FavoriteMutationRequest> {
                provider_id,
                request,
            } = parse(&params)?;
            let capability =
                provider_command(core.providers().require_account_provider(&provider_id))?;
            provider(capability.provider_account().set_favorite(request).await)
        }
        "provider_create_playlist" => {
            let ProviderNamedRequest::<CreatePlaylistRequest> {
                provider_id,
                request,
            } = parse(&params)?;
            let capability =
                provider_command(core.providers().require_account_provider(&provider_id))?;
            provider(capability.provider_account().create_playlist(request).await)
        }
        "provider_rename_playlist" => {
            let ProviderNamedRequest::<RenamePlaylistRequest> {
                provider_id,
                request,
            } = parse(&params)?;
            let capability =
                provider_command(core.providers().require_account_provider(&provider_id))?;
            provider(capability.provider_account().rename_playlist(request).await)
        }
        "provider_add_playlist_track" => {
            let ProviderNamedRequest::<PlaylistTrackMutationRequest> {
                provider_id,
                request,
            } = parse(&params)?;
            let capability =
                provider_command(core.providers().require_account_provider(&provider_id))?;
            provider(
                capability
                    .provider_account()
                    .add_playlist_track(request)
                    .await,
            )
        }
        "provider_remove_playlist_track" => {
            let ProviderNamedRequest::<PlaylistTrackMutationRequest> {
                provider_id,
                request,
            } = parse(&params)?;
            let capability =
                provider_command(core.providers().require_account_provider(&provider_id))?;
            provider(
                capability
                    .provider_account()
                    .remove_playlist_track(request)
                    .await,
            )
        }
        "provider_delete_playlist" => {
            let ProviderNamedRequest::<DeletePlaylistRequest> {
                provider_id,
                request,
            } = parse(&params)?;
            let capability =
                provider_command(core.providers().require_account_provider(&provider_id))?;
            provider(capability.provider_account().delete_playlist(request).await)
        }
        "provider_set_playlist_collected" => {
            let ProviderNamedRequest::<CollectPlaylistRequest> {
                provider_id,
                request,
            } = parse(&params)?;
            let capability =
                provider_command(core.providers().require_account_provider(&provider_id))?;
            provider(
                capability
                    .provider_account()
                    .set_playlist_collected(request)
                    .await,
            )
        }
        "provider_auth_start" => {
            let ProviderAuthStartParams {
                provider_id,
                mobile,
            } = parse(&params)?;
            core.continuation()
                .end(ContinuationTerminalReason::AccountChanged)
                .await;
            let capability =
                provider_command(core.providers().require_account_provider(&provider_id))?;
            if mobile {
                provider(capability.provider_account().start_mobile_login().await)
            } else {
                provider(capability.provider_account().start_qr_login().await)
            }
        }
        "provider_auth_heartbeat" => {
            let ProviderAuthHeartbeatParams {
                provider_id,
                attempt_id,
                owner_lease_id,
            } = parse(&params)?;
            let capability =
                provider_command(core.providers().require_account_provider(&provider_id))?;
            let account = capability.provider_account();
            let result = if account.is_oauth_login(&attempt_id).await
                && !host.oauth_window_is_live(&attempt_id)
            {
                account.cancel_oauth_login(&attempt_id).await
            } else {
                account.heartbeat_qr_login(attempt_id, owner_lease_id).await
            };
            core.continuation()
                .validate_account_generation(&provider_id)
                .await;
            provider(result)
        }
        "provider_auth_cancel" => {
            let ProviderAttemptParams {
                provider_id,
                attempt_id,
            } = parse(&params)?;
            let capability =
                provider_command(core.providers().require_account_provider(&provider_id))?;
            let result = capability
                .provider_account()
                .cancel_qr_login(attempt_id.clone())
                .await;
            host.close_oauth_window(&attempt_id);
            core.continuation()
                .validate_account_generation(&provider_id)
                .await;
            provider(result)
        }
        "provider_auth_refresh" => {
            let ProviderOptionalAttemptParams {
                provider_id,
                attempt_id,
            } = parse(&params)?;
            let capability =
                provider_command(core.providers().require_account_provider(&provider_id))?;
            let result = capability
                .provider_account()
                .refresh_qr_login(attempt_id)
                .await;
            core.continuation()
                .validate_account_generation(&provider_id)
                .await;
            provider(result)
        }
        "provider_sign_out" => {
            let ProviderIdParams { provider_id } = parse(&params)?;
            core.continuation()
                .end(ContinuationTerminalReason::AccountChanged)
                .await;
            let capability =
                provider_command(core.providers().require_account_provider(&provider_id))?;
            provider(capability.provider_account().sign_out().await)
        }
        "provider_cache_stats" => {
            let ProviderIdParams { provider_id } = parse(&params)?;
            let catalog =
                provider_command(core.providers().require_catalog_provider(&provider_id))?;
            provider(catalog.catalog_cache_stats())
        }
        "provider_clear_cache" => {
            let ProviderIdParams { provider_id } = parse(&params)?;
            let catalog =
                provider_command(core.providers().require_catalog_provider(&provider_id))?;
            provider(catalog.catalog_clear_cache())
        }
        "qqmusic_status" => ok(core.qq_music().status().await),
        "qqmusic_home" => {
            let super::types::RefreshParams { refresh } = parse(&params)?;
            provider(core.qq_music().home(refresh).await)
        }
        "qqmusic_discover" => {
            let super::types::RefreshParams { refresh } = parse(&params)?;
            provider(core.qq_music().discover(refresh).await)
        }
        "qqmusic_area" => {
            let EncAreaParams { enc_area } = parse(&params)?;
            provider(core.qq_music().area(enc_area).await)
        }
        "qqmusic_library" => ok(core.qq_music().library()),
        "qqmusic_search" => {
            let SearchParams {
                query,
                kind,
                page,
                limit,
            } = parse(&params)?;
            provider(core.qq_music().search(query, kind, page, limit).await)
        }
        "qqmusic_song" => {
            let IdParams { id } = parse(&params)?;
            provider(core.qq_music().song(id).await)
        }
        "qqmusic_album" => {
            let IdParams { id } = parse(&params)?;
            provider(core.qq_music().album(id).await)
        }
        "qqmusic_artist" => {
            let IdParams { id } = parse(&params)?;
            provider(core.qq_music().artist(id).await)
        }
        "qqmusic_artist_catalog" => {
            let ArtistCatalogParams {
                id,
                kind,
                page,
                limit,
            } = parse(&params)?;
            provider(core.qq_music().artist_catalog(id, kind, page, limit).await)
        }
        "qqmusic_playlist" => {
            let IdParams { id } = parse(&params)?;
            provider(core.qq_music().playlist(id).await)
        }
        "qqmusic_lyrics" => {
            let SongIdParams { song_id } = parse(&params)?;
            provider(core.qq_music().lyrics(song_id).await)
        }
        "catalog_share_song" => {
            let ShareSongParams { provider_id, id } = parse(&params)?;
            provider(core.providers().share_song(&provider_id, id).await)
        }
        "qqmusic_cache_artwork" => {
            let UrlParams { url } = parse(&params)?;
            provider(core.qq_music().artwork_data_uri(url).await)
        }
        "qqmusic_set_preferred_quality" => {
            let QualityParams { quality } = parse(&params)?;
            provider(
                ops::qqmusic_set_preferred_quality(
                    core.qq_music().as_ref(),
                    &core.player(),
                    quality,
                )
                .await,
            )
        }
        "qqmusic_set_current_quality" => {
            let QualityParams { quality } = parse(&params)?;
            provider(
                ops::qqmusic_set_current_quality(core.qq_music().as_ref(), &core.player(), quality)
                    .await,
            )
        }
        "qqmusic_account_snapshot" => ok(core.qq_music().account_snapshot().await),
        "qqmusic_favorite_songs" => {
            let CursorPageParams { cursor, limit } = parse(&params)?;
            provider(core.qq_music().favorite_songs(cursor, limit).await)
        }
        "qqmusic_account_playlists" => {
            let CursorPageParams { cursor, limit } = parse(&params)?;
            provider(core.qq_music().account_playlists(cursor, limit).await)
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
                    .await,
            )
        }
        "qqmusic_account_recently_played" => {
            let CursorPageParams { cursor, limit } = parse(&params)?;
            provider(core.qq_music().account_recently_played(cursor, limit).await)
        }
        "qqmusic_set_favorite" => {
            let NamedRequest::<FavoriteMutationRequest> { request } = parse(&params)?;
            provider(core.qq_music().set_favorite(request).await)
        }
        "qqmusic_create_playlist" => {
            let NamedRequest::<CreatePlaylistRequest> { request } = parse(&params)?;
            provider(core.qq_music().create_playlist(request).await)
        }
        "qqmusic_rename_playlist" => {
            let NamedRequest::<RenamePlaylistRequest> { request } = parse(&params)?;
            provider(core.qq_music().rename_playlist(request).await)
        }
        "qqmusic_add_playlist_track" => {
            let NamedRequest::<PlaylistTrackMutationRequest> { request } = parse(&params)?;
            provider(core.qq_music().add_playlist_track(request).await)
        }
        "qqmusic_remove_playlist_track" => {
            let NamedRequest::<PlaylistTrackMutationRequest> { request } = parse(&params)?;
            provider(core.qq_music().remove_playlist_track(request).await)
        }
        "qqmusic_delete_playlist" => {
            let NamedRequest::<DeletePlaylistRequest> { request } = parse(&params)?;
            provider(core.qq_music().delete_playlist(request).await)
        }
        "qqmusic_set_playlist_collected" => {
            let NamedRequest::<CollectPlaylistRequest> { request } = parse(&params)?;
            provider(core.qq_music().set_playlist_collected(request).await)
        }
        "qqmusic_auth_start" => {
            core.continuation()
                .end(ContinuationTerminalReason::AccountChanged)
                .await;
            provider(core.qq_music().start_qr_login().await)
        }
        "qqmusic_auth_heartbeat" => {
            let AuthHeartbeatParams {
                attempt_id,
                owner_lease_id,
            } = parse(&params)?;
            let live = host.oauth_window_is_live(&attempt_id);
            let result = ops::qqmusic_auth_heartbeat(
                core.qq_music().as_ref(),
                attempt_id,
                owner_lease_id,
                live,
            )
            .await;
            core.continuation()
                .validate_account_generation("qqmusic")
                .await;
            provider(result)
        }
        "qqmusic_auth_cancel" => {
            let AttemptIdParams { attempt_id } = parse(&params)?;
            let result = core.qq_music().cancel_qr_login(attempt_id.clone()).await;
            host.close_oauth_window(&attempt_id);
            core.continuation()
                .validate_account_generation("qqmusic")
                .await;
            provider(result)
        }
        "qqmusic_auth_refresh" => {
            let OptionalAttemptParams { attempt_id } = parse(&params)?;
            let result = core.qq_music().refresh_qr_login(attempt_id).await;
            core.continuation()
                .validate_account_generation("qqmusic")
                .await;
            provider(result)
        }
        "qqmusic_sign_out" => {
            core.continuation()
                .end(ContinuationTerminalReason::AccountChanged)
                .await;
            provider(core.qq_music().sign_out().await)
        }
        "qqmusic_cache_stats" => provider(core.qq_music().cache_stats()),
        "qqmusic_clear_cache" => provider(core.qq_music().clear_cache()),
        "continuation_snapshot" => ok(core.continuation().snapshot().await),
        "continuation_start" => {
            let NamedRequest::<ContinuationStartRequest> { request } = parse(&params)?;
            cmd(core
                .continuation()
                .start(request)
                .await
                .map_err(|error| error.to_string()))
        }
        "continuation_end" => ok(core
            .continuation()
            .end(ContinuationTerminalReason::Explicit)
            .await),
        "player_snapshot" => ok(core.player().snapshot().await),
        "player_hydrate_queue" => {
            let TracksParams { tracks } = parse(&params)?;
            core.continuation()
                .end(ContinuationTerminalReason::QueueReplaced)
                .await;
            core.qq_music().remember_songs(&tracks).await;
            ok(core.player().hydrate_queue(tracks).await)
        }
        "player_play_tracks" => {
            let NamedRequest::<PlayTracksRequest> { request } = parse(&params)?;
            core.continuation()
                .end(ContinuationTerminalReason::QueueReplaced)
                .await;
            core.qq_music().remember_songs(&request.tracks).await;
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
            })
            .map(|()| json!({})))
        }
        "appearance_background_load" => {
            let ReferenceParams { reference } = parse(&params)?;
            cmd(ops::appearance_background_load(&core.config().paths.data_dir, reference).await)
        }
        #[cfg(feature = "local-api")]
        "local_api_status" => ok(core.local_api().status().await),
        #[cfg(feature = "local-api")]
        "local_api_set_enabled" => {
            let EnabledParams { enabled } = parse(&params)?;
            cmd(core
                .local_api()
                .set_enabled(enabled)
                .await
                .map_err(|error| error.to_string()))
        }
        #[cfg(feature = "local-api")]
        "local_api_set_port" => {
            let PortParams { port } = parse(&params)?;
            cmd(ops::local_api_set_port(&core.local_api(), port).await)
        }
        #[cfg(feature = "local-api")]
        "local_api_set_token" => {
            let TokenParams { token } = parse(&params)?;
            cmd(core
                .local_api()
                .set_token(token)
                .await
                .map_err(|error| error.to_string()))
        }
        #[cfg(feature = "local-api")]
        "local_api_reveal_token" => ok(core.local_api().reveal_token().await),
        #[cfg(feature = "local-api")]
        "local_api_regenerate_token" => cmd(core
            .local_api()
            .regenerate_token()
            .await
            .map_err(|error| error.to_string())),
        #[cfg(not(feature = "local-api"))]
        "local_api_status"
        | "local_api_set_enabled"
        | "local_api_set_port"
        | "local_api_set_token"
        | "local_api_reveal_token"
        | "local_api_regenerate_token" => Err(DispatchError::Unavailable {
            feature: "local API",
        }),
        "debug_perf_sample" => {
            let SampleParams { sample } = parse(&params)?;
            cmd(ops::write_perf_sample(core.logging().log_dir(), &sample))
        }
        "diagnostics_snapshot" => {
            let NamedRequest::<super::types::DiagnosticsRequest> { request } = parse(&params)?;
            ok(ops::assemble_diagnostics_snapshot(
                &core.player(),
                core.qq_music().as_ref(),
                &core.logging(),
                Some(&core.plugins()),
                ops::live_platform_diagnostics(core, host),
                host.app_section(),
                request,
            )
            .await)
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
        "statistics_snapshot" => {
            let StatisticsRangeParams { range } = parse(&params)?;
            cmd(core
                .statistics()
                .snapshot(range)
                .map_err(|error| error.to_string()))
        }
        "statistics_clear" => {
            let result = core
                .statistics()
                .clear()
                .map_err(|error| DispatchError::Command {
                    message: error.to_string(),
                    retryable: false,
                    details: None,
                })?;
            core.player().publish_api_event(
                "statistics.changed",
                &StatisticsChanged {
                    revision: result.revision,
                },
            );
            ok(result)
        }
        "issue_reporter_preview" => {
            let IssueReporterPreviewParams { draft, request } = parse(&params)?;
            ok(ops::issue_reporter_preview(core, host, draft, request).await)
        }
        "issue_reporter_validate_url" => {
            let UrlParams { url } = parse(&params)?;
            cmd(crate::issue_reporter::validate_open_url(&url).map_err(str::to_owned))
        }
        #[cfg(feature = "plugins")]
        "plugin_list" => ok(ops::plugin_list(&core.plugins())),
        #[cfg(feature = "plugins")]
        "plugin_inspect_path" => {
            let PathParams { path } = parse(&params)?;
            cmd(ops::plugin_inspect_path(&core.plugins(), path))
        }
        #[cfg(feature = "plugins")]
        "plugin_install" => {
            let NamedRequest::<PluginInstallRequest> { request } = parse(&params)?;
            cmd(ops::plugin_install(&core.plugins(), request, notify_plugin))
        }
        #[cfg(feature = "plugins")]
        "plugin_set_enabled" => {
            let NamedRequest::<PluginEnableRequest> { request } = parse(&params)?;
            cmd(ops::plugin_set_enabled(
                &core.plugins(),
                request,
                notify_plugin,
            ))
        }
        #[cfg(feature = "plugins")]
        "plugin_uninstall" => {
            let NamedRequest::<PluginUninstallRequest> { request } = parse(&params)?;
            cmd(ops::plugin_uninstall(
                &core.plugins(),
                request,
                notify_plugin,
            ))
        }
        #[cfg(feature = "plugins")]
        "plugin_set_safe_mode" => {
            let EnabledParams { enabled } = parse(&params)?;
            cmd(ops::plugin_set_safe_mode(
                &core.plugins(),
                enabled,
                notify_plugin,
            ))
        }
        #[cfg(feature = "plugins")]
        "plugin_set_developer_mode" => {
            let EnabledParams { enabled } = parse(&params)?;
            cmd(ops::plugin_set_developer_mode(
                &core.plugins(),
                enabled,
                notify_plugin,
            ))
        }
        #[cfg(feature = "plugins")]
        "plugin_active_resources" => ok(ops::plugin_active_resources(&core.plugins())),
        #[cfg(feature = "plugins")]
        "plugin_diagnostics" => ok(ops::plugin_diagnostics(&core.plugins())),
        #[cfg(feature = "plugins")]
        "plugin_runtime_start" => {
            let PluginIdParams { plugin_id } = parse(&params)?;
            cmd(ops::plugin_runtime_start(&core.plugins(), &plugin_id))
        }
        #[cfg(feature = "plugins")]
        "plugin_runtime_stop" => {
            let TokenParams { token } = parse(&params)?;
            ops::plugin_runtime_stop(&core.plugins(), &token);
            Ok(Value::Null)
        }
        #[cfg(feature = "plugins")]
        "plugin_mark_failed" => {
            let PluginMarkFailedParams { id, reason } = parse(&params)?;
            cmd(ops::plugin_mark_failed(
                &core.plugins(),
                &id,
                &reason,
                notify_plugin,
            ))
        }
        #[cfg(feature = "plugins")]
        "plugin_bridge" => {
            let NamedRequest::<PluginBridgeRequest> { request } = parse(&params)?;
            cmd(ops::plugin_bridge(&core.plugins(), &core.player(), request).await)
        }
        #[cfg(feature = "plugins")]
        "plugin_install_unpacked" => {
            let NamedRequest::<PluginInstallRequest> { request } = parse(&params)?;
            cmd(ops::plugin_install_unpacked(
                &core.plugins(),
                request,
                notify_plugin,
            ))
        }
        #[cfg(feature = "plugins")]
        "plugin_reload" => {
            let IdParams { id } = parse(&params)?;
            cmd(ops::plugin_reload(&core.plugins(), &id, notify_plugin))
        }
        #[cfg(feature = "plugins")]
        "plugin_read_asset" => {
            let PluginReadAssetParams { plugin_id, path } = parse(&params)?;
            cmd(ops::plugin_read_asset(&core.plugins(), &plugin_id, &path))
        }
        #[cfg(feature = "plugins")]
        "plugin_settings_get" => {
            let IdParams { id } = parse(&params)?;
            cmd(ops::plugin_settings_get(&core.plugins(), &id))
        }
        #[cfg(feature = "plugins")]
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
            core.statistics().shutdown();
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
            core.continuation()
                .end(ContinuationTerminalReason::AccountChanged)
                .await;
            provider(ops::auth_oauth_prepare(core.qq_music().as_ref(), provider_kind).await)
        }
        "auth_oauth_complete" => {
            let OAuthCompleteParams {
                attempt_id,
                callback_url,
            } = parse(&params)?;
            let callback_url = reqwest::Url::parse(&callback_url)
                .map_err(|error| DispatchError::InvalidParams(error.to_string()))?;
            let result =
                ops::auth_oauth_complete(core.qq_music().as_ref(), &attempt_id, callback_url).await;
            core.continuation()
                .validate_account_generation("qqmusic")
                .await;
            provider(result)
        }
        "auth_oauth_cancel" => {
            let AttemptIdParams { attempt_id } = parse(&params)?;
            let result = ops::auth_oauth_cancel(core.qq_music().as_ref(), &attempt_id).await;
            core.continuation()
                .validate_account_generation("qqmusic")
                .await;
            provider(result)
        }
        "provider_auth_oauth_prepare" => {
            let ProviderOAuthPrepareParams {
                provider_id,
                method_id,
            } = parse(&params)?;
            core.continuation()
                .end(ContinuationTerminalReason::AccountChanged)
                .await;
            let capability =
                provider_command(core.providers().require_account_provider(&provider_id))?;
            provider(capability.account_prepare_login(&method_id).await)
        }
        "provider_auth_oauth_complete" => {
            let ProviderOAuthCompleteParams {
                provider_id,
                attempt_id,
                callback_url,
            } = parse(&params)?;
            let callback_url = reqwest::Url::parse(&callback_url)
                .map_err(|error| DispatchError::InvalidParams(error.to_string()))?;
            let capability =
                provider_command(core.providers().require_account_provider(&provider_id))?;
            let result = capability
                .provider_account()
                .complete_oauth_login(&attempt_id, callback_url)
                .await;
            core.continuation()
                .validate_account_generation(&provider_id)
                .await;
            provider(result)
        }
        "provider_auth_oauth_cancel" => {
            let ProviderAttemptParams {
                provider_id,
                attempt_id,
            } = parse(&params)?;
            let capability =
                provider_command(core.providers().require_account_provider(&provider_id))?;
            let result = capability
                .provider_account()
                .cancel_oauth_login(&attempt_id)
                .await;
            core.continuation()
                .validate_account_generation(&provider_id)
                .await;
            provider(result)
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
        "statistics_export_to" => {
            let NamedRequest::<StatisticsExportRequest> { request } = parse(&params)?;
            cmd(core
                .statistics()
                .export(request)
                .map_err(|error| error.to_string()))
        }
        "preferences_set_background_from" => {
            let PathParams { path } = parse(&params)?;
            cmd(ops::preferences_set_background_from(&core.config().paths.data_dir, path).await)
        }
        #[cfg(feature = "plugins")]
        "plugin_install_from" => {
            let NamedRequest::<PluginInstallRequest> { request } = parse(&params)?;
            cmd(ops::plugin_install_from(
                &core.plugins(),
                request,
                notify_plugin,
            ))
        }
        #[cfg(not(feature = "plugins"))]
        "plugin_list"
        | "plugin_inspect_path"
        | "plugin_install"
        | "plugin_set_enabled"
        | "plugin_uninstall"
        | "plugin_set_safe_mode"
        | "plugin_set_developer_mode"
        | "plugin_active_resources"
        | "plugin_diagnostics"
        | "plugin_runtime_start"
        | "plugin_runtime_stop"
        | "plugin_mark_failed"
        | "plugin_bridge"
        | "plugin_install_unpacked"
        | "plugin_reload"
        | "plugin_read_asset"
        | "plugin_settings_get"
        | "plugin_settings_set"
        | "plugin_install_from" => Err(DispatchError::Unavailable { feature: "plugins" }),
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
