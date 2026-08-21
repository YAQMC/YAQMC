//! QQ Music provider with in-tree and pinned `qqmusic-api` integration paths.
//!
//! P14-C still keeps `intree` as the default feature until provenance and soak
//! gates pass. Optional `qmapi` compiles an
//! injected `ApiTransport` plus QMC, lyric, vkey, CGI/sign, session, G/H
//! account/entitlement, and K catalog comparison adapters against pinned
//! `qqmusic-api`. Production QMC decrypt stays in-tree until row J passes a
//! real-file golden. When `qmapi` is on in a non-test build, lyric HTTP, clear
//! vkey HTTP, VIP fetch, and raw favorite/playlist writes use the library;
//! credential-v2 is the restore primary. The legacy session remains a synced
//! migration/rollback fallback. Encrypted evkey, `zzb`, QR/OAuth, mutation
//! reconciliation, `choose_source`, and home/discover/area stay in-tree.

#[cfg(not(any(feature = "intree", feature = "qmapi")))]
compile_error!("enable the `intree` and/or `qmapi` QQ Music backend feature");

mod adapter;
#[cfg(feature = "qmapi")]
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
