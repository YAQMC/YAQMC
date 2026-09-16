use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;
use yaqmc_core::audio::UnavailableAudioEngine;
use yaqmc_core::credentials::{CredentialError, CredentialStore};
use yaqmc_core::server::{
    actions_for_player_event, core_dispatch_methods, dispatch, DispatchError, NoopHost,
};
use yaqmc_core::{bootstrap, CoreBootstrapInputs, CoreConfig, CoreHandle, CorePaths};
use yaqmc_protocol::{
    methods, ErrorCode, MethodOwner, WindowOrigin, CHANNEL_PROVIDER_PROFILES_CHANGED,
};
use yaqmc_provider_api::{
    LyricDocument, LyricMetadata, LyricSyncMode, LyricsProvider, ProviderCapabilities,
    ProviderResult, RecommendationBatch, RecommendationProvider, RecommendationRequest,
    ShareEntityKind, ShareProvider, ShareTarget,
};

struct ScopedShareProvider {
    profile_id: &'static str,
}

struct ScopedLyricsProvider {
    profile_id: &'static str,
}

struct ScopedRecommendationProvider {
    profile_id: &'static str,
}

#[async_trait]
impl ShareProvider for ScopedShareProvider {
    async fn share_song(&self, id: String) -> ProviderResult<ShareTarget> {
        Ok(ShareTarget {
            provider_id: "fake".to_owned(),
            profile_id: self.profile_id.to_owned(),
            entity_kind: ShareEntityKind::Song,
            entity_id: id,
            title: self.profile_id.to_owned(),
            artists: Vec::new(),
            album: None,
            canonical_https_url: None,
        })
    }
}

#[async_trait]
impl LyricsProvider for ScopedLyricsProvider {
    async fn lyrics_for_song(&self, song_id: String) -> ProviderResult<Option<LyricDocument>> {
        Ok(Some(LyricDocument {
            song_id,
            sync_mode: LyricSyncMode::Unsynchronized,
            metadata: LyricMetadata {
                source_label: self.profile_id.to_owned(),
                language: None,
                translated_language: None,
                offset_ms: 0,
            },
            vocalists: Vec::new(),
            lines: Vec::new(),
        }))
    }
}

#[async_trait]
impl RecommendationProvider for ScopedRecommendationProvider {
    async fn recommendation_next(
        &self,
        _request: RecommendationRequest,
    ) -> ProviderResult<RecommendationBatch> {
        Ok(RecommendationBatch {
            songs: Vec::new(),
            next_cursor: Some(self.profile_id.to_owned()),
            ended: false,
        })
    }
}

fn share_capabilities(profile_id: &'static str) -> ProviderCapabilities {
    ProviderCapabilities {
        share: Some(Arc::new(ScopedShareProvider { profile_id })),
        lyrics: Some(Arc::new(ScopedLyricsProvider { profile_id })),
        recommendations: Some(Arc::new(ScopedRecommendationProvider { profile_id })),
        ..ProviderCapabilities::default()
    }
}

struct TestCredentials;

impl CredentialStore for TestCredentials {
    fn load(&self, _account: &str) -> Result<Option<String>, CredentialError> {
        Ok(None)
    }

    fn save(&self, _account: &str, _secret: &str) -> Result<(), CredentialError> {
        Ok(())
    }

    fn delete(&self, _account: &str) -> Result<(), CredentialError> {
        Ok(())
    }
}

fn boot() -> (
    tempfile::TempDir,
    tokio::runtime::Runtime,
    CoreHandle,
    NoopHost,
) {
    let root = tempfile::tempdir().expect("temp root");
    std::fs::create_dir_all(root.path().join("config")).expect("config dir");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("current-thread runtime");
    let config = CoreConfig {
        paths: CorePaths {
            data_dir: root.path().join("data"),
            cache_dir: root.path().join("cache"),
            log_dir: root.path().join("logs"),
            local_api_config_path: root.path().join("config").join("local-api.json"),
        },
        release_channel: "test-channel".to_owned(),
        build_commit: "0123456789abcdef0123456789abcdef01234567".to_owned(),
    };
    let handle = bootstrap(
        config,
        CoreBootstrapInputs {
            credentials: Arc::new(TestCredentials),
            audio: Arc::new(UnavailableAudioEngine),
            runtime: runtime.handle().clone(),
            windows_hwnd: None,
            windows_start_error: None,
            plugin_fallback_dir: root.path().join("plugin-fallback"),
            log_fallback_dir: root.path().join("log-fallback"),
        },
    )
    .expect("bootstrap");
    let host = NoopHost {
        download_dir: root.path().join("downloads"),
    };
    (root, runtime, handle, host)
}

#[test]
fn registry_core_methods_match_dispatch_arms() {
    let registry: Vec<&str> = methods()
        .iter()
        .filter(|spec| spec.owner == MethodOwner::Core)
        .map(|spec| spec.name)
        .collect();
    assert_eq!(registry, core_dispatch_methods());
    let source = include_str!("../src/server/methods.rs");
    for name in core_dispatch_methods() {
        assert!(
            source.contains(&format!("\"{name}\" =>")),
            "missing dispatch arm for {name}"
        );
    }
}

#[test]
fn provider_profile_lifecycle_dispatch_round_trips_typed_descriptors() {
    let (_root, runtime, core, host) = boot();
    runtime.block_on(async {
        let mut events = core.player().subscribe();
        let initial = dispatch(
            &core,
            &host,
            WindowOrigin::Main,
            "provider_profile_list",
            None,
        )
        .await
        .expect("list profiles");
        assert_eq!(initial.as_array().map(Vec::len), Some(1));
        assert_eq!(initial[0]["providerId"], "qqmusic");
        assert_eq!(initial[0]["profileId"], "default");
        assert_eq!(initial[0]["enabled"], true);

        let created = dispatch(
            &core,
            &host,
            WindowOrigin::Main,
            "provider_profile_create",
            Some(json!({ "providerId": "qqmusic", "label": "Work" })),
        )
        .await
        .expect("create profile");
        let profile_id = created["profileId"]
            .as_str()
            .expect("generated profile id")
            .to_owned();
        assert_eq!(created["providerId"], "qqmusic");
        assert_eq!(created["label"], "Work");
        assert_eq!(created["enabled"], true);
        assert_eq!(
            events
                .recv()
                .await
                .expect("create profile event")
                .event_type,
            "provider.profiles.changed"
        );

        let unchanged_enabled = dispatch(
            &core,
            &host,
            WindowOrigin::Main,
            "provider_profile_enable",
            Some(json!({ "providerId": "qqmusic", "profileId": profile_id })),
        )
        .await
        .expect("enabling an enabled profile is idempotent");
        assert_eq!(unchanged_enabled["enabled"], true);
        assert!(matches!(
            events.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));

        let disabled = dispatch(
            &core,
            &host,
            WindowOrigin::Main,
            "provider_profile_disable",
            Some(json!({ "providerId": "qqmusic", "profileId": profile_id })),
        )
        .await
        .expect("disable profile");
        assert_eq!(disabled["enabled"], false);
        assert_eq!(
            events
                .recv()
                .await
                .expect("disable profile event")
                .event_type,
            "provider.profiles.changed"
        );

        let unchanged_disabled = dispatch(
            &core,
            &host,
            WindowOrigin::Main,
            "provider_profile_disable",
            Some(json!({ "providerId": "qqmusic", "profileId": profile_id })),
        )
        .await
        .expect("disabling a disabled profile is idempotent");
        assert_eq!(unchanged_disabled["enabled"], false);
        assert!(matches!(
            events.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));

        let enabled = dispatch(
            &core,
            &host,
            WindowOrigin::Main,
            "provider_profile_enable",
            Some(json!({ "providerId": "qqmusic", "profileId": profile_id })),
        )
        .await
        .expect("enable profile");
        assert_eq!(enabled["enabled"], true);
        assert_eq!(
            events
                .recv()
                .await
                .expect("enable profile event")
                .event_type,
            "provider.profiles.changed"
        );

        let deleted = dispatch(
            &core,
            &host,
            WindowOrigin::Main,
            "provider_profile_delete",
            Some(json!({ "providerId": "qqmusic", "profileId": profile_id })),
        )
        .await
        .expect("delete profile");
        assert_eq!(deleted["profileId"], profile_id);
        assert_eq!(
            events
                .recv()
                .await
                .expect("delete profile event")
                .event_type,
            "provider.profiles.changed"
        );

        let final_profiles = dispatch(
            &core,
            &host,
            WindowOrigin::Main,
            "provider_profile_list",
            None,
        )
        .await
        .expect("list profiles after deletion");
        assert_eq!(final_profiles, initial);
    });

    let actions = actions_for_player_event("provider.profiles.changed");
    assert_eq!(
        actions.channels,
        vec!["api://event", CHANNEL_PROVIDER_PROFILES_CHANGED]
    );
    assert!(!actions.update_system_media);
    assert!(!actions.persist_queue);
}

#[test]
fn provider_profile_dispatch_errors_are_stable_and_fail_closed() {
    let (_root, runtime, core, host) = boot();
    runtime.block_on(async {
        for (method, params, expected_code) in [
            (
                "provider_profile_create",
                json!({ "providerId": "missing", "label": "Work" }),
                "invalid-request",
            ),
            (
                "provider_profile_create",
                json!({ "providerId": "qqmusic", "label": "\n" }),
                "invalid-request",
            ),
            (
                "provider_profile_disable",
                json!({ "providerId": "qqmusic", "profileId": "default" }),
                "protected-default",
            ),
            (
                "provider_profile_delete",
                json!({ "providerId": "qqmusic", "profileId": "missing" }),
                "not-found",
            ),
        ] {
            let error = dispatch(&core, &host, WindowOrigin::Main, method, Some(params))
                .await
                .expect_err("invalid lifecycle request fails closed")
                .into_core_error();
            assert_eq!(error.code, ErrorCode::CommandError.as_str());
            assert!(!error.retryable);
            assert_eq!(
                error
                    .details
                    .as_ref()
                    .and_then(|details| details["code"].as_str()),
                Some(expected_code)
            );
        }
    });
}

#[test]
fn host_owned_methods_are_not_dispatched_by_core() {
    let (_root, runtime, core, host) = boot();
    runtime.block_on(async {
        let error = dispatch(
            &core,
            &host,
            WindowOrigin::Host,
            "system_shortcuts_set_enabled",
            Some(json!({ "enabled": true })),
        )
        .await
        .expect_err("host methods stay on the host");
        let core_error = error.into_core_error();
        assert_eq!(core_error.code, ErrorCode::Denied.as_str());
        assert!(core_error.message.contains("host"));
    });
}

#[test]
fn dispatch_rechecks_acl_before_running_a_core_method() {
    let (_root, runtime, core, host) = boot();
    runtime.block_on(async {
        let error = dispatch(
            &core,
            &host,
            WindowOrigin::LyricsDesktop,
            "qqmusic_sign_out",
            None,
        )
        .await
        .expect_err("lyric surfaces cannot spoof account ACL");
        match error {
            DispatchError::Denied(denied) => {
                assert_eq!(denied.code(), ErrorCode::Denied);
            }
            other => panic!("expected denied, got {other:?}"),
        }
    });
}

#[test]
fn player_group_dispatch_round_trips_a_snapshot() {
    let (_root, runtime, core, host) = boot();
    runtime.block_on(async {
        let snapshot = dispatch(&core, &host, WindowOrigin::Main, "player_snapshot", None)
            .await
            .expect("player_snapshot");
        assert_eq!(snapshot["isPlaying"], false);
        let toggled = dispatch(
            &core,
            &host,
            WindowOrigin::LyricsDesktop,
            "player_toggle",
            None,
        )
        .await;
        assert!(toggled.is_ok() || matches!(toggled, Err(DispatchError::Command { .. })));
    });
}

#[test]
fn provider_dispatch_defaults_and_rejects_profile_scope_at_the_registry_boundary() {
    let (_root, runtime, core, host) = boot();
    runtime.block_on(async {
        for params in [
            json!({ "providerId": "qqmusic" }),
            json!({ "providerId": "qqmusic", "profileId": "default" }),
        ] {
            let status = dispatch(
                &core,
                &host,
                WindowOrigin::Main,
                "provider_status",
                Some(params),
            )
            .await
            .expect("the compatibility profile is available");
            assert_eq!(status["providerId"], "qqmusic");
            assert_eq!(status["profileId"], "default");
        }

        for (params, expected_code) in [
            (
                json!({ "providerId": "qqmusic", "profileId": "bad profile" }),
                "invalid-request",
            ),
            (
                json!({ "providerId": "qqmusic", "profileId": "secondary" }),
                "profile-unavailable",
            ),
            (json!({ "providerId": "missing" }), "provider-unavailable"),
        ] {
            let error = dispatch(
                &core,
                &host,
                WindowOrigin::Main,
                "provider_status",
                Some(params),
            )
            .await
            .expect_err("invalid or unavailable scopes fail closed")
            .into_core_error();
            assert_eq!(
                error
                    .details
                    .as_ref()
                    .and_then(|value| value["code"].as_str()),
                Some(expected_code)
            );
        }
    });
}

#[test]
fn generic_provider_dispatch_selects_the_exact_default_or_work_profile() {
    let (_root, runtime, core, host) = boot();
    core.providers()
        .register_capabilities("fake", share_capabilities("default"))
        .expect("register fake default profile");
    core.providers()
        .register_profile("fake", "work", share_capabilities("work"))
        .expect("register fake work profile");

    runtime.block_on(async {
        for (params, expected_profile) in [
            (json!({ "providerId": "fake", "id": "song-1" }), "default"),
            (
                json!({ "providerId": "fake", "profileId": "work", "id": "song-1" }),
                "work",
            ),
        ] {
            let share = dispatch(
                &core,
                &host,
                WindowOrigin::Main,
                "catalog_share_song",
                Some(params),
            )
            .await
            .expect("share dispatch uses the requested profile");
            assert_eq!(share["providerId"], "fake");
            assert_eq!(share["profileId"], expected_profile);
            assert_eq!(share["title"], expected_profile);
        }

        for (params, expected_profile) in [
            (json!({ "providerId": "fake", "id": "song-1" }), "default"),
            (
                json!({ "providerId": "fake", "profileId": "work", "id": "song-1" }),
                "work",
            ),
        ] {
            let lyrics = dispatch(
                &core,
                &host,
                WindowOrigin::Main,
                "provider_lyrics",
                Some(params),
            )
            .await
            .expect("lyrics dispatch uses the requested profile");
            assert_eq!(lyrics["songId"], "song-1");
            assert_eq!(lyrics["metadata"]["sourceLabel"], expected_profile);
        }

        for (profile_id, expected_profile) in [(None, "default"), (Some("work"), "work")] {
            let mut params = json!({
                "providerId": "fake",
                "request": { "kind": "guess", "limit": 10, "cursor": null, "seeds": [] }
            });
            if let Some(profile_id) = profile_id {
                params["profileId"] = json!(profile_id);
            }
            let batch = dispatch(
                &core,
                &host,
                WindowOrigin::Main,
                "provider_recommendation_next",
                Some(params),
            )
            .await
            .expect("recommendation dispatch uses the requested profile");
            assert_eq!(batch["nextCursor"], expected_profile);
        }

        for (profile_id, expected_code) in [
            ("missing", "profile-unavailable"),
            ("bad profile", "invalid-request"),
        ] {
            let error = dispatch(
                &core,
                &host,
                WindowOrigin::Main,
                "catalog_share_song",
                Some(json!({
                    "providerId": "fake",
                    "profileId": profile_id,
                    "id": "song-1"
                })),
            )
            .await
            .expect_err("unknown and invalid profiles fail closed")
            .into_core_error();
            assert_eq!(error.code, ErrorCode::CommandError.as_str());
            assert_eq!(
                error
                    .details
                    .as_ref()
                    .and_then(|value| value["code"].as_str()),
                Some(expected_code)
            );
        }

        let error = dispatch(
            &core,
            &host,
            WindowOrigin::Main,
            "provider_account_playlist_tracks",
            Some(json!({
                "providerId": "fake",
                "profileId": "work",
                "playlist": {
                    "providerId": "fake",
                    "profileId": "default",
                    "id": "playlist-1",
                    "reference": { "kind": "owned", "tid": "tid-1" },
                    "title": "Fixture Playlist",
                    "description": "",
                    "owner": { "id": "owner-1", "displayName": "Owner" },
                    "artwork": { "src": "", "alt": "", "dominantColor": "#000000" },
                    "ownership": "owned",
                    "capabilities": {
                        "canAddTracks": true,
                        "canRemoveTracks": true,
                        "canRename": true,
                        "canDelete": true,
                        "canReorder": true
                    },
                    "trackCount": 1,
                    "updatedAtMs": null
                },
                "cursor": null,
                "limit": 20
            })),
        )
        .await
        .expect_err("account playlist input cannot cross profile boundaries")
        .into_core_error();
        assert_eq!(error.code, ErrorCode::CommandError.as_str());
        assert_eq!(
            error
                .details
                .as_ref()
                .and_then(|value| value["code"].as_str()),
            Some("invalid-request")
        );
        assert!(error
            .message
            .contains("does not match the requested profile"));
    });
}

#[test]
fn profile_aware_provider_methods_parse_provider_id_before_scope_resolution() {
    let (_root, runtime, core, host) = boot();
    runtime.block_on(async {
        for params in [json!({}), json!({ "providerId": 42 })] {
            let error = dispatch(
                &core,
                &host,
                WindowOrigin::Main,
                "provider_status",
                Some(params),
            )
            .await
            .expect_err("malformed provider parameters are protocol errors")
            .into_core_error();
            assert_eq!(error.code, ErrorCode::Protocol.as_str());
            assert!(error.details.is_none());
        }

        let error = dispatch(
            &core,
            &host,
            WindowOrigin::Main,
            "provider_status",
            Some(json!({ "providerId": "missing" })),
        )
        .await
        .expect_err("an unknown, well-typed provider reaches provider resolution")
        .into_core_error();
        assert_eq!(error.code, ErrorCode::CommandError.as_str());
        assert!(!error.retryable);
        assert_eq!(
            error
                .details
                .as_ref()
                .and_then(|value| value["code"].as_str()),
            Some("provider-unavailable")
        );
    });
}

#[test]
fn continuation_start_preserves_provider_command_error_details() {
    let (_root, runtime, core, host) = boot();
    runtime.block_on(async {
        let error = dispatch(
            &core,
            &host,
            WindowOrigin::Main,
            "continuation_start",
            Some(json!({
                "request": {
                    "providerId": "missing",
                    "kind": "guess",
                    "tracks": []
                }
            })),
        )
        .await
        .expect_err("unknown providers fail with a provider command error")
        .into_core_error();
        assert_eq!(error.code, ErrorCode::CommandError.as_str());
        assert_eq!(error.message, "music provider is unavailable");
        assert!(!error.retryable);
        assert_eq!(
            error
                .details
                .as_ref()
                .and_then(|value| value["code"].as_str()),
            Some("provider-unavailable")
        );
        assert_eq!(
            error
                .details
                .as_ref()
                .and_then(|value| value["message"].as_str()),
            Some("music provider is unavailable")
        );
        assert_eq!(
            error
                .details
                .as_ref()
                .and_then(|value| value["retryable"].as_bool()),
            Some(false)
        );
    });
}

#[test]
fn statistics_dispatch_round_trips_snapshot_export_and_clear_notification() {
    let (root, runtime, core, host) = boot();
    runtime.block_on(async {
        let snapshot = dispatch(
            &core,
            &host,
            WindowOrigin::Main,
            "statistics_snapshot",
            Some(json!({ "range": "30-days" })),
        )
        .await
        .expect("statistics snapshot");
        assert_eq!(snapshot["range"], "30-days");
        assert_eq!(snapshot["recordCount"], 0);

        let path = root.path().join("statistics.json");
        let exported = dispatch(
            &core,
            &host,
            WindowOrigin::Main,
            "statistics_export_to",
            Some(json!({
                "request": {
                    "range": "all-time",
                    "format": "json",
                    "path": path
                }
            })),
        )
        .await
        .expect("statistics export");
        assert_eq!(exported["sessionCount"], 0);
        assert!(path.is_file());

        let mut events = core.player().subscribe();
        let cleared = dispatch(&core, &host, WindowOrigin::Main, "statistics_clear", None)
            .await
            .expect("statistics clear");
        assert_eq!(cleared["deletedSessions"], 0);
        let changed = events.try_recv().expect("statistics changed event");
        assert_eq!(changed.event_type, "statistics.changed");
        assert_eq!(changed.data["revision"], cleared["revision"]);
    });
}

#[test]
fn dispatch_rejects_oversize_method_payloads_without_raising_the_hard_cap() {
    let (_root, runtime, core, host) = boot();
    runtime.block_on(async {
        let oversized = json!({ "value": "x".repeat(2 * 1024 * 1024) });
        let error = dispatch(
            &core,
            &host,
            WindowOrigin::Main,
            "app_preferences_set",
            Some(oversized),
        )
        .await
        .expect_err("1 MiB default cap");
        let core_error = error.into_core_error();
        assert_eq!(core_error.code, ErrorCode::Protocol.as_str());
    });
}
