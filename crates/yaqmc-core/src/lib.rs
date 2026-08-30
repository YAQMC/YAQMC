//! Host-neutral ownership seams for the YAQMC application core.

pub mod app_preferences;
pub mod audio;
pub mod continuation;
pub mod credentials;
pub mod diagnostics;
pub mod fullscreen_watch;
pub mod issue_reporter;
pub mod local_api;
pub mod logging;
pub mod media;
pub mod pidfile;
pub mod platform;
pub mod playback_session;
pub mod playback_types;
pub mod player;
pub mod plugin;
pub mod server;
pub mod statistics;
pub mod storage;
pub mod streaming;
pub mod system_media;

mod bootstrap;

#[cfg(test)]
mod system_media_runtime_tests;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::{error::Error, fmt, path::PathBuf};

use tokio::sync::{broadcast, watch};

const HOST_COMMAND_CHANNEL_CAPACITY: usize = 16;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CorePaths {
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub log_dir: PathBuf,
    pub local_api_config_path: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CoreConfig {
    pub paths: CorePaths,
    pub release_channel: String,
    pub build_commit: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostCommand {
    RaiseMainWindow,
    Quit,
    /// Lyric surfaces should hide (`true`) or restore (`false`) for a
    /// foreground-fullscreen app. Serialized as `{ "surfaceAutoHide": bool }`.
    SurfaceAutoHide(bool),
}

/// Closed, non-blocking sender for the host-control commands Core may request.
///
/// The host subscribes before enabling any native callback source. A missing
/// subscriber is deliberately logged and ignored: losing a raise/quit delivery
/// must not turn a player or native-media callback into an application error.
#[derive(Clone)]
pub struct HostCommandPublisher {
    sender: broadcast::Sender<HostCommand>,
}

impl Default for HostCommandPublisher {
    fn default() -> Self {
        let (sender, _) = broadcast::channel(HOST_COMMAND_CHANNEL_CAPACITY);
        Self { sender }
    }
}

impl HostCommandPublisher {
    pub fn subscribe(&self) -> broadcast::Receiver<HostCommand> {
        self.sender.subscribe()
    }

    /// Returns whether at least one host subscriber accepted the command.
    pub fn publish(&self, command: HostCommand) -> bool {
        match self.sender.send(command) {
            Ok(_) => true,
            Err(_) => {
                tracing::debug!(target: "host.command", ?command, "host command had no active subscriber");
                false
            }
        }
    }
}

#[derive(Debug)]
pub enum CoreBootstrapError {
    Failed(String),
}

impl CoreBootstrapError {
    pub(crate) fn from_error(error: impl fmt::Display) -> Self {
        Self::Failed(error.to_string())
    }
}

impl fmt::Display for CoreBootstrapError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Failed(message) => formatter.write_str(message),
        }
    }
}

impl Error for CoreBootstrapError {}

pub use bootstrap::CoreBootstrapInputs;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostCommandRequestError {
    NoSubscribers,
}

impl fmt::Display for HostCommandRequestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoSubscribers => formatter.write_str("no host command subscriber is available"),
        }
    }
}

impl Error for HostCommandRequestError {}

pub struct CoreHandle {
    config: CoreConfig,
    host_command_publisher: HostCommandPublisher,
    shutdown_state: watch::Sender<bool>,
    is_shutdown: AtomicBool,
    services: Arc<bootstrap::CoreServices>,
}

impl CoreHandle {
    pub fn config(&self) -> &CoreConfig {
        &self.config
    }

    pub fn subscribe_host_commands(&self) -> broadcast::Receiver<HostCommand> {
        self.host_command_publisher.subscribe()
    }

    pub fn host_command_publisher(&self) -> HostCommandPublisher {
        self.host_command_publisher.clone()
    }

    pub fn subscribe_shutdown(&self) -> watch::Receiver<bool> {
        self.shutdown_state.subscribe()
    }

    pub fn request_host_control(
        &self,
        command: HostCommand,
    ) -> Result<(), HostCommandRequestError> {
        self.host_command_publisher
            .publish(command)
            .then_some(())
            .ok_or(HostCommandRequestError::NoSubscribers)
    }

    pub fn is_shutdown(&self) -> bool {
        self.is_shutdown.load(Ordering::Acquire)
    }

    pub fn shutdown(&self) {
        if !self.is_shutdown.swap(true, Ordering::AcqRel) {
            self.services.statistics.shutdown();
            self.shutdown_state.send_replace(true);
        }
    }

    pub fn storage(&self) -> Arc<crate::storage::StorageService> {
        Arc::clone(&self.services.storage)
    }

    pub fn plugins(&self) -> Arc<crate::plugin::ExtensionHost> {
        Arc::clone(&self.services.plugins)
    }

    pub fn logging(&self) -> Arc<crate::logging::LoggingHandle> {
        Arc::clone(&self.services.logging)
    }

    pub fn credentials(&self) -> Arc<dyn crate::credentials::CredentialStore> {
        Arc::clone(&self.services.credentials)
    }

    pub fn providers(&self) -> Arc<yaqmc_provider_api::ProviderRegistry> {
        Arc::clone(&self.services.providers)
    }

    pub fn qq_music(&self) -> Arc<dyn yaqmc_provider_api::MusicProvider> {
        Arc::clone(&self.services.qq_music)
    }

    pub fn audio(&self) -> Arc<dyn crate::audio::AudioEngine> {
        Arc::clone(&self.services.audio)
    }

    pub fn player(&self) -> Arc<crate::player::PlayerService> {
        Arc::clone(&self.services.player)
    }

    pub fn continuation(&self) -> Arc<crate::continuation::ContinuationService> {
        Arc::clone(&self.services.continuation)
    }

    pub fn statistics(&self) -> Arc<crate::statistics::StatisticsService> {
        Arc::clone(&self.services.statistics)
    }

    pub fn local_api(&self) -> Arc<crate::local_api::LocalApiService> {
        Arc::clone(&self.services.local_api)
    }

    pub fn system_media(&self) -> Arc<crate::system_media::SystemMediaIntegration> {
        self.services
            .system_media
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .expect("start_system_media must run after the host subscribes to host commands")
    }

    pub fn start_system_media(&self) -> Arc<crate::system_media::SystemMediaIntegration> {
        self.services
            .start_system_media(self.host_command_publisher.clone())
    }
}

pub fn bootstrap(
    config: CoreConfig,
    inputs: CoreBootstrapInputs,
) -> Result<CoreHandle, CoreBootstrapError> {
    let (shutdown_state, _) = watch::channel(false);
    let host_command_publisher = HostCommandPublisher::default();
    let runtime = inputs.runtime.clone();
    let services = bootstrap::CoreServices::construct(&config, inputs)?;

    let handle = CoreHandle {
        config,
        host_command_publisher,
        shutdown_state,
        is_shutdown: AtomicBool::new(false),
        services: Arc::new(services),
    };
    fullscreen_watch::maybe_spawn_platform_watch(
        &runtime,
        handle.host_command_publisher.clone(),
        handle.subscribe_shutdown(),
    );
    Ok(handle)
}
