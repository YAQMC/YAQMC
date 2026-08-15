use std::str::FromStr;
use thiserror::Error;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PluginPermission {
    TrackRead,
    LyricsRead,
    PlayerRead,
    PlayerControl,
    ThemeRead,
    PluginStorage,
    SceneRegister,
    StyleRegister,
}

pub const V1_PERMISSIONS: &[PluginPermission] = &[
    PluginPermission::TrackRead,
    PluginPermission::LyricsRead,
    PluginPermission::PlayerRead,
    PluginPermission::PlayerControl,
    PluginPermission::ThemeRead,
    PluginPermission::PluginStorage,
    PluginPermission::SceneRegister,
    PluginPermission::StyleRegister,
];

const RESERVED: &[&str] = &[
    "network",
    "filesystem",
    "provider",
    "account",
    "native",
    "shell",
    "network.fetch",
    "filesystem.read",
    "account.credentials",
];

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PermissionError {
    #[error("the permission is reserved and unavailable in plugin platform v1")]
    Reserved,
    #[error("the permission format is unknown")]
    Unknown,
}

impl PluginPermission {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TrackRead => "track.read",
            Self::LyricsRead => "lyrics.read",
            Self::PlayerRead => "player.read",
            Self::PlayerControl => "player.control",
            Self::ThemeRead => "theme.read",
            Self::PluginStorage => "plugin.storage",
            Self::SceneRegister => "scene.register",
            Self::StyleRegister => "style.register",
        }
    }

    #[allow(dead_code)]
    pub fn label(self) -> &'static str {
        match self {
            Self::TrackRead => "Read current track",
            Self::LyricsRead => "Read lyrics",
            Self::PlayerRead => "Read playback state",
            Self::PlayerControl => "Control playback",
            Self::ThemeRead => "Read theme",
            Self::PluginStorage => "Private plugin storage",
            Self::SceneRegister => "Register lyrics scenes",
            Self::StyleRegister => "Register styles",
        }
    }

    pub fn sensitive(self) -> bool {
        matches!(self, Self::PlayerControl)
    }
}

impl FromStr for PluginPermission {
    type Err = PermissionError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        parse_permission(value)
    }
}

pub fn parse_permission(value: &str) -> Result<PluginPermission, PermissionError> {
    if RESERVED
        .iter()
        .any(|reserved| *reserved == value || value.starts_with(&format!("{reserved}.")))
    {
        return Err(PermissionError::Reserved);
    }
    for permission in V1_PERMISSIONS {
        if permission.as_str() == value {
            return Ok(*permission);
        }
    }
    Err(PermissionError::Unknown)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v1_permissions_parse_and_reserved_are_denied() {
        assert_eq!(
            parse_permission("player.control").unwrap(),
            PluginPermission::PlayerControl
        );
        assert_eq!(parse_permission("network"), Err(PermissionError::Reserved));
        assert_eq!(
            parse_permission("filesystem.read"),
            Err(PermissionError::Reserved)
        );
        assert_eq!(parse_permission("eval"), Err(PermissionError::Unknown));
        assert_eq!(PluginPermission::TrackRead.label(), "Read current track");
        assert!(PluginPermission::PlayerControl.sensitive());
    }
}
