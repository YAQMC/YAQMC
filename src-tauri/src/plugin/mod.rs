//! YAQMC runtime plugin host (ExtensionHost).
//!
//! This is not a Tauri framework plugin. Runtime plugins are user-installed
//! `*.yaqmc-plugin` packages with CSS, Scene Schema, and/or an isolated JS bundle.

pub mod commands;
pub mod host;
pub mod manifest;
pub mod network;
pub mod package;
pub mod permissions;
pub mod scanner;
pub mod settings;

pub use host::{ExtensionHost, PluginDiagnostic, PluginStatus};
pub use manifest::PluginManifest;

pub const MAX_COMPRESSED_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_EXPANDED_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_FILE_COUNT: usize = 256;
pub const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
pub const PLUGIN_STORAGE_QUOTA: usize = 64 * 1024;
