//! Local API surface for reduced (for example Android) Core builds.

use crate::credentials::{CredentialError, CredentialStore};
use crate::player::PlayerService;
use serde::Serialize;
use std::sync::Arc;
use thiserror::Error;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LocalApiRunState {
    Disabled,
    Starting,
    Running,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalApiStatus {
    pub enabled: bool,
    pub state: LocalApiRunState,
    pub host: &'static str,
    pub configured_port: u16,
    pub bound_port: Option<u16>,
    pub token_configured: bool,
    pub token_state: LocalApiTokenState,
    pub last_error: Option<String>,
}

/// Mirrors the real service: this build cannot read secure token storage, so the
/// API is treated as fail-closed rather than as the user disabling the token.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LocalApiTokenState {
    Configured,
    ExplicitlyDisabled,
    Unavailable,
}

#[derive(Debug, Error)]
pub enum LocalApiError {
    #[error("local API is unavailable in this Core build")]
    Unavailable,
    #[error("secure credential storage is unavailable")]
    Credentials(#[from] CredentialError),
}

pub struct LocalApiService;

impl LocalApiService {
    pub fn new(
        _config_path: std::path::PathBuf,
        _player: Arc<PlayerService>,
        _credentials: Arc<dyn CredentialStore>,
    ) -> Result<Arc<Self>, LocalApiError> {
        Ok(Arc::new(Self))
    }

    pub async fn start_if_enabled(&self) -> Result<LocalApiStatus, LocalApiError> {
        Err(LocalApiError::Unavailable)
    }

    pub async fn status(&self) -> LocalApiStatus {
        LocalApiStatus {
            enabled: false,
            state: LocalApiRunState::Disabled,
            host: "127.0.0.1",
            configured_port: 19_532,
            bound_port: None,
            token_configured: false,
            token_state: LocalApiTokenState::Unavailable,
            last_error: Some("local API is unavailable in this Core build".to_owned()),
        }
    }

    pub async fn set_enabled(&self, _enabled: bool) -> Result<LocalApiStatus, LocalApiError> {
        Err(LocalApiError::Unavailable)
    }

    pub async fn set_port(&self, _port: u16) -> Result<LocalApiStatus, LocalApiError> {
        Err(LocalApiError::Unavailable)
    }

    pub async fn set_token(&self, _token: String) -> Result<LocalApiStatus, LocalApiError> {
        Err(LocalApiError::Unavailable)
    }

    pub async fn reveal_token(&self) -> String {
        String::new()
    }

    pub async fn regenerate_token(&self) -> Result<LocalApiStatus, LocalApiError> {
        Err(LocalApiError::Unavailable)
    }
}
