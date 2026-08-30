//! Executes the distributable API v3 Provider Component fixture through the
//! real package inspector, ExtensionHost lifecycle, and dynamic registry.

use std::{path::PathBuf, sync::Arc};

use yaqmc_core::{
    credentials::{CredentialError, CredentialStore},
    plugin::{ExtensionHost, PluginStatus},
    storage::StorageService,
};
use yaqmc_provider_api::{CatalogSearchKind, ProviderRegistry, SearchResult};

struct TestCredentials;

impl CredentialStore for TestCredentials {
    fn load(&self, _account: &str) -> Result<Option<String>, CredentialError> {
        Ok(None)
    }

    fn save(&self, _account: &str, _secret: &str) -> Result<(), CredentialError> {
        Ok(())
    }

    fn delete(&self, _account: &str) -> Result<(), CredentialError> {
        Ok(())
    }
}

fn example_package() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/plugins/packages/dev.yaqmc.example.catalog-1.0.0.yaqmc-plugin")
}

fn provider_registry(root: &std::path::Path) -> Arc<ProviderRegistry> {
    let storage = Arc::new(
        StorageService::open(root.join("data"), root.join("cache")).expect("storage opens"),
    );
    let credentials: Arc<dyn CredentialStore> = Arc::new(TestCredentials);
    let provider = yaqmc_provider_qqmusic::create_intree_provider(
        storage,
        credentials,
        root.join("fixture-media"),
    )
    .expect("built-in provider");
    Arc::new(ProviderRegistry::new("qqmusic", [provider]).expect("provider registry"))
}

#[tokio::test]
async fn packaged_component_installs_invokes_and_recovers_after_reenable() {
    let root = tempfile::tempdir().expect("temporary host root");
    let registry = provider_registry(root.path());
    let host = ExtensionHost::open(root.path().join("plugins")).expect("host opens");
    host.attach_provider_registry(Arc::clone(&registry))
        .expect("registry attaches");

    let package = example_package();
    assert!(package.is_file(), "missing {}", package.display());
    let record = host
        .install(&package, true, &["provider.catalog".to_owned()])
        .expect("component installs");
    assert_eq!(record.status, PluginStatus::Active);
    assert!(registry.contains("dev.yaqmc.example.catalog"));

    let catalog = registry
        .catalog_provider("dev.yaqmc.example.catalog")
        .expect("catalog capability registers");
    let result = catalog
        .catalog_search("component".to_owned(), CatalogSearchKind::Song, 1, 20)
        .await
        .expect("component search succeeds");
    let SearchResult::Song { items, .. } = result else {
        panic!("component search must return songs")
    };
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].title, "Component Model");
    assert_eq!(
        items[0]
            .provider
            .as_ref()
            .expect("provider reference")
            .provider_id,
        "dev.yaqmc.example.catalog"
    );

    host.set_enabled("dev.yaqmc.example.catalog", false)
        .expect("component disables");
    assert!(!registry.contains("dev.yaqmc.example.catalog"));
    host.set_enabled("dev.yaqmc.example.catalog", true)
        .expect("component re-enables");
    assert!(registry.contains("dev.yaqmc.example.catalog"));
}
