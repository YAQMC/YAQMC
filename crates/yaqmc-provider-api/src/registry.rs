//! Runtime-ID provider registry and legacy capability façade.

use crate::{
    AccountProvider, Album, AreaFeed, Artist, ArtistCatalogKind, ArtistCatalogPage,
    AudioQualityPreference, CacheStats, CatalogProvider, CatalogProviderCapabilities,
    CatalogSearchKind, DiscoverFeed, HomeFeed, LibrarySnapshot, LyricDocument, LyricsProvider,
    MusicProvider, PlaybackSourceError, PlaybackSourceProvider, PlaybackSourceResolver,
    PlaybackSourceSelection, Playlist, ProviderAccount, ProviderCommandError, ProviderResult,
    ProviderStatus, RecommendationBatch, RecommendationProvider, RecommendationRequest,
    ResolvedPlaybackSource, SearchResult, ShareProvider, ShareTarget, Song,
};
use async_trait::async_trait;
use std::{borrow::Borrow, collections::HashMap, fmt, sync::Arc};

pub const MAX_PROVIDER_ID_BYTES: usize = 64;

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ProviderId(String);

impl ProviderId {
    pub fn parse(value: impl AsRef<str>) -> Result<Self, ProviderIdError> {
        let value = value.as_ref();
        if value.is_empty() {
            return Err(ProviderIdError::Empty);
        }
        if value.len() > MAX_PROVIDER_ID_BYTES {
            return Err(ProviderIdError::TooLong);
        }
        let mut bytes = value.bytes();
        if !bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        {
            return Err(ProviderIdError::InvalidCharacter);
        }
        if !bytes.all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_' | b'.')
        }) {
            return Err(ProviderIdError::InvalidCharacter);
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl AsRef<str> for ProviderId {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl Borrow<str> for ProviderId {
    fn borrow(&self) -> &str {
        self.as_str()
    }
}

impl fmt::Display for ProviderId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderIdError {
    Empty,
    TooLong,
    InvalidCharacter,
}

impl fmt::Display for ProviderIdError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => formatter.write_str("music provider ID must not be empty"),
            Self::TooLong => write!(
                formatter,
                "music provider ID exceeds the {MAX_PROVIDER_ID_BYTES}-byte limit"
            ),
            Self::InvalidCharacter => formatter.write_str(
                "music provider ID must use lowercase ASCII letters, digits, dots, underscores, or hyphens",
            ),
        }
    }
}

impl std::error::Error for ProviderIdError {}

#[derive(Debug, Eq, PartialEq)]
pub enum ProviderRegistryError {
    Empty,
    InvalidId(ProviderIdError),
    DuplicateId(ProviderId),
    MissingDefault(ProviderId),
}

impl fmt::Display for ProviderRegistryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => formatter.write_str("at least one music provider is required"),
            Self::InvalidId(error) => error.fmt(formatter),
            Self::DuplicateId(id) => write!(formatter, "duplicate music provider id: {id}"),
            Self::MissingDefault(id) => {
                write!(formatter, "default music provider is missing: {id}")
            }
        }
    }
}

impl std::error::Error for ProviderRegistryError {}

struct LegacyCapabilityAdapter {
    provider: Arc<dyn MusicProvider>,
}

#[async_trait]
impl CatalogProvider for LegacyCapabilityAdapter {
    fn catalog_capabilities(&self) -> CatalogProviderCapabilities {
        self.provider.capabilities()
    }

    async fn catalog_status(&self) -> ProviderStatus {
        self.provider.status().await
    }

    async fn catalog_search(
        &self,
        query: String,
        kind: CatalogSearchKind,
        page: u32,
        limit: u32,
    ) -> ProviderResult<SearchResult> {
        self.provider.search(query, kind, page, limit).await
    }

    async fn catalog_song(&self, id: String) -> ProviderResult<Song> {
        self.provider.song(id).await
    }

    async fn catalog_album(&self, id: String) -> ProviderResult<Album> {
        self.provider.album(id).await
    }

    async fn catalog_artist(&self, id: String) -> ProviderResult<Artist> {
        self.provider.artist(id).await
    }

    async fn catalog_artist_page(
        &self,
        id: String,
        kind: ArtistCatalogKind,
        page: u32,
        limit: u32,
    ) -> ProviderResult<ArtistCatalogPage> {
        self.provider.artist_catalog(id, kind, page, limit).await
    }

    async fn catalog_playlist(&self, id: String) -> ProviderResult<Playlist> {
        self.provider.playlist(id).await
    }

    async fn catalog_home(&self, refresh: bool) -> ProviderResult<HomeFeed> {
        self.provider.home(refresh).await
    }

    async fn catalog_discover(&self, refresh: bool) -> ProviderResult<DiscoverFeed> {
        self.provider.discover(refresh).await
    }

    async fn catalog_area(&self, enc_area: String) -> ProviderResult<AreaFeed> {
        self.provider.area(enc_area).await
    }

    fn catalog_library(&self) -> LibrarySnapshot {
        self.provider.library()
    }

    async fn catalog_artwork_data_uri(&self, url: String) -> ProviderResult<String> {
        self.provider.artwork_data_uri(url).await
    }

    fn catalog_cache_stats(&self) -> ProviderResult<CacheStats> {
        self.provider.cache_stats()
    }

    fn catalog_clear_cache(&self) -> ProviderResult<CacheStats> {
        self.provider.clear_cache()
    }

    async fn catalog_remember_songs(&self, songs: &[Song]) {
        self.provider.remember_songs(songs).await;
    }
}

#[async_trait]
impl PlaybackSourceResolver for LegacyCapabilityAdapter {
    async fn resolve(&self, song: &Song) -> Result<ResolvedPlaybackSource, PlaybackSourceError> {
        self.provider.resolve(song).await
    }

    async fn resolve_client_fallback(
        &self,
        song: &Song,
        failed: &PlaybackSourceSelection,
    ) -> Result<ResolvedPlaybackSource, PlaybackSourceError> {
        self.provider.resolve_client_fallback(song, failed).await
    }
}

#[async_trait]
impl PlaybackSourceProvider for LegacyCapabilityAdapter {
    fn playback_media_http_client(&self) -> reqwest::Client {
        self.provider.media_http_client()
    }

    async fn playback_set_preferred_quality(
        &self,
        quality: AudioQualityPreference,
    ) -> ProviderResult<ProviderStatus> {
        self.provider.set_preferred_quality(quality).await
    }

    async fn playback_set_current_quality(
        &self,
        track_id: String,
        quality: AudioQualityPreference,
    ) -> ProviderResult<()> {
        self.provider.set_current_quality(track_id, quality).await
    }
}

#[async_trait]
impl RecommendationProvider for LegacyCapabilityAdapter {
    async fn recommendation_next(
        &self,
        request: RecommendationRequest,
    ) -> ProviderResult<RecommendationBatch> {
        self.provider.recommendation_next(request).await
    }
}

#[async_trait]
impl LyricsProvider for LegacyCapabilityAdapter {
    async fn lyrics_for_song(&self, song_id: String) -> ProviderResult<Option<LyricDocument>> {
        self.provider.lyrics(song_id).await
    }
}

#[async_trait]
impl ShareProvider for LegacyCapabilityAdapter {
    async fn share_song(&self, id: String) -> ProviderResult<ShareTarget> {
        self.provider.share_song(id).await
    }
}

impl AccountProvider for LegacyCapabilityAdapter {
    fn provider_account(&self) -> &dyn ProviderAccount {
        self.provider.account()
    }
}

/// Capability view over the current monolithic provider contract.
///
/// Every view is present for a legacy provider. Future provider instances can
/// make capabilities optional without forcing existing Core consumers to move
/// in one change.
pub struct MusicProviderCapabilityFacade {
    id: ProviderId,
    adapter: LegacyCapabilityAdapter,
}

impl MusicProviderCapabilityFacade {
    fn from_legacy(id: ProviderId, provider: Arc<dyn MusicProvider>) -> Self {
        Self {
            id,
            adapter: LegacyCapabilityAdapter { provider },
        }
    }

    pub fn id(&self) -> &ProviderId {
        &self.id
    }

    pub fn catalog(&self) -> Option<&dyn CatalogProvider> {
        Some(&self.adapter)
    }

    pub fn playback(&self) -> Option<&dyn PlaybackSourceProvider> {
        Some(&self.adapter)
    }

    pub fn recommendations(&self) -> Option<&dyn RecommendationProvider> {
        Some(&self.adapter)
    }

    pub fn lyrics(&self) -> Option<&dyn LyricsProvider> {
        Some(&self.adapter)
    }

    pub fn share(&self) -> Option<&dyn ShareProvider> {
        Some(&self.adapter)
    }

    pub fn account(&self) -> Option<&dyn AccountProvider> {
        Some(&self.adapter)
    }

    pub fn legacy_provider(&self) -> Arc<dyn MusicProvider> {
        Arc::clone(&self.adapter.provider)
    }
}

pub struct ProviderRegistry {
    providers: HashMap<ProviderId, MusicProviderCapabilityFacade>,
    default_id: ProviderId,
}

impl ProviderRegistry {
    pub fn new(
        default_id: impl AsRef<str>,
        providers: impl IntoIterator<Item = Arc<dyn MusicProvider>>,
    ) -> Result<Self, ProviderRegistryError> {
        let default_id = ProviderId::parse(default_id).map_err(ProviderRegistryError::InvalidId)?;
        let mut registry = HashMap::new();
        for provider in providers {
            let id = ProviderId::parse(provider.id()).map_err(ProviderRegistryError::InvalidId)?;
            let facade = MusicProviderCapabilityFacade::from_legacy(id.clone(), provider);
            if registry.insert(id.clone(), facade).is_some() {
                return Err(ProviderRegistryError::DuplicateId(id));
            }
        }
        if registry.is_empty() {
            return Err(ProviderRegistryError::Empty);
        }
        if !registry.contains_key(&default_id) {
            return Err(ProviderRegistryError::MissingDefault(default_id));
        }
        Ok(Self {
            providers: registry,
            default_id,
        })
    }

    pub fn provider(&self, id: &str) -> Option<Arc<dyn MusicProvider>> {
        self.providers
            .get(id)
            .map(MusicProviderCapabilityFacade::legacy_provider)
    }

    pub fn capabilities(&self, id: &str) -> Option<&MusicProviderCapabilityFacade> {
        self.providers.get(id)
    }

    pub fn provider_ids(&self) -> impl Iterator<Item = &ProviderId> {
        self.providers.keys()
    }

    pub fn default_id(&self) -> &ProviderId {
        &self.default_id
    }

    pub fn default_provider(&self) -> Arc<dyn MusicProvider> {
        self.providers
            .get(&self.default_id)
            .expect("ProviderRegistry validates its default provider")
            .legacy_provider()
    }

    pub async fn share_song(&self, provider_id: &str, id: String) -> ProviderResult<ShareTarget> {
        let provider = self.capabilities(provider_id).ok_or_else(|| {
            ProviderCommandError::invalid_request("music provider is unavailable")
        })?;
        let share = provider.share().ok_or_else(|| ProviderCommandError {
            code: "unsupported-operation".to_owned(),
            message: "this music provider does not support sharing".to_owned(),
            retryable: false,
        })?;
        share.share_song(id).await
    }

    pub fn account_generation(&self, provider_id: &str) -> Option<u64> {
        let provider = self.capabilities(provider_id)?;
        Some(
            provider
                .account()
                .map_or(0, |account| account.provider_account().account_generation()),
        )
    }

    pub async fn recommendation_next(
        &self,
        provider_id: &str,
        request: RecommendationRequest,
    ) -> ProviderResult<RecommendationBatch> {
        let provider = self.capabilities(provider_id).ok_or_else(|| {
            ProviderCommandError::invalid_request("music provider is unavailable")
        })?;
        let recommendations = provider
            .recommendations()
            .ok_or_else(|| ProviderCommandError {
                code: "unsupported-operation".to_owned(),
                message: "this music provider does not support recommendations".to_owned(),
                retryable: false,
            })?;
        recommendations.recommendation_next(request).await
    }

    fn provider_for_song(
        &self,
        song: &Song,
    ) -> Result<Arc<dyn MusicProvider>, PlaybackSourceError> {
        match song.provider.as_ref() {
            Some(reference) => self
                .provider(&reference.provider_id)
                .ok_or(PlaybackSourceError::TrackUnavailable),
            None => Ok(self.default_provider()),
        }
    }
}

#[async_trait]
impl PlaybackSourceResolver for ProviderRegistry {
    async fn resolve(&self, song: &Song) -> Result<ResolvedPlaybackSource, PlaybackSourceError> {
        self.provider_for_song(song)?.resolve(song).await
    }

    async fn resolve_client_fallback(
        &self,
        song: &Song,
        failed: &PlaybackSourceSelection,
    ) -> Result<ResolvedPlaybackSource, PlaybackSourceError> {
        self.provider_for_song(song)?
            .resolve_client_fallback(song, failed)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_provider_ids_are_owned_and_validated() {
        let source = String::from("plugin.example-source_2");
        let id = ProviderId::parse(&source).expect("valid runtime provider ID");
        drop(source);
        assert_eq!(id.as_str(), "plugin.example-source_2");
        assert_eq!(id.to_string(), "plugin.example-source_2");
    }

    #[test]
    fn provider_ids_reject_unsafe_or_ambiguous_inputs() {
        assert_eq!(ProviderId::parse(""), Err(ProviderIdError::Empty));
        assert_eq!(
            ProviderId::parse("Uppercase"),
            Err(ProviderIdError::InvalidCharacter)
        );
        assert_eq!(
            ProviderId::parse("plugin/escape"),
            Err(ProviderIdError::InvalidCharacter)
        );
        assert_eq!(
            ProviderId::parse("plugin:account"),
            Err(ProviderIdError::InvalidCharacter)
        );
        assert_eq!(
            ProviderId::parse("a".repeat(MAX_PROVIDER_ID_BYTES + 1)),
            Err(ProviderIdError::TooLong)
        );
    }
}
