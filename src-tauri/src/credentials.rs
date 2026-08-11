use std::sync::Arc;
#[cfg(test)]
use std::{collections::HashMap, sync::Mutex};
use thiserror::Error;

const SERVICE_NAME: &str = "org.yaqmc.desktop";
const LEGACY_SERVICE_NAME: &str = "dev.music-client.desktop";

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

pub struct PlatformCredentialStore;

impl PlatformCredentialStore {
    pub fn new() -> Self {
        Self
    }

    fn entry(account: &str) -> Result<keyring::Entry, CredentialError> {
        keyring::Entry::new(SERVICE_NAME, account).map_err(|_| CredentialError::Unavailable)
    }

    fn legacy_entry(account: &str) -> Result<keyring::Entry, CredentialError> {
        keyring::Entry::new(LEGACY_SERVICE_NAME, account).map_err(|_| CredentialError::Unavailable)
    }
}

impl CredentialStore for PlatformCredentialStore {
    fn load(&self, account: &str) -> Result<Option<String>, CredentialError> {
        match Self::entry(account)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => match Self::legacy_entry(account)?.get_password() {
                Ok(secret) => {
                    Self::entry(account)?
                        .set_password(&secret)
                        .map_err(|_| CredentialError::OperationFailed)?;
                    let _ = Self::legacy_entry(account)?.delete_credential();
                    Ok(Some(secret))
                }
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err(CredentialError::OperationFailed),
            },
            Err(_) => Err(CredentialError::OperationFailed),
        }
    }

    fn save(&self, account: &str, secret: &str) -> Result<(), CredentialError> {
        Self::entry(account)?
            .set_password(secret)
            .map_err(|_| CredentialError::OperationFailed)
    }

    fn delete(&self, account: &str) -> Result<(), CredentialError> {
        let result = match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(CredentialError::OperationFailed),
        };
        let _ = Self::legacy_entry(account)?.delete_credential();
        result
    }
}

#[cfg(test)]
#[derive(Default)]
pub struct MemoryCredentialStore {
    secrets: Mutex<HashMap<String, String>>,
}

#[cfg(test)]
impl CredentialStore for MemoryCredentialStore {
    fn load(&self, account: &str) -> Result<Option<String>, CredentialError> {
        Ok(self
            .secrets
            .lock()
            .expect("credential lock")
            .get(account)
            .cloned())
    }

    fn save(&self, account: &str, secret: &str) -> Result<(), CredentialError> {
        self.secrets
            .lock()
            .expect("credential lock")
            .insert(account.to_owned(), secret.to_owned());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), CredentialError> {
        self.secrets
            .lock()
            .expect("credential lock")
            .remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    struct BlockingTestStore {
        entered: Arc<Barrier>,
        release: Arc<Barrier>,
    }

    struct PanickingTestStore;

    impl CredentialStore for BlockingTestStore {
        fn load(&self, _account: &str) -> Result<Option<String>, CredentialError> {
            self.entered.wait();
            self.release.wait();
            Ok(None)
        }

        fn save(&self, _account: &str, _secret: &str) -> Result<(), CredentialError> {
            Ok(())
        }

        fn delete(&self, _account: &str) -> Result<(), CredentialError> {
            Ok(())
        }
    }

    impl CredentialStore for PanickingTestStore {
        fn load(&self, _account: &str) -> Result<Option<String>, CredentialError> {
            panic!("credential worker panic")
        }

        fn save(&self, _account: &str, _secret: &str) -> Result<(), CredentialError> {
            Ok(())
        }

        fn delete(&self, _account: &str) -> Result<(), CredentialError> {
            Ok(())
        }
    }

    #[test]
    fn credential_contract_round_trips_without_plaintext_files() {
        let store = MemoryCredentialStore::default();
        assert_eq!(store.load("qqmusic").expect("load"), None);
        store.save("qqmusic", "session").expect("save");
        assert_eq!(
            store.load("qqmusic").expect("load"),
            Some("session".to_owned())
        );
        store.delete("qqmusic").expect("delete");
        assert_eq!(store.load("qqmusic").expect("load"), None);
    }

    #[tokio::test]
    async fn async_store_round_trips_through_the_blocking_adapter() {
        let backend: Arc<dyn CredentialStore> = Arc::new(MemoryCredentialStore::default());
        let store = SpawnBlockingCredentialStore::new(backend);

        assert_eq!(store.load("qqmusic-staging").await.expect("load"), None);
        store
            .save("qqmusic-staging", "session")
            .await
            .expect("save");
        assert_eq!(
            store.load("qqmusic-staging").await.expect("load"),
            Some("session".to_owned())
        );
        assert_eq!(
            store.load("qqmusic-session").await.expect("active load"),
            None
        );
        store.delete("qqmusic-staging").await.expect("delete");
        assert_eq!(store.load("qqmusic-staging").await.expect("load"), None);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn blocking_backend_does_not_stall_the_async_executor() {
        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let backend: Arc<dyn CredentialStore> = Arc::new(BlockingTestStore {
            entered: Arc::clone(&entered),
            release: Arc::clone(&release),
        });
        let store = SpawnBlockingCredentialStore::new(backend);
        let load = tokio::spawn(async move { store.load("qqmusic-session").await });

        tokio::task::spawn_blocking(move || entered.wait())
            .await
            .expect("barrier joins");
        tokio::time::timeout(
            std::time::Duration::from_millis(50),
            tokio::task::yield_now(),
        )
        .await
        .expect("executor remains responsive");
        tokio::task::spawn_blocking(move || release.wait())
            .await
            .expect("release joins");

        assert_eq!(load.await.expect("load joins").expect("load"), None);
    }

    #[tokio::test]
    async fn blocking_worker_failure_is_sanitized() {
        let backend: Arc<dyn CredentialStore> = Arc::new(PanickingTestStore);
        let store = SpawnBlockingCredentialStore::new(backend);

        let error = store
            .load("qqmusic-session")
            .await
            .expect_err("worker panic must fail");
        assert!(matches!(error, CredentialError::JoinFailed));
        assert_eq!(error.to_string(), "the secure credential worker failed");
    }
}
