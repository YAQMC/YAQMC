use std::net::IpAddr;
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
    UiContextMenu,
    UiPlayerBar,
    UiSidebar,
    UiNotify,
    Network,
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

pub const V2_PERMISSIONS: &[PluginPermission] = &[
    PluginPermission::UiContextMenu,
    PluginPermission::UiPlayerBar,
    PluginPermission::UiSidebar,
    PluginPermission::UiNotify,
    PluginPermission::Network,
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
    #[error("the permission is reserved and unavailable")]
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
            Self::UiContextMenu => "ui.contextMenu",
            Self::UiPlayerBar => "ui.playerBar",
            Self::UiSidebar => "ui.sidebar",
            Self::UiNotify => "ui.notify",
            Self::Network => "network",
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
            Self::UiContextMenu => "Add track context-menu actions",
            Self::UiPlayerBar => "Add Player Bar actions",
            Self::UiSidebar => "Add sidebar commands",
            Self::UiNotify => "Show notifications",
            Self::Network => "Scoped HTTPS network access",
        }
    }

    #[allow(dead_code)]
    pub fn sensitive(self) -> bool {
        matches!(self, Self::PlayerControl | Self::Network)
    }
}

impl FromStr for PluginPermission {
    type Err = PermissionError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        parse_permission(value).map(|(permission, _)| permission)
    }
}

pub fn parse_permission(
    value: &str,
) -> Result<(PluginPermission, Option<String>), PermissionError> {
    if let Some(origin) = value.strip_prefix("network:") {
        let origin = parse_https_origin(origin)?;
        return Ok((PluginPermission::Network, Some(origin)));
    }
    if RESERVED
        .iter()
        .any(|reserved| *reserved == value || value.starts_with(&format!("{reserved}.")))
    {
        return Err(PermissionError::Reserved);
    }
    for permission in V1_PERMISSIONS.iter().chain(V2_PERMISSIONS.iter()) {
        if permission.as_str() == value {
            return Ok((*permission, None));
        }
    }
    Err(PermissionError::Unknown)
}

pub fn parse_https_origin(value: &str) -> Result<String, PermissionError> {
    let rest = value
        .strip_prefix("https://")
        .ok_or(PermissionError::Unknown)?;
    if rest.is_empty()
        || rest.contains('/')
        || rest.contains('?')
        || rest.contains('#')
        || rest.contains('@')
        || rest.contains('*')
        || rest.contains('\\')
    {
        return Err(PermissionError::Unknown);
    }
    let (host, port) = match rest.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') => {
            let port: u16 = port.parse().map_err(|_| PermissionError::Unknown)?;
            (host, Some(port))
        }
        _ => (rest, None),
    };
    let host = host.to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return Err(PermissionError::Unknown);
    }
    if host.parse::<IpAddr>().is_ok() {
        return Err(PermissionError::Unknown);
    }
    if !is_dns_hostname(&host) {
        return Err(PermissionError::Unknown);
    }
    Ok(match port {
        None | Some(443) => format!("https://{host}"),
        Some(port) => format!("https://{host}:{port}"),
    })
}

pub fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(value) => {
            value.is_loopback()
                || value.is_private()
                || value.is_link_local()
                || value.is_unspecified()
                || value.is_broadcast()
                || value.octets()[0] == 0
                || (value.octets()[0] == 169 && value.octets()[1] == 254)
                || value.octets()[0] >= 224
        }
        IpAddr::V6(value) => {
            value.is_loopback()
                || value.is_unique_local()
                || value.is_unicast_link_local()
                || value.is_unspecified()
                || value.is_multicast()
                || value
                    .to_ipv4_mapped()
                    .is_some_and(|mapped| is_blocked_ip(IpAddr::V4(mapped)))
        }
    }
}

fn is_dns_hostname(host: &str) -> bool {
    if host.len() < 4
        || host.len() > 253
        || !host.contains('.')
        || host.starts_with('.')
        || host.ends_with('.')
    {
        return false;
    }
    host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v1_permissions_parse_and_reserved_are_denied() {
        assert_eq!(
            parse_permission("player.control").unwrap(),
            (PluginPermission::PlayerControl, None)
        );
        assert_eq!(parse_permission("network"), Err(PermissionError::Reserved));
        assert_eq!(
            parse_permission("filesystem.read"),
            Err(PermissionError::Reserved)
        );
        assert_eq!(parse_permission("eval"), Err(PermissionError::Unknown));
        assert_eq!(PluginPermission::TrackRead.label(), "Read current track");
        assert!(PluginPermission::PlayerControl.sensitive());
        assert!(PluginPermission::Network.sensitive());
    }

    #[test]
    fn scoped_https_origins_parse_and_wildcards_are_rejected() {
        assert_eq!(
            parse_permission("network:https://api.example.com").unwrap(),
            (
                PluginPermission::Network,
                Some("https://api.example.com".into())
            )
        );
        assert_eq!(
            parse_permission("network:https://api.example.com:8443")
                .unwrap()
                .1,
            Some("https://api.example.com:8443".into())
        );
        assert!(parse_permission("network:*").is_err());
        assert!(parse_permission("network:https://*").is_err());
        assert!(parse_permission("network:https://127.0.0.1").is_err());
        assert!(parse_permission("network:https://localhost").is_err());
        assert!(parse_permission("network:http://api.example.com").is_err());
        assert!(parse_permission("network:https://api.example.com/path").is_err());
        assert!(is_blocked_ip("127.0.0.1".parse().unwrap()));
        assert!(is_blocked_ip("10.0.0.1".parse().unwrap()));
        assert!(is_blocked_ip("169.254.169.254".parse().unwrap()));
        assert!(!is_blocked_ip("1.1.1.1".parse().unwrap()));
    }
}
