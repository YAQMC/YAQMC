use std::sync::Arc;

use serde_json::json;
use yaqmc_core::audio::UnavailableAudioEngine;
use yaqmc_core::credentials::{CredentialError, CredentialStore};
use yaqmc_core::server::{dispatch, NoopHost};
use yaqmc_core::{bootstrap, CoreBootstrapInputs, CoreConfig, CoreHandle, CorePaths};
use yaqmc_protocol::{method, MethodOwner, WindowOrigin, PROTOCOL_ONLY_METHODS};

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

const PNG: &[u8] = b"\x89PNG\r\n\x1a\nrest";

#[test]
fn dialog_split_io_methods_are_protocol_only_core_owned() {
    for name in [
        "diagnostics_export_bundle_to",
        "preferences_set_background_from",
        "plugin_install_from",
    ] {
        assert!(PROTOCOL_ONLY_METHODS.contains(&name), "{name}");
        let spec = method(name).expect(name);
        assert_eq!(spec.owner, MethodOwner::Core);
        assert!(spec.main_window_only);
    }
    assert_eq!(
        method("appearance_pick_background")
            .expect("picker stays host")
            .owner,
        MethodOwner::Host
    );
    assert_eq!(
        method("plugin_pick_package")
            .expect("plugin picker stays host")
            .owner,
        MethodOwner::Host
    );
    assert!(method("diagnostics_export_bundle").is_some());
}

#[test]
fn diagnostics_export_bundle_to_writes_the_explicit_path() {
    let (root, runtime, core, host) = boot();
    runtime.block_on(async {
        let dest = root.path().join("chosen").join("YAQMC-diagnostics.zip");
        let result = dispatch(
            &core,
            &host,
            WindowOrigin::Main,
            "diagnostics_export_bundle_to",
            Some(json!({
                "path": dest.to_string_lossy(),
                "request": { "includeLogs": false }
            })),
        )
        .await
        .expect("export to");
        assert_eq!(result["path"].as_str(), Some(dest.to_str().unwrap()));
        assert!(dest.exists());
        assert!(result["bytes"].as_u64().expect("bytes") > 0);
        assert!(!root
            .path()
            .join("downloads")
            .join("YAQMC-diagnostics.zip")
            .exists());
    });
}

#[test]
fn preferences_set_background_from_copies_an_explicit_image() {
    let (root, runtime, core, host) = boot();
    let source = root.path().join("picked.png");
    std::fs::write(&source, PNG).expect("png");
    runtime.block_on(async {
        let result = dispatch(
            &core,
            &host,
            WindowOrigin::Main,
            "preferences_set_background_from",
            Some(json!({ "path": source.to_string_lossy() })),
        )
        .await
        .expect("set background from");
        assert_eq!(
            result["reference"].as_str(),
            Some("backgrounds/custom-background.png")
        );
        let data_uri = result["dataUri"].as_str().expect("dataUri");
        assert!(data_uri.starts_with("data:image/png;base64,"));
        assert!(root
            .path()
            .join("data")
            .join("backgrounds")
            .join("custom-background.png")
            .exists());
    });
}

#[test]
fn plugin_install_from_wraps_plugin_install_for_an_explicit_path() {
    let (_root, runtime, core, host) = boot();
    runtime.block_on(async {
        let error = dispatch(
            &core,
            &host,
            WindowOrigin::Main,
            "plugin_install_from",
            Some(json!({
                "request": {
                    "path": "missing-plugin.yaqmc-plugin",
                    "enable": false,
                    "grant": []
                }
            })),
        )
        .await
        .expect_err("missing package");
        let core_error = error.into_core_error();
        assert_eq!(core_error.code, "core.command_error");
        assert!(!core_error.message.is_empty());
    });
}
