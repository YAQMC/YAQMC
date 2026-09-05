//! System-media no-op surface for non-desktop Core builds.

use crate::platform::SystemMediaStatus;
use crate::player::{PlayerService, PlayerSnapshot};
pub use crate::HostCommandPublisher;
use std::sync::Arc;

#[derive(Clone)]
pub struct SystemMediaStartConfig {
    pub windows_hwnd: Option<isize>,
    pub windows_start_error: Option<String>,
    pub runtime: tokio::runtime::Handle,
    pub host_commands: HostCommandPublisher,
}

pub struct SystemMediaIntegration;

impl SystemMediaIntegration {
    pub fn start(config: SystemMediaStartConfig, player: Arc<PlayerService>) -> Arc<Self> {
        let _ = (config, player);
        Arc::new(Self)
    }

    pub fn attach_hwnd(
        &self,
        hwnd: isize,
        player: Arc<PlayerService>,
        host_commands: HostCommandPublisher,
        runtime: tokio::runtime::Handle,
    ) {
        let _ = (hwnd, player, host_commands, runtime);
    }

    pub fn status(&self) -> SystemMediaStatus {
        SystemMediaStatus {
            available: false,
            backend: "unavailable",
            specification: "none",
            error: Some("system media is unavailable in this Core build".to_owned()),
        }
    }

    pub fn update(&self, snapshot: &PlayerSnapshot, seeked: bool) {
        let _ = (snapshot, seeked);
    }
}

pub fn parse_window_handle_hex(value: &str) -> Result<isize, String> {
    let value = value.trim();
    let value = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
        .unwrap_or(value);
    isize::from_str_radix(value, 16).map_err(|_| "invalid window handle".to_owned())
}
