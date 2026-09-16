//! Core-owned lifecycle and persistence for local provider profiles.

use std::{collections::HashSet, fmt::Write as _, path::PathBuf, sync::Arc};

use rand::RngCore;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::Mutex;
use yaqmc_provider_api::{
    CredentialStore, MusicProvider, ProviderProfileKey, ProviderRegistry, DEFAULT_PROFILE_ID,
};
use yaqmc_provider_qqmusic::create_intree_provider_for_profile;

use crate::storage::StorageService;

pub const PROVIDER_PROFILE_CATALOG_SETTING_KEY: &str = "provider-profile-catalog";
pub const PROVIDER_PROFILE_CATALOG_VERSION: u32 = 1;
pub const MAX_PROVIDER_PROFILES: usize = 32;
pub const MAX_PROVIDER_PROFILE_CATALOG_BYTES: usize = 64 * 1024;
pub const MAX_PROVIDER_PROFILE_LABEL_BYTES: usize = 128;

const QQMUSIC_PROVIDER_ID: &str = "qqmusic";
const DEFAULT_QQMUSIC_LABEL: &str = "QQ Music";
const GENERATED_ID_ATTEMPTS: usize = 16;

/// Profile-level lifecycle data. Platform discovery remains represented by
/// `ProviderDescriptor`; this value never impersonates a platform provider.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderProfileDescriptor {
    pub provider_id: String,
    pub profile_id: String,
    pub label: String,
    pub enabled: bool,
}

impl ProviderProfileDescriptor {
    fn key(&self) -> ProviderProfileKey {
        ProviderProfileKey::new(&self.provider_id, &self.profile_id)
            .expect("catalog descriptors are validated before publication")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderProfileCatalogIssue {
    Oversize,
    Malformed,
    UnsupportedVersion,
    TooManyProfiles,
    DuplicateProfile,
    ForeignProvider,
    InvalidProfile,
    InvalidDefault,
    InvalidLabel,
}

impl std::fmt::Display for ProviderProfileCatalogIssue {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Oversize => "the provider profile catalog exceeds its size limit",
            Self::Malformed => "the provider profile catalog is malformed",
            Self::UnsupportedVersion => "the provider profile catalog version is unsupported",
            Self::TooManyProfiles => "the provider profile catalog exceeds its profile limit",
            Self::DuplicateProfile => "the provider profile catalog contains a duplicate profile",
            Self::ForeignProvider => "the provider profile catalog contains an unknown provider",
            Self::InvalidProfile => "the provider profile catalog contains an invalid profile",
            Self::InvalidDefault => "the provider profile catalog has no valid default profile",
            Self::InvalidLabel => "the provider profile catalog contains an invalid label",
        })
    }
}

#[derive(Debug, Error)]
pub enum ProviderProfileManagerError {
    #[error("provider profiles only support qqmusic in this release")]
    UnsupportedProvider,
    #[error("the provider profile label is invalid")]
    InvalidLabel,
    #[error("the default provider profile cannot be changed")]
    ProtectedDefault,
    #[error("the provider profile was not found")]
    NotFound,
    #[error("the provider profile catalog is full")]
    CatalogFull,
    #[error("the provider profile catalog could not be persisted")]
    Storage,
    #[error("the provider profile instance could not be created")]
    Provider,
    #[error("the provider profile registry transition failed")]
    Registry,
    #[error("the provider profile account cleanup failed: {0}")]
    Cleanup(String),
    #[error("the provider profile runtime is inconsistent")]
    InconsistentRuntime,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedProfileCatalog {
    version: u32,
    profiles: Vec<ProviderProfileDescriptor>,
}

pub struct ProviderProfileManager {
    storage: Arc<StorageService>,
    credentials: Arc<dyn CredentialStore>,
    registry: Arc<ProviderRegistry>,
    fixture_root: PathBuf,
    profiles: Mutex<Vec<ProviderProfileDescriptor>>,
    catalog_issue: Option<ProviderProfileCatalogIssue>,
}

impl ProviderProfileManager {
    pub(crate) fn open(
        storage: Arc<StorageService>,
        credentials: Arc<dyn CredentialStore>,
        registry: Arc<ProviderRegistry>,
        fixture_root: PathBuf,
        runtime: &tokio::runtime::Handle,
    ) -> Result<Self, ProviderProfileManagerError> {
        let raw = storage
            .get_setting(PROVIDER_PROFILE_CATALOG_SETTING_KEY)
            .map_err(|_| ProviderProfileManagerError::Storage)?;
        let (profiles, catalog_issue, repair) = match raw {
            None => (default_catalog(), None, true),
            Some(raw) => match decode_catalog(&raw) {
                Ok(profiles) => (profiles, None, false),
                Err(issue) => {
                    tracing::warn!(target: "provider.profiles", issue = %issue, "provider profile catalog failed closed");
                    (default_catalog(), Some(issue), true)
                }
            },
        };
        if repair {
            persist_catalog(storage.as_ref(), &profiles)?;
        }

        let enabled_profiles = profiles
            .iter()
            .filter(|profile| profile.enabled && profile.profile_id != DEFAULT_PROFILE_ID)
            .map(ProviderProfileDescriptor::key)
            .collect::<Vec<_>>();
        let manager = Self {
            storage,
            credentials,
            registry,
            fixture_root,
            profiles: Mutex::new(profiles),
            catalog_issue,
        };
        for key in enabled_profiles {
            let provider = manager.instantiate(&key)?;
            manager
                .registry
                .register_legacy_profile(Arc::clone(&provider))
                .map_err(|_| ProviderProfileManagerError::Registry)?;
            runtime.spawn(async move {
                provider.account().restore_session().await;
            });
        }
        Ok(manager)
    }

    pub fn catalog_issue(&self) -> Option<ProviderProfileCatalogIssue> {
        self.catalog_issue
    }

    pub async fn list(&self) -> Vec<ProviderProfileDescriptor> {
        self.profiles.lock().await.clone()
    }

    pub async fn create(
        &self,
        provider_id: &str,
        label: &str,
    ) -> Result<(ProviderProfileDescriptor, bool), ProviderProfileManagerError> {
        require_qqmusic(provider_id)?;
        let label = validate_label(label)?.to_owned();
        let mut profiles = self.profiles.lock().await;
        if profiles.len() >= MAX_PROVIDER_PROFILES {
            return Err(ProviderProfileManagerError::CatalogFull);
        }
        let profile_id = generate_profile_id(&profiles)?;
        let descriptor = ProviderProfileDescriptor {
            provider_id: QQMUSIC_PROVIDER_ID.to_owned(),
            profile_id,
            label,
            enabled: true,
        };
        let provider = self.instantiate(&descriptor.key())?;
        self.registry
            .register_legacy_profile(provider)
            .map_err(|_| ProviderProfileManagerError::Registry)?;

        let mut next = profiles.clone();
        next.push(descriptor.clone());
        sort_profiles(&mut next);
        if let Err(error) = persist_catalog(self.storage.as_ref(), &next) {
            let _ = self
                .registry
                .unregister_profile(&descriptor.provider_id, &descriptor.profile_id);
            return Err(error);
        }
        *profiles = next;
        Ok((descriptor, true))
    }

    pub async fn enable(
        &self,
        provider_id: &str,
        profile_id: &str,
    ) -> Result<(ProviderProfileDescriptor, bool), ProviderProfileManagerError> {
        let key = checked_mutation_key(provider_id, profile_id)?;
        let mut profiles = self.profiles.lock().await;
        let index = find_profile(&profiles, &key)?;
        if profiles[index].enabled
            && self
                .registry
                .capabilities_for_profile(provider_id, profile_id)
                .is_some()
        {
            return Ok((profiles[index].clone(), false));
        }

        let provider = self.instantiate(&key)?;
        // Lifecycle operations are intentionally serialized across this await.
        // QQ restore does not acquire the manager or registry lock, and no
        // partially restored instance becomes routable before it completes.
        provider.account().restore_session().await;
        self.registry
            .register_legacy_profile(provider)
            .map_err(|_| ProviderProfileManagerError::Registry)?;
        let mut next = profiles.clone();
        next[index].enabled = true;
        if let Err(error) = persist_catalog(self.storage.as_ref(), &next) {
            let _ = self.registry.unregister_profile(provider_id, profile_id);
            return Err(error);
        }
        *profiles = next;
        Ok((profiles[index].clone(), true))
    }

    pub async fn disable(
        &self,
        provider_id: &str,
        profile_id: &str,
    ) -> Result<(ProviderProfileDescriptor, bool), ProviderProfileManagerError> {
        let key = checked_mutation_key(provider_id, profile_id)?;
        let mut profiles = self.profiles.lock().await;
        let index = find_profile(&profiles, &key)?;
        if !profiles[index].enabled {
            return Ok((profiles[index].clone(), false));
        }
        let provider = self
            .registry
            .capabilities_for_profile(provider_id, profile_id)
            .and_then(|facade| facade.legacy_provider())
            .ok_or(ProviderProfileManagerError::InconsistentRuntime)?;
        self.registry
            .unregister_profile(provider_id, profile_id)
            .map_err(|_| ProviderProfileManagerError::Registry)?
            .ok_or(ProviderProfileManagerError::InconsistentRuntime)?;
        let mut next = profiles.clone();
        next[index].enabled = false;
        if let Err(error) = persist_catalog(self.storage.as_ref(), &next) {
            self.registry
                .register_legacy_profile(provider)
                .map_err(|_| ProviderProfileManagerError::InconsistentRuntime)?;
            return Err(error);
        }
        *profiles = next;
        Ok((profiles[index].clone(), true))
    }

    pub async fn delete(
        &self,
        provider_id: &str,
        profile_id: &str,
    ) -> Result<(ProviderProfileDescriptor, bool), ProviderProfileManagerError> {
        let key = checked_mutation_key(provider_id, profile_id)?;
        let mut profiles = self.profiles.lock().await;
        let index = find_profile(&profiles, &key)?;
        let descriptor = profiles[index].clone();
        let provider = if descriptor.enabled {
            self.registry
                .capabilities_for_profile(provider_id, profile_id)
                .and_then(|facade| facade.legacy_provider())
                .ok_or(ProviderProfileManagerError::InconsistentRuntime)?
        } else {
            self.instantiate(&key)?
        };
        // Remove the exact route before awaiting cleanup. New requests must
        // fail closed while credentials are being deleted; keep the provider
        // Arc so a failed cleanup/persist can restore the route as a guest.
        let route_removed = if descriptor.enabled {
            self.registry
                .unregister_profile(provider_id, profile_id)
                .map_err(|_| ProviderProfileManagerError::Registry)?
                .ok_or(ProviderProfileManagerError::InconsistentRuntime)?;
            true
        } else {
            false
        };

        if let Err(error) = provider.account().sign_out().await {
            if route_removed
                && self
                    .registry
                    .register_legacy_profile(Arc::clone(&provider))
                    .is_err()
            {
                return Err(ProviderProfileManagerError::InconsistentRuntime);
            }
            return Err(ProviderProfileManagerError::Cleanup(error.code));
        }

        let mut next = profiles.clone();
        next.remove(index);
        if let Err(error) = persist_catalog(self.storage.as_ref(), &next) {
            // Persistence failed, so the old catalog remains authoritative.
            // The account is nevertheless guest after successful cleanup; a
            // restored route is safe and keeps the catalog/runtime coherent.
            if route_removed
                && self
                    .registry
                    .register_legacy_profile(Arc::clone(&provider))
                    .is_err()
            {
                return Err(ProviderProfileManagerError::InconsistentRuntime);
            }
            return Err(error);
        }
        *profiles = next;
        Ok((descriptor, true))
    }

    fn instantiate(
        &self,
        key: &ProviderProfileKey,
    ) -> Result<Arc<dyn MusicProvider>, ProviderProfileManagerError> {
        create_intree_provider_for_profile(
            Arc::clone(&self.storage),
            Arc::clone(&self.credentials),
            self.fixture_root.clone(),
            key.clone(),
        )
        .map_err(|_| ProviderProfileManagerError::Provider)
    }
}

fn default_catalog() -> Vec<ProviderProfileDescriptor> {
    vec![ProviderProfileDescriptor {
        provider_id: QQMUSIC_PROVIDER_ID.to_owned(),
        profile_id: DEFAULT_PROFILE_ID.to_owned(),
        label: DEFAULT_QQMUSIC_LABEL.to_owned(),
        enabled: true,
    }]
}

fn decode_catalog(
    raw: &str,
) -> Result<Vec<ProviderProfileDescriptor>, ProviderProfileCatalogIssue> {
    if raw.len() > MAX_PROVIDER_PROFILE_CATALOG_BYTES {
        return Err(ProviderProfileCatalogIssue::Oversize);
    }
    let mut catalog: PersistedProfileCatalog =
        serde_json::from_str(raw).map_err(|_| ProviderProfileCatalogIssue::Malformed)?;
    if catalog.version != PROVIDER_PROFILE_CATALOG_VERSION {
        return Err(ProviderProfileCatalogIssue::UnsupportedVersion);
    }
    if catalog.profiles.len() > MAX_PROVIDER_PROFILES {
        return Err(ProviderProfileCatalogIssue::TooManyProfiles);
    }
    let mut keys = HashSet::with_capacity(catalog.profiles.len());
    let mut has_default = false;
    for descriptor in &catalog.profiles {
        if descriptor.provider_id != QQMUSIC_PROVIDER_ID {
            return Err(ProviderProfileCatalogIssue::ForeignProvider);
        }
        let key = ProviderProfileKey::new(&descriptor.provider_id, &descriptor.profile_id)
            .map_err(|_| ProviderProfileCatalogIssue::InvalidProfile)?;
        if !keys.insert(key) {
            return Err(ProviderProfileCatalogIssue::DuplicateProfile);
        }
        validate_label(&descriptor.label).map_err(|_| ProviderProfileCatalogIssue::InvalidLabel)?;
        if descriptor.profile_id == DEFAULT_PROFILE_ID {
            if !descriptor.enabled {
                return Err(ProviderProfileCatalogIssue::InvalidDefault);
            }
            has_default = true;
        }
    }
    if !has_default {
        return Err(ProviderProfileCatalogIssue::InvalidDefault);
    }
    sort_profiles(&mut catalog.profiles);
    Ok(catalog.profiles)
}

fn persist_catalog(
    storage: &StorageService,
    profiles: &[ProviderProfileDescriptor],
) -> Result<(), ProviderProfileManagerError> {
    let raw = serde_json::to_string(&PersistedProfileCatalog {
        version: PROVIDER_PROFILE_CATALOG_VERSION,
        profiles: profiles.to_vec(),
    })
    .map_err(|_| ProviderProfileManagerError::Storage)?;
    if raw.len() > MAX_PROVIDER_PROFILE_CATALOG_BYTES {
        return Err(ProviderProfileManagerError::CatalogFull);
    }
    storage
        .set_setting(PROVIDER_PROFILE_CATALOG_SETTING_KEY, &raw)
        .map_err(|_| ProviderProfileManagerError::Storage)
}

fn validate_label(label: &str) -> Result<&str, ProviderProfileManagerError> {
    let label = label.trim();
    if label.is_empty()
        || label.len() > MAX_PROVIDER_PROFILE_LABEL_BYTES
        || label.chars().any(char::is_control)
    {
        return Err(ProviderProfileManagerError::InvalidLabel);
    }
    Ok(label)
}

fn require_qqmusic(provider_id: &str) -> Result<(), ProviderProfileManagerError> {
    if provider_id == QQMUSIC_PROVIDER_ID {
        Ok(())
    } else {
        Err(ProviderProfileManagerError::UnsupportedProvider)
    }
}

fn checked_mutation_key(
    provider_id: &str,
    profile_id: &str,
) -> Result<ProviderProfileKey, ProviderProfileManagerError> {
    require_qqmusic(provider_id)?;
    let key = ProviderProfileKey::new(provider_id, profile_id)
        .map_err(|_| ProviderProfileManagerError::NotFound)?;
    if key.profile_id == DEFAULT_PROFILE_ID {
        return Err(ProviderProfileManagerError::ProtectedDefault);
    }
    Ok(key)
}

fn find_profile(
    profiles: &[ProviderProfileDescriptor],
    key: &ProviderProfileKey,
) -> Result<usize, ProviderProfileManagerError> {
    profiles
        .iter()
        .position(|profile| {
            profile.provider_id == key.provider_id && profile.profile_id == key.profile_id
        })
        .ok_or(ProviderProfileManagerError::NotFound)
}

fn generate_profile_id(
    profiles: &[ProviderProfileDescriptor],
) -> Result<String, ProviderProfileManagerError> {
    for _ in 0..GENERATED_ID_ATTEMPTS {
        let mut random = [0_u8; 16];
        rand::rng().fill_bytes(&mut random);
        let mut id = String::with_capacity(35);
        id.push_str("qq-");
        for byte in random {
            write!(&mut id, "{byte:02x}").expect("writing to a String cannot fail");
        }
        if !profiles.iter().any(|profile| profile.profile_id == id) {
            return Ok(id);
        }
    }
    Err(ProviderProfileManagerError::Provider)
}

fn sort_profiles(profiles: &mut [ProviderProfileDescriptor]) {
    profiles.sort_by(|left, right| {
        left.provider_id
            .cmp(&right.provider_id)
            .then_with(|| {
                (left.profile_id != DEFAULT_PROFILE_ID)
                    .cmp(&(right.profile_id != DEFAULT_PROFILE_ID))
            })
            .then_with(|| left.profile_id.cmp(&right.profile_id))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::MemoryCredentialStore;
    use serde_json::json;
    use std::{collections::HashMap, sync::Mutex as StdMutex};
    use yaqmc_provider_api::CredentialError;

    #[derive(Default)]
    struct DeleteFailingCredentialStore {
        values: StdMutex<HashMap<String, String>>,
    }

    impl CredentialStore for DeleteFailingCredentialStore {
        fn load(&self, account: &str) -> Result<Option<String>, CredentialError> {
            Ok(self.values.lock().expect("values").get(account).cloned())
        }

        fn save(&self, account: &str, secret: &str) -> Result<(), CredentialError> {
            self.values
                .lock()
                .expect("values")
                .insert(account.to_owned(), secret.to_owned());
            Ok(())
        }

        fn delete(&self, _account: &str) -> Result<(), CredentialError> {
            Err(CredentialError::OperationFailed)
        }
    }

    fn encoded(profiles: serde_json::Value) -> String {
        json!({"version": 1, "profiles": profiles}).to_string()
    }

    #[test]
    fn catalog_validation_rejects_corrupt_oversize_duplicate_and_foreign_inputs() {
        assert_eq!(
            decode_catalog("not-json"),
            Err(ProviderProfileCatalogIssue::Malformed)
        );
        assert_eq!(
            decode_catalog(&"x".repeat(MAX_PROVIDER_PROFILE_CATALOG_BYTES + 1)),
            Err(ProviderProfileCatalogIssue::Oversize)
        );
        let default = json!({
            "providerId": "qqmusic", "profileId": "default", "label": "QQ Music", "enabled": true
        });
        assert_eq!(
            decode_catalog(&encoded(json!([default.clone(), default]))),
            Err(ProviderProfileCatalogIssue::DuplicateProfile)
        );
        assert_eq!(
            decode_catalog(&encoded(json!([{
                "providerId": "spotify", "profileId": "default", "label": "Spotify", "enabled": true
            }]))),
            Err(ProviderProfileCatalogIssue::ForeignProvider)
        );
        assert_eq!(
            decode_catalog(&json!({"version": 99, "profiles": []}).to_string()),
            Err(ProviderProfileCatalogIssue::UnsupportedVersion)
        );
        assert_eq!(
            decode_catalog(&encoded(json!([{
                "providerId": "qqmusic", "profileId": "work", "label": "Work", "enabled": true
            }]))),
            Err(ProviderProfileCatalogIssue::InvalidDefault)
        );
    }

    #[test]
    fn catalog_sorting_is_stable_by_provider_and_profile_id() {
        let profiles = decode_catalog(&encoded(json!([
            {"providerId":"qqmusic","profileId":"zz","label":"Z","enabled":false},
            {"providerId":"qqmusic","profileId":"default","label":"QQ Music","enabled":true},
            {"providerId":"qqmusic","profileId":"aa","label":"A","enabled":true}
        ])))
        .expect("catalog");
        assert_eq!(
            profiles
                .iter()
                .map(|profile| profile.profile_id.as_str())
                .collect::<Vec<_>>(),
            vec!["default", "aa", "zz"]
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn first_run_persists_default_and_restart_restores_profiles() {
        let root = tempfile::tempdir().expect("root");
        let storage = Arc::new(
            StorageService::open(root.path().join("data"), root.path().join("cache"))
                .expect("storage"),
        );
        let credentials: Arc<dyn CredentialStore> = Arc::new(MemoryCredentialStore::default());
        let default = yaqmc_provider_qqmusic::create_intree_provider(
            Arc::clone(&storage),
            Arc::clone(&credentials),
            root.path().join("fixtures"),
        )
        .expect("default provider");
        let registry = Arc::new(ProviderRegistry::new("qqmusic", [default]).expect("registry"));
        let manager = ProviderProfileManager::open(
            Arc::clone(&storage),
            Arc::clone(&credentials),
            Arc::clone(&registry),
            root.path().join("fixtures"),
            &tokio::runtime::Handle::current(),
        )
        .expect("manager");
        assert_eq!(manager.list().await, default_catalog());
        assert!(storage
            .get_setting(PROVIDER_PROFILE_CATALOG_SETTING_KEY)
            .expect("setting")
            .is_some());
        let created = manager.create("qqmusic", "Work").await.expect("create").0;
        assert!(registry
            .capabilities_for_profile("qqmusic", &created.profile_id)
            .is_some());
        let snapshot = registry
            .capabilities_for_profile("qqmusic", &created.profile_id)
            .expect("profile facade")
            .account()
            .expect("account capability")
            .provider_account()
            .account_snapshot()
            .await;
        assert_eq!(snapshot.profile_id, created.profile_id);

        let default = yaqmc_provider_qqmusic::create_intree_provider(
            Arc::clone(&storage),
            Arc::clone(&credentials),
            root.path().join("fixtures"),
        )
        .expect("default provider");
        let restarted_registry =
            Arc::new(ProviderRegistry::new("qqmusic", [default]).expect("registry"));
        let restarted = ProviderProfileManager::open(
            storage,
            credentials,
            Arc::clone(&restarted_registry),
            root.path().join("fixtures"),
            &tokio::runtime::Handle::current(),
        )
        .expect("restart manager");
        assert_eq!(restarted.list().await.len(), 2);
        assert!(restarted_registry
            .capabilities_for_profile("qqmusic", &created.profile_id)
            .is_some());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn disable_enable_and_delete_are_profile_isolated() {
        let storage = Arc::new(StorageService::temporary());
        let credentials: Arc<dyn CredentialStore> = Arc::new(MemoryCredentialStore::default());
        let default = yaqmc_provider_qqmusic::create_intree_provider(
            Arc::clone(&storage),
            Arc::clone(&credentials),
            PathBuf::from("fixtures"),
        )
        .expect("default provider");
        let registry = Arc::new(ProviderRegistry::new("qqmusic", [default]).expect("registry"));
        let manager = ProviderProfileManager::open(
            storage,
            Arc::clone(&credentials),
            Arc::clone(&registry),
            PathBuf::from("fixtures"),
            &tokio::runtime::Handle::current(),
        )
        .expect("manager");
        let alpha = manager.create("qqmusic", "Alpha").await.expect("alpha").0;
        let beta = manager.create("qqmusic", "Beta").await.expect("beta").0;
        let alpha_credential = format!("qqmusic:credential:v3:{}", alpha.profile_id);
        credentials
            .save(&alpha_credential, "opaque-test-record")
            .expect("seed credential");

        manager
            .disable("qqmusic", &alpha.profile_id)
            .await
            .expect("disable");
        assert_eq!(
            credentials.load(&alpha_credential).expect("credential"),
            Some("opaque-test-record".to_owned())
        );
        assert!(registry
            .capabilities_for_profile("qqmusic", &alpha.profile_id)
            .is_none());
        assert!(registry
            .capabilities_for_profile("qqmusic", &beta.profile_id)
            .is_some());
        manager
            .enable("qqmusic", &alpha.profile_id)
            .await
            .expect("enable");
        manager
            .delete("qqmusic", &alpha.profile_id)
            .await
            .expect("delete");
        assert!(registry
            .capabilities_for_profile("qqmusic", &alpha.profile_id)
            .is_none());
        assert!(registry
            .capabilities_for_profile("qqmusic", &beta.profile_id)
            .is_some());
        assert!(registry.capabilities("qqmusic").is_some());
        assert!(matches!(
            manager.disable("qqmusic", DEFAULT_PROFILE_ID).await,
            Err(ProviderProfileManagerError::ProtectedDefault)
        ));
        assert!(matches!(
            manager.delete("qqmusic", DEFAULT_PROFILE_ID).await,
            Err(ProviderProfileManagerError::ProtectedDefault)
        ));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn corrupt_catalog_repairs_to_default_and_retains_observable_issue() {
        let storage = Arc::new(StorageService::temporary());
        storage
            .set_setting(PROVIDER_PROFILE_CATALOG_SETTING_KEY, "{corrupt")
            .expect("seed corrupt catalog");
        let credentials: Arc<dyn CredentialStore> = Arc::new(MemoryCredentialStore::default());
        let default = yaqmc_provider_qqmusic::create_intree_provider(
            Arc::clone(&storage),
            Arc::clone(&credentials),
            PathBuf::from("fixtures"),
        )
        .expect("default provider");
        let registry = Arc::new(ProviderRegistry::new("qqmusic", [default]).expect("registry"));
        let manager = ProviderProfileManager::open(
            Arc::clone(&storage),
            credentials,
            registry,
            PathBuf::from("fixtures"),
            &tokio::runtime::Handle::current(),
        )
        .expect("manager");

        assert_eq!(
            manager.catalog_issue(),
            Some(ProviderProfileCatalogIssue::Malformed)
        );
        assert_eq!(manager.list().await, default_catalog());
        let repaired = storage
            .get_setting(PROVIDER_PROFILE_CATALOG_SETTING_KEY)
            .expect("setting")
            .expect("repaired catalog");
        assert_eq!(
            decode_catalog(&repaired).expect("valid repair"),
            default_catalog()
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn delete_cleanup_failure_keeps_catalog_and_routes_unchanged() {
        let storage = Arc::new(StorageService::temporary());
        let credentials: Arc<dyn CredentialStore> =
            Arc::new(DeleteFailingCredentialStore::default());
        let default = yaqmc_provider_qqmusic::create_intree_provider(
            Arc::clone(&storage),
            Arc::clone(&credentials),
            PathBuf::from("fixtures"),
        )
        .expect("default provider");
        let registry = Arc::new(ProviderRegistry::new("qqmusic", [default]).expect("registry"));
        let manager = ProviderProfileManager::open(
            Arc::clone(&storage),
            credentials,
            Arc::clone(&registry),
            PathBuf::from("fixtures"),
            &tokio::runtime::Handle::current(),
        )
        .expect("manager");
        let created = manager.create("qqmusic", "Work").await.expect("create").0;
        let before = storage
            .get_setting(PROVIDER_PROFILE_CATALOG_SETTING_KEY)
            .expect("setting");

        assert!(matches!(
            manager.delete("qqmusic", &created.profile_id).await,
            Err(ProviderProfileManagerError::Cleanup(_))
        ));
        assert_eq!(
            storage
                .get_setting(PROVIDER_PROFILE_CATALOG_SETTING_KEY)
                .expect("setting"),
            before
        );
        assert!(manager
            .list()
            .await
            .iter()
            .any(|profile| profile.profile_id == created.profile_id));
        assert!(registry
            .capabilities_for_profile("qqmusic", &created.profile_id)
            .is_some());
    }
}
