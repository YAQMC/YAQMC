use std::fmt;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::{ErrorCode, DEFAULT_METHOD_PAYLOAD_BYTES, FRAME_HARD_CAP_BYTES};

const PLUGIN_READ_ASSET_RESPONSE_CAP: u32 = 6 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WindowOrigin {
    Host,
    Main,
    LyricsDesktop,
    LyricsIsland,
    LyricsDesktopUnlock,
    LyricsIslandUnlock,
}

impl fmt::Display for WindowOrigin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Host => "host",
            Self::Main => "main",
            Self::LyricsDesktop => "lyrics-desktop",
            Self::LyricsIsland => "lyrics-island",
            Self::LyricsDesktopUnlock => "lyrics-desktop-unlock",
            Self::LyricsIslandUnlock => "lyrics-island-unlock",
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MethodOwner {
    Core,
    Host,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TimeoutClass {
    Control,
    Standard,
    Long,
}

impl TimeoutClass {
    pub fn duration(self) -> Duration {
        match self {
            Self::Control => Duration::from_secs(10),
            Self::Standard => Duration::from_secs(30),
            Self::Long => Duration::from_secs(120),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MethodSpec {
    pub name: &'static str,
    pub owner: MethodOwner,
    pub main_window_only: bool,
    pub timeout_class: TimeoutClass,
    pub allowed_origins: &'static [WindowOrigin],
    pub request_cap: u32,
    pub response_cap: u32,
}

impl MethodSpec {
    pub fn allows(self, origin: WindowOrigin) -> bool {
        self.allowed_origins.contains(&origin)
    }

    pub fn accepts_request_bytes(self, length: u32) -> bool {
        length <= self.request_cap && length <= FRAME_HARD_CAP_BYTES
    }

    pub fn accepts_response_bytes(self, length: u32) -> bool {
        length <= self.response_cap && length <= FRAME_HARD_CAP_BYTES
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AclDenied {
    pub method: String,
    pub origin: WindowOrigin,
}

impl AclDenied {
    pub fn code(&self) -> ErrorCode {
        ErrorCode::Denied
    }

    pub fn retryable(&self) -> bool {
        false
    }
}

impl fmt::Display for AclDenied {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} is not allowed from {}", self.method, self.origin)
    }
}

impl std::error::Error for AclDenied {}

#[derive(Clone, Copy)]
enum OriginClass {
    Main,
    /// Main-window renderer continuation only. Used by dialog-split IO
    /// (`*_to` / `*_from`): the host owns the picker, not the Core write.
    MainRenderer,
    Surfaces,
    Unlock,
}

const HOST_AND_MAIN: &[WindowOrigin] = &[WindowOrigin::Host, WindowOrigin::Main];
const MAIN_RENDERER: &[WindowOrigin] = &[WindowOrigin::Main];
const HOST_MAIN_AND_SURFACES: &[WindowOrigin] = &[
    WindowOrigin::Host,
    WindowOrigin::Main,
    WindowOrigin::LyricsDesktop,
    WindowOrigin::LyricsIsland,
];
const HOST_AND_UNLOCK: &[WindowOrigin] = &[
    WindowOrigin::Host,
    WindowOrigin::LyricsDesktopUnlock,
    WindowOrigin::LyricsIslandUnlock,
];

const METHODS: &[MethodSpec] = &[
    spec("platform_diagnostics", MethodOwner::Core, OriginClass::Main),
    spec(
        "platform_export_diagnostics",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec(
        "system_integration_status",
        MethodOwner::Host,
        OriginClass::Main,
    ),
    spec(
        "system_shortcuts_set_enabled",
        MethodOwner::Host,
        OriginClass::Main,
    ),
    spec("audio_output_devices", MethodOwner::Core, OriginClass::Main),
    spec(
        "audio_set_output_device",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec("qqmusic_status", MethodOwner::Core, OriginClass::Main),
    spec("qqmusic_home", MethodOwner::Core, OriginClass::Main),
    spec("qqmusic_discover", MethodOwner::Core, OriginClass::Main),
    spec("qqmusic_area", MethodOwner::Core, OriginClass::Main),
    spec("qqmusic_guess_next", MethodOwner::Core, OriginClass::Main),
    spec("qqmusic_library", MethodOwner::Core, OriginClass::Main),
    spec("qqmusic_search", MethodOwner::Core, OriginClass::Main),
    spec("qqmusic_song", MethodOwner::Core, OriginClass::Main),
    spec("qqmusic_album", MethodOwner::Core, OriginClass::Main),
    spec("qqmusic_artist", MethodOwner::Core, OriginClass::Main),
    spec(
        "qqmusic_artist_catalog",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec("qqmusic_playlist", MethodOwner::Core, OriginClass::Main),
    spec("qqmusic_lyrics", MethodOwner::Core, OriginClass::Main),
    spec("catalog_share_song", MethodOwner::Core, OriginClass::Main),
    spec(
        "qqmusic_cache_artwork",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec(
        "qqmusic_set_preferred_quality",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec(
        "qqmusic_set_current_quality",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec(
        "qqmusic_account_snapshot",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec(
        "qqmusic_favorite_songs",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec(
        "qqmusic_account_playlists",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec(
        "qqmusic_account_playlist_tracks",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec(
        "qqmusic_account_recently_played",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec("qqmusic_set_favorite", MethodOwner::Core, OriginClass::Main),
    spec(
        "qqmusic_create_playlist",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec(
        "qqmusic_rename_playlist",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec(
        "qqmusic_add_playlist_track",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec(
        "qqmusic_remove_playlist_track",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec(
        "qqmusic_delete_playlist",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec(
        "qqmusic_set_playlist_collected",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec("qqmusic_auth_start", MethodOwner::Core, OriginClass::Main),
    spec(
        "qqmusic_auth_oauth_start",
        MethodOwner::Host,
        OriginClass::Main,
    ),
    spec(
        "qqmusic_auth_heartbeat",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec("qqmusic_auth_cancel", MethodOwner::Core, OriginClass::Main),
    spec("qqmusic_auth_refresh", MethodOwner::Core, OriginClass::Main),
    spec("qqmusic_sign_out", MethodOwner::Core, OriginClass::Main),
    spec("qqmusic_cache_stats", MethodOwner::Core, OriginClass::Main),
    spec("qqmusic_clear_cache", MethodOwner::Core, OriginClass::Main),
    spec("player_snapshot", MethodOwner::Core, OriginClass::Main),
    spec("player_hydrate_queue", MethodOwner::Core, OriginClass::Main),
    spec("player_play_tracks", MethodOwner::Core, OriginClass::Main),
    spec(
        "player_play_from_queue",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec(
        "player_play_queue_entry",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec("player_play", MethodOwner::Core, OriginClass::Main),
    spec("player_pause", MethodOwner::Core, OriginClass::Main),
    spec("player_toggle", MethodOwner::Core, OriginClass::Surfaces),
    spec("player_next", MethodOwner::Core, OriginClass::Surfaces),
    spec("player_previous", MethodOwner::Core, OriginClass::Surfaces),
    spec("player_seek", MethodOwner::Core, OriginClass::Main),
    spec("player_set_volume", MethodOwner::Core, OriginClass::Main),
    spec("player_toggle_muted", MethodOwner::Core, OriginClass::Main),
    spec(
        "player_toggle_shuffle",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec("player_set_shuffle", MethodOwner::Core, OriginClass::Main),
    spec("player_cycle_repeat", MethodOwner::Core, OriginClass::Main),
    spec("player_set_repeat", MethodOwner::Core, OriginClass::Main),
    spec(
        "player_set_primary_playback_mode",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec("player_add_to_queue", MethodOwner::Core, OriginClass::Main),
    spec(
        "player_add_tracks_to_queue",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec(
        "player_remove_from_queue",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec(
        "player_remove_queue_entry",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec(
        "player_reorder_queue_entry",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec(
        "player_play_next_queue_entry",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec("player_set_lyrics", MethodOwner::Core, OriginClass::Main),
    spec("player_lyrics", MethodOwner::Core, OriginClass::Surfaces),
    spec(
        "lyrics_surface_projection",
        MethodOwner::Core,
        OriginClass::Surfaces,
    ),
    spec(
        "app_preferences_get",
        MethodOwner::Core,
        OriginClass::Surfaces,
    ),
    spec(
        "app_preferences_set",
        MethodOwner::Core,
        OriginClass::Surfaces,
    ),
    spec(
        "appearance_background_load",
        MethodOwner::Core,
        OriginClass::Surfaces,
    ),
    spec(
        "lyrics_surfaces_reconcile",
        MethodOwner::Host,
        OriginClass::Main,
    ),
    spec(
        "lyrics_surface_capabilities",
        MethodOwner::Host,
        OriginClass::Main,
    ),
    spec(
        "lyrics_surface_status",
        MethodOwner::Host,
        OriginClass::Main,
    ),
    spec(
        "lyrics_surfaces_unlock_all",
        MethodOwner::Host,
        OriginClass::Main,
    ),
    spec(
        "lyrics_surface_unlock",
        MethodOwner::Host,
        OriginClass::Unlock,
    ),
    spec(
        "lyrics_surface_close",
        MethodOwner::Host,
        OriginClass::Surfaces,
    ),
    spec(
        "lyrics_surface_set_interaction",
        MethodOwner::Host,
        OriginClass::Surfaces,
    ),
    spec(
        "lyrics_surface_reset_position",
        MethodOwner::Host,
        OriginClass::Main,
    ),
    spec(
        "lyrics_surface_show_settings",
        MethodOwner::Host,
        OriginClass::Surfaces,
    ),
    spec("local_api_status", MethodOwner::Core, OriginClass::Main),
    spec(
        "local_api_set_enabled",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec("local_api_set_port", MethodOwner::Core, OriginClass::Main),
    spec("local_api_set_token", MethodOwner::Core, OriginClass::Main),
    spec(
        "local_api_reveal_token",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec(
        "local_api_regenerate_token",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec("debug_perf_sample", MethodOwner::Core, OriginClass::Main),
    spec("diagnostics_snapshot", MethodOwner::Core, OriginClass::Main),
    spec(
        "diagnostics_reveal_bundle",
        MethodOwner::Host,
        OriginClass::Main,
    ),
    spec(
        "diagnostics_open_log_folder",
        MethodOwner::Host,
        OriginClass::Main,
    ),
    spec(
        "diagnostics_clear_logs",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec(
        "diagnostics_set_log_level",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec(
        "diagnostics_current_level",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec(
        "diagnostics_recent_errors",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec(
        "diagnostics_record_error",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec(
        "diagnostics_log_frontend",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec(
        "issue_reporter_preview",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec(
        "issue_reporter_validate_url",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec("plugin_list", MethodOwner::Core, OriginClass::Main),
    spec("plugin_inspect_path", MethodOwner::Core, OriginClass::Main),
    spec("plugin_install", MethodOwner::Core, OriginClass::Main),
    spec("plugin_set_enabled", MethodOwner::Core, OriginClass::Main),
    spec("plugin_uninstall", MethodOwner::Core, OriginClass::Main),
    spec("plugin_set_safe_mode", MethodOwner::Core, OriginClass::Main),
    spec(
        "plugin_set_developer_mode",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec(
        "plugin_active_resources",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec("plugin_diagnostics", MethodOwner::Core, OriginClass::Main),
    spec("plugin_runtime_start", MethodOwner::Core, OriginClass::Main),
    spec("plugin_runtime_stop", MethodOwner::Core, OriginClass::Main),
    spec("plugin_mark_failed", MethodOwner::Core, OriginClass::Main),
    spec("plugin_bridge", MethodOwner::Core, OriginClass::Main),
    spec(
        "plugin_pick_directory",
        MethodOwner::Host,
        OriginClass::Main,
    ),
    spec(
        "plugin_install_unpacked",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec("plugin_reload", MethodOwner::Core, OriginClass::Main),
    spec("plugin_read_asset", MethodOwner::Core, OriginClass::Main),
    spec("plugin_settings_get", MethodOwner::Core, OriginClass::Main),
    spec("plugin_settings_set", MethodOwner::Core, OriginClass::Main),
    spec("core_ping", MethodOwner::Core, OriginClass::Main),
    spec("platform_attach", MethodOwner::Core, OriginClass::Main),
    spec(
        "core_shutdown_prepare",
        MethodOwner::Core,
        OriginClass::Main,
    ),
    spec("auth_oauth_prepare", MethodOwner::Core, OriginClass::Main),
    spec("auth_oauth_complete", MethodOwner::Core, OriginClass::Main),
    spec("auth_oauth_cancel", MethodOwner::Core, OriginClass::Main),
    spec("app_settings_get", MethodOwner::Core, OriginClass::Main),
    spec("app_settings_set", MethodOwner::Core, OriginClass::Main),
    spec("app_settings_remove", MethodOwner::Core, OriginClass::Main),
    spec(
        "diagnostics_export_bundle_to",
        MethodOwner::Core,
        OriginClass::MainRenderer,
    ),
    spec(
        "preferences_set_background_from",
        MethodOwner::Core,
        OriginClass::MainRenderer,
    ),
    spec(
        "plugin_install_from",
        MethodOwner::Core,
        OriginClass::MainRenderer,
    ),
];

pub const PROTOCOL_ONLY_METHODS: &[&str] = &[
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

const fn spec(name: &'static str, owner: MethodOwner, origins: OriginClass) -> MethodSpec {
    MethodSpec {
        name,
        owner,
        main_window_only: matches!(origins, OriginClass::Main | OriginClass::MainRenderer),
        timeout_class: timeout_class(name),
        allowed_origins: origin_slice(origins),
        request_cap: DEFAULT_METHOD_PAYLOAD_BYTES,
        response_cap: response_cap(name),
    }
}

const fn origin_slice(origins: OriginClass) -> &'static [WindowOrigin] {
    match origins {
        OriginClass::Main => HOST_AND_MAIN,
        OriginClass::MainRenderer => MAIN_RENDERER,
        OriginClass::Surfaces => HOST_MAIN_AND_SURFACES,
        OriginClass::Unlock => HOST_AND_UNLOCK,
    }
}

const fn timeout_class(name: &str) -> TimeoutClass {
    if const_starts_with(name, "player_") || const_eq(name, "core_ping") {
        TimeoutClass::Control
    } else if const_eq(name, "plugin_install")
        || const_eq(name, "plugin_install_from")
        || const_eq(name, "plugin_install_unpacked")
        || const_eq(name, "plugin_reload")
        || const_eq(name, "diagnostics_export_bundle_to")
        || const_eq(name, "platform_export_diagnostics")
    {
        TimeoutClass::Long
    } else {
        TimeoutClass::Standard
    }
}

const fn response_cap(name: &str) -> u32 {
    if const_eq(name, "plugin_read_asset") {
        PLUGIN_READ_ASSET_RESPONSE_CAP
    } else {
        DEFAULT_METHOD_PAYLOAD_BYTES
    }
}

const fn const_eq(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    if left.len() != right.len() {
        return false;
    }
    let mut index = 0;
    while index < left.len() {
        if left[index] != right[index] {
            return false;
        }
        index += 1;
    }
    true
}

const fn const_starts_with(value: &str, prefix: &str) -> bool {
    let value = value.as_bytes();
    let prefix = prefix.as_bytes();
    if value.len() < prefix.len() {
        return false;
    }
    let mut index = 0;
    while index < prefix.len() {
        if value[index] != prefix[index] {
            return false;
        }
        index += 1;
    }
    true
}

pub fn methods() -> &'static [MethodSpec] {
    METHODS
}

pub fn method(name: &str) -> Option<&'static MethodSpec> {
    METHODS.iter().find(|spec| spec.name == name)
}

pub fn authorize(origin: WindowOrigin, name: &str) -> Result<&'static MethodSpec, AclDenied> {
    let spec = method(name).ok_or_else(|| AclDenied {
        method: name.to_owned(),
        origin,
    })?;
    if spec.allows(origin) {
        Ok(spec)
    } else {
        Err(AclDenied {
            method: name.to_owned(),
            origin,
        })
    }
}
