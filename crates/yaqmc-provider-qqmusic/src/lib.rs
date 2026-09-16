//! QQ Music provider with the pinned `qqmusic-api` production path.
//!
//! The pinned library is the production backend: QMC decryption, lyric HTTP,
//! clear vkey HTTP, VIP fetch, credential-v2 restore, and raw favorite/playlist
//! writes run through the injected `ApiTransport`. Encrypted evkey, `zzb`,
//! QR/OAuth, mutation reconciliation, `choose_source`, and home/discover/area
//! remain in-tree Keep responsibilities.

mod adapter;
mod qmapi;
pub mod qmc;
pub mod qqmusic;

pub use qqmusic::{QQMusicError, QQMusicService};

/// Composition-root factory. Callers receive only the provider-api trait object;
/// the retained implementation type does not escape into Core services.
pub fn create_intree_provider<Storage>(
    storage: std::sync::Arc<Storage>,
    credentials: std::sync::Arc<dyn yaqmc_provider_api::CredentialStore>,
    fixture_root: std::path::PathBuf,
) -> Result<std::sync::Arc<dyn yaqmc_provider_api::MusicProvider>, QQMusicError>
where
    Storage: yaqmc_provider_api::ProviderStorage + 'static,
{
    let profile = yaqmc_provider_api::ProviderProfileKey::default_profile("qqmusic")
        .expect("QQ Music's default profile key is valid");
    create_intree_provider_for_profile(storage, credentials, fixture_root, profile)
}

/// Build an isolated in-tree QQ Music provider for a validated local profile.
/// Credentials and account cache scope remain bound to `profile` inside the
/// service; Core only owns the non-secret profile catalogue.
pub fn create_intree_provider_for_profile<Storage>(
    storage: std::sync::Arc<Storage>,
    credentials: std::sync::Arc<dyn yaqmc_provider_api::CredentialStore>,
    fixture_root: std::path::PathBuf,
    profile: yaqmc_provider_api::ProviderProfileKey,
) -> Result<std::sync::Arc<dyn yaqmc_provider_api::MusicProvider>, QQMusicError>
where
    Storage: yaqmc_provider_api::ProviderStorage + 'static,
{
    // `ProviderProfileKey` fields are public for wire/DTO ergonomics. Rebuild
    // the key at every provider boundary so a caller cannot inject an invalid
    // key and cause credential or storage access before validation.
    let profile =
        yaqmc_provider_api::ProviderProfileKey::new(&profile.provider_id, &profile.profile_id)
            .map_err(|_| QQMusicError::InvalidRequest)?;
    if profile.provider_id != "qqmusic" {
        return Err(QQMusicError::InvalidRequest);
    }
    QQMusicService::new_for_profile(storage, credentials, fixture_root, profile).map(|provider| {
        std::sync::Arc::new(provider) as std::sync::Arc<dyn yaqmc_provider_api::MusicProvider>
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use yaqmc_core::{credentials::MemoryCredentialStore, storage::StorageService};
    use yaqmc_provider_api::{
        AlbumSummary, Artwork, AudioQuality, CredentialStore, PlaybackSourceError,
        PlaybackSourceResolver, ProviderCapabilities, ProviderProfileKey, ProviderRegistry,
        ProviderRegistryError, ProviderTrackReference, RecommendationBatch, RecommendationProvider,
        RecommendationRequest, Song, SongAvailability,
    };

    struct StaticRecommendations;

    #[async_trait::async_trait]
    impl RecommendationProvider for StaticRecommendations {
        async fn recommendation_next(
            &self,
            _request: RecommendationRequest,
        ) -> yaqmc_provider_api::ProviderResult<RecommendationBatch> {
            Ok(RecommendationBatch {
                songs: Vec::new(),
                next_cursor: None,
                ended: true,
            })
        }
    }

    #[test]
    fn builtin_provider_projects_every_legacy_capability_under_a_runtime_id() {
        let root = tempfile::tempdir().expect("temporary provider root");
        let storage = Arc::new(
            StorageService::open(root.path().join("data"), root.path().join("cache"))
                .expect("provider storage"),
        );
        let credentials: Arc<dyn CredentialStore> = Arc::new(MemoryCredentialStore::default());
        let provider =
            create_intree_provider(storage, credentials, root.path().join("fixture-media"))
                .expect("built-in provider");
        let registry =
            ProviderRegistry::new(String::from("qqmusic"), [provider]).expect("runtime registry");

        assert_eq!(registry.default_id().as_str(), "qqmusic");
        assert_eq!(
            registry
                .provider_ids()
                .map(|id| id.to_string())
                .collect::<Vec<_>>(),
            vec!["qqmusic".to_owned()]
        );
        let capabilities = registry.capabilities("qqmusic").expect("capability façade");
        assert_eq!(capabilities.id().as_str(), "qqmusic");
        assert!(capabilities.catalog().is_some());
        assert!(capabilities.playback().is_some());
        assert!(capabilities.recommendations().is_some());
        assert!(capabilities.lyrics().is_some());
        let legacy = capabilities.legacy_provider().expect("legacy provider");
        // Capability accounts are exposed through the scoped legacy adapter;
        // verify that the adapter still delegates the account generation to
        // the underlying legacy provider rather than relying on identity of
        // the two different trait-object views.
        assert_eq!(
            capabilities
                .account()
                .expect("account capability")
                .provider_account()
                .account_generation(),
            legacy.account().account_generation()
        );
        assert_eq!(legacy.id(), "qqmusic");
    }

    #[tokio::test]
    async fn profile_factory_and_registry_preserve_exact_profile_identity() {
        let root = tempfile::tempdir().expect("temporary provider root");
        let storage = Arc::new(
            StorageService::open(root.path().join("data"), root.path().join("cache"))
                .expect("provider storage"),
        );
        let credentials: Arc<dyn CredentialStore> = Arc::new(MemoryCredentialStore::default());
        let work_key = ProviderProfileKey::new("qqmusic", "work").expect("work key");
        let work = create_intree_provider_for_profile(
            Arc::clone(&storage),
            Arc::clone(&credentials),
            root.path().join("fixture-media"),
            work_key.clone(),
        )
        .expect("work provider");
        assert_eq!(work.profile_key(), work_key);
        assert!(matches!(
            ProviderRegistry::new("qqmusic", [Arc::clone(&work)]),
            Err(ProviderRegistryError::ExpectedDefaultProfile(key)) if key == work_key
        ));

        let default = create_intree_provider(
            Arc::clone(&storage),
            Arc::clone(&credentials),
            root.path().join("fixture-media"),
        )
        .expect("default provider");
        let registry = ProviderRegistry::new("qqmusic", [default]).expect("registry");
        registry
            .register_legacy_profile(Arc::clone(&work))
            .expect("register work");
        assert!(matches!(
            registry.register_legacy_profile(Arc::clone(&work)),
            Err(ProviderRegistryError::DuplicateProfile(key)) if key == work_key
        ));
        let snapshot = registry
            .require_account_provider_for_profile(Some("qqmusic"), Some("work"))
            .expect("work account")
            .provider_account()
            .account_snapshot()
            .await;
        assert_eq!(snapshot.provider_id, "qqmusic");
        assert_eq!(snapshot.profile_id, "work");

        let foreign = ProviderProfileKey::new("spotify", "work").expect("foreign key");
        assert!(matches!(
            create_intree_provider_for_profile(
                Arc::clone(&storage),
                Arc::clone(&credentials),
                root.path().join("fixture-media"),
                foreign,
            ),
            Err(QQMusicError::InvalidRequest)
        ));
        let mut malformed = work_key;
        malformed.profile_id = "Invalid Profile".to_owned();
        let before = storage
            .get_setting("qqmusic-profile-validation-test")
            .expect("read setting");
        assert!(matches!(
            create_intree_provider_for_profile(
                Arc::clone(&storage),
                Arc::clone(&credentials),
                root.path().join("fixture-media"),
                malformed,
            ),
            Err(QQMusicError::InvalidRequest)
        ));
        assert_eq!(
            storage
                .get_setting("qqmusic-profile-validation-test")
                .expect("read setting"),
            before,
            "invalid profile validation must not touch storage"
        );
    }

    #[tokio::test]
    async fn unknown_provider_tracks_fail_closed_without_default_substitution() {
        let root = tempfile::tempdir().expect("temporary provider root");
        let storage = Arc::new(
            StorageService::open(root.path().join("data"), root.path().join("cache"))
                .expect("provider storage"),
        );
        let credentials: Arc<dyn CredentialStore> = Arc::new(MemoryCredentialStore::default());
        let provider =
            create_intree_provider(storage, credentials, root.path().join("fixture-media"))
                .expect("built-in provider");
        let registry = ProviderRegistry::new("qqmusic", [provider]).expect("runtime registry");
        let song = Song {
            id: "plugin:track:1".to_owned(),
            title: "Unavailable plugin track".to_owned(),
            artists: Vec::new(),
            album: AlbumSummary {
                id: String::new(),
                title: String::new(),
            },
            artwork: Artwork {
                src: String::new(),
                alt: String::new(),
                dominant_color: String::new(),
                variants: Vec::new(),
            },
            duration_ms: 0,
            track_number: 1,
            is_favorite: false,
            quality: AudioQuality::Standard,
            availability: SongAvailability::Available,
            audio_formats: Vec::new(),
            playback_capability: None,
            provider: Some(ProviderTrackReference {
                provider_id: "plugin.missing".to_owned(),
                profile_id: yaqmc_provider_api::DEFAULT_PROFILE_ID.to_owned(),
                track_id: "1".to_owned(),
                numeric_id: None,
                album_id: None,
                media_id: None,
            }),
        };

        assert!(matches!(
            registry.resolve(&song).await,
            Err(PlaybackSourceError::TrackUnavailable)
        ));
    }

    #[tokio::test]
    async fn plugin_capabilities_register_and_unregister_without_replacing_default() {
        let root = tempfile::tempdir().expect("temporary provider root");
        let storage = Arc::new(
            StorageService::open(root.path().join("data"), root.path().join("cache"))
                .expect("provider storage"),
        );
        let credentials: Arc<dyn CredentialStore> = Arc::new(MemoryCredentialStore::default());
        let provider =
            create_intree_provider(storage, credentials, root.path().join("fixture-media"))
                .expect("built-in provider");
        let registry = ProviderRegistry::new("qqmusic", [provider]).expect("runtime registry");
        let recommendation: Arc<dyn RecommendationProvider> = Arc::new(StaticRecommendations);

        let facade = registry
            .register_capabilities(
                "plugin.example",
                ProviderCapabilities {
                    recommendations: Some(recommendation),
                    ..ProviderCapabilities::default()
                },
            )
            .expect("register plugin provider");
        assert_eq!(facade.id().as_str(), "plugin.example");
        assert!(facade.catalog().is_none());
        assert!(facade.recommendations().is_some());
        assert!(facade.legacy_provider().is_none());
        assert!(registry.contains("plugin.example"));
        assert_eq!(
            registry
                .provider_ids()
                .map(|id| id.to_string())
                .collect::<Vec<_>>(),
            vec!["plugin.example".to_owned(), "qqmusic".to_owned()]
        );
        let request = RecommendationRequest {
            kind: yaqmc_provider_api::RecommendationKind::Guess,
            limit: 5,
            cursor: None,
            seeds: Vec::new(),
        };
        assert!(
            registry
                .recommendation_next("plugin.example", request)
                .await
                .expect("plugin recommendation")
                .ended
        );

        assert!(registry
            .unregister("plugin.example")
            .expect("unregister")
            .is_some());
        assert!(!registry.contains("plugin.example"));
        let disabled = registry
            .descriptors()
            .into_iter()
            .find(|provider| provider.provider_id == "plugin.example")
            .expect("disabled provider descriptor");
        assert!(!disabled.available);
        assert!(disabled.capabilities.recommendations);
        assert_eq!(
            registry
                .recommendation_next(
                    "plugin.example",
                    RecommendationRequest {
                        kind: yaqmc_provider_api::RecommendationKind::Guess,
                        limit: 5,
                        cursor: None,
                        seeds: Vec::new(),
                    },
                )
                .await
                .expect_err("disabled provider cannot be invoked")
                .code,
            "provider-unavailable"
        );

        let recommendation: Arc<dyn RecommendationProvider> = Arc::new(StaticRecommendations);
        registry
            .register_capabilities(
                "plugin.example",
                ProviderCapabilities {
                    display_name: Some("Example provider".to_owned()),
                    recommendations: Some(recommendation),
                    ..ProviderCapabilities::default()
                },
            )
            .expect("re-enable provider");
        let restored = registry
            .descriptors()
            .into_iter()
            .find(|provider| provider.provider_id == "plugin.example")
            .expect("restored provider descriptor");
        assert!(restored.available);
        assert_eq!(restored.display_name, "Example provider");
        assert_eq!(
            registry.unregister("qqmusic").unwrap_err(),
            ProviderRegistryError::ProtectedDefault(
                yaqmc_provider_api::ProviderId::parse("qqmusic").expect("id")
            )
        );
    }
}
