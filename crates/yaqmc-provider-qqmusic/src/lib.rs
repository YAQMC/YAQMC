//! QQ Music provider backed by YAQMC's existing in-tree implementation.
//!
//! P14-A deliberately keeps this backend as the default and performs no upstream
//! `qm-api-rs` linkage or protocol replacement.

#[cfg(not(feature = "intree"))]
compile_error!("P14-A requires the `intree` QQ Music backend feature");

mod adapter;
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
