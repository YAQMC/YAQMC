use super::account::{AccountEntitlement, EntitlementTier, MembershipState};
use crate::{
    audio::AudioFormat,
    media::PlaybackSourceError,
    player::{AudioCodec, AudioFormatInfo, AudioQuality},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AudioQualityPreference {
    Automatic,
    Standard,
    High,
    Lossless,
}

impl AudioQualityPreference {
    pub(crate) fn from_setting(value: Option<String>) -> Self {
        match value.as_deref() {
            Some("standard") => Self::Standard,
            Some("high") => Self::High,
            Some("lossless") => Self::Lossless,
            _ => Self::Automatic,
        }
    }

    pub(crate) fn as_setting(self) -> &'static str {
        match self {
            Self::Automatic => "automatic",
            Self::Standard => "standard",
            Self::High => "high",
            Self::Lossless => "lossless",
        }
    }

    fn requested_quality(self) -> Option<AudioQuality> {
        match self {
            Self::Automatic => None,
            Self::Standard => Some(AudioQuality::Standard),
            Self::High => Some(AudioQuality::High),
            Self::Lossless => Some(AudioQuality::Lossless),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlaybackFallbackReason {
    SourceUnavailable,
    AccountRights,
    PreviewOnly,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSourceSelection {
    pub requested_quality: AudioQualityPreference,
    pub resolved_quality: AudioQuality,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<PlaybackFallbackReason>,
    pub preview: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PreviewRange {
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VkeyAvailability {
    pub filename: String,
    pub available: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourceCandidate {
    pub filename: String,
    pub cache_label: &'static str,
    pub format: AudioFormat,
    pub codec: AudioCodec,
    pub mime_type: &'static str,
    pub bitrate_kbps: Option<u32>,
    pub quality: AudioQuality,
    pub preview: bool,
}

impl SourceCandidate {
    pub(crate) fn content_length(&self) -> Option<u64> {
        None
    }

    #[cfg(test)]
    fn test(name: &str, quality: AudioQuality, preview: bool) -> Self {
        let (format, codec) = if quality == AudioQuality::Lossless {
            (AudioFormat::Flac, AudioCodec::Flac)
        } else {
            (AudioFormat::Mp3, AudioCodec::Mp3)
        };
        Self {
            filename: name.to_owned(),
            cache_label: "test",
            format,
            codec,
            mime_type: "audio/test",
            bitrate_kbps: None,
            quality,
            preview,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourceDecision {
    pub candidate: SourceCandidate,
    pub selection: PlaybackSourceSelection,
    pub preview: Option<PreviewRange>,
}

fn rank(quality: AudioQuality) -> u8 {
    match quality {
        AudioQuality::Standard => 1,
        AudioQuality::High => 2,
        AudioQuality::Lossless => 3,
    }
}

fn candidate_matches_track(candidate: &SourceCandidate, formats: &[AudioFormatInfo]) -> bool {
    candidate.preview
        || formats.is_empty()
        || formats
            .iter()
            .any(|format| format.quality == candidate.quality && format.codec == candidate.codec)
}

fn quality_in_preference_order(preference: AudioQualityPreference, quality: AudioQuality) -> bool {
    match preference {
        AudioQualityPreference::Automatic => true,
        AudioQualityPreference::Standard => quality == AudioQuality::Standard,
        AudioQualityPreference::High => rank(quality) <= rank(AudioQuality::High),
        AudioQualityPreference::Lossless => true,
    }
}

pub(crate) fn candidates_for_request(
    preference: AudioQualityPreference,
    entitlement: &AccountEntitlement,
    candidates: &[SourceCandidate],
) -> Vec<SourceCandidate> {
    let mut selected = candidates
        .iter()
        .filter(|candidate| {
            candidate.preview
                || (quality_in_preference_order(preference, candidate.quality)
                    && entitlement.permitted_qualities.contains(&candidate.quality))
        })
        .cloned()
        .collect::<Vec<_>>();
    selected.sort_by_key(|candidate| {
        if candidate.preview {
            (1_u8, 0_u8)
        } else {
            (0_u8, u8::MAX - rank(candidate.quality))
        }
    });
    selected
}

pub(crate) fn choose_source(
    preference: AudioQualityPreference,
    entitlement: &AccountEntitlement,
    track_formats: &[AudioFormatInfo],
    candidates: &[SourceCandidate],
    vkey_results: &[VkeyAvailability],
    preview: Option<PreviewRange>,
) -> Result<SourceDecision, PlaybackSourceError> {
    let requested = preference.requested_quality();
    let requested_allowed =
        requested.is_none_or(|quality| entitlement.permitted_qualities.contains(&quality));
    let requested_has_format = requested.is_some_and(|quality| {
        track_formats.is_empty() || track_formats.iter().any(|format| format.quality == quality)
    });

    for candidate in candidates_for_request(preference, entitlement, candidates) {
        if !candidate_matches_track(&candidate, track_formats) {
            continue;
        }
        if candidate.preview && preview.is_none() {
            continue;
        }
        if !vkey_results
            .iter()
            .any(|result| result.filename == candidate.filename && result.available)
        {
            continue;
        }
        let fallback_reason = if candidate.preview {
            Some(PlaybackFallbackReason::PreviewOnly)
        } else if let Some(requested) = requested {
            if requested == candidate.quality {
                None
            } else if requested_has_format && !requested_allowed {
                Some(PlaybackFallbackReason::AccountRights)
            } else {
                Some(PlaybackFallbackReason::SourceUnavailable)
            }
        } else {
            None
        };
        return Ok(SourceDecision {
            selection: PlaybackSourceSelection {
                requested_quality: preference,
                resolved_quality: candidate.quality,
                fallback_reason,
                preview: candidate.preview,
            },
            preview: candidate.preview.then_some(preview).flatten(),
            candidate,
        });
    }

    if requested.is_some() {
        if requested_has_format && !requested_allowed {
            Err(PlaybackSourceError::EntitlementInsufficient)
        } else {
            Err(PlaybackSourceError::TrackUnavailable)
        }
    } else {
        Err(PlaybackSourceError::TrackUnavailable)
    }
}

pub(crate) fn normalize_account_entitlement(payload: &Value) -> AccountEntitlement {
    let normalized = payload
        .pointer("/data/entitlement")
        .or_else(|| payload.get("entitlement"));
    let string = |key: &str| {
        normalized
            .and_then(|value| value.get(key))
            .and_then(Value::as_str)
            .map(|value| value.trim().to_ascii_lowercase())
    };
    let normalized_tier = match string("tier").as_deref() {
        Some("free") => EntitlementTier::Free,
        Some("music-vip" | "music_vip" | "vip") => EntitlementTier::MusicVip,
        Some("super-vip" | "super_vip" | "svip") => EntitlementTier::SuperVip,
        _ => EntitlementTier::Unknown,
    };
    let normalized_membership = match string("membership").as_deref() {
        Some("active" | "vip" | "svip" | "music-vip" | "super-vip") => MembershipState::Active,
        Some("expired") => MembershipState::Expired,
        Some("inactive" | "free") => MembershipState::Inactive,
        _ => MembershipState::Unknown,
    };
    let mut permitted_qualities = normalized
        .and_then(|value| value.get("permittedQualities"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(
            |value| match value.as_str()?.trim().to_ascii_lowercase().as_str() {
                "standard" => Some(AudioQuality::Standard),
                "high" => Some(AudioQuality::High),
                "lossless" => Some(AudioQuality::Lossless),
                _ => None,
            },
        )
        .collect::<Vec<_>>();
    permitted_qualities.sort_by_key(|quality| rank(*quality));
    permitted_qualities.dedup();
    if permitted_qualities.is_empty() {
        permitted_qualities.push(AudioQuality::Standard);
    }
    let normalized_observed_maximum =
        string("observedMaximumQuality").and_then(|quality| match quality.as_str() {
            "standard" => Some(AudioQuality::Standard),
            "high" => Some(AudioQuality::High),
            "lossless" => Some(AudioQuality::Lossless),
            _ => None,
        });
    if normalized.is_some() {
        return AccountEntitlement {
            tier: normalized_tier,
            membership: normalized_membership,
            expires_at_ms: normalized
                .and_then(|value| value.get("expiresAtMs"))
                .and_then(Value::as_u64),
            permitted_qualities,
            observed_maximum_quality: normalized_observed_maximum,
            restrictions: Vec::new(),
        };
    }

    let raw = payload
        .pointer("/req/data")
        .or_else(|| payload.pointer("/req_0/data"))
        .filter(|value| {
            value.get("svip").is_some()
                || value.pointer("/identity/vip").is_some()
                || value.pointer("/identity/HugeVip").is_some()
                || value.pointer("/userinfo/expire").is_some()
        });
    let numeric = |pointer: &str| {
        raw.and_then(|value| value.pointer(pointer))
            .and_then(|value| {
                value
                    .as_u64()
                    .or_else(|| value.as_i64().and_then(|number| u64::try_from(number).ok()))
                    .or_else(|| value.as_str()?.parse::<u64>().ok())
            })
    };
    let vip = numeric("/identity/vip").unwrap_or_default() > 0;
    let super_vip = numeric("/svip").unwrap_or_default() > 0
        || numeric("/identity/HugeVip").unwrap_or_default() > 0;
    let expires_at_ms = numeric("/userinfo/expire")
        .filter(|value| *value >= 946_684_800)
        .map(|value| {
            if value < 10_000_000_000 {
                value.saturating_mul(1_000)
            } else {
                value
            }
        });
    if raw.is_none() {
        return AccountEntitlement {
            tier: EntitlementTier::Unknown,
            membership: MembershipState::Unknown,
            expires_at_ms: None,
            permitted_qualities: vec![AudioQuality::Standard],
            observed_maximum_quality: None,
            restrictions: Vec::new(),
        };
    }

    let active = vip || super_vip;
    AccountEntitlement {
        tier: if super_vip {
            EntitlementTier::SuperVip
        } else if vip {
            EntitlementTier::MusicVip
        } else {
            EntitlementTier::Free
        },
        membership: if active {
            MembershipState::Active
        } else if expires_at_ms.is_some() {
            MembershipState::Expired
        } else {
            MembershipState::Inactive
        },
        expires_at_ms,
        permitted_qualities: if active {
            vec![
                AudioQuality::Standard,
                AudioQuality::High,
                AudioQuality::Lossless,
            ]
        } else {
            vec![AudioQuality::Standard]
        },
        observed_maximum_quality: Some(if active {
            AudioQuality::Lossless
        } else {
            AudioQuality::Standard
        }),
        restrictions: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        player::{AudioCodec, AudioFormatInfo, AudioQuality},
        qqmusic::account::{AccountEntitlement, EntitlementTier, MembershipState},
    };

    fn entitlement(qualities: Vec<AudioQuality>) -> AccountEntitlement {
        AccountEntitlement {
            tier: EntitlementTier::Unknown,
            membership: MembershipState::Active,
            expires_at_ms: None,
            observed_maximum_quality: qualities.last().cloned(),
            permitted_qualities: qualities,
            restrictions: Vec::new(),
        }
    }

    fn format(quality: AudioQuality, codec: AudioCodec) -> AudioFormatInfo {
        AudioFormatInfo {
            quality,
            codec,
            bitrate_kbps: None,
            sample_rate_hz: None,
            bit_depth: None,
            lossless: codec == AudioCodec::Flac,
        }
    }

    fn candidate(name: &str, quality: AudioQuality, preview: bool) -> SourceCandidate {
        SourceCandidate::test(name, quality, preview)
    }

    fn all_candidates() -> Vec<SourceCandidate> {
        vec![
            candidate("lossless", AudioQuality::Lossless, false),
            candidate("high", AudioQuality::High, false),
            candidate("standard", AudioQuality::Standard, false),
            candidate("preview", AudioQuality::Standard, true),
        ]
    }

    fn all_formats() -> Vec<AudioFormatInfo> {
        vec![
            format(AudioQuality::Standard, AudioCodec::Mp3),
            format(AudioQuality::High, AudioCodec::Mp3),
            format(AudioQuality::Lossless, AudioCodec::Flac),
        ]
    }

    fn availability(names: &[&str]) -> Vec<VkeyAvailability> {
        all_candidates()
            .into_iter()
            .map(|candidate| VkeyAvailability {
                available: names.contains(&candidate.filename.as_str()),
                filename: candidate.filename,
            })
            .collect()
    }

    #[test]
    fn deterministic_quality_matrix_respects_rights_availability_and_preview() {
        let cases = [
            (
                "auto-vip-lossless",
                AudioQualityPreference::Automatic,
                entitlement(vec![
                    AudioQuality::Standard,
                    AudioQuality::High,
                    AudioQuality::Lossless,
                ]),
                availability(&["lossless", "high", "standard"]),
                AudioQuality::Lossless,
                None,
            ),
            (
                "auto-free-standard",
                AudioQualityPreference::Automatic,
                entitlement(vec![AudioQuality::Standard]),
                availability(&["lossless", "high", "standard"]),
                AudioQuality::Standard,
                None,
            ),
            (
                "standard",
                AudioQualityPreference::Standard,
                entitlement(vec![
                    AudioQuality::Standard,
                    AudioQuality::High,
                    AudioQuality::Lossless,
                ]),
                availability(&["standard"]),
                AudioQuality::Standard,
                None,
            ),
            (
                "high-missing",
                AudioQualityPreference::High,
                entitlement(vec![AudioQuality::Standard, AudioQuality::High]),
                availability(&["standard"]),
                AudioQuality::Standard,
                Some(PlaybackFallbackReason::SourceUnavailable),
            ),
            (
                "lossless-rights",
                AudioQualityPreference::Lossless,
                entitlement(vec![AudioQuality::Standard, AudioQuality::High]),
                availability(&["lossless", "high", "standard"]),
                AudioQuality::High,
                Some(PlaybackFallbackReason::AccountRights),
            ),
            (
                "lossless-missing",
                AudioQualityPreference::Lossless,
                entitlement(vec![
                    AudioQuality::Standard,
                    AudioQuality::High,
                    AudioQuality::Lossless,
                ]),
                availability(&["high", "standard"]),
                AudioQuality::High,
                Some(PlaybackFallbackReason::SourceUnavailable),
            ),
        ];

        for (name, preference, rights, vkeys, quality, reason) in cases {
            let decision = choose_source(
                preference,
                &rights,
                &all_formats(),
                &all_candidates(),
                &vkeys,
                None,
            )
            .unwrap_or_else(|error| panic!("{name}: {error}"));
            assert_eq!(decision.selection.resolved_quality, quality, "{name}");
            assert_eq!(decision.selection.fallback_reason, reason, "{name}");
        }
    }

    #[test]
    fn official_preview_is_the_last_fallback() {
        let decision = choose_source(
            AudioQualityPreference::Lossless,
            &entitlement(vec![AudioQuality::Standard]),
            &all_formats(),
            &all_candidates(),
            &availability(&["preview"]),
            Some(PreviewRange {
                start_ms: 1_000,
                end_ms: 31_000,
            }),
        )
        .expect("preview");
        assert!(decision.candidate.preview);
        assert_eq!(
            decision.selection.fallback_reason,
            Some(PlaybackFallbackReason::PreviewOnly)
        );
        assert_eq!(decision.preview.unwrap().start_ms, 1_000);
    }

    #[test]
    fn unavailable_and_insufficient_rights_are_distinct() {
        let candidates = all_candidates();
        let formats = all_formats();
        assert_eq!(
            choose_source(
                AudioQualityPreference::Standard,
                &entitlement(vec![AudioQuality::Standard]),
                &formats,
                &candidates,
                &availability(&[]),
                None,
            ),
            Err(PlaybackSourceError::TrackUnavailable)
        );
        assert_eq!(
            choose_source(
                AudioQualityPreference::Lossless,
                &entitlement(vec![AudioQuality::Standard]),
                &[format(AudioQuality::Lossless, AudioCodec::Flac)],
                &candidates,
                &availability(&[]),
                None,
            ),
            Err(PlaybackSourceError::EntitlementInsufficient)
        );
    }

    #[test]
    fn request_candidates_never_probe_excluded_paid_qualities() {
        let selected = candidates_for_request(
            AudioQualityPreference::Lossless,
            &entitlement(vec![AudioQuality::Standard]),
            &all_candidates(),
        );
        assert_eq!(
            selected
                .iter()
                .map(|candidate| candidate.filename.as_str())
                .collect::<Vec<_>>(),
            vec!["standard", "preview"]
        );
    }

    #[test]
    fn sanitized_entitlement_fixtures_normalize_without_marketing_text() {
        let free: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/qqmusic/account/entitlement-free.json"
        ))
        .expect("free fixture");
        let vip: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/qqmusic/account/entitlement-vip.json"
        ))
        .expect("vip fixture");
        let free = normalize_account_entitlement(&free);
        let vip = normalize_account_entitlement(&vip);
        assert_eq!(free.tier, EntitlementTier::Free);
        assert_eq!(free.membership, MembershipState::Inactive);
        assert_eq!(free.permitted_qualities, vec![AudioQuality::Standard]);
        assert_eq!(vip.tier, EntitlementTier::MusicVip);
        assert_eq!(vip.membership, MembershipState::Active);
        assert_eq!(vip.expires_at_ms, Some(4_102_444_800_000));
        assert_eq!(
            vip.permitted_qualities,
            vec![
                AudioQuality::Standard,
                AudioQuality::High,
                AudioQuality::Lossless
            ]
        );
        assert_eq!(vip.observed_maximum_quality, Some(AudioQuality::Lossless));
    }

    #[test]
    fn absent_or_unrecognized_entitlement_is_conservative() {
        let entitlement = normalize_account_entitlement(&Value::Null);
        assert_eq!(entitlement.tier, EntitlementTier::Unknown);
        assert_eq!(entitlement.membership, MembershipState::Unknown);
        assert_eq!(
            entitlement.permitted_qualities,
            vec![AudioQuality::Standard]
        );
        assert_eq!(entitlement.observed_maximum_quality, None);
    }

    #[test]
    fn implausibly_small_expiry_is_not_presented_as_an_expired_membership() {
        let payload = serde_json::json!({
            "req": {
                "data": {
                    "svip": 0,
                    "identity": { "vip": 0, "HugeVip": 0 },
                    "userinfo": { "expire": 3 }
                }
            }
        });

        let entitlement = normalize_account_entitlement(&payload);

        assert_eq!(entitlement.tier, EntitlementTier::Free);
        assert_eq!(entitlement.membership, MembershipState::Inactive);
        assert_eq!(entitlement.expires_at_ms, None);
    }
}
