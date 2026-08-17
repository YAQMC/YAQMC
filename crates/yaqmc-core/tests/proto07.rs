use std::sync::Arc;

use serde_json::json;
use yaqmc_core::audio::UnavailableAudioEngine;
use yaqmc_core::credentials::{CredentialError, CredentialStore};
use yaqmc_core::qqmusic::{OAuthLoginProvider, url_matches_oauth_allowlist};
use yaqmc_core::server::{NoopHost, dispatch};
use yaqmc_core::{CoreBootstrapInputs, CoreConfig, CoreHandle, CorePaths, bootstrap};
use yaqmc_protocol::{MethodOwner, PROTOCOL_ONLY_METHODS, WindowOrigin, method};

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
fn oauth_protocol_methods_are_core_owned_and_not_tauri_commands() {
    for name in [
        "auth_oauth_prepare",
        "auth_oauth_complete",
        "auth_oauth_cancel",
    ] {
        assert!(PROTOCOL_ONLY_METHODS.contains(&name), "{name}");
        let spec = method(name).expect(name);
        assert_eq!(spec.owner, MethodOwner::Core);
    }
    let oauth_start = method("qqmusic_auth_oauth_start").expect("oauth start stays host-owned");
    assert_eq!(oauth_start.owner, MethodOwner::Host);
}

#[test]
fn prepare_returns_allowlist_and_cancel_consumes_the_attempt() {
    let (_root, runtime, core, host) = boot();
    runtime.block_on(async {
        let prepared = dispatch(
            &core,
            &host,
            WindowOrigin::Host,
            "auth_oauth_prepare",
            Some(json!({ "providerKind": "qq" })),
        )
        .await
        .expect("prepare");
        assert!(prepared.get("snapshot").is_none());
        let url = prepared["url"].as_str().expect("url");
        assert!(url.contains("graph.qq.com"));
        let allowlist = prepared["navigationAllowlist"]
            .as_array()
            .expect("allowlist");
        assert!(
            allowlist
                .iter()
                .any(|entry| entry.as_str() == Some("https://graph.qq.com/**"))
        );
        assert_eq!(
            prepared["callbackMatcher"]["urlPrefix"].as_str(),
            Some(OAuthLoginProvider::Qq.callback_url_prefix())
        );
        let parsed: Vec<String> = allowlist
            .iter()
            .map(|entry| entry.as_str().expect("glob").to_owned())
            .collect();
        assert!(url_matches_oauth_allowlist(
            &reqwest::Url::parse(url).expect("authorization url"),
            &parsed
        ));

        let attempt_id = prepared["attemptId"]
            .as_str()
            .expect("attemptId")
            .to_owned();
        dispatch(
            &core,
            &host,
            WindowOrigin::Host,
            "auth_oauth_cancel",
            Some(json!({ "attemptId": attempt_id })),
        )
        .await
        .expect("cancel");
    });
}

#[test]
fn tauri_oauth_window_consumes_the_protocol_methods() {
    let source = include_str!("../../../src-tauri/src/qqmusic_oauth_host.rs");
    assert!(source.contains("ops::auth_oauth_prepare"));
    assert!(source.contains("ops::auth_oauth_complete"));
    assert!(source.contains("ops::auth_oauth_cancel"));
    assert!(!source.contains("start_oauth_login("));
}
