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
    QQMusicService::new(storage, credentials, fixture_root).map(|provider| {
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
        PlaybackSourceResolver, ProviderRegistry, ProviderTrackReference, Song, SongAvailability,
    };

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
                .map(|id| id.as_str())
                .collect::<Vec<_>>(),
            vec!["qqmusic"]
        );
        let capabilities = registry.capabilities("qqmusic").expect("capability façade");
        assert_eq!(capabilities.id().as_str(), "qqmusic");
        assert!(capabilities.catalog().is_some());
        assert!(capabilities.playback().is_some());
        assert!(capabilities.recommendations().is_some());
        assert!(capabilities.lyrics().is_some());
        let legacy = capabilities.legacy_provider();
        assert!(std::ptr::eq(
            capabilities
                .account()
                .expect("account capability")
                .provider_account(),
            legacy.account()
        ));
        assert_eq!(legacy.id(), "qqmusic");
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
}
