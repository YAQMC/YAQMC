use std::sync::Arc;

use serde_json::json;
use yaqmc_core::audio::UnavailableAudioEngine;
use yaqmc_core::credentials::{CredentialError, CredentialStore};
use yaqmc_core::server::{dispatch, NoopHost};
use yaqmc_core::{bootstrap, CoreBootstrapInputs, CoreConfig, CoreHandle, CorePaths};
use yaqmc_protocol::WindowOrigin;

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
fn diagnostics_export_bundle_to_writes_host_json_when_payload_is_present() {
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
                "request": {
                    "includeLogs": false,
                    "hostPayload": {
                        "schemaVersion": 1,
                        "electron": "43.4.0",
                        "chrome": "140.0.7339.241",
                        "node": "24.11.1",
                        "windows": [{ "id": 1, "role": "main", "visible": true }],
                        "display": {
                            "backend": "win32",
                            "capabilities": {
                                "alwaysOnTop": true,
                                "clickThrough": true,
                                "globalShortcuts": true,
                                "transparency": true
                            }
                        },
                        "updater": { "state": "idle", "canInstall": true, "channel": "stable" },
                        "restartCounter": 0,
                        "log": "host log tail\n"
                    }
                }
            })),
        )
        .await
        .expect("export to");
        assert_eq!(result["path"].as_str(), Some(dest.to_str().unwrap()));
        assert!(dest.exists());
        let bytes = std::fs::read(&dest).expect("zip bytes");
        let haystack = String::from_utf8_lossy(&bytes);
        assert!(haystack.contains("host.json"));
        assert!(haystack.contains("host.log"));
    });
}

#[test]
fn diagnostics_export_bundle_to_stays_backward_compatible_without_host_payload() {
    let (root, runtime, core, host) = boot();
    runtime.block_on(async {
        let dest = root.path().join("plain").join("YAQMC-diagnostics.zip");
        dispatch(
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
        let bytes = std::fs::read(&dest).expect("zip bytes");
        let haystack = String::from_utf8_lossy(&bytes);
        assert!(haystack.contains("diagnostics.json"));
        assert!(!haystack.contains("host.json"));
        assert!(!haystack.contains("host.log"));
    });
}
