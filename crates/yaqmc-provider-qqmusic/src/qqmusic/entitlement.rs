use super::account::{AccountEntitlement, EntitlementTier, MembershipState, SecondaryEntitlement};
use serde_json::Value;
use yaqmc_provider_api::{
    AudioCodec, AudioFormat, AudioFormatInfo, AudioQuality, PlaybackSourceError,
};
pub(crate) use yaqmc_provider_api::{
    AudioQualityPreference, ClientCapabilityState, EntitlementCapabilityState,
    PlaybackFallbackReason, PlaybackSourceSelection, QualityCapabilityState,
    ResourceCapabilityState,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PreviewRange {
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VkeyAvailability {
    pub filename: String,
    pub available: bool,
    pub known: bool,
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
    pub encrypted: bool,
    pub client_supported: bool,
}

impl SourceCandidate {
    pub(crate) fn content_length(&self) -> Option<u64> {
        None
    }

    #[cfg(test)]
    fn test(name: &str, quality: AudioQuality, preview: bool) -> Self {
        let (format, codec) = if matches!(
            quality,
            AudioQuality::Lossless | AudioQuality::HiRes | AudioQuality::Master
        ) {
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
            encrypted: false,
            client_supported: true,
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
        AudioQuality::HiRes => 4,
        AudioQuality::Master => 5,
    }
}

fn candidate_matches_track(candidate: &SourceCandidate, formats: &[AudioFormatInfo]) -> bool {
    candidate.preview
        || candidate.quality == AudioQuality::HiRes
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
        AudioQualityPreference::Lossless => rank(quality) <= rank(AudioQuality::Lossless),
        AudioQualityPreference::HiRes => rank(quality) <= rank(AudioQuality::HiRes),
        AudioQualityPreference::Master => true,
    }
}

fn entitlement_capability(
    entitlement: &AccountEntitlement,
    quality: AudioQuality,
) -> EntitlementCapabilityState {
    if quality == AudioQuality::Standard {
        return EntitlementCapabilityState::Allowed;
    }
    if entitlement.membership == MembershipState::Unknown {
        return EntitlementCapabilityState::Unknown;
    }
    if entitlement.permitted_qualities.contains(&quality) {
        EntitlementCapabilityState::Allowed
    } else {
        EntitlementCapabilityState::Denied
    }
}

pub(crate) fn quality_capabilities(
    entitlement: &AccountEntitlement,
    track_formats: &[AudioFormatInfo],
    candidates: &[SourceCandidate],
    vkey_results: &[VkeyAvailability],
) -> Vec<QualityCapabilityState> {
    [
        AudioQuality::Standard,
        AudioQuality::High,
        AudioQuality::Lossless,
        AudioQuality::HiRes,
        AudioQuality::Master,
    ]
    .into_iter()
    .map(|quality| {
        let matching = candidates
            .iter()
            .filter(|candidate| {
                !candidate.preview
                    && candidate.quality == quality
                    && candidate_matches_track(candidate, track_formats)
            })
            .collect::<Vec<_>>();
        let entitlement = entitlement_capability(entitlement, quality);
        let resource = if matching.iter().any(|candidate| {
            vkey_results.iter().any(|result| {
                result.filename == candidate.filename && result.known && result.available
            })
        }) {
            ResourceCapabilityState::Available
        } else if matching.is_empty() {
            if track_formats.is_empty() {
                ResourceCapabilityState::Unknown
            } else {
                ResourceCapabilityState::Unavailable
            }
        } else if matching.iter().all(|candidate| {
            vkey_results.iter().any(|result| {
                result.filename == candidate.filename && result.known && !result.available
            })
        }) {
            ResourceCapabilityState::Unavailable
        } else {
            ResourceCapabilityState::Unknown
        };
        let client = if matching.is_empty() {
            ClientCapabilityState::Unknown
        } else if matching.iter().any(|candidate| candidate.client_supported) {
            ClientCapabilityState::Supported
        } else {
            ClientCapabilityState::Unsupported
        };
        QualityCapabilityState {
            quality,
            playable: entitlement == EntitlementCapabilityState::Allowed
                && resource == ResourceCapabilityState::Available
                && client == ClientCapabilityState::Supported,
            entitlement,
            resource,
            client,
        }
    })
    .collect()
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
        quality == AudioQuality::HiRes
            || track_formats.is_empty()
            || track_formats.iter().any(|format| format.quality == quality)
    });
    let quality_capabilities =
        quality_capabilities(entitlement, track_formats, candidates, vkey_results);
    let requested_capability = requested.and_then(|quality| {
        quality_capabilities
            .iter()
            .find(|capability| capability.quality == quality)
    });

    for candidate in candidates_for_request(preference, entitlement, candidates) {
        if !candidate_matches_track(&candidate, track_formats) {
            continue;
        }
        if candidate.preview && preview.is_none() {
            continue;
        }
        if !candidate.client_supported {
            continue;
        }
        if !vkey_results
            .iter()
            .any(|result| result.filename == candidate.filename && result.known && result.available)
        {
            continue;
        }
        let fallback_reason = if candidate.preview {
            Some(PlaybackFallbackReason::PreviewOnly)
        } else if let Some(requested) = requested {
            if requested == candidate.quality {
                None
            } else {
                match requested_capability {
                    Some(capability)
                        if requested_has_format
                            && capability.entitlement == EntitlementCapabilityState::Denied =>
                    {
                        Some(PlaybackFallbackReason::AccountRights)
                    }
                    Some(capability)
                        if capability.entitlement == EntitlementCapabilityState::Unknown =>
                    {
                        Some(PlaybackFallbackReason::EntitlementUnknown)
                    }
                    Some(capability)
                        if capability.resource == ResourceCapabilityState::Available
                            && capability.client == ClientCapabilityState::Unsupported =>
                    {
                        Some(PlaybackFallbackReason::ClientUnsupported)
                    }
                    _ => Some(PlaybackFallbackReason::SourceUnavailable),
                }
            }
        } else {
            quality_capabilities
                .iter()
                .rev()
                .find(|capability| {
                    rank(capability.quality) > rank(candidate.quality)
                        && capability.entitlement == EntitlementCapabilityState::Allowed
                })
                .and_then(|capability| {
                    if capability.resource == ResourceCapabilityState::Available
                        && capability.client == ClientCapabilityState::Unsupported
                    {
                        Some(PlaybackFallbackReason::ClientUnsupported)
                    } else if capability.resource == ResourceCapabilityState::Unavailable {
                        Some(PlaybackFallbackReason::SourceUnavailable)
                    } else {
                        None
                    }
                })
        };
        return Ok(SourceDecision {
            selection: PlaybackSourceSelection {
                requested_quality: preference,
                resolved_quality: candidate.quality,
                fallback_reason,
                preview: candidate.preview,
                quality_capabilities,
            },
            preview: candidate.preview.then_some(preview).flatten(),
            candidate,
        });
    }

    if requested.is_some() {
        match requested_capability {
            Some(capability)
                if requested_has_format
                    && capability.entitlement == EntitlementCapabilityState::Denied =>
            {
                Err(PlaybackSourceError::EntitlementInsufficient)
            }
            Some(capability) if capability.entitlement == EntitlementCapabilityState::Unknown => {
                Err(PlaybackSourceError::EntitlementUnknown)
            }
            Some(capability)
                if capability.resource == ResourceCapabilityState::Available
                    && capability.client == ClientCapabilityState::Unsupported =>
            {
                Err(PlaybackSourceError::DecoderUnsupported)
            }
            _ if requested_has_format && !requested_allowed => {
                Err(PlaybackSourceError::EntitlementInsufficient)
            }
            _ => Err(PlaybackSourceError::TrackUnavailable),
        }
    } else if quality_capabilities.iter().any(|capability| {
        capability.entitlement == EntitlementCapabilityState::Allowed
            && capability.resource == ResourceCapabilityState::Available
            && capability.client == ClientCapabilityState::Unsupported
    }) {
        Err(PlaybackSourceError::DecoderUnsupported)
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
        Some("green-diamond" | "green_diamond" | "music-vip" | "music_vip" | "vip") => {
            EntitlementTier::GreenDiamond
        }
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
                "hi-res" | "hires" => Some(AudioQuality::HiRes),
                "master" => Some(AudioQuality::Master),
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
            "hi-res" | "hires" => Some(AudioQuality::HiRes),
            "master" => Some(AudioQuality::Master),
            _ => None,
        });
    let mut secondary_entitlements = normalized
        .and_then(|value| value.get("secondaryEntitlements"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(
            |value| match value.as_str()?.trim().to_ascii_lowercase().as_str() {
                "luxury-green-diamond" => Some(SecondaryEntitlement::LuxuryGreenDiamond),
                "annual-green-diamond" => Some(SecondaryEntitlement::AnnualGreenDiamond),
                "annual-luxury-green-diamond" => {
                    Some(SecondaryEntitlement::AnnualLuxuryGreenDiamond)
                }
                "star" => Some(SecondaryEntitlement::Star),
                "annual-star" => Some(SecondaryEntitlement::AnnualStar),
                "eight-platform" => Some(SecondaryEntitlement::EightPlatform),
                "twelve-platform" => Some(SecondaryEntitlement::TwelvePlatform),
                "family" => Some(SecondaryEntitlement::Family),
                "child" => Some(SecondaryEntitlement::Child),
                "trial" => Some(SecondaryEntitlement::Trial),
                "couple" => Some(SecondaryEntitlement::Couple),
                "ad-free" => Some(SecondaryEntitlement::AdFree),
                _ => None,
            },
        )
        .collect::<Vec<_>>();
    secondary_entitlements.sort_by_key(|value| *value as u8);
    secondary_entitlements.dedup();
    if normalized.is_some() {
        return AccountEntitlement {
            tier: normalized_tier,
            membership: normalized_membership,
            expires_at_ms: normalized
                .and_then(|value| value.get("expiresAtMs"))
                .and_then(Value::as_u64),
            secondary_entitlements,
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
                || value.get("star").is_some()
                || value.get("ystar").is_some()
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
    let green_diamond = numeric("/identity/vip").unwrap_or_default() > 0
        || numeric("/identity/HugeVip").unwrap_or_default() > 0;
    let super_vip = numeric("/svip").unwrap_or_default() > 0;
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
            secondary_entitlements: Vec::new(),
            permitted_qualities: vec![AudioQuality::Standard],
            observed_maximum_quality: None,
            restrictions: Vec::new(),
        };
    }

    let active = green_diamond || super_vip;
    let secondary_entitlements = [
        (
            "/identity/HugeVip",
            SecondaryEntitlement::LuxuryGreenDiamond,
        ),
        (
            "/identity/yearflag",
            SecondaryEntitlement::AnnualGreenDiamond,
        ),
        (
            "/identity/HugeYearFlag",
            SecondaryEntitlement::AnnualLuxuryGreenDiamond,
        ),
        ("/star", SecondaryEntitlement::Star),
        ("/ystar", SecondaryEntitlement::AnnualStar),
        ("/identity/eight", SecondaryEntitlement::EightPlatform),
        ("/identity/twelve", SecondaryEntitlement::TwelvePlatform),
        ("/identity/GroupVipFlag", SecondaryEntitlement::Family),
        ("/identity/ChildVip", SecondaryEntitlement::Child),
        ("/identity/ExpVip", SecondaryEntitlement::Trial),
        ("/identity/CPLoverFlag", SecondaryEntitlement::Couple),
        ("/identity/AdVipFlag", SecondaryEntitlement::AdFree),
    ]
    .into_iter()
    .filter_map(|(pointer, entitlement)| {
        (numeric(pointer).unwrap_or_default() > 0).then_some(entitlement)
    })
    .collect();
    AccountEntitlement {
        tier: if super_vip {
            EntitlementTier::SuperVip
        } else if green_diamond {
            EntitlementTier::GreenDiamond
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
        secondary_entitlements,
        permitted_qualities: if active {
            let mut qualities = vec![
                AudioQuality::Standard,
                AudioQuality::High,
                AudioQuality::Lossless,
            ];
            if super_vip {
                qualities.push(AudioQuality::HiRes);
                qualities.push(AudioQuality::Master);
            }
            qualities
        } else {
            vec![AudioQuality::Standard]
        },
        observed_maximum_quality: Some(if super_vip {
            AudioQuality::Master
        } else if active {
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
    use crate::qqmusic::account::{AccountEntitlement, EntitlementTier, MembershipState};

    fn entitlement(qualities: Vec<AudioQuality>) -> AccountEntitlement {
        AccountEntitlement {
            tier: EntitlementTier::Unknown,
            membership: MembershipState::Active,
            expires_at_ms: None,
            secondary_entitlements: Vec::new(),
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
            candidate("master", AudioQuality::Master, false),
            candidate("hi-res", AudioQuality::HiRes, false),
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
            format(AudioQuality::HiRes, AudioCodec::Flac),
            format(AudioQuality::Master, AudioCodec::Flac),
        ]
    }

    fn availability(names: &[&str]) -> Vec<VkeyAvailability> {
        all_candidates()
            .into_iter()
            .map(|candidate| VkeyAvailability {
                available: names.contains(&candidate.filename.as_str()),
                known: true,
                filename: candidate.filename,
            })
            .collect()
    }

    #[test]
    fn deterministic_quality_matrix_respects_rights_availability_and_preview() {
        let cases = [
            (
                "master-super-vip",
                AudioQualityPreference::Master,
                entitlement(vec![
                    AudioQuality::Standard,
                    AudioQuality::High,
                    AudioQuality::Lossless,
                    AudioQuality::HiRes,
                    AudioQuality::Master,
                ]),
                availability(&["master", "hi-res", "lossless", "high", "standard"]),
                AudioQuality::Master,
                None,
            ),
            (
                "hi-res-never-upgrades-to-master",
                AudioQualityPreference::HiRes,
                entitlement(vec![
                    AudioQuality::Standard,
                    AudioQuality::High,
                    AudioQuality::Lossless,
                    AudioQuality::HiRes,
                    AudioQuality::Master,
                ]),
                availability(&["master", "hi-res", "lossless", "high", "standard"]),
                AudioQuality::HiRes,
                None,
            ),
            (
                "lossless-never-upgrades-to-master",
                AudioQualityPreference::Lossless,
                entitlement(vec![
                    AudioQuality::Standard,
                    AudioQuality::High,
                    AudioQuality::Lossless,
                    AudioQuality::Master,
                ]),
                availability(&["master", "lossless", "high", "standard"]),
                AudioQuality::Lossless,
                None,
            ),
            (
                "master-missing",
                AudioQualityPreference::Master,
                entitlement(vec![
                    AudioQuality::Standard,
                    AudioQuality::High,
                    AudioQuality::Lossless,
                    AudioQuality::Master,
                ]),
                availability(&["lossless", "high", "standard"]),
                AudioQuality::Lossless,
                Some(PlaybackFallbackReason::SourceUnavailable),
            ),
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
    fn quality_capability_matrix_keeps_entitlement_resource_and_client_independent() {
        let mut unsupported = candidate("master", AudioQuality::Master, false);
        unsupported.client_supported = false;
        let formats = [format(AudioQuality::Master, AudioCodec::Flac)];
        let vkeys = [VkeyAvailability {
            filename: "master".to_owned(),
            available: true,
            known: true,
        }];

        let supported = quality_capabilities(
            &entitlement(vec![AudioQuality::Master]),
            &formats,
            &[candidate("master", AudioQuality::Master, false)],
            &vkeys,
        );
        assert_eq!(
            supported.last(),
            Some(&QualityCapabilityState {
                quality: AudioQuality::Master,
                entitlement: EntitlementCapabilityState::Allowed,
                resource: ResourceCapabilityState::Available,
                client: ClientCapabilityState::Supported,
                playable: true,
            })
        );

        let client_unsupported = quality_capabilities(
            &entitlement(vec![AudioQuality::Master]),
            &formats,
            &[unsupported.clone()],
            &vkeys,
        );
        assert_eq!(
            client_unsupported
                .last()
                .map(|state| (state.client, state.playable)),
            Some((ClientCapabilityState::Unsupported, false))
        );
        assert_eq!(
            choose_source(
                AudioQualityPreference::Master,
                &entitlement(vec![AudioQuality::Master]),
                &formats,
                &[unsupported],
                &vkeys,
                None,
            ),
            Err(PlaybackSourceError::DecoderUnsupported)
        );

        let unavailable = quality_capabilities(
            &entitlement(vec![AudioQuality::Master]),
            &formats,
            &[candidate("master", AudioQuality::Master, false)],
            &[VkeyAvailability {
                filename: "master".to_owned(),
                available: false,
                known: true,
            }],
        );
        assert_eq!(
            unavailable
                .last()
                .map(|state| (state.resource, state.playable)),
            Some((ResourceCapabilityState::Unavailable, false))
        );

        let resource_unknown = quality_capabilities(
            &entitlement(vec![AudioQuality::Master]),
            &formats,
            &[candidate("master", AudioQuality::Master, false)],
            &[VkeyAvailability {
                filename: "master".to_owned(),
                available: false,
                known: false,
            }],
        );
        assert_eq!(
            resource_unknown
                .last()
                .map(|state| (state.resource, state.playable)),
            Some((ResourceCapabilityState::Unknown, false))
        );

        let denied = quality_capabilities(
            &entitlement(vec![AudioQuality::Standard]),
            &formats,
            &[candidate("master", AudioQuality::Master, false)],
            &vkeys,
        );
        assert_eq!(
            denied
                .last()
                .map(|state| (state.entitlement, state.playable)),
            Some((EntitlementCapabilityState::Denied, false))
        );

        let unknown_entitlement = AccountEntitlement {
            tier: EntitlementTier::Unknown,
            membership: MembershipState::Unknown,
            expires_at_ms: None,
            secondary_entitlements: Vec::new(),
            permitted_qualities: vec![AudioQuality::Standard],
            observed_maximum_quality: None,
            restrictions: Vec::new(),
        };
        let unknown = quality_capabilities(
            &unknown_entitlement,
            &formats,
            &[candidate("master", AudioQuality::Master, false)],
            &vkeys,
        );
        assert_eq!(
            unknown
                .last()
                .map(|state| (state.entitlement, state.playable)),
            Some((EntitlementCapabilityState::Unknown, false))
        );
        assert_eq!(
            choose_source(
                AudioQualityPreference::Master,
                &unknown_entitlement,
                &formats,
                &[candidate("master", AudioQuality::Master, false)],
                &vkeys,
                None,
            ),
            Err(PlaybackSourceError::EntitlementUnknown)
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
        assert_eq!(vip.tier, EntitlementTier::GreenDiamond);
        assert_eq!(vip.membership, MembershipState::Active);
        assert_eq!(vip.expires_at_ms, Some(4_102_444_800_000));
        assert_eq!(
            vip.secondary_entitlements,
            vec![
                SecondaryEntitlement::AnnualGreenDiamond,
                SecondaryEntitlement::Family
            ]
        );
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
        assert!(entitlement.secondary_entitlements.is_empty());
    }

    #[test]
    fn huge_vip_is_luxury_green_diamond_not_super_vip() {
        let entitlement = normalize_account_entitlement(&serde_json::json!({
            "req": {
                "data": {
                    "svip": 0,
                    "identity": {
                        "vip": 0,
                        "HugeVip": 1,
                        "HugeYearFlag": 1,
                        "eight": 1,
                        "twelve": 1
                    },
                    "userinfo": { "expire": 4_102_444_800_u64 }
                }
            }
        }));

        assert_eq!(entitlement.tier, EntitlementTier::GreenDiamond);
        assert_eq!(entitlement.membership, MembershipState::Active);
        assert_eq!(
            entitlement.secondary_entitlements,
            vec![
                SecondaryEntitlement::LuxuryGreenDiamond,
                SecondaryEntitlement::AnnualLuxuryGreenDiamond,
                SecondaryEntitlement::EightPlatform,
                SecondaryEntitlement::TwelvePlatform
            ]
        );
    }

    #[test]
    fn only_authoritative_svip_flag_selects_super_vip() {
        let entitlement = normalize_account_entitlement(&serde_json::json!({
            "req": {
                "data": {
                    "svip": 1,
                    "identity": { "vip": 1, "HugeVip": 1 },
                    "userinfo": { "expire": 4_102_444_800_u64 }
                }
            }
        }));

        assert_eq!(entitlement.tier, EntitlementTier::SuperVip);
        assert_eq!(
            entitlement.permitted_qualities,
            vec![
                AudioQuality::Standard,
                AudioQuality::High,
                AudioQuality::Lossless,
                AudioQuality::HiRes,
                AudioQuality::Master
            ]
        );
    }

    #[test]
    fn normalized_entitlement_accepts_legacy_tier_and_deduplicates_known_details() {
        let entitlement = normalize_account_entitlement(&serde_json::json!({
            "entitlement": {
                "tier": "music-vip",
                "membership": "active",
                "secondaryEntitlements": [
                    "annual-green-diamond",
                    "family",
                    "family",
                    "untrusted-marketing-label"
                ],
                "permittedQualities": ["standard", "hires", "hi-res"],
                "observedMaximumQuality": "hires"
            }
        }));

        assert_eq!(entitlement.tier, EntitlementTier::GreenDiamond);
        assert_eq!(
            entitlement.permitted_qualities,
            vec![AudioQuality::Standard, AudioQuality::HiRes]
        );
        assert_eq!(
            entitlement.observed_maximum_quality,
            Some(AudioQuality::HiRes)
        );
        assert_eq!(
            entitlement.secondary_entitlements,
            vec![
                SecondaryEntitlement::AnnualGreenDiamond,
                SecondaryEntitlement::Family
            ]
        );
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
