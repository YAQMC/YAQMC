//! Provider-neutral playback capability and selection values.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AudioQuality {
    Standard,
    High,
    Lossless,
    Master,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AudioCodec {
    Mp3,
    Aac,
    Flac,
    Alac,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFormatInfo {
    pub quality: AudioQuality,
    pub codec: AudioCodec,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bitrate_kbps: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_rate_hz: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bit_depth: Option<u16>,
    pub lossless: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AudioQualityPreference {
    Automatic,
    Standard,
    High,
    Lossless,
    Master,
}

impl AudioQualityPreference {
    pub fn from_setting(value: Option<String>) -> Self {
        match value.as_deref() {
            Some("standard") => Self::Standard,
            Some("high") => Self::High,
            Some("lossless") => Self::Lossless,
            Some("master") => Self::Master,
            _ => Self::Automatic,
        }
    }

    pub fn as_setting(self) -> &'static str {
        match self {
            Self::Automatic => "automatic",
            Self::Standard => "standard",
            Self::High => "high",
            Self::Lossless => "lossless",
            Self::Master => "master",
        }
    }

    pub fn requested_quality(self) -> Option<AudioQuality> {
        match self {
            Self::Automatic => None,
            Self::Standard => Some(AudioQuality::Standard),
            Self::High => Some(AudioQuality::High),
            Self::Lossless => Some(AudioQuality::Lossless),
            Self::Master => Some(AudioQuality::Master),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlaybackFallbackReason {
    SourceUnavailable,
    AccountRights,
    EntitlementUnknown,
    ClientUnsupported,
    PreviewOnly,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EntitlementCapabilityState {
    Allowed,
    Denied,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResourceCapabilityState {
    Available,
    Unavailable,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ClientCapabilityState {
    Supported,
    Unsupported,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityCapabilityState {
    pub quality: AudioQuality,
    pub entitlement: EntitlementCapabilityState,
    pub resource: ResourceCapabilityState,
    pub client: ClientCapabilityState,
    pub playable: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSourceSelection {
    pub requested_quality: AudioQualityPreference,
    pub resolved_quality: AudioQuality,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<PlaybackFallbackReason>,
    pub preview: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub quality_capabilities: Vec<QualityCapabilityState>,
}

/// In-process account/session fence. It is deliberately neither serializable nor
/// debuggable because the opaque provider scope must not cross the wire boundary.
#[derive(Clone, Eq, PartialEq)]
pub struct PlaybackEpoch {
    generation: u64,
    opaque_scope: String,
}

impl PlaybackEpoch {
    pub fn new(generation: u64, opaque_scope: impl Into<String>) -> Self {
        Self {
            generation,
            opaque_scope: opaque_scope.into(),
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }
}
