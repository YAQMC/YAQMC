//! Host-neutral YAQMC runtime plugin services.

pub mod api;
pub mod bridge;
pub mod component;
pub mod host;
pub mod manifest;
pub mod network;
pub mod package;
pub mod permissions;
pub mod provider;
pub mod scanner;
pub mod settings;

pub use api::{
    PluginBridgeRequest, PluginEnableRequest, PluginInspectResult, PluginInstallRequest,
    PluginSettingsWrite, PluginUninstallRequest,
};
pub use host::{ExtensionHost, PluginDiagnostic, PluginStatus};
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
