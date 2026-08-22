//! Immutable registry of provider trait objects.

use crate::{
    MusicProvider, PlaybackSourceError, PlaybackSourceResolver, PlaybackSourceSelection,
    ResolvedPlaybackSource, Song,
};
use async_trait::async_trait;
use std::{collections::HashMap, fmt, sync::Arc};

#[derive(Debug, Eq, PartialEq)]
pub enum ProviderRegistryError {
    Empty,
    DuplicateId(&'static str),
    MissingDefault(&'static str),
}

impl fmt::Display for ProviderRegistryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => formatter.write_str("at least one music provider is required"),
            Self::DuplicateId(id) => write!(formatter, "duplicate music provider id: {id}"),
            Self::MissingDefault(id) => {
                write!(formatter, "default music provider is missing: {id}")
            }
        }
    }
}

impl std::error::Error for ProviderRegistryError {}

pub struct ProviderRegistry {
    providers: HashMap<&'static str, Arc<dyn MusicProvider>>,
    default_id: &'static str,
}

impl ProviderRegistry {
    pub fn new(
        default_id: &'static str,
        providers: impl IntoIterator<Item = Arc<dyn MusicProvider>>,
    ) -> Result<Self, ProviderRegistryError> {
        let mut registry = HashMap::new();
        for provider in providers {
            let id = provider.id();
            if registry.insert(id, provider).is_some() {
                return Err(ProviderRegistryError::DuplicateId(id));
            }
        }
        if registry.is_empty() {
            return Err(ProviderRegistryError::Empty);
        }
        if !registry.contains_key(default_id) {
            return Err(ProviderRegistryError::MissingDefault(default_id));
        }
        Ok(Self {
            providers: registry,
            default_id,
        })
    }

    pub fn provider(&self, id: &str) -> Option<Arc<dyn MusicProvider>> {
        self.providers.get(id).map(Arc::clone)
    }

    pub fn default_provider(&self) -> Arc<dyn MusicProvider> {
        Arc::clone(
            self.providers
                .get(self.default_id)
                .expect("ProviderRegistry validates its default provider"),
        )
    }

    fn provider_for_song(&self, song: &Song) -> Arc<dyn MusicProvider> {
        song.provider
            .as_ref()
            .and_then(|reference| self.provider(&reference.provider_id))
            .unwrap_or_else(|| self.default_provider())
    }
}

#[async_trait]
impl PlaybackSourceResolver for ProviderRegistry {
    async fn resolve(&self, song: &Song) -> Result<ResolvedPlaybackSource, PlaybackSourceError> {
        self.provider_for_song(song).resolve(song).await
    }

    async fn resolve_client_fallback(
        &self,
        song: &Song,
        failed: &PlaybackSourceSelection,
    ) -> Result<ResolvedPlaybackSource, PlaybackSourceError> {
        self.provider_for_song(song)
            .resolve_client_fallback(song, failed)
            .await
    }
}
