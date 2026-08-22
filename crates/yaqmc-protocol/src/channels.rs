//! ADR-004 event channel names. Core fan-out owns the player/lyrics/host-command
//! map; plugin/preferences still notify through existing host callbacks until a
//! later bus merge. `account://changed` and `core://log` are declared and unused.

pub const CHANNEL_API_EVENT: &str = "api://event";
pub const CHANNEL_PLAYER_SNAPSHOT: &str = "player://snapshot";
pub const CHANNEL_LYRICS_PROJECTION: &str = "lyrics://projection";
pub const CHANNEL_LYRICS_DOCUMENT: &str = "lyrics://document";
pub const CHANNEL_PLUGIN_CHANGED: &str = "plugin://changed";
pub const CHANNEL_PREFERENCES_CHANGED: &str = "preferences://changed";
pub const CHANNEL_LYRICS_SURFACE_CLOSED: &str = "lyrics://surface-closed";
pub const CHANNEL_LYRICS_SURFACE_INTERACTION: &str = "lyrics://surface-interaction";
pub const CHANNEL_APP_OPEN_SETTINGS: &str = "app://open-settings";
pub const CHANNEL_HOST_COMMAND: &str = "host://command";
pub const CHANNEL_HOST_CORE_STATUS: &str = "host://core-status";
pub const CHANNEL_HOST_UPDATE: &str = "host://update";
pub const CHANNEL_CORE_LOG: &str = "core://log";
pub const CHANNEL_ACCOUNT_CHANGED: &str = "account://changed";

/// Channels Core may emit as protocol `event` frames (including reserved unused).
pub const CORE_EVENT_CHANNELS: &[&str] = &[
    CHANNEL_API_EVENT,
    CHANNEL_PLAYER_SNAPSHOT,
    CHANNEL_LYRICS_PROJECTION,
    CHANNEL_LYRICS_DOCUMENT,
    CHANNEL_PLUGIN_CHANGED,
    CHANNEL_PREFERENCES_CHANGED,
    CHANNEL_HOST_COMMAND,
    CHANNEL_CORE_LOG,
    CHANNEL_ACCOUNT_CHANGED,
];

/// Existing host-owned window/tray channels. Not emitted by Core fan-out.
pub const HOST_EVENT_CHANNELS: &[&str] = &[
    CHANNEL_LYRICS_SURFACE_CLOSED,
    CHANNEL_LYRICS_SURFACE_INTERACTION,
    CHANNEL_APP_OPEN_SETTINGS,
    CHANNEL_HOST_CORE_STATUS,
    CHANNEL_HOST_UPDATE,
];
