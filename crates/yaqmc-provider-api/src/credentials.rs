//! Secret-store boundary supplied by the host Core.

use std::sync::Arc;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CredentialError {
    #[error("the platform secure credential store is unavailable")]
    Unavailable,
    #[error("the secure credential operation failed")]
    OperationFailed,
    #[error("the secure credential worker failed")]
    JoinFailed,
}

pub trait CredentialStore: Send + Sync {
    fn load(&self, account: &str) -> Result<Option<String>, CredentialError>;
    fn save(&self, account: &str, secret: &str) -> Result<(), CredentialError>;
    fn delete(&self, account: &str) -> Result<(), CredentialError>;
}

#[derive(Clone)]
pub struct SpawnBlockingCredentialStore {
    inner: Arc<dyn CredentialStore>,
}

impl SpawnBlockingCredentialStore {
    pub fn new(inner: Arc<dyn CredentialStore>) -> Self {
        Self { inner }
    }

    /// Shared host backend (`PlatformCredentialStore`, file sandbox, or memory).
    pub fn inner(&self) -> Arc<dyn CredentialStore> {
        Arc::clone(&self.inner)
    }

    pub async fn load(&self, account: &str) -> Result<Option<String>, CredentialError> {
        let inner = Arc::clone(&self.inner);
        let account = account.to_owned();
        tokio::task::spawn_blocking(move || inner.load(&account))
            .await
            .map_err(|_| CredentialError::JoinFailed)?
    }

    pub async fn save(&self, account: &str, secret: &str) -> Result<(), CredentialError> {
        let inner = Arc::clone(&self.inner);
        let account = account.to_owned();
        let secret = secret.to_owned();
        tokio::task::spawn_blocking(move || inner.save(&account, &secret))
            .await
            .map_err(|_| CredentialError::JoinFailed)?
    }

    pub async fn delete(&self, account: &str) -> Result<(), CredentialError> {
        let inner = Arc::clone(&self.inner);
        let account = account.to_owned();
        tokio::task::spawn_blocking(move || inner.delete(&account))
            .await
            .map_err(|_| CredentialError::JoinFailed)?
    }
}
