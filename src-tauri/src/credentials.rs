#[cfg(test)]
use std::sync::Mutex;
use thiserror::Error;

const SERVICE_NAME: &str = "org.yaqmc.desktop";
const LEGACY_SERVICE_NAME: &str = "dev.music-client.desktop";

#[derive(Debug, Error)]
pub enum CredentialError {
    #[error("the platform secure credential store is unavailable")]
    Unavailable,
    #[error("the secure credential operation failed")]
    OperationFailed,
}

pub trait CredentialStore: Send + Sync {
    fn load(&self, account: &str) -> Result<Option<String>, CredentialError>;
    fn save(&self, account: &str, secret: &str) -> Result<(), CredentialError>;
    fn delete(&self, account: &str) -> Result<(), CredentialError>;
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
    secret: Mutex<Option<String>>,
}

#[cfg(test)]
impl CredentialStore for MemoryCredentialStore {
    fn load(&self, _account: &str) -> Result<Option<String>, CredentialError> {
        Ok(self.secret.lock().expect("credential lock").clone())
    }

    fn save(&self, _account: &str, secret: &str) -> Result<(), CredentialError> {
        *self.secret.lock().expect("credential lock") = Some(secret.to_owned());
        Ok(())
    }

    fn delete(&self, _account: &str) -> Result<(), CredentialError> {
        *self.secret.lock().expect("credential lock") = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
