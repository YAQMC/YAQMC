//! Typed validation for values crossing a provider boundary.
//!
//! Serde defaults retain compatibility with the pre-provider/profile wire
//! format. Explicit foreign provider or non-default profile identities are
//! rejected; they are never silently rewritten.

use crate::{
    AccountPlaylistDetail, AccountPlaylistSummary, AccountSnapshot, Album, AreaFeed, Artist,
    ArtistCatalogPage, DiscoverFeed, FeaturedRelease, HomeFeed, LibrarySnapshot, MediaCollection,
    Page, Playlist, PlaylistMutationResult, ProviderCommandError, ProviderProfileKey,
    ProviderResult, ProviderStatus, ProviderTrackReference, RecommendationBatch,
    RemotePlayHistoryItem, SearchResult, ShareTarget, Song,
};

/// A provider-owned DTO that can be checked against the provider boundary.
pub trait ProviderScopedOutput: Sized {
    fn validate_profile_scope(self, profile: &ProviderProfileKey) -> ProviderResult<Self>;

    fn validate_scope(self, provider_id: &str) -> ProviderResult<Self> {
        let profile = ProviderProfileKey::default_profile(provider_id)
            .map_err(|_| invalid_response("the provider scope is invalid"))?;
        self.validate_profile_scope(&profile)
    }
}

fn invalid_response(message: &str) -> ProviderCommandError {
    ProviderCommandError {
        code: "invalid-provider-response".to_owned(),
        message: message.to_owned(),
        retryable: false,
    }
}

fn validate_provider_reference(
    reference: &ProviderTrackReference,
    profile: &ProviderProfileKey,
) -> ProviderResult<()> {
    if reference.provider_id != profile.provider_id {
        return Err(invalid_response(
            "the provider returned a foreign song provider",
        ));
    }
    if reference.profile_id == profile.profile_id {
        Ok(())
    } else {
        Err(invalid_response(
            "the provider returned an unavailable profile",
        ))
    }
}

fn validate_provider_id_and_profile(
    provider: &str,
    profile_id: &str,
    expected: &ProviderProfileKey,
) -> ProviderResult<()> {
    if provider != expected.provider_id {
        return Err(invalid_response("the provider returned a foreign provider"));
    }
    if profile_id != expected.profile_id {
        return Err(invalid_response(
            "the provider returned an unavailable profile",
        ));
    }
    Ok(())
}

impl ProviderScopedOutput for Song {
    fn validate_profile_scope(mut self, profile: &ProviderProfileKey) -> ProviderResult<Self> {
        if let Some(reference) = &self.provider {
            validate_provider_reference(reference, profile)?;
        } else {
            self.provider = Some(ProviderTrackReference {
                provider_id: profile.provider_id.clone(),
                profile_id: profile.profile_id.clone(),
                track_id: self.id.clone(),
                numeric_id: None,
                album_id: None,
                media_id: None,
            });
        }
        Ok(self)
    }
}

impl ProviderScopedOutput for ShareTarget {
    fn validate_profile_scope(self, profile: &ProviderProfileKey) -> ProviderResult<Self> {
        validate_provider_id_and_profile(&self.provider_id, &self.profile_id, profile)?;
        Ok(self)
    }
}

impl ProviderScopedOutput for AccountSnapshot {
    fn validate_profile_scope(self, profile: &ProviderProfileKey) -> ProviderResult<Self> {
        validate_provider_id_and_profile(&self.provider_id, &self.profile_id, profile)?;
        Ok(self)
    }
}

impl ProviderScopedOutput for ProviderStatus {
    fn validate_profile_scope(self, profile: &ProviderProfileKey) -> ProviderResult<Self> {
        validate_provider_id_and_profile(&self.provider_id, &self.profile_id, profile)?;
        Ok(self)
    }
}

impl ProviderScopedOutput for AccountPlaylistSummary {
    fn validate_profile_scope(self, profile: &ProviderProfileKey) -> ProviderResult<Self> {
        validate_provider_id_and_profile(&self.provider_id, &self.profile_id, profile)?;
        Ok(self)
    }
}

impl<T: ProviderScopedOutput> ProviderScopedOutput for Page<T> {
    fn validate_profile_scope(mut self, profile: &ProviderProfileKey) -> ProviderResult<Self> {
        self.items = self
            .items
            .into_iter()
            .map(|item| item.validate_profile_scope(profile))
            .collect::<ProviderResult<Vec<_>>>()?;
        Ok(self)
    }
}

impl ProviderScopedOutput for AccountPlaylistDetail {
    fn validate_profile_scope(mut self, profile: &ProviderProfileKey) -> ProviderResult<Self> {
        self.summary = self.summary.validate_profile_scope(profile)?;
        self.tracks = self.tracks.validate_profile_scope(profile)?;
        Ok(self)
    }
}

impl ProviderScopedOutput for Album {
    fn validate_profile_scope(mut self, profile: &ProviderProfileKey) -> ProviderResult<Self> {
        self.tracks = self
            .tracks
            .into_iter()
            .map(|song| song.validate_profile_scope(profile))
            .collect::<ProviderResult<Vec<_>>>()?;
        Ok(self)
    }
}

impl ProviderScopedOutput for Playlist {
    fn validate_profile_scope(mut self, profile: &ProviderProfileKey) -> ProviderResult<Self> {
        self.tracks = self
            .tracks
            .into_iter()
            .map(|song| song.validate_profile_scope(profile))
            .collect::<ProviderResult<Vec<_>>>()?;
        Ok(self)
    }
}

impl ProviderScopedOutput for Artist {
    fn validate_profile_scope(mut self, profile: &ProviderProfileKey) -> ProviderResult<Self> {
        self.top_songs = self
            .top_songs
            .into_iter()
            .map(|song| song.validate_profile_scope(profile))
            .collect::<ProviderResult<Vec<_>>>()?;
        Ok(self)
    }
}

impl ProviderScopedOutput for FeaturedRelease {
    fn validate_profile_scope(mut self, profile: &ProviderProfileKey) -> ProviderResult<Self> {
        self.album = self.album.validate_profile_scope(profile)?;
        Ok(self)
    }
}

impl ProviderScopedOutput for MediaCollection {
    fn validate_profile_scope(self, profile: &ProviderProfileKey) -> ProviderResult<Self> {
        match self {
            Self::Album(album) => Ok(Self::Album(album.validate_profile_scope(profile)?)),
            Self::Playlist(playlist) => {
                Ok(Self::Playlist(playlist.validate_profile_scope(profile)?))
            }
        }
    }
}

impl ProviderScopedOutput for HomeFeed {
    fn validate_profile_scope(mut self, profile: &ProviderProfileKey) -> ProviderResult<Self> {
        self.featured = self.featured.validate_profile_scope(profile)?;
        self.recently_played = self
            .recently_played
            .into_iter()
            .map(|item| item.validate_profile_scope(profile))
            .collect::<ProviderResult<Vec<_>>>()?;
        self.made_for_you = self
            .made_for_you
            .into_iter()
            .map(|playlist| playlist.validate_profile_scope(profile))
            .collect::<ProviderResult<Vec<_>>>()?;
        self.new_releases = self
            .new_releases
            .into_iter()
            .map(|album| album.validate_profile_scope(profile))
            .collect::<ProviderResult<Vec<_>>>()?;
        self.guess_songlist = self
            .guess_songlist
            .map(|playlist| playlist.validate_profile_scope(profile))
            .transpose()?;
        self.recommended_songlists = self
            .recommended_songlists
            .into_iter()
            .map(|playlist| playlist.validate_profile_scope(profile))
            .collect::<ProviderResult<Vec<_>>>()?;
        self.daily_songlist = self
            .daily_songlist
            .map(|playlist| playlist.validate_profile_scope(profile))
            .transpose()?;
        self.new_song_songlist = self
            .new_song_songlist
            .map(|playlist| playlist.validate_profile_scope(profile))
            .transpose()?;
        self.radar_songs = self
            .radar_songs
            .into_iter()
            .map(|song| song.validate_profile_scope(profile))
            .collect::<ProviderResult<Vec<_>>>()?;
        Ok(self)
    }
}

impl ProviderScopedOutput for DiscoverFeed {
    fn validate_profile_scope(mut self, profile: &ProviderProfileKey) -> ProviderResult<Self> {
        self.charts = self
            .charts
            .into_iter()
            .map(|playlist| playlist.validate_profile_scope(profile))
            .collect::<ProviderResult<Vec<_>>>()?;
        self.new_songs = self
            .new_songs
            .map(|playlist| playlist.validate_profile_scope(profile))
            .transpose()?;
        self.new_albums = self
            .new_albums
            .into_iter()
            .map(|album| album.validate_profile_scope(profile))
            .collect::<ProviderResult<Vec<_>>>()?;
        self.popular_songlists = self
            .popular_songlists
            .into_iter()
            .map(|playlist| playlist.validate_profile_scope(profile))
            .collect::<ProviderResult<Vec<_>>>()?;
        Ok(self)
    }
}

impl ProviderScopedOutput for AreaFeed {
    fn validate_profile_scope(mut self, profile: &ProviderProfileKey) -> ProviderResult<Self> {
        self.songlists = self
            .songlists
            .into_iter()
            .map(|playlist| playlist.validate_profile_scope(profile))
            .collect::<ProviderResult<Vec<_>>>()?;
        self.playlists = self
            .playlists
            .into_iter()
            .map(|playlist| playlist.validate_profile_scope(profile))
            .collect::<ProviderResult<Vec<_>>>()?;
        Ok(self)
    }
}

impl ProviderScopedOutput for LibrarySnapshot {
    fn validate_profile_scope(mut self, profile: &ProviderProfileKey) -> ProviderResult<Self> {
        self.favorite_songs = self
            .favorite_songs
            .into_iter()
            .map(|song| song.validate_profile_scope(profile))
            .collect::<ProviderResult<Vec<_>>>()?;
        self.saved_albums = self
            .saved_albums
            .into_iter()
            .map(|album| album.validate_profile_scope(profile))
            .collect::<ProviderResult<Vec<_>>>()?;
        self.saved_playlists = self
            .saved_playlists
            .into_iter()
            .map(|playlist| playlist.validate_profile_scope(profile))
            .collect::<ProviderResult<Vec<_>>>()?;
        Ok(self)
    }
}

impl ProviderScopedOutput for SearchResult {
    fn validate_profile_scope(self, profile: &ProviderProfileKey) -> ProviderResult<Self> {
        match self {
            Self::Song {
                query,
                page,
                has_more,
                items,
            } => Ok(Self::Song {
                query,
                page,
                has_more,
                items: items
                    .into_iter()
                    .map(|song| song.validate_profile_scope(profile))
                    .collect::<ProviderResult<Vec<_>>>()?,
            }),
            other => Ok(other),
        }
    }
}

impl ProviderScopedOutput for ArtistCatalogPage {
    fn validate_profile_scope(self, profile: &ProviderProfileKey) -> ProviderResult<Self> {
        match self {
            Self::Song {
                artist_id,
                page,
                has_more,
                items,
            } => Ok(Self::Song {
                artist_id,
                page,
                has_more,
                items: items
                    .into_iter()
                    .map(|song| song.validate_profile_scope(profile))
                    .collect::<ProviderResult<Vec<_>>>()?,
            }),
            other => Ok(other),
        }
    }
}

impl ProviderScopedOutput for RecommendationBatch {
    fn validate_profile_scope(mut self, profile: &ProviderProfileKey) -> ProviderResult<Self> {
        self.songs = self
            .songs
            .into_iter()
            .map(|song| song.validate_profile_scope(profile))
            .collect::<ProviderResult<Vec<_>>>()?;
        Ok(self)
    }
}

impl ProviderScopedOutput for RemotePlayHistoryItem {
    fn validate_profile_scope(mut self, profile: &ProviderProfileKey) -> ProviderResult<Self> {
        self.song = self.song.validate_profile_scope(profile)?;
        Ok(self)
    }
}

impl ProviderScopedOutput for PlaylistMutationResult {
    fn validate_profile_scope(mut self, profile: &ProviderProfileKey) -> ProviderResult<Self> {
        self.playlist = self
            .playlist
            .map(|playlist| playlist.validate_profile_scope(profile))
            .transpose()?;
        Ok(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn summary(provider_id: &str) -> AccountPlaylistSummary {
        serde_json::from_value(json!({
            "providerId": provider_id,
            "profileId": "default",
            "id": "playlist-1",
            "reference": {"kind": "owned", "tid": "tid-1"},
            "title": "Playlist",
            "description": "",
            "owner": {"id": "owner-1", "displayName": "Owner"},
            "artwork": {"src": "", "alt": "", "dominantColor": ""},
            "ownership": "owned",
            "capabilities": {
                "canAddTracks": true,
                "canRemoveTracks": true,
                "canRename": true,
                "canDelete": true,
                "canReorder": true
            },
            "trackCount": 0,
            "updatedAtMs": null
        }))
        .expect("playlist summary fixture")
    }

    #[test]
    fn playlist_scope_rejects_foreign_provider_and_profile() {
        assert!(summary("qqmusic").validate_scope("qqmusic").is_ok());
        assert!(summary("other-provider").validate_scope("qqmusic").is_err());
        let mut foreign_profile = summary("qqmusic");
        foreign_profile.profile_id = "other-profile".to_owned();
        assert!(foreign_profile.validate_scope("qqmusic").is_err());
    }

    #[test]
    fn exact_profile_scope_accepts_only_the_selected_profile() {
        let work = ProviderProfileKey::new("qqmusic", "work").expect("work profile");
        let mut work_summary = summary("qqmusic");
        work_summary.profile_id = "work".to_owned();
        assert!(work_summary.validate_profile_scope(&work).is_ok());
        assert!(summary("qqmusic").validate_profile_scope(&work).is_err());
    }
}
