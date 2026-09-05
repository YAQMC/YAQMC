//! Host-neutral YAQMC runtime plugin services.

#[cfg(not(feature = "plugins"))]
mod disabled;

#[cfg(not(feature = "plugins"))]
pub use disabled::ExtensionHost;

#[cfg(feature = "plugins")]
pub mod api;
#[cfg(feature = "plugins")]
pub mod bridge;
#[cfg(feature = "plugins")]
pub mod component;
#[cfg(feature = "plugins")]
pub mod component_host;
#[cfg(feature = "plugins")]
pub mod host;
#[cfg(feature = "plugins")]
pub mod manifest;
#[cfg(feature = "plugins")]
pub mod network;
#[cfg(feature = "plugins")]
pub mod package;
#[cfg(feature = "plugins")]
pub mod permissions;
#[cfg(feature = "plugins")]
pub mod provider;
#[cfg(feature = "plugins")]
pub mod scanner;
#[cfg(feature = "plugins")]
pub mod settings;

#[cfg(feature = "plugins")]
pub use api::{
    PluginBridgeRequest, PluginEnableRequest, PluginInspectResult, PluginInstallRequest,
    PluginSettingsWrite, PluginUninstallRequest,
};
#[cfg(feature = "plugins")]
pub use host::{ExtensionHost, PluginDiagnostic, PluginStatus};
#[cfg(feature = "plugins")]
pub use manifest::PluginManifest;

pub const LEGACY_MAX_COMPRESSED_BYTES: u64 = 8 * 1024 * 1024;
pub const LEGACY_MAX_EXPANDED_BYTES: u64 = 32 * 1024 * 1024;
pub const LEGACY_MAX_FILE_COUNT: usize = 256;
pub const LEGACY_MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
pub const COMPONENT_MAX_COMPRESSED_BYTES: u64 = 32 * 1024 * 1024;
pub const COMPONENT_MAX_EXPANDED_BYTES: u64 = 96 * 1024 * 1024;
pub const COMPONENT_MAX_FILE_COUNT: usize = 512;
pub const COMPONENT_MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
pub const COMPONENT_MAX_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_COMPRESSION_RATIO: u64 = 200;
pub const PLUGIN_STORAGE_QUOTA: usize = 64 * 1024;
