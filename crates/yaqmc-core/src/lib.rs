//! Host-neutral ownership seams for the YAQMC application core.

pub mod app_preferences;
pub mod credentials;
pub mod diagnostics;
pub mod issue_reporter;
pub mod logging;
pub mod platform;
pub mod plugin;
pub mod storage;

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
    host_command_sender: broadcast::Sender<HostCommand>,
    shutdown_state: watch::Sender<bool>,
    is_shutdown: AtomicBool,
}

impl CoreHandle {
    pub fn config(&self) -> &CoreConfig {
        &self.config
    }

    pub fn subscribe_host_commands(&self) -> broadcast::Receiver<HostCommand> {
        self.host_command_sender.subscribe()
    }

    pub fn subscribe_shutdown(&self) -> watch::Receiver<bool> {
        self.shutdown_state.subscribe()
    }

    pub fn request_host_control(
        &self,
        command: HostCommand,
    ) -> Result<(), HostCommandRequestError> {
        self.host_command_sender
            .send(command)
            .map(|_| ())
            .map_err(|_| HostCommandRequestError::NoSubscribers)
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
    let (host_command_sender, _) = broadcast::channel(HOST_COMMAND_CHANNEL_CAPACITY);
    let (shutdown_state, _) = watch::channel(false);

    Ok(CoreHandle {
        config,
        host_command_sender,
        shutdown_state,
        is_shutdown: AtomicBool::new(false),
    })
}
