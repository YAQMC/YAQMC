//! Host-neutral ownership seams for the YAQMC application core.

pub mod app_preferences;
pub mod audio;
pub mod credentials;
pub mod diagnostics;
pub mod issue_reporter;
pub mod local_api;
pub mod logging;
pub mod media;
pub mod platform;
pub mod playback_session;
pub mod playback_types;
pub mod player;
pub mod plugin;
pub mod qmc;
pub mod qqmusic;
pub mod storage;
pub mod streaming;
pub mod system_media;

#[cfg(test)]
mod system_media_runtime_tests;

use std::sync::atomic::{AtomicBool, Ordering};
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CoreBootstrapError {}

impl fmt::Display for CoreBootstrapError {
    fn fmt(&self, _formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match *self {}
    }
}

impl Error for CoreBootstrapError {}

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
            self.shutdown_state.send_replace(true);
        }
    }
}

pub fn bootstrap(config: CoreConfig) -> Result<CoreHandle, CoreBootstrapError> {
    let (shutdown_state, _) = watch::channel(false);

    Ok(CoreHandle {
        config,
        host_command_publisher: HostCommandPublisher::default(),
        shutdown_state,
        is_shutdown: AtomicBool::new(false),
    })
}
