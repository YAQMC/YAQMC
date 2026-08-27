use yaqmc_core::playback_types::{
    AudioCodec, AudioFormatInfo, AudioQuality, AudioQualityPreference, ClientCapabilityState,
    EntitlementCapabilityState, PlaybackEpoch, PlaybackFallbackReason, PlaybackSourceSelection,
    QualityCapabilityState, ResourceCapabilityState,
};

#[test]
fn playback_values_preserve_wire_shapes_and_preference_settings() {
    assert_eq!(
        serde_json::to_value([
            AudioQuality::Standard,
            AudioQuality::High,
            AudioQuality::Lossless,
            AudioQuality::HiRes,
            AudioQuality::Master,
        ])
        .unwrap(),
        serde_json::json!(["standard", "high", "lossless", "hi-res", "master"])
    );
    assert_eq!(
        serde_json::to_value([
            AudioCodec::Mp3,
            AudioCodec::Aac,
            AudioCodec::Flac,
            AudioCodec::Alac,
            AudioCodec::Unknown,
        ])
        .unwrap(),
        serde_json::json!(["mp3", "aac", "flac", "alac", "unknown"])
    );
    assert_eq!(
        serde_json::to_value([
            AudioQualityPreference::Automatic,
            AudioQualityPreference::Standard,
            AudioQualityPreference::High,
            AudioQualityPreference::Lossless,
            AudioQualityPreference::HiRes,
            AudioQualityPreference::Master,
        ])
        .unwrap(),
        serde_json::json!([
            "automatic",
            "standard",
            "high",
            "lossless",
            "hi-res",
            "master"
        ])
    );
    assert_eq!(
        serde_json::to_value([
            PlaybackFallbackReason::SourceUnavailable,
            PlaybackFallbackReason::AccountRights,
            PlaybackFallbackReason::EntitlementUnknown,
            PlaybackFallbackReason::ClientUnsupported,
            PlaybackFallbackReason::PreviewOnly,
        ])
        .unwrap(),
        serde_json::json!([
            "source-unavailable",
            "account-rights",
            "entitlement-unknown",
            "client-unsupported",
            "preview-only",
        ])
    );
    assert_eq!(
        serde_json::to_value([
            EntitlementCapabilityState::Allowed,
            EntitlementCapabilityState::Denied,
            EntitlementCapabilityState::Unknown,
        ])
        .unwrap(),
        serde_json::json!(["allowed", "denied", "unknown"])
    );
    assert_eq!(
        serde_json::to_value([
            ResourceCapabilityState::Available,
            ResourceCapabilityState::Unavailable,
            ResourceCapabilityState::Unknown,
        ])
        .unwrap(),
        serde_json::json!(["available", "unavailable", "unknown"])
    );
    assert_eq!(
        serde_json::to_value([
            ClientCapabilityState::Supported,
            ClientCapabilityState::Unsupported,
            ClientCapabilityState::Unknown,
        ])
        .unwrap(),
        serde_json::json!(["supported", "unsupported", "unknown"])
    );

    let format = AudioFormatInfo {
        quality: AudioQuality::High,
        codec: AudioCodec::Aac,
        bitrate_kbps: None,
        sample_rate_hz: Some(44_100),
        bit_depth: None,
        lossless: false,
    };
    assert_eq!(
        serde_json::to_value(format).unwrap(),
        serde_json::json!({
            "quality": "high",
            "codec": "aac",
            "sampleRateHz": 44_100,
            "lossless": false,
        })
    );

    let selection = PlaybackSourceSelection {
        requested_quality: AudioQualityPreference::Automatic,
        resolved_quality: AudioQuality::High,
        fallback_reason: None,
        preview: false,
        quality_capabilities: vec![QualityCapabilityState {
            quality: AudioQuality::High,
            entitlement: EntitlementCapabilityState::Allowed,
            resource: ResourceCapabilityState::Available,
            client: ClientCapabilityState::Supported,
            playable: true,
        }],
    };
    assert_eq!(
        serde_json::to_value(selection).unwrap(),
        serde_json::json!({
            "requestedQuality": "automatic",
            "resolvedQuality": "high",
            "preview": false,
            "qualityCapabilities": [{
                "quality": "high",
                "entitlement": "allowed",
                "resource": "available",
                "client": "supported",
                "playable": true,
            }],
        })
    );
    let omitted_selection = PlaybackSourceSelection {
        requested_quality: AudioQualityPreference::Standard,
        resolved_quality: AudioQuality::Standard,
        fallback_reason: None,
        preview: false,
        quality_capabilities: Vec::new(),
    };
    assert_eq!(
        serde_json::to_value(omitted_selection).unwrap(),
        serde_json::json!({
            "requestedQuality": "standard",
            "resolvedQuality": "standard",
            "preview": false,
        })
    );

    for (setting, expected, persisted) in [
        (None, AudioQualityPreference::Automatic, "automatic"),
        (
            Some("automatic"),
            AudioQualityPreference::Automatic,
            "automatic",
        ),
        (
            Some("standard"),
            AudioQualityPreference::Standard,
            "standard",
        ),
        (Some("high"), AudioQualityPreference::High, "high"),
        (
            Some("lossless"),
            AudioQualityPreference::Lossless,
            "lossless",
        ),
        (Some("master"), AudioQualityPreference::Master, "master"),
        (Some("hi-res"), AudioQualityPreference::HiRes, "hi-res"),
        (Some("hires"), AudioQualityPreference::HiRes, "hi-res"),
        (
            Some("unrecognized"),
            AudioQualityPreference::Automatic,
            "automatic",
        ),
    ] {
        assert_eq!(
            AudioQualityPreference::from_setting(setting.map(str::to_owned)),
            expected
        );
        assert_eq!(expected.as_setting(), persisted);
    }
}

#[test]
fn playback_epoch_is_scope_sensitive_but_not_a_wire_value() {
    let first = PlaybackEpoch::new(7, "opaque-account-a");
    let same = PlaybackEpoch::new(7, "opaque-account-a");
    let new_generation = PlaybackEpoch::new(8, "opaque-account-a");
    let new_scope = PlaybackEpoch::new(7, "opaque-account-b");

    assert!(first == same);
    assert!(first != new_generation);
    assert!(first != new_scope);
    assert_eq!(first.generation(), 7);
}
