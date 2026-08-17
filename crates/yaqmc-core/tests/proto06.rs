use std::sync::Arc;

use serde_json::json;
use yaqmc_core::audio::UnavailableAudioEngine;
use yaqmc_core::credentials::{CredentialError, CredentialStore};
use yaqmc_core::server::{NoopHost, serve_protocol};
use yaqmc_core::{CoreBootstrapInputs, CoreConfig, CoreHandle, CorePaths, bootstrap};
use yaqmc_protocol::{
    AttachMessage, CoreMessage, CoreTransport, HostIdentity, PROTOCOL_VERSION, PlatformAttach,
    PlatformKind, ResponseBody, ShutdownReason, duplex_pair, host_handshake,
};

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

fn boot() -> (tempfile::TempDir, CoreHandle, NoopHost) {
    let root = tempfile::tempdir().expect("temp root");
    std::fs::create_dir_all(root.path().join("config")).expect("config dir");
    let runtime = tokio::runtime::Handle::current();
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
            runtime,
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
    (root, handle, host)
}

fn attach_message() -> AttachMessage {
    AttachMessage {
        protocol: PROTOCOL_VERSION,
        host: HostIdentity {
            app: "yaqmc".to_owned(),
            version: "0.1.0".to_owned(),
        },
        platform: PlatformAttach {
            main_window_handle: None,
            platform_kind: PlatformKind::Windows,
            display_backend: None,
        },
    }
}

#[tokio::test]
async fn handshake_core_ping_and_stdin_eof_shut_the_server_down() {
    let (_root, core, host) = boot();
    let (mut host_transport, core_transport) = duplex_pair();
    let server = tokio::spawn(async move { serve_protocol(core, &host, core_transport).await });

    let identity = host_handshake(&mut host_transport, attach_message(), Some("0.1.0"))
        .await
        .expect("host handshake");
    assert_eq!(identity.version, "0.1.0");
    assert_eq!(identity.channel, "test-channel");

    host_transport
        .send(&CoreMessage::Request {
            id: 1,
            method: "core_ping".to_owned(),
            params: None,
        })
        .await
        .expect("core_ping");
    match host_transport.recv().await.expect("ping response") {
        CoreMessage::Response { id, body } => {
            assert_eq!(id, 1);
            assert_eq!(body, ResponseBody::success(json!({})));
        }
        other => panic!("expected response, got {other:?}"),
    }

    drop(host_transport);
    server
        .await
        .expect("server task")
        .expect("EOF shutdown is success");
}

#[tokio::test]
async fn platform_attach_and_shutdown_prepare_then_shutdown_ack() {
    let (_root, core, host) = boot();
    let (mut host_transport, core_transport) = duplex_pair();
    let server = tokio::spawn(async move { serve_protocol(core, &host, core_transport).await });

    host_handshake(&mut host_transport, attach_message(), Some("0.1.0"))
        .await
        .expect("host handshake");

    host_transport
        .send(&CoreMessage::Request {
            id: 2,
            method: "platform_attach".to_owned(),
            params: Some(json!({
                "mainWindowHandle": "0000000000123456",
                "platformKind": "windows",
            })),
        })
        .await
        .expect("platform_attach");
    match host_transport.recv().await.expect("attach response") {
        CoreMessage::Response { id, body } => {
            assert_eq!(id, 2);
            assert_eq!(body, ResponseBody::success(json!({ "ok": true })));
        }
        other => panic!("expected response, got {other:?}"),
    }

    host_transport
        .send(&CoreMessage::Request {
            id: 3,
            method: "core_shutdown_prepare".to_owned(),
            params: None,
        })
        .await
        .expect("shutdown prepare");
    match host_transport.recv().await.expect("prepare response") {
        CoreMessage::Response { id, body } => {
            assert_eq!(id, 3);
            assert_eq!(body, ResponseBody::success(json!({ "ok": true })));
        }
        other => panic!("expected response, got {other:?}"),
    }

    host_transport
        .send(&CoreMessage::Shutdown {
            reason: ShutdownReason::Quit,
        })
        .await
        .expect("shutdown");
    match host_transport.recv().await.expect("shutdown-ack") {
        CoreMessage::ShutdownAck => {}
        other => panic!("expected shutdown-ack, got {other:?}"),
    }

    server
        .await
        .expect("server task")
        .expect("shutdown-ack path");
}

#[test]
fn cargo_defines_the_yaqmc_core_stdio_binary() {
    let manifest = include_str!("../Cargo.toml");
    assert!(manifest.contains("name = \"yaqmc-core\""));
    assert!(manifest.contains("path = \"src/bin/yaqmc-core.rs\""));
    let _bin = include_str!("../src/bin/yaqmc-core.rs");
}
