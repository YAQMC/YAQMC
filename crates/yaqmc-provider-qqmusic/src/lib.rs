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
