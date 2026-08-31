//! Executes the distributable API v3 Provider Component fixture through the
//! real package inspector, ExtensionHost lifecycle, and dynamic registry.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use yaqmc_core::{
    credentials::{CredentialError, CredentialStore},
    plugin::{ExtensionHost, PluginStatus},
    storage::StorageService,
};
use yaqmc_provider_api::{
    AccountState, AudioQuality, AudioQualityPreference, CatalogSearchKind, PlaybackFallbackReason,
    PlaybackLocation, PlaybackSourceError, PlaybackSourceResolver, ProviderRegistry,
    ProviderTrackReference, RecommendationKind, RecommendationRequest, SearchResult,
};

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

#[derive(Default)]
struct RecordingCredentials {
    values: Mutex<HashMap<String, String>>,
}

impl RecordingCredentials {
    fn accounts(&self) -> Vec<String> {
        self.values
            .lock()
            .expect("credential values")
            .keys()
            .cloned()
            .collect()
    }
}

impl CredentialStore for RecordingCredentials {
    fn load(&self, account: &str) -> Result<Option<String>, CredentialError> {
        Ok(self
            .values
            .lock()
            .expect("credential values")
            .get(account)
            .cloned())
    }

    fn save(&self, account: &str, secret: &str) -> Result<(), CredentialError> {
        self.values
            .lock()
            .expect("credential values")
            .insert(account.to_owned(), secret.to_owned());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), CredentialError> {
        self.values
            .lock()
            .expect("credential values")
            .remove(account);
        Ok(())
    }
}

fn example_package() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/plugins/packages/dev.yaqmc.example.catalog-1.0.0.yaqmc-plugin")
}

fn platform_example_package() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/plugins/packages/dev.yaqmc.example.platform-1.0.0.yaqmc-plugin")
}

fn provider_registry(root: &std::path::Path) -> Arc<ProviderRegistry> {
    provider_registry_with_credentials(root, Arc::new(TestCredentials))
}

fn provider_registry_with_credentials(
    root: &std::path::Path,
    credentials: Arc<dyn CredentialStore>,
) -> Arc<ProviderRegistry> {
    let storage = Arc::new(
        StorageService::open(root.join("data"), root.join("cache")).expect("storage opens"),
    );
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

#[tokio::test]
async fn complete_platform_component_exercises_capabilities_and_lifecycle() {
    const PROVIDER_ID: &str = "dev.yaqmc.example.platform";
    let root = tempfile::tempdir().expect("temporary host root");
    let recording = Arc::new(RecordingCredentials::default());
    let credentials: Arc<dyn CredentialStore> = recording.clone();
    let registry = provider_registry_with_credentials(root.path(), Arc::clone(&credentials));
    let host = ExtensionHost::open(root.path().join("plugins")).expect("host opens");
    host.attach_provider_runtime(
        Arc::clone(&registry),
        credentials,
        root.path().join("component-cache"),
        tokio::runtime::Handle::current(),
    )
    .expect("provider runtime attaches");

    let package = platform_example_package();
    assert!(package.is_file(), "missing {}", package.display());
    let inspection = host.inspect_path(&package).expect("package inspects");
    let grants = inspection.manifest.requested_permission_keys();
    let record = host
        .install(&package, true, &grants)
        .expect("complete component installs");
    assert_eq!(record.status, PluginStatus::Active);
    let descriptor = registry
        .descriptors()
        .into_iter()
        .find(|descriptor| descriptor.provider_id == PROVIDER_ID)
        .expect("provider descriptor");
    assert!(descriptor.available);
    assert!(descriptor.capabilities.catalog);
    assert!(descriptor.capabilities.playback);
    assert!(descriptor.capabilities.recommendations);
    assert!(descriptor.capabilities.lyrics);
    assert!(descriptor.capabilities.account);

    let catalog = registry
        .require_catalog_provider(PROVIDER_ID)
        .expect("catalog capability");
    let result = catalog
        .catalog_search("component".to_owned(), CatalogSearchKind::Song, 1, 20)
        .await
        .expect("component search succeeds");
    let SearchResult::Song { items, .. } = result else {
        panic!("component search must return songs")
    };
    let song = items.into_iter().next().expect("fixture song");
    assert_eq!(
        catalog
            .catalog_home(false)
            .await
            .expect("home")
            .made_for_you
            .len(),
        1
    );
    assert_eq!(
        catalog
            .catalog_discover(false)
            .await
            .expect("discover")
            .charts
            .len(),
        1
    );

    let recommendations = registry
        .recommendation_next(
            PROVIDER_ID,
            RecommendationRequest {
                kind: RecommendationKind::Guess,
                limit: 10,
                cursor: None,
                seeds: Vec::new(),
            },
        )
        .await
        .expect("recommendation capability");
    assert_eq!(recommendations.songs.len(), 1);
    assert!(recommendations.ended);
    let lyrics = registry
        .require_lyrics_provider(PROVIDER_ID)
        .expect("lyrics capability")
        .lyrics_for_song(song.id.clone())
        .await
        .expect("lyrics request")
        .expect("lyrics document");
    assert_eq!(lyrics.lines.len(), 1);

    let account = registry
        .require_account_provider(PROVIDER_ID)
        .expect("account capability");
    let methods = account
        .account_login_methods()
        .await
        .expect("login methods");
    assert_eq!(methods.len(), 1);
    assert_eq!(methods[0].id, "example");
    let prepared = account
        .account_prepare_login("example")
        .await
        .expect("oauth preparation");
    let authorize_url = reqwest::Url::parse(&prepared.url).expect("authorization URL");
    let state = authorize_url
        .query_pairs()
        .find(|(name, _)| name == "state")
        .map(|(_, value)| value.into_owned())
        .expect("oauth state");
    let callback_url = reqwest::Url::parse(&format!(
        "{}?code=fixture&state={state}",
        prepared.callback_matcher.url_prefix
    ))
    .expect("callback URL");
    let snapshot = account
        .provider_account()
        .complete_oauth_login(&prepared.attempt_id, callback_url)
        .await
        .expect("oauth completion");
    assert!(matches!(
        snapshot.account,
        AccountState::Authenticated { .. }
    ));
    assert_eq!(
        account
            .provider_account()
            .favorite_songs(None, 20)
            .await
            .expect("favorite songs")
            .items
            .len(),
        1
    );
    let credential_accounts = recording.accounts();
    assert_eq!(credential_accounts.len(), 1);
    assert!(credential_accounts[0].starts_with("plugin-component:"));

    let playback = registry
        .require_playback_provider(PROVIDER_ID)
        .expect("playback capability");
    playback
        .playback_set_preferred_quality(AudioQualityPreference::Lossless)
        .await
        .expect("quality preference");
    let resolved = registry
        .resolve(&song)
        .await
        .expect("opaque playback source");
    assert_eq!(
        resolved.selection.requested_quality,
        AudioQualityPreference::Lossless
    );
    assert_eq!(resolved.selection.resolved_quality, AudioQuality::Standard);
    assert_eq!(
        resolved.selection.fallback_reason,
        Some(PlaybackFallbackReason::SourceUnavailable)
    );
    let PlaybackLocation::Opaque(source) = &resolved.location else {
        panic!("component playback must remain opaque")
    };
    let old_source = Arc::clone(source);
    assert_eq!(
        old_source
            .read_range(0, 4, tokio_util::sync::CancellationToken::new())
            .await
            .expect("opaque range"),
        b"RIFF"
    );

    let mut builtin_song = song.clone();
    builtin_song.id = "qqmusic-fixture".to_owned();
    builtin_song.provider = Some(ProviderTrackReference {
        provider_id: "qqmusic".to_owned(),
        track_id: "qqmusic-fixture".to_owned(),
        numeric_id: None,
        album_id: None,
        media_id: None,
    });
    let queue = [builtin_song, song];
    host.set_enabled(PROVIDER_ID, false)
        .expect("component disables");
    assert!(registry.contains("qqmusic"));
    assert_eq!(
        registry.resolve(&queue[1]).await.unwrap_err(),
        PlaybackSourceError::TrackUnavailable
    );
    assert!(old_source
        .read_range(0, 4, tokio_util::sync::CancellationToken::new())
        .await
        .is_err());
    let unavailable = registry
        .descriptors()
        .into_iter()
        .find(|descriptor| descriptor.provider_id == PROVIDER_ID)
        .expect("inactive provider tombstone");
    assert!(!unavailable.available);

    host.set_enabled(PROVIDER_ID, true)
        .expect("component re-enables");
    let restored = registry
        .resolve(&queue[1])
        .await
        .expect("restored playback source");
    let PlaybackLocation::Opaque(source) = restored.location else {
        panic!("restored component playback must remain opaque")
    };
    assert_eq!(
        source
            .read_range(0, 4, tokio_util::sync::CancellationToken::new())
            .await
            .expect("restored opaque range"),
        b"RIFF"
    );
    let restored_account = registry
        .require_account_provider(PROVIDER_ID)
        .expect("restored account capability");
    assert!(matches!(
        restored_account
            .provider_account()
            .account_snapshot()
            .await
            .account,
        AccountState::Authenticated { .. }
    ));
    assert!(matches!(
        restored_account
            .provider_account()
            .sign_out()
            .await
            .expect("component sign out")
            .account,
        AccountState::Guest { .. }
    ));
    assert!(recording.accounts().is_empty());
}
