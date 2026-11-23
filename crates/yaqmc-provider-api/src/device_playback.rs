//! Experimental remote playback capability. Reports do not acknowledge remote pause.
use crate::Song;
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePlaybackSnapshot {
    pub current_song_id: String,
    pub tracks: Vec<Song>,
    pub updated_at_ms: u64,
    pub queue_truncated: bool,
    /// Core-only account binding; never supplied by a renderer.
    #[serde(skip)]
    pub account_generation: u64,
}

/// Authoritative local state to publish, independent of any remote snapshot.
pub struct PlaybackReport {
    pub current_song_id: String,
    pub tracks: Vec<Song>,
    pub account_generation: u64,
    pub position_ms: u64,
    pub is_playing: bool,
}
