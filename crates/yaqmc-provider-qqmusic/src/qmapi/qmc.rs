//! QMC comparison adapter for the pinned library's QMCDecode implementation.
//! Synthetic Map/RC4 vectors must match in-tree playback before a real-file
//! golden authorizes production replacement.

use std::{fmt, io};

use qqmusic_api::qmc::{ekey_decrypt, Qmc2Map, Qmc2Rc4};
use yaqmc_provider_api::MediaDecryptor;

use crate::qmc::EncryptedMediaKey;

enum QmapiCipher {
    Map(Qmc2Map),
    Rc4(Qmc2Rc4),
}

pub(crate) struct QmapiQmcDecryptor {
    cipher: QmapiCipher,
    derived_key_length: usize,
}

impl QmapiQmcDecryptor {
    pub(crate) fn new(ekey: &EncryptedMediaKey) -> Result<Self, qqmusic_api::QmError> {
        let key = ekey_decrypt(ekey.expose())?;
        let derived_key_length = key.len();
        let cipher = if (1..=300).contains(&key.len()) {
            QmapiCipher::Map(Qmc2Map::new(&key)?)
        } else {
            QmapiCipher::Rc4(Qmc2Rc4::new(&key)?)
        };
        Ok(Self {
            cipher,
            derived_key_length,
        })
    }

    pub(crate) fn cipher_kind(&self) -> &'static str {
        match self.cipher {
            QmapiCipher::Map(_) => "map",
            QmapiCipher::Rc4(_) => "rc4",
        }
    }

    pub(crate) fn derived_key_length(&self) -> usize {
        self.derived_key_length
    }
}

impl fmt::Debug for QmapiQmcDecryptor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("QmapiQmcDecryptor([REDACTED])")
    }
}

impl MediaDecryptor for QmapiQmcDecryptor {
    fn decrypt(&self, data: &mut [u8], offset: u64) -> io::Result<()> {
        let offset = usize::try_from(offset)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "QMC offset is too large"))?;
        let plain = match &self.cipher {
            QmapiCipher::Map(cipher) => cipher.decrypt(data, offset),
            QmapiCipher::Rc4(cipher) => cipher.decrypt(data, offset),
        };
        data.copy_from_slice(&plain);
        Ok(())
    }

    fn cipher_kind(&self) -> &'static str {
        QmapiQmcDecryptor::cipher_kind(self)
    }

    fn derived_key_length(&self) -> usize {
        QmapiQmcDecryptor::derived_key_length(self)
    }
}
