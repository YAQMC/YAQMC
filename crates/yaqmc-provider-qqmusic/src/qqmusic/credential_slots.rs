//! Profile-bound secure-store slots for QQ Music authentication state.
//!
//! The auth and qmapi layers retain their logical legacy names.  This adapter
//! is the only place that maps them to physical credential-store slots, so a
//! service instance cannot accidentally cross a provider/profile boundary.

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use subtle::ConstantTimeEq;
use yaqmc_provider_api::{
    CredentialError, CredentialStore, ProviderProfileKey, DEFAULT_PROFILE_ID,
};

const ACTIVE_LOGICAL_SLOT: &str = "qqmusic-session";
const STAGING_LOGICAL_SLOT: &str = "qqmusic-session-staging";
const CREDENTIAL_LOGICAL_SLOT: &str = "qqmusic-credential-v2";
const SLOT_ENVELOPE_VERSION: u8 = 3;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct QQMusicCredentialSlots {
    profile: ProviderProfileKey,
    active: String,
    staging: String,
    credential: String,
}

impl QQMusicCredentialSlots {
    pub(crate) fn new(profile: ProviderProfileKey) -> Result<Self, CredentialError> {
        let profile = ProviderProfileKey::new(&profile.provider_id, &profile.profile_id)
            .map_err(|_| CredentialError::OperationFailed)?;
        if profile.provider_id != "qqmusic" {
            return Err(CredentialError::OperationFailed);
        }
        let profile_id = profile.profile_id.clone();
        Ok(Self {
            profile,
            active: format!("qqmusic:session:v3:{profile_id}:active"),
            staging: format!("qqmusic:session:v3:{profile_id}:staging"),
            credential: format!("qqmusic:credential:v3:{profile_id}"),
        })
    }

    #[cfg(test)]
    pub(crate) fn active(&self) -> &str {
        &self.active
    }

    #[cfg(test)]
    pub(crate) fn staging(&self) -> &str {
        &self.staging
    }

    #[cfg(test)]
    pub(crate) fn credential(&self) -> &str {
        &self.credential
    }

    fn physical(&self, logical: &str) -> Result<&str, CredentialError> {
        match logical {
            ACTIVE_LOGICAL_SLOT => Ok(&self.active),
            STAGING_LOGICAL_SLOT => Ok(&self.staging),
            CREDENTIAL_LOGICAL_SLOT => Ok(&self.credential),
            _ => Err(CredentialError::OperationFailed),
        }
    }

    fn permits_legacy_migration(&self) -> bool {
        self.profile.profile_id == DEFAULT_PROFILE_ID
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SlotEnvelope {
    version: u8,
    provider_profile: ProviderProfileKey,
    payload: String,
}

/// Maps the three QQ Music credential records to a verified profile scope.
///
/// Only `default` reads the pre-profile records.  Migrating a legacy record is
/// deliberately write/readback/delete: a failed new-slot write leaves the old
/// record intact, while a legacy delete failure cannot invalidate the verified
/// v3 copy.
pub(crate) struct ProfileCredentialStore {
    inner: Arc<dyn CredentialStore>,
    slots: QQMusicCredentialSlots,
}

impl ProfileCredentialStore {
    pub(crate) fn new(inner: Arc<dyn CredentialStore>, slots: QQMusicCredentialSlots) -> Self {
        Self { inner, slots }
    }

    fn encode(&self, payload: &str) -> Result<String, CredentialError> {
        serde_json::to_string(&SlotEnvelope {
            version: SLOT_ENVELOPE_VERSION,
            provider_profile: self.slots.profile.clone(),
            payload: payload.to_owned(),
        })
        .map_err(|_| CredentialError::OperationFailed)
    }

    fn decode(&self, raw: &str) -> Result<String, CredentialError> {
        let envelope: SlotEnvelope =
            serde_json::from_str(raw).map_err(|_| CredentialError::OperationFailed)?;
        if envelope.version != SLOT_ENVELOPE_VERSION
            || envelope.provider_profile != self.slots.profile
        {
            return Err(CredentialError::OperationFailed);
        }
        Ok(envelope.payload)
    }

    fn migrate_legacy(
        &self,
        logical: &str,
        physical: &str,
        legacy_payload: String,
    ) -> Result<Option<String>, CredentialError> {
        let encoded = self.encode(&legacy_payload)?;
        self.inner.save(physical, &encoded)?;
        let readback = self
            .inner
            .load(physical)?
            .ok_or(CredentialError::OperationFailed)?;
        let restored = self.decode(&readback)?;
        if !bool::from(restored.as_bytes().ct_eq(legacy_payload.as_bytes())) {
            return Err(CredentialError::OperationFailed);
        }
        // This is intentionally best effort.  A verified scoped record is
        // authoritative even when the old global record cannot be removed.
        let _ = self.inner.delete(logical);
        Ok(Some(restored))
    }
}

impl CredentialStore for ProfileCredentialStore {
    fn load(&self, account: &str) -> Result<Option<String>, CredentialError> {
        let physical = self.slots.physical(account)?;
        if let Some(raw) = self.inner.load(physical)? {
            return self.decode(&raw).map(Some);
        }
        if !self.slots.permits_legacy_migration() {
            return Ok(None);
        }
        match self.inner.load(account)? {
            Some(legacy_payload) => self.migrate_legacy(account, physical, legacy_payload),
            None => Ok(None),
        }
    }

    fn save(&self, account: &str, secret: &str) -> Result<(), CredentialError> {
        let physical = self.slots.physical(account)?;
        self.inner.save(physical, &self.encode(secret)?)
    }

    fn delete(&self, account: &str) -> Result<(), CredentialError> {
        let physical = self.slots.physical(account)?;
        self.inner.delete(physical)?;
        if self.slots.permits_legacy_migration() {
            self.inner.delete(account)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryStore(Mutex<HashMap<String, String>>);

    impl CredentialStore for MemoryStore {
        fn load(&self, account: &str) -> Result<Option<String>, CredentialError> {
            Ok(self.0.lock().expect("memory store").get(account).cloned())
        }
        fn save(&self, account: &str, secret: &str) -> Result<(), CredentialError> {
            self.0
                .lock()
                .expect("memory store")
                .insert(account.into(), secret.into());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), CredentialError> {
            self.0.lock().expect("memory store").remove(account);
            Ok(())
        }
    }

    fn slots(profile: &str) -> QQMusicCredentialSlots {
        QQMusicCredentialSlots::new(ProviderProfileKey::new("qqmusic", profile).expect("profile"))
            .expect("QQ Music slots")
    }

    #[test]
    fn slots_are_fixed_and_profile_is_validated_before_use() {
        let slots = slots("alpha_1");
        assert_eq!(slots.active(), "qqmusic:session:v3:alpha_1:active");
        assert_eq!(slots.staging(), "qqmusic:session:v3:alpha_1:staging");
        assert_eq!(slots.credential(), "qqmusic:credential:v3:alpha_1");
        assert!(ProviderProfileKey::new("qqmusic", "bad profile").is_err());
        assert!(QQMusicCredentialSlots::new(
            ProviderProfileKey::new("other", "default").expect("valid foreign key")
        )
        .is_err());
        let malformed = ProviderProfileKey {
            provider_id: "qqmusic".to_owned(),
            profile_id: "Invalid Profile".to_owned(),
        };
        assert!(QQMusicCredentialSlots::new(malformed).is_err());
    }

    #[test]
    fn default_migrates_legacy_only_after_scoped_readback() {
        let inner = Arc::new(MemoryStore::default());
        inner
            .save(ACTIVE_LOGICAL_SLOT, "legacy")
            .expect("seed legacy");
        let scoped = ProfileCredentialStore::new(inner.clone(), slots("default"));
        assert_eq!(
            scoped.load(ACTIVE_LOGICAL_SLOT).expect("migrate"),
            Some("legacy".into())
        );
        assert!(inner.load(ACTIVE_LOGICAL_SLOT).expect("legacy").is_none());
        assert!(inner
            .load("qqmusic:session:v3:default:active")
            .expect("scoped")
            .is_some());
    }

    #[test]
    fn non_default_never_reads_legacy_and_profiles_are_isolated() {
        let inner = Arc::new(MemoryStore::default());
        inner
            .save(CREDENTIAL_LOGICAL_SLOT, "legacy")
            .expect("seed legacy");
        let alpha = ProfileCredentialStore::new(inner.clone(), slots("alpha"));
        let beta = ProfileCredentialStore::new(inner.clone(), slots("beta"));
        assert_eq!(alpha.load(CREDENTIAL_LOGICAL_SLOT).expect("load"), None);
        alpha
            .save(CREDENTIAL_LOGICAL_SLOT, "alpha-secret")
            .expect("save alpha");
        beta.save(CREDENTIAL_LOGICAL_SLOT, "beta-secret")
            .expect("save beta");
        assert_eq!(
            alpha.load(CREDENTIAL_LOGICAL_SLOT).expect("load alpha"),
            Some("alpha-secret".into())
        );
        assert_eq!(
            beta.load(CREDENTIAL_LOGICAL_SLOT).expect("load beta"),
            Some("beta-secret".into())
        );
        assert_eq!(
            inner.load(CREDENTIAL_LOGICAL_SLOT).expect("legacy"),
            Some("legacy".into())
        );
    }

    #[test]
    fn scope_mismatch_fails_closed_without_using_legacy() {
        let inner = Arc::new(MemoryStore::default());
        let alpha = ProfileCredentialStore::new(inner.clone(), slots("alpha"));
        alpha
            .save(ACTIVE_LOGICAL_SLOT, "alpha-secret")
            .expect("save alpha");
        let beta = ProfileCredentialStore::new(inner, slots("beta"));
        // A copied v3 envelope remains tied to alpha and cannot be decoded by beta.
        let copied = beta
            .inner
            .load("qqmusic:session:v3:alpha:active")
            .expect("copied")
            .expect("present");
        beta.inner
            .save("qqmusic:session:v3:beta:active", &copied)
            .expect("inject mismatch");
        assert!(beta.load(ACTIVE_LOGICAL_SLOT).is_err());
    }

    #[test]
    fn failed_default_migration_keeps_legacy_and_never_touches_another_profile() {
        struct FailingScopedWrite {
            entries: Mutex<HashMap<String, String>>,
        }

        impl CredentialStore for FailingScopedWrite {
            fn load(&self, account: &str) -> Result<Option<String>, CredentialError> {
                Ok(self
                    .entries
                    .lock()
                    .expect("fault store")
                    .get(account)
                    .cloned())
            }

            fn save(&self, account: &str, secret: &str) -> Result<(), CredentialError> {
                if account == "qqmusic:session:v3:default:active" {
                    return Err(CredentialError::OperationFailed);
                }
                self.entries
                    .lock()
                    .expect("fault store")
                    .insert(account.into(), secret.into());
                Ok(())
            }

            fn delete(&self, account: &str) -> Result<(), CredentialError> {
                self.entries.lock().expect("fault store").remove(account);
                Ok(())
            }
        }

        let inner = Arc::new(FailingScopedWrite {
            entries: Mutex::new(HashMap::from([
                (ACTIVE_LOGICAL_SLOT.to_owned(), "legacy".to_owned()),
                (
                    "qqmusic:session:v3:beta:active".to_owned(),
                    "beta-record".to_owned(),
                ),
            ])),
        });
        let default = ProfileCredentialStore::new(inner.clone(), slots("default"));
        assert!(default.load(ACTIVE_LOGICAL_SLOT).is_err());
        assert_eq!(
            inner.load(ACTIVE_LOGICAL_SLOT).expect("legacy remains"),
            Some("legacy".into())
        );
        assert_eq!(
            inner
                .load("qqmusic:session:v3:beta:active")
                .expect("other profile remains"),
            Some("beta-record".into())
        );
    }
}
