use std::sync::Arc;

use serde_json::json;
use yaqmc_core::audio::UnavailableAudioEngine;
use yaqmc_core::credentials::{CredentialError, CredentialStore};
use yaqmc_core::server::{serve_protocol, NoopHost};
use yaqmc_core::{bootstrap, CoreBootstrapInputs, CoreConfig, CoreHandle, CorePaths};
use yaqmc_protocol::{
    duplex_pair, host_handshake, AttachMessage, CoreMessage, CoreTransport, HostIdentity,
    PlatformAttach, PlatformKind, ResponseBody, ShutdownReason, WindowOrigin,
    CHANNEL_PREFERENCES_CHANGED, PROTOCOL_VERSION,
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

async fn recv_until_non_event<T: CoreTransport>(transport: &mut T) -> CoreMessage {
    loop {
        match transport.recv().await.expect("protocol message") {
            CoreMessage::Event { .. } => {}
            message => return message,
        }
    }
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
    let server = tokio::spawn(async move { serve_protocol(core, host, core_transport).await });

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
            origin: None,
        })
        .await
        .expect("core_ping");
    match recv_until_non_event(&mut host_transport).await {
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
    let server = tokio::spawn(async move { serve_protocol(core, host, core_transport).await });

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
            origin: None,
        })
        .await
        .expect("platform_attach");
    match recv_until_non_event(&mut host_transport).await {
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
            origin: None,
        })
        .await
        .expect("shutdown prepare");
    match recv_until_non_event(&mut host_transport).await {
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
    match recv_until_non_event(&mut host_transport).await {
        CoreMessage::ShutdownAck => {}
        other => panic!("expected shutdown-ack, got {other:?}"),
    }

    server
        .await
        .expect("server task")
        .expect("shutdown-ack path");
}

#[tokio::test]
async fn stdio_requests_use_main_assigned_origin_for_dialog_split_io() {
    let (root, core, host) = boot();
    let (mut host_transport, core_transport) = duplex_pair();
    let server = tokio::spawn(async move { serve_protocol(core, host, core_transport).await });

    host_handshake(&mut host_transport, attach_message(), Some("0.1.0"))
        .await
        .expect("host handshake");

    host_transport
        .send(&CoreMessage::Request {
            id: 10,
            method: "diagnostics_export_bundle_to".to_owned(),
            params: Some(json!({
                "path": root.path().join("denied-host.zip").to_string_lossy(),
                "request": { "includeLogs": false }
            })),
            origin: None,
        })
        .await
        .expect("host-origin export");
    match recv_until_non_event(&mut host_transport).await {
        CoreMessage::Response {
            id,
            body: ResponseBody::Failure { error },
        } => {
            assert_eq!(id, 10);
            assert_eq!(error.code, "host.denied");
            assert!(error.message.contains("not allowed from host"));
        }
        other => panic!("expected host ACL denial, got {other:?}"),
    }

    host_transport
        .send(&CoreMessage::Request {
            id: 11,
            method: "diagnostics_export_bundle_to".to_owned(),
            params: Some(json!({
                "path": root.path().join("denied-lyrics.zip").to_string_lossy(),
                "request": { "includeLogs": false }
            })),
            origin: Some(WindowOrigin::LyricsDesktop),
        })
        .await
        .expect("lyrics-origin export");
    match recv_until_non_event(&mut host_transport).await {
        CoreMessage::Response {
            id,
            body: ResponseBody::Failure { error },
        } => {
            assert_eq!(id, 11);
            assert!(error.message.contains("not allowed from lyrics-desktop"));
        }
        other => panic!("expected lyrics ACL denial, got {other:?}"),
    }

    let dest = root.path().join("main-origin.zip");
    host_transport
        .send(&CoreMessage::Request {
            id: 12,
            method: "diagnostics_export_bundle_to".to_owned(),
            params: Some(json!({
                "path": dest.to_string_lossy(),
                "request": { "includeLogs": false }
            })),
            origin: Some(WindowOrigin::Main),
        })
        .await
        .expect("main-origin export");
    match recv_until_non_event(&mut host_transport).await {
        CoreMessage::Response {
            id,
            body: ResponseBody::Success { .. },
        } => {
            assert_eq!(id, 12);
            assert!(dest.is_file(), "main-origin export should write a zip");
        }
        other => panic!("expected main-origin success, got {other:?}"),
    }

    drop(host_transport);
    server
        .await
        .expect("server task")
        .expect("EOF shutdown is success");
}

#[tokio::test]
async fn app_preferences_set_emits_preferences_changed_string_payload() {
    let (_root, core, host) = boot();
    let (mut host_transport, core_transport) = duplex_pair();
    let server = tokio::spawn(async move { serve_protocol(core, host, core_transport).await });

    host_handshake(&mut host_transport, attach_message(), Some("0.1.0"))
        .await
        .expect("host handshake");

    host_transport
        .send(&CoreMessage::Request {
            id: 20,
            method: "app_preferences_set".to_owned(),
            params: Some(json!({ "value": r#"{"version":2,"locale":"zh-CN"}"# })),
            origin: Some(WindowOrigin::Main),
        })
        .await
        .expect("preferences set");

    let mut saw_event = false;
    let mut saw_response = false;
    for _ in 0..32 {
        if saw_event && saw_response {
            break;
        }
        match host_transport.recv().await.expect("protocol message") {
            CoreMessage::Event {
                channel, payload, ..
            } if channel == CHANNEL_PREFERENCES_CHANGED => {
                let stored = payload.as_str().expect("Tauri-shaped JSON string payload");
                let document: serde_json::Value =
                    serde_json::from_str(stored).expect("stored preferences");
                assert_eq!(document["locale"], "zh-CN");
                saw_event = true;
            }
            CoreMessage::Response { id, body } => {
                assert_eq!(id, 20);
                assert!(matches!(body, ResponseBody::Success { .. }));
                saw_response = true;
            }
            CoreMessage::Event { .. } => {}
            other => panic!("unexpected {other:?}"),
        }
    }
    assert!(saw_event, "stdio must emit preferences://changed");
    assert!(saw_response);

    drop(host_transport);
    server
        .await
        .expect("server task")
        .expect("EOF shutdown is success");
}

#[test]
fn cargo_defines_the_yaqmc_core_stdio_binary() {
    let manifest = include_str!("../Cargo.toml");
    assert!(manifest.contains("name = \"yaqmc-core\""));
    assert!(manifest.contains("path = \"src/bin/yaqmc-core.rs\""));
    let _bin = include_str!("../src/bin/yaqmc-core.rs");
}
