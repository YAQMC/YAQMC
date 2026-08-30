use std::{collections::BTreeSet, sync::Arc};

use async_trait::async_trait;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use thiserror::Error;
use yaqmc_provider_api::{
    Album, AreaFeed, Artist, ArtistCatalogKind, ArtistCatalogPage, AudioQualityPreference,
    CacheStats, CatalogProvider, CatalogProviderCapabilities, CatalogSearchKind, DiscoverFeed,
    HomeFeed, LibrarySnapshot, Playlist, ProviderCapabilities, ProviderCommandError,
    ProviderResult, ProviderStatus, SearchResult, Song,
};

use crate::plugin::{
    component::{ComponentRuntimeError, ProviderComponent},
    manifest::{PluginManifest, ProviderCapability},
};

const MAX_CATALOG_VALUE_DEPTH: usize = 64;
const MAX_CATALOG_VALUE_NODES: usize = 100_000;
const MAX_CATALOG_STRING_BYTES: usize = 1024 * 1024;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ComponentProviderError {
    #[error("the plugin manifest does not declare a provider component")]
    MissingProvider,
    #[error("the provider component could not be loaded")]
    Runtime(#[from] ComponentRuntimeError),
}

/// Capability adapter between the frozen Plugin API v3 envelope and Core's
/// provider-neutral contracts. The component never receives Core trait objects.
pub struct ComponentProviderAdapter {
    provider_id: String,
    display_name: String,
    component: ProviderComponent,
    declared: BTreeSet<ProviderCapability>,
}

impl ComponentProviderAdapter {
    pub fn from_manifest(
        manifest: &PluginManifest,
        component_bytes: &[u8],
    ) -> Result<Arc<Self>, ComponentProviderError> {
        let provider = manifest
            .provider
            .as_ref()
            .ok_or(ComponentProviderError::MissingProvider)?;
        let declared = provider
            .capabilities
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();
        let component = ProviderComponent::load(component_bytes, declared.iter().copied())?;
        Ok(Arc::new(Self {
            provider_id: provider.id.clone(),
            display_name: provider
                .name
                .clone()
                .unwrap_or_else(|| manifest.name.clone()),
            component,
            declared,
        }))
    }

    pub fn provider_id(&self) -> &str {
        &self.provider_id
    }

    pub fn component(&self) -> &ProviderComponent {
        &self.component
    }

    pub fn registry_capabilities(self: &Arc<Self>) -> ProviderCapabilities {
        ProviderCapabilities {
            catalog: self
                .declared
                .contains(&ProviderCapability::Catalog)
                .then(|| Arc::clone(self) as Arc<dyn CatalogProvider>),
            ..ProviderCapabilities::default()
        }
    }

    async fn call<Req, Response>(
        &self,
        capability: ProviderCapability,
        operation: &str,
        request: &Req,
    ) -> ProviderResult<Response>
    where
        Req: Serialize + ?Sized,
        Response: DeserializeOwned,
    {
        let payload = serde_json::to_string(request)
            .map_err(|_| ProviderCommandError::invalid_request("provider request is invalid"))?;
        let response = self
            .component
            .invoke(capability, operation, &payload)
            .await
            .map_err(map_runtime_error)?;
        let mut value: Value =
            serde_json::from_str(&response).map_err(|_| ProviderCommandError {
                code: "invalid-provider-response".to_owned(),
                message: "the provider returned malformed JSON".to_owned(),
                retryable: false,
            })?;
        let mut nodes = 0;
        validate_value(&value, 0, &mut nodes)?;
        enforce_provider_scope(&mut value, &self.provider_id);
        serde_json::from_value(value).map_err(|_| ProviderCommandError {
            code: "invalid-provider-response".to_owned(),
            message: "the provider response does not match the requested operation".to_owned(),
            retryable: false,
        })
    }

    fn catalog_capability_projection(&self) -> CatalogProviderCapabilities {
        CatalogProviderCapabilities {
            search: true,
            album: true,
            artist: true,
            playlist: true,
            lyrics: self.declared.contains(&ProviderCapability::Lyrics),
            word_timed_lyrics: self.declared.contains(&ProviderCapability::Lyrics),
            streaming: self.declared.contains(&ProviderCapability::Playback),
            quality_selection: self.declared.contains(&ProviderCapability::Playback),
        }
    }
}

#[async_trait]
impl CatalogProvider for ComponentProviderAdapter {
    fn catalog_capabilities(&self) -> CatalogProviderCapabilities {
        self.catalog_capability_projection()
    }

    async fn catalog_status(&self) -> ProviderStatus {
        ProviderStatus {
            provider_id: self.provider_id.clone(),
            display_name: self.display_name.clone(),
            connection: if self.component.circuit_open() {
                "circuit-open".to_owned()
            } else if self.component.enabled() {
                "ready".to_owned()
            } else {
                "disabled".to_owned()
            },
            message: String::new(),
            preferred_quality: AudioQualityPreference::Automatic,
            capabilities: self.catalog_capability_projection(),
        }
    }

    async fn catalog_search(
        &self,
        query: String,
        kind: CatalogSearchKind,
        page: u32,
        limit: u32,
    ) -> ProviderResult<SearchResult> {
        self.call(
            ProviderCapability::Catalog,
            "catalog.search",
            &json!({ "query": query, "kind": kind, "page": page, "limit": limit }),
        )
        .await
    }

    async fn catalog_song(&self, id: String) -> ProviderResult<Song> {
        self.call(
            ProviderCapability::Catalog,
            "catalog.song",
            &json!({ "id": id }),
        )
        .await
    }

    async fn catalog_album(&self, id: String) -> ProviderResult<Album> {
        self.call(
            ProviderCapability::Catalog,
            "catalog.album",
            &json!({ "id": id }),
        )
        .await
    }

    async fn catalog_artist(&self, id: String) -> ProviderResult<Artist> {
        self.call(
            ProviderCapability::Catalog,
            "catalog.artist",
            &json!({ "id": id }),
        )
        .await
    }

    async fn catalog_artist_page(
        &self,
        id: String,
        kind: ArtistCatalogKind,
        page: u32,
        limit: u32,
    ) -> ProviderResult<ArtistCatalogPage> {
        self.call(
            ProviderCapability::Catalog,
            "catalog.artist-page",
            &json!({ "id": id, "kind": kind, "page": page, "limit": limit }),
        )
        .await
    }

    async fn catalog_playlist(&self, id: String) -> ProviderResult<Playlist> {
        self.call(
            ProviderCapability::Catalog,
            "catalog.playlist",
            &json!({ "id": id }),
        )
        .await
    }

    async fn catalog_home(&self, refresh: bool) -> ProviderResult<HomeFeed> {
        self.call(
            ProviderCapability::Catalog,
            "catalog.home",
            &json!({ "refresh": refresh }),
        )
        .await
    }

    async fn catalog_discover(&self, refresh: bool) -> ProviderResult<DiscoverFeed> {
        self.call(
            ProviderCapability::Catalog,
            "catalog.discover",
            &json!({ "refresh": refresh }),
        )
        .await
    }

    async fn catalog_area(&self, enc_area: String) -> ProviderResult<AreaFeed> {
        self.call(
            ProviderCapability::Catalog,
            "catalog.area",
            &json!({ "encArea": enc_area }),
        )
        .await
    }

    fn catalog_library(&self) -> LibrarySnapshot {
        LibrarySnapshot::default()
    }

    async fn catalog_artwork_data_uri(&self, url: String) -> ProviderResult<String> {
        self.call(
            ProviderCapability::Catalog,
            "catalog.artwork-data-uri",
            &json!({ "url": url }),
        )
        .await
    }

    fn catalog_cache_stats(&self) -> ProviderResult<CacheStats> {
        Err(unsupported("component cache statistics"))
    }

    fn catalog_clear_cache(&self) -> ProviderResult<CacheStats> {
        Err(unsupported("component cache clearing"))
    }

    async fn catalog_remember_songs(&self, _songs: &[Song]) {}
}

fn unsupported(operation: &str) -> ProviderCommandError {
    ProviderCommandError {
        code: "unsupported-operation".to_owned(),
        message: format!("this provider does not support {operation}"),
        retryable: false,
    }
}

fn map_runtime_error(error: ComponentRuntimeError) -> ProviderCommandError {
    match error {
        ComponentRuntimeError::Guest(message) => {
            serde_json::from_str(&message).unwrap_or(ProviderCommandError {
                code: "provider-operation-failed".to_owned(),
                message: "the provider rejected the operation".to_owned(),
                retryable: false,
            })
        }
        ComponentRuntimeError::Deadline => ProviderCommandError {
            code: "provider-timeout".to_owned(),
            message: "the provider operation timed out".to_owned(),
            retryable: true,
        },
        ComponentRuntimeError::CircuitOpen => ProviderCommandError {
            code: "provider-circuit-open".to_owned(),
            message: "the provider was disabled after repeated sandbox faults".to_owned(),
            retryable: false,
        },
        ComponentRuntimeError::Disabled | ComponentRuntimeError::Cancelled => {
            ProviderCommandError {
                code: "provider-unavailable".to_owned(),
                message: "the provider is disabled".to_owned(),
                retryable: false,
            }
        }
        ComponentRuntimeError::CapabilityDenied => ProviderCommandError {
            code: "unsupported-operation".to_owned(),
            message: "the provider capability was not granted".to_owned(),
            retryable: false,
        },
        ComponentRuntimeError::InvalidComponent
        | ComponentRuntimeError::OversizedResponse
        | ComponentRuntimeError::SandboxFault => ProviderCommandError {
            code: "provider-sandbox-fault".to_owned(),
            message: "the provider sandbox rejected the operation".to_owned(),
            retryable: false,
        },
    }
}

fn validate_value(value: &Value, depth: usize, nodes: &mut usize) -> ProviderResult<()> {
    *nodes = nodes.saturating_add(1);
    if depth > MAX_CATALOG_VALUE_DEPTH || *nodes > MAX_CATALOG_VALUE_NODES {
        return Err(invalid_response("the provider response is too complex"));
    }
    match value {
        Value::String(value) if value.len() > MAX_CATALOG_STRING_BYTES => Err(invalid_response(
            "the provider response contains an oversized string",
        )),
        Value::Array(values) => {
            for value in values {
                validate_value(value, depth + 1, nodes)?;
            }
            Ok(())
        }
        Value::Object(values) => {
            for value in values.values() {
                validate_value(value, depth + 1, nodes)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn invalid_response(message: &str) -> ProviderCommandError {
    ProviderCommandError {
        code: "invalid-provider-response".to_owned(),
        message: message.to_owned(),
        retryable: false,
    }
}

fn enforce_provider_scope(value: &mut Value, provider_id: &str) {
    match value {
        Value::Array(values) => {
            for value in values {
                enforce_provider_scope(value, provider_id);
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                enforce_provider_scope(value, provider_id);
            }
            if looks_like_song(values) {
                let track_id = values
                    .get("provider")
                    .and_then(Value::as_object)
                    .and_then(|provider| provider.get("trackId"))
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .or_else(|| values.get("id").and_then(Value::as_str))
                    .unwrap_or_default()
                    .to_owned();
                let provider = values
                    .entry("provider".to_owned())
                    .or_insert_with(|| json!({}));
                if let Some(provider) = provider.as_object_mut() {
                    provider.insert("providerId".to_owned(), json!(provider_id));
                    provider.insert("trackId".to_owned(), json!(track_id));
                }
            }
            if values.contains_key("entityKind") && values.contains_key("entityId") {
                values.insert("providerId".to_owned(), json!(provider_id));
            }
        }
        _ => {}
    }
}

fn looks_like_song(values: &serde_json::Map<String, Value>) -> bool {
    [
        "id",
        "title",
        "artists",
        "album",
        "artwork",
        "durationMs",
        "quality",
        "availability",
    ]
    .iter()
    .all(|key| values.contains_key(*key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::{component::static_test_component, manifest::PluginManifest};

    fn manifest() -> PluginManifest {
        PluginManifest::parse(
            br#"{
                "manifestVersion": 2,
                "id": "dev.example.catalog",
                "name": "Example Catalog",
                "version": "1.0.0",
                "apiVersion": 3,
                "entrypoints": { "component": "component/provider.wasm" },
                "provider": {
                    "id": "dev.example.catalog",
                    "witVersion": "0.1.0",
                    "world": "provider",
                    "capabilities": ["provider.catalog"]
                },
                "permissions": ["provider.catalog"]
            }"#,
        )
        .expect("manifest")
    }

    fn adapter(response: Value) -> Arc<ComponentProviderAdapter> {
        let source = static_test_component(&serde_json::to_string(&response).expect("response"));
        ComponentProviderAdapter::from_manifest(&manifest(), source.as_bytes()).expect("adapter")
    }

    fn song() -> Value {
        json!({
            "id": "song-1",
            "title": "Fixture Song",
            "artists": [{ "id": "artist-1", "name": "Fixture Artist" }],
            "album": { "id": "album-1", "title": "Fixture Album" },
            "artwork": { "src": "", "alt": "Fixture", "dominantColor": "#000000" },
            "durationMs": 180000,
            "trackNumber": 1,
            "isFavorite": false,
            "quality": "standard",
            "availability": { "status": "available" },
            "provider": { "providerId": "spoofed", "trackId": "song-1" }
        })
    }

    #[tokio::test]
    async fn read_only_catalog_component_searches_and_opens_entities() {
        let search = adapter(json!({
            "kind": "song",
            "query": "fixture",
            "page": 1,
            "hasMore": false,
            "items": [song()]
        }));
        let result = search
            .catalog_search("fixture".to_owned(), CatalogSearchKind::Song, 1, 20)
            .await
            .expect("search");
        let SearchResult::Song { items, .. } = result else {
            panic!("song result")
        };
        assert_eq!(
            items[0].provider.as_ref().expect("provider").provider_id,
            "dev.example.catalog"
        );

        let opened_song = adapter(song())
            .catalog_song("song-1".to_owned())
            .await
            .expect("song");
        assert_eq!(opened_song.title, "Fixture Song");

        let album = adapter(json!({
            "id": "album-1",
            "title": "Fixture Album",
            "artist": { "id": "artist-1", "name": "Fixture Artist" },
            "artwork": { "src": "", "alt": "Fixture", "dominantColor": "#000000" },
            "releaseYear": 2026,
            "genre": "",
            "description": "",
            "tracks": [song()]
        }))
        .catalog_album("album-1".to_owned())
        .await
        .expect("album");
        assert_eq!(album.tracks.len(), 1);

        let artist = adapter(json!({
            "id": "artist-1",
            "name": "Fixture Artist",
            "artwork": { "src": "", "alt": "Fixture", "dominantColor": "#000000" },
            "description": "",
            "topSongs": [song()],
            "albums": []
        }))
        .catalog_artist("artist-1".to_owned())
        .await
        .expect("artist");
        assert_eq!(artist.top_songs[0].title, "Fixture Song");
    }

    #[tokio::test]
    async fn registry_projection_exposes_only_declared_component_capabilities() {
        let adapter = adapter(json!({}));
        let capabilities = adapter.registry_capabilities();
        assert!(capabilities.catalog.is_some());
        assert!(capabilities.playback.is_none());
        assert!(capabilities.account.is_none());
        adapter.component().disable();
        assert_eq!(
            adapter.catalog_status().await.connection,
            "disabled".to_owned()
        );
    }
}
