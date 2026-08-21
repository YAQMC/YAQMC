// QMC media-key validation and production decryption through the pinned
// library adapter. The former in-tree Map/RC4/TEA implementation was retired
// at the P14-C cutover; its synthetic and real-file evidence is archived in
// docs/migration/p14b-live-verify.md.

use std::{fmt, sync::Arc};
use thiserror::Error;
use yaqmc_provider_api::{EncryptedMedia, MediaDecryptor, PlaybackSourceError};
use zeroize::Zeroizing;

#[derive(Clone)]
pub struct EncryptedMediaKey(Zeroizing<String>);

impl EncryptedMediaKey {
    pub fn new(value: String) -> Result<Self, QmcError> {
        let value = value.trim();
        if value.is_empty() || value.len() > 16 * 1_024 {
            return Err(QmcError::InvalidKey);
        }
        Ok(Self(Zeroizing::new(value.to_owned())))
    }

    pub(crate) fn expose(&self) -> &str {
        self.0.as_str()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn is_v2(&self) -> bool {
        self.0.as_str().starts_with("QQMusic EncV2,Key:")
    }
}

impl fmt::Debug for EncryptedMediaKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("EncryptedMediaKey([REDACTED])")
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum QmcError {
    #[error("the encrypted media key is invalid")]
    InvalidKey,
}

impl EncryptedMedia for EncryptedMediaKey {
    fn key_len(&self) -> usize {
        self.len()
    }

    fn key_is_v2(&self) -> bool {
        self.is_v2()
    }

    fn create_decryptor(&self) -> Result<Arc<dyn MediaDecryptor>, PlaybackSourceError> {
        crate::qmapi::qmc::QmapiQmcDecryptor::new(self)
            .map(|decryptor| Arc::new(decryptor) as Arc<dyn MediaDecryptor>)
            .map_err(|_| PlaybackSourceError::DecryptionFailed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_keys_are_rejected_without_exposing_the_value() {
        assert_eq!(
            EncryptedMediaKey::new("  ".to_owned()).expect_err("empty key"),
            QmcError::InvalidKey
        );
        let key = EncryptedMediaKey::new("not-secret".to_owned()).expect("bounded key");
        assert_eq!(format!("{key:?}"), "EncryptedMediaKey([REDACTED])");
    }
}
