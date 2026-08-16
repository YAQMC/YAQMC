use super::account::{AccountEntitlement, AccountPlaylistSummary, AccountProfile};
use serde::{de::Error as _, Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use yaqmc_core::playback_types::PlaybackEpoch;

pub(crate) const ACCOUNT_CACHE_KIND: &str = "qqmusic-account";
const CURSOR_PREFIX: &str = "cursor:";
const MAX_CURSOR_ENTRIES: usize = 512;
const MAX_COMPLETED_MUTATIONS: usize = 256;
const MAX_TRACK_REFERENCES: usize = 4_096;

#[derive(Clone, Eq, Hash, PartialEq)]
pub(crate) struct OpaqueAccountScope(String);

impl OpaqueAccountScope {
    pub(crate) fn generate() -> Self {
        Self(format!("{:032x}", rand::random::<u128>()))
    }

    pub(crate) fn parse(value: impl Into<String>) -> Result<Self, ()> {
        let value = value.into();
        if value.len() == 32
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            Ok(Self(value))
        } else {
            Err(())
        }
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

impl Serialize for OpaqueAccountScope {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for OpaqueAccountScope {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(value).map_err(|()| D::Error::custom("invalid opaque account scope"))
    }
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct AccountEpoch {
    pub(crate) generation: u64,
    pub(crate) scope: OpaqueAccountScope,
}

impl AccountEpoch {
    pub(crate) fn playback_epoch(&self) -> PlaybackEpoch {
        PlaybackEpoch::new(self.generation, self.scope.as_str())
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountLibraryProjection {
    pub(crate) favorite_ids: Vec<String>,
    pub(crate) playlists: Vec<AccountPlaylistSummary>,
    pub(crate) profile: AccountProfile,
    pub(crate) entitlement: AccountEntitlement,
    pub(crate) fetched_at_ms: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CachedAccountPage<T> {
    pub(crate) items: Vec<T>,
    pub(crate) total: Option<u64>,
    pub(crate) fetched_at_ms: u64,
    pub(crate) expires_at_ms: u64,
    pub(crate) terminal: bool,
}

pub(crate) struct AccountCache;

impl AccountCache {
    pub(crate) fn projection_key(scope: &OpaqueAccountScope) -> String {
        format!("qqmusic:account:{}:projection-v3", scope.as_str())
    }

    pub(crate) fn favorites_key(
        scope: &OpaqueAccountScope,
        outward_cursor: Option<&str>,
    ) -> String {
        format!(
            "{}favorites:{}",
            Self::scope_prefix(scope),
            cursor_digest(outward_cursor)
        )
    }

    pub(crate) fn playlists_key(
        scope: &OpaqueAccountScope,
        outward_cursor: Option<&str>,
    ) -> String {
        format!(
            "{}playlists-v3:{}",
            Self::scope_prefix(scope),
            cursor_digest(outward_cursor)
        )
    }

    pub(crate) fn playlist_tracks_key(
        scope: &OpaqueAccountScope,
        playlist_id: &str,
        outward_cursor: Option<&str>,
    ) -> String {
        format!(
            "{}playlist-v3:{}:tracks:{}",
            Self::scope_prefix(scope),
            stable_key_component(playlist_id),
            cursor_digest(outward_cursor)
        )
    }

    pub(crate) fn recent_key(scope: &OpaqueAccountScope, outward_cursor: Option<&str>) -> String {
        format!(
            "{}recent:{}",
            Self::scope_prefix(scope),
            cursor_digest(outward_cursor)
        )
    }

    pub(crate) fn scope_prefix(scope: &OpaqueAccountScope) -> String {
        format!("qqmusic:account:{}:", scope.as_str())
    }

    pub(crate) fn favorites_prefix(scope: &OpaqueAccountScope) -> String {
        format!("{}favorites:", Self::scope_prefix(scope))
    }

    pub(crate) fn playlists_prefix(scope: &OpaqueAccountScope) -> String {
        format!("{}playlists-v3:", Self::scope_prefix(scope))
    }

    pub(crate) fn playlist_tracks_prefix(scope: &OpaqueAccountScope, playlist_id: &str) -> String {
        format!(
            "{}playlist-v3:{}:tracks:",
            Self::scope_prefix(scope),
            stable_key_component(playlist_id)
        )
    }
}

pub(crate) struct CompletedResultCache<T> {
    epoch: Option<AccountEpoch>,
    entries: HashMap<String, T>,
    order: VecDeque<String>,
}

impl<T> Default for CompletedResultCache<T> {
    fn default() -> Self {
        Self {
            epoch: None,
            entries: HashMap::new(),
            order: VecDeque::new(),
        }
    }
}

impl<T: Clone> CompletedResultCache<T> {
    pub(crate) fn get(&mut self, epoch: &AccountEpoch, operation_id: &str) -> Option<T> {
        self.ensure_epoch(epoch);
        self.entries.get(operation_id).cloned()
    }

    pub(crate) fn insert_if_current(
        &mut self,
        epoch: &AccountEpoch,
        operation_id: String,
        result: T,
    ) {
        self.ensure_epoch(epoch);
        if !self.entries.contains_key(&operation_id) {
            self.order.push_back(operation_id.clone());
        }
        self.entries.insert(operation_id, result);
        while self.entries.len() > MAX_COMPLETED_MUTATIONS {
            if let Some(expired) = self.order.pop_front() {
                self.entries.remove(&expired);
            }
        }
    }

    pub(crate) fn clear(&mut self) {
        self.epoch = None;
        self.entries.clear();
        self.order.clear();
    }

    fn ensure_epoch(&mut self, epoch: &AccountEpoch) {
        if self.epoch.as_ref() != Some(epoch) {
            self.clear();
            self.epoch = Some(epoch.clone());
        }
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }
}

#[derive(Default)]
pub(crate) struct ProviderTrackRegistry {
    numeric_ids: HashMap<String, u64>,
    order: VecDeque<String>,
}

impl ProviderTrackRegistry {
    pub(crate) fn remember(&mut self, stable_id: String, numeric_id: u64) {
        if numeric_id == 0 {
            return;
        }
        if !self.numeric_ids.contains_key(&stable_id) {
            self.order.push_back(stable_id.clone());
        }
        self.numeric_ids.insert(stable_id, numeric_id);
        while self.numeric_ids.len() > MAX_TRACK_REFERENCES {
            if let Some(expired) = self.order.pop_front() {
                self.numeric_ids.remove(&expired);
            }
        }
    }

    pub(crate) fn numeric_id(&self, stable_id: &str) -> Option<u64> {
        self.numeric_ids.get(stable_id).copied()
    }
}

#[derive(Clone)]
struct CursorEntry {
    epoch: AccountEpoch,
    resource: String,
    provider_cursor: String,
}

#[derive(Default)]
pub(crate) struct OpaqueCursorRegistry {
    epoch: Option<AccountEpoch>,
    entries: HashMap<String, CursorEntry>,
    order: VecDeque<String>,
}

impl OpaqueCursorRegistry {
    pub(crate) fn issue(
        &mut self,
        epoch: &AccountEpoch,
        resource: &str,
        provider_cursor: String,
    ) -> String {
        self.ensure_epoch(epoch);
        let token = loop {
            let candidate = format!("{CURSOR_PREFIX}{:032x}", rand::random::<u128>());
            if !self.entries.contains_key(&candidate) {
                break candidate;
            }
        };
        self.entries.insert(
            token.clone(),
            CursorEntry {
                epoch: epoch.clone(),
                resource: resource.to_owned(),
                provider_cursor,
            },
        );
        self.order.push_back(token.clone());
        while self.entries.len() > MAX_CURSOR_ENTRIES {
            if let Some(expired) = self.order.pop_front() {
                self.entries.remove(&expired);
            }
        }
        token
    }

    pub(crate) fn resolve(
        &mut self,
        epoch: &AccountEpoch,
        resource: &str,
        token: &str,
    ) -> Option<String> {
        self.ensure_epoch(epoch);
        let entry = self.entries.get(token)?;
        (entry.epoch == *epoch && entry.resource == resource).then(|| entry.provider_cursor.clone())
    }

    pub(crate) fn clear(&mut self) {
        self.epoch = None;
        self.entries.clear();
        self.order.clear();
    }

    fn ensure_epoch(&mut self, epoch: &AccountEpoch) {
        if self.epoch.as_ref() != Some(epoch) {
            self.clear();
            self.epoch = Some(epoch.clone());
        }
    }
}

fn cursor_digest(outward_cursor: Option<&str>) -> String {
    let value = outward_cursor.unwrap_or("first");
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn stable_key_component(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':') {
                character
            } else {
                '_'
            }
        })
        .take(160)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::player::Song;
    use serde_json::Value;

    fn scope(value: char) -> OpaqueAccountScope {
        OpaqueAccountScope::parse(value.to_string().repeat(32)).expect("valid scope")
    }

    #[test]
    fn account_cache_scope_is_random_validated_and_contains_no_identity() {
        let scope = OpaqueAccountScope::generate();
        assert_eq!(scope.as_str().len(), 32);
        assert!(scope
            .as_str()
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
        let key = AccountCache::projection_key(&scope);
        assert!(!key.contains("10001"));
        assert_eq!(
            key,
            format!("qqmusic:account:{}:projection-v3", scope.as_str())
        );
        assert!(
            serde_json::from_str::<OpaqueAccountScope>("\"ABCDEF0123456789ABCDEF0123456789\"")
                .is_err()
        );
        assert!(serde_json::from_str::<OpaqueAccountScope>("\"scope-user\"").is_err());
    }

    #[test]
    fn cache_keys_hash_only_outward_cursors() {
        let scope = scope('a');
        let key = AccountCache::favorites_key(&scope, Some("cursor:opaque"));
        assert!(key.starts_with(&format!("qqmusic:account:{}:favorites:", scope.as_str())));
        assert!(!key.contains("cursor:opaque"));
        assert_eq!(key.rsplit(':').next().expect("digest").len(), 64);
    }

    #[test]
    fn playlist_identity_schema_uses_v3_keys_and_cannot_read_v2_entries() {
        let scope = scope('a');
        let list_key = AccountCache::playlists_key(&scope, None);
        let detail_key =
            AccountCache::playlist_tracks_key(&scope, "qqmusic:account-collection:favorites", None);
        assert!(list_key.contains("playlists-v3:"));
        assert!(detail_key.contains("playlist-v3:"));
        assert!(!list_key.contains("playlists-v2:"));
        assert!(!detail_key.contains("playlist-v2:"));
    }

    #[test]
    fn completed_results_are_bounded_and_scoped_to_one_account_epoch() {
        let first_epoch = AccountEpoch {
            generation: 1,
            scope: scope('a'),
        };
        let second_epoch = AccountEpoch {
            generation: 2,
            scope: scope('b'),
        };
        let mut cache = CompletedResultCache::default();
        for index in 0..300 {
            cache.insert_if_current(&first_epoch, format!("operation-{index:03}"), index);
        }
        assert_eq!(cache.len(), MAX_COMPLETED_MUTATIONS);
        assert!(cache.get(&first_epoch, "operation-000").is_none());
        assert_eq!(cache.get(&first_epoch, "operation-299"), Some(299));

        assert!(cache.get(&second_epoch, "operation-299").is_none());
        assert_eq!(cache.len(), 0);
    }

    #[test]
    fn provider_track_references_are_bounded_and_keep_numeric_wire_ids() {
        let mut registry = ProviderTrackRegistry::default();
        for index in 1..=4_100_u64 {
            registry.remember(format!("qqmusic:track:MID-{index}"), index);
        }
        assert_eq!(registry.numeric_id("qqmusic:track:MID-1"), None);
        assert_eq!(registry.numeric_id("qqmusic:track:MID-4100"), Some(4_100));
    }

    #[test]
    fn cursor_registry_is_resource_and_epoch_scoped_and_bounded() {
        let first_epoch = AccountEpoch {
            generation: 7,
            scope: scope('a'),
        };
        let second_epoch = AccountEpoch {
            generation: 8,
            scope: scope('b'),
        };
        let mut registry = OpaqueCursorRegistry::default();
        let token = registry.issue(&first_epoch, "favorites", "provider:2".to_owned());
        assert_eq!(token.len(), CURSOR_PREFIX.len() + 32);
        assert!(token.starts_with(CURSOR_PREFIX));
        assert!(!token.contains("provider"));
        assert_eq!(
            registry
                .resolve(&first_epoch, "favorites", &token)
                .as_deref(),
            Some("provider:2")
        );
        assert!(registry.resolve(&first_epoch, "recent", &token).is_none());
        assert!(registry
            .resolve(&second_epoch, "favorites", &token)
            .is_none());

        for index in 0..=MAX_CURSOR_ENTRIES {
            registry.issue(&second_epoch, "favorites", index.to_string());
        }
        assert_eq!(registry.entries.len(), MAX_CURSOR_ENTRIES);
    }

    #[test]
    fn cached_pages_cannot_serialize_live_or_provider_cursors() {
        let cached = CachedAccountPage::<Song> {
            items: Vec::new(),
            total: Some(3),
            fetched_at_ms: 1_000,
            expires_at_ms: 2_000,
            terminal: false,
        };
        let json = serde_json::to_string(&cached).expect("cached page serializes");
        assert!(!json.to_ascii_lowercase().contains("cursor"));
        assert!(!json.contains("provider:2"));
        assert_eq!(
            serde_json::from_str::<Value>(&json).unwrap()["terminal"],
            false
        );
    }
}
