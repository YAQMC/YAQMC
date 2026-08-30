//! Runtime-ID provider registry and legacy capability façade.

use crate::{
    AccountLoginFlow, AccountLoginMethodDescriptor, AccountProvider, Album, AreaFeed, Artist,
    ArtistCatalogKind, ArtistCatalogPage, AudioQualityPreference, CacheStats, CatalogProvider,
    CatalogProviderCapabilities, CatalogSearchKind, DiscoverFeed, HomeFeed, LibrarySnapshot,
    LyricDocument, LyricsProvider, MusicProvider, PlaybackSourceError, PlaybackSourceProvider,
    PlaybackSourceResolver, PlaybackSourceSelection, Playlist, ProviderAccount,
    ProviderCommandError, ProviderResult, ProviderStatus, RecommendationBatch,
    RecommendationProvider, RecommendationRequest, ResolvedPlaybackSource, SearchResult,
    ShareProvider, ShareTarget, Song,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::{
    borrow::Borrow,
    collections::HashMap,
    fmt,
    sync::{Arc, RwLock},
};

pub const MAX_PROVIDER_ID_BYTES: usize = 64;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilitySummary {
    pub catalog: bool,
    pub playback: bool,
    pub recommendations: bool,
    pub lyrics: bool,
    pub share: bool,
    pub account: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDescriptor {
    pub provider_id: String,
    pub display_name: String,
    pub is_default: bool,
    pub available: bool,
    pub capabilities: ProviderCapabilitySummary,
}

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
    EmptyCapabilities,
    ProtectedDefault(ProviderId),
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
            Self::EmptyCapabilities => {
                formatter.write_str("a music provider must expose at least one capability")
            }
            Self::ProtectedDefault(id) => {
                write!(
                    formatter,
                    "the default music provider cannot be removed: {id}"
                )
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

#[async_trait]
impl AccountProvider for LegacyCapabilityAdapter {
    fn provider_account(&self) -> &dyn ProviderAccount {
        self.provider.account()
    }

    async fn account_login_methods(&self) -> ProviderResult<Vec<AccountLoginMethodDescriptor>> {
        Ok(vec![
            AccountLoginMethodDescriptor {
                id: "qq".to_owned(),
                label: "QQ".to_owned(),
                flow: AccountLoginFlow::OAuth,
            },
            AccountLoginMethodDescriptor {
                id: "wechat".to_owned(),
                label: "WeChat".to_owned(),
                flow: AccountLoginFlow::OAuth,
            },
        ])
    }

    async fn account_prepare_login(
        &self,
        method_id: &str,
    ) -> ProviderResult<crate::OAuthPrepareResult> {
        let method = match method_id {
            "qq" => crate::OAuthLoginProvider::Qq,
            "wechat" => crate::OAuthLoginProvider::Wechat,
            _ => {
                return Err(ProviderCommandError::invalid_request(
                    "account login method is unavailable",
                ));
            }
        };
        self.provider.prepare_oauth_login(method).await
    }
}

/// Capability view over the current monolithic provider contract.
///
/// Every view is present for a legacy provider. Future provider instances can
/// make capabilities optional without forcing existing Core consumers to move
/// in one change.
#[derive(Default)]
pub struct ProviderCapabilities {
    pub display_name: Option<String>,
    pub catalog: Option<Arc<dyn CatalogProvider>>,
    pub playback: Option<Arc<dyn PlaybackSourceProvider>>,
    pub recommendations: Option<Arc<dyn RecommendationProvider>>,
    pub lyrics: Option<Arc<dyn LyricsProvider>>,
    pub share: Option<Arc<dyn ShareProvider>>,
    pub account: Option<Arc<dyn AccountProvider>>,
}

impl ProviderCapabilities {
    pub fn is_empty(&self) -> bool {
        self.catalog.is_none()
            && self.playback.is_none()
            && self.recommendations.is_none()
            && self.lyrics.is_none()
            && self.share.is_none()
            && self.account.is_none()
    }
}

pub struct MusicProviderCapabilityFacade {
    id: ProviderId,
    display_name: String,
    catalog: Option<Arc<dyn CatalogProvider>>,
    playback: Option<Arc<dyn PlaybackSourceProvider>>,
    recommendations: Option<Arc<dyn RecommendationProvider>>,
    lyrics: Option<Arc<dyn LyricsProvider>>,
    share: Option<Arc<dyn ShareProvider>>,
    account: Option<Arc<dyn AccountProvider>>,
    legacy_provider: Option<Arc<dyn MusicProvider>>,
}

impl fmt::Debug for MusicProviderCapabilityFacade {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MusicProviderCapabilityFacade")
            .field("id", &self.id)
            .field("catalog", &self.catalog.is_some())
            .field("playback", &self.playback.is_some())
            .field("recommendations", &self.recommendations.is_some())
            .field("lyrics", &self.lyrics.is_some())
            .field("share", &self.share.is_some())
            .field("account", &self.account.is_some())
            .field("legacy", &self.legacy_provider.is_some())
            .finish()
    }
}

impl MusicProviderCapabilityFacade {
    fn from_legacy(id: ProviderId, provider: Arc<dyn MusicProvider>) -> Self {
        let display_name = provider.display_name().to_owned();
        let adapter = Arc::new(LegacyCapabilityAdapter {
            provider: Arc::clone(&provider),
        });
        Self {
            id,
            display_name,
            catalog: Some(adapter.clone()),
            playback: Some(adapter.clone()),
            recommendations: Some(adapter.clone()),
            lyrics: Some(adapter.clone()),
            share: Some(adapter.clone()),
            account: Some(adapter),
            legacy_provider: Some(provider),
        }
    }

    fn from_capabilities(id: ProviderId, capabilities: ProviderCapabilities) -> Self {
        let display_name = capabilities
            .display_name
            .unwrap_or_else(|| id.as_str().to_owned());
        Self {
            id,
            display_name,
            catalog: capabilities.catalog,
            playback: capabilities.playback,
            recommendations: capabilities.recommendations,
            lyrics: capabilities.lyrics,
            share: capabilities.share,
            account: capabilities.account,
            legacy_provider: None,
        }
    }

    pub fn id(&self) -> &ProviderId {
        &self.id
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    pub fn descriptor(&self, is_default: bool, available: bool) -> ProviderDescriptor {
        ProviderDescriptor {
            provider_id: self.id.to_string(),
            display_name: self.display_name.clone(),
            is_default,
            available,
            capabilities: ProviderCapabilitySummary {
                catalog: self.catalog.is_some(),
                playback: self.playback.is_some(),
                recommendations: self.recommendations.is_some(),
                lyrics: self.lyrics.is_some(),
                share: self.share.is_some(),
                account: self.account.is_some(),
            },
        }
    }

    pub fn catalog(&self) -> Option<&dyn CatalogProvider> {
        self.catalog.as_deref()
    }

    pub fn playback(&self) -> Option<&dyn PlaybackSourceProvider> {
        self.playback.as_deref()
    }

    pub fn recommendations(&self) -> Option<&dyn RecommendationProvider> {
        self.recommendations.as_deref()
    }

    pub fn lyrics(&self) -> Option<&dyn LyricsProvider> {
        self.lyrics.as_deref()
    }

    pub fn share(&self) -> Option<&dyn ShareProvider> {
        self.share.as_deref()
    }

    pub fn account(&self) -> Option<&dyn AccountProvider> {
        self.account.as_deref()
    }

    pub fn legacy_provider(&self) -> Option<Arc<dyn MusicProvider>> {
        self.legacy_provider.as_ref().map(Arc::clone)
    }

    fn playback_arc(&self) -> Option<Arc<dyn PlaybackSourceProvider>> {
        self.playback.as_ref().map(Arc::clone)
    }

    fn catalog_arc(&self) -> Option<Arc<dyn CatalogProvider>> {
        self.catalog.as_ref().map(Arc::clone)
    }

    fn lyrics_arc(&self) -> Option<Arc<dyn LyricsProvider>> {
        self.lyrics.as_ref().map(Arc::clone)
    }

    fn account_arc(&self) -> Option<Arc<dyn AccountProvider>> {
        self.account.as_ref().map(Arc::clone)
    }
}

pub struct ProviderRegistry {
    providers: RwLock<HashMap<ProviderId, Arc<MusicProviderCapabilityFacade>>>,
    inactive: RwLock<HashMap<ProviderId, ProviderDescriptor>>,
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
            let facade = Arc::new(MusicProviderCapabilityFacade::from_legacy(
                id.clone(),
                provider,
            ));
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
            providers: RwLock::new(registry),
            inactive: RwLock::new(HashMap::new()),
            default_id,
        })
    }

    pub fn provider(&self, id: &str) -> Option<Arc<dyn MusicProvider>> {
        self.read_providers()
            .get(id)
            .and_then(|provider| provider.legacy_provider())
    }

    pub fn capabilities(&self, id: &str) -> Option<Arc<MusicProviderCapabilityFacade>> {
        self.read_providers().get(id).map(Arc::clone)
    }

    pub fn provider_ids(&self) -> impl Iterator<Item = ProviderId> {
        let mut ids = self.read_providers().keys().cloned().collect::<Vec<_>>();
        ids.sort();
        ids.into_iter()
    }

    pub fn descriptors(&self) -> Vec<ProviderDescriptor> {
        let providers = self.read_providers();
        let mut descriptors = providers
            .values()
            .map(|provider| provider.descriptor(provider.id() == &self.default_id, true))
            .collect::<Vec<_>>();
        descriptors.extend(self.read_inactive().values().cloned());
        descriptors.sort_by(|left, right| left.provider_id.cmp(&right.provider_id));
        descriptors
    }

    pub fn register_inactive(
        &self,
        id: impl AsRef<str>,
        display_name: impl Into<String>,
        capabilities: ProviderCapabilitySummary,
    ) -> Result<(), ProviderRegistryError> {
        let id = ProviderId::parse(id).map_err(ProviderRegistryError::InvalidId)?;
        if self.read_providers().contains_key(&id) {
            return Ok(());
        }
        self.write_inactive().insert(
            id.clone(),
            ProviderDescriptor {
                provider_id: id.to_string(),
                display_name: display_name.into(),
                is_default: id == self.default_id,
                available: false,
                capabilities,
            },
        );
        Ok(())
    }

    pub fn forget_inactive(&self, id: &str) {
        self.write_inactive().remove(id);
    }

    pub fn default_id(&self) -> &ProviderId {
        &self.default_id
    }

    pub fn default_provider(&self) -> Arc<dyn MusicProvider> {
        self.read_providers()
            .get(&self.default_id)
            .expect("ProviderRegistry validates its default provider")
            .legacy_provider()
            .expect("ProviderRegistry default is a legacy provider")
    }

    pub fn register_capabilities(
        &self,
        id: impl AsRef<str>,
        capabilities: ProviderCapabilities,
    ) -> Result<Arc<MusicProviderCapabilityFacade>, ProviderRegistryError> {
        if capabilities.is_empty() {
            return Err(ProviderRegistryError::EmptyCapabilities);
        }
        let id = ProviderId::parse(id).map_err(ProviderRegistryError::InvalidId)?;
        let facade = Arc::new(MusicProviderCapabilityFacade::from_capabilities(
            id.clone(),
            capabilities,
        ));
        let mut providers = self.write_providers();
        if providers.contains_key(&id) {
            return Err(ProviderRegistryError::DuplicateId(id));
        }
        providers.insert(id.clone(), Arc::clone(&facade));
        drop(providers);
        self.write_inactive().remove(&id);
        Ok(facade)
    }

    pub fn unregister(
        &self,
        id: &str,
    ) -> Result<Option<Arc<MusicProviderCapabilityFacade>>, ProviderRegistryError> {
        if id == self.default_id.as_str() {
            return Err(ProviderRegistryError::ProtectedDefault(
                self.default_id.clone(),
            ));
        }
        let removed = self.write_providers().remove(id);
        if let Some(provider) = &removed {
            self.write_inactive()
                .insert(provider.id().clone(), provider.descriptor(false, false));
        }
        Ok(removed)
    }

    pub fn contains(&self, id: &str) -> bool {
        self.read_providers().contains_key(id)
    }

    pub fn catalog_provider(&self, id: &str) -> Option<Arc<dyn CatalogProvider>> {
        self.capabilities(id)
            .and_then(|provider| provider.catalog_arc())
    }

    pub fn require_catalog_provider(&self, id: &str) -> ProviderResult<Arc<dyn CatalogProvider>> {
        let provider = self.require_provider(id)?;
        provider
            .catalog_arc()
            .ok_or_else(|| unsupported_provider_capability("catalog"))
    }

    pub fn require_lyrics_provider(&self, id: &str) -> ProviderResult<Arc<dyn LyricsProvider>> {
        let provider = self.require_provider(id)?;
        provider
            .lyrics_arc()
            .ok_or_else(|| unsupported_provider_capability("lyrics"))
    }

    pub fn require_playback_provider(
        &self,
        id: &str,
    ) -> ProviderResult<Arc<dyn PlaybackSourceProvider>> {
        let provider = self.require_provider(id)?;
        provider
            .playback_arc()
            .ok_or_else(|| unsupported_provider_capability("playback"))
    }

    pub fn require_account_provider(&self, id: &str) -> ProviderResult<Arc<dyn AccountProvider>> {
        let provider = self.require_provider(id)?;
        provider
            .account_arc()
            .ok_or_else(|| unsupported_provider_capability("account"))
    }

    pub async fn remember_songs(&self, id: &str, songs: &[Song]) {
        if let Some(provider) = self.catalog_provider(id) {
            provider.catalog_remember_songs(songs).await;
        }
    }

    pub async fn share_song(&self, provider_id: &str, id: String) -> ProviderResult<ShareTarget> {
        let provider = self.require_provider(provider_id)?;
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
        let provider = self.require_provider(provider_id)?;
        let recommendations = provider
            .recommendations()
            .ok_or_else(|| ProviderCommandError {
                code: "unsupported-operation".to_owned(),
                message: "this music provider does not support recommendations".to_owned(),
                retryable: false,
            })?;
        recommendations.recommendation_next(request).await
    }

    fn require_provider(&self, id: &str) -> ProviderResult<Arc<MusicProviderCapabilityFacade>> {
        self.capabilities(id).ok_or_else(|| ProviderCommandError {
            code: "provider-unavailable".to_owned(),
            message: "music provider is unavailable".to_owned(),
            retryable: false,
        })
    }

    fn playback_for_song(
        &self,
        song: &Song,
    ) -> Result<Arc<dyn PlaybackSourceProvider>, PlaybackSourceError> {
        match song.provider.as_ref() {
            Some(reference) => self
                .capabilities(&reference.provider_id)
                .and_then(|provider| provider.playback_arc())
                .ok_or(PlaybackSourceError::TrackUnavailable),
            None => self
                .capabilities(self.default_id.as_str())
                .and_then(|provider| provider.playback_arc())
                .ok_or(PlaybackSourceError::TrackUnavailable),
        }
    }

    fn read_providers(
        &self,
    ) -> std::sync::RwLockReadGuard<'_, HashMap<ProviderId, Arc<MusicProviderCapabilityFacade>>>
    {
        self.providers
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn write_providers(
        &self,
    ) -> std::sync::RwLockWriteGuard<'_, HashMap<ProviderId, Arc<MusicProviderCapabilityFacade>>>
    {
        self.providers
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn read_inactive(
        &self,
    ) -> std::sync::RwLockReadGuard<'_, HashMap<ProviderId, ProviderDescriptor>> {
        self.inactive
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn write_inactive(
        &self,
    ) -> std::sync::RwLockWriteGuard<'_, HashMap<ProviderId, ProviderDescriptor>> {
        self.inactive
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn unsupported_provider_capability(capability: &str) -> ProviderCommandError {
    ProviderCommandError {
        code: "unsupported-operation".to_owned(),
        message: format!("this music provider does not support {capability}"),
        retryable: false,
    }
}

#[async_trait]
impl PlaybackSourceResolver for ProviderRegistry {
    async fn resolve(&self, song: &Song) -> Result<ResolvedPlaybackSource, PlaybackSourceError> {
        self.playback_for_song(song)?.resolve(song).await
    }

    async fn resolve_client_fallback(
        &self,
        song: &Song,
        failed: &PlaybackSourceSelection,
    ) -> Result<ResolvedPlaybackSource, PlaybackSourceError> {
        self.playback_for_song(song)?
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
