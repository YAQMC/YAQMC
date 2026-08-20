//! Stable player and lyric values shared by Core and providers.

use crate::playback::{AudioFormatInfo, AudioQuality};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtworkVariant {
    pub src: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Artwork {
    pub src: String,
    pub alt: String,
    pub dominant_color: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub variants: Vec<ArtworkVariant>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ArtistSummary {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct AlbumSummary {
    pub id: String,
    pub title: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTrackReference {
    pub provider_id: String,
    pub track_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub numeric_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub album_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum PlaybackCapability {
    Full,
    Preview {
        #[serde(rename = "startMs")]
        start_ms: u64,
        #[serde(rename = "endMs")]
        end_ms: u64,
    },
    Unavailable {
        reason: String,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum SongAvailability {
    Available,
    Unavailable {
        reason: String,
    },
    EntitlementRequired {
        #[serde(rename = "requiredTier")]
        required_tier: String,
    },
}

impl SongAvailability {
    #[doc(hidden)]
    pub fn is_available(&self) -> bool {
        matches!(self, Self::Available | Self::EntitlementRequired { .. })
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Song {
    pub id: String,
    pub title: String,
    pub artists: Vec<ArtistSummary>,
    pub album: AlbumSummary,
    pub artwork: Artwork,
    pub duration_ms: u64,
    pub track_number: u32,
    pub is_favorite: bool,
    pub quality: AudioQuality,
    pub availability: SongAvailability,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub audio_formats: Vec<AudioFormatInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playback_capability: Option<PlaybackCapability>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<ProviderTrackReference>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricVocalist {
    pub id: String,
    pub display_name: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricWord {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricLine {
    pub id: String,
    pub start_ms: Option<u64>,
    pub end_ms: Option<u64>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub translation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub romanization: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vocalist_id: Option<String>,
    #[serde(default)]
    pub words: Vec<LyricWord>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricMetadata {
    pub source_label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub translated_language: Option<String>,
    pub offset_ms: i64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LyricSyncMode {
    Unsynchronized,
    Line,
    Word,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricDocument {
    pub song_id: String,
    pub sync_mode: LyricSyncMode,
    pub metadata: LyricMetadata,
    #[serde(default)]
    pub vocalists: Vec<LyricVocalist>,
    pub lines: Vec<LyricLine>,
}
