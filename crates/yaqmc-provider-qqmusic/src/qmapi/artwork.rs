//! Cache-facing adapter; the library owns image request and response policy.
use yaqmc_provider_api::{ArtworkBytes, ArtworkFetcher, ProviderStorageError};

pub(crate) struct QmapiArtworkFetcher<'a>(pub &'a qqmusic_api::Client);

#[async_trait::async_trait]
impl ArtworkFetcher for QmapiArtworkFetcher<'_> {
    async fn fetch(&self, url: &str) -> Result<ArtworkBytes, ProviderStorageError> {
        let result =
            qqmusic_api::artwork::download(self.0, url, tokio_util::sync::CancellationToken::new())
                .await
                .map_err(|_| ProviderStorageError)?;
        Ok(ArtworkBytes {
            bytes: result.bytes,
            mime_type: result.mime_type,
        })
    }
}
