use std::sync::Arc;

use serde_json::json;
use yaqmc_core::audio::UnavailableAudioEngine;
use yaqmc_core::credentials::{CredentialError, CredentialStore};
use yaqmc_core::server::{core_dispatch_methods, dispatch, DispatchError, NoopHost};
use yaqmc_core::{bootstrap, CoreBootstrapInputs, CoreConfig, CoreHandle, CorePaths};
use yaqmc_protocol::{methods, ErrorCode, MethodOwner, WindowOrigin};

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
