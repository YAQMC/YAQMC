use std::time::Duration;

use tokio::io::{duplex, split, AsyncWriteExt};
use yaqmc_protocol::{
    core_handshake, duplex_pair, host_handshake, host_handshake_with_timeout, read_frame,
    write_frame, AttachMessage, CoreError, CoreIdentity, CoreMessage, CoreTransport,
    DisplayBackend, DuplexTransport, ErrorCode, FrameError, HostIdentity, PipeTransport,
    PlatformAttach, PlatformKind, ProtocolError, ProtocolVersion, ResponseBody, ShutdownReason,
    StdioTransport, DEFAULT_METHOD_PAYLOAD_BYTES, FRAME_HARD_CAP_BYTES, HANDSHAKE_TIMEOUT,
    PROTOCOL_VERSION, SHUTDOWN_TIMEOUT,
};

fn hello_message() -> CoreMessage {
    CoreMessage::Hello {
        protocol: PROTOCOL_VERSION,
        core: CoreIdentity {
            version: "0.1.0".to_owned(),
            commit: "0123456789abcdef0123456789abcdef01234567".to_owned(),
            channel: "stable".to_owned(),
        },
    }
}

fn attach_message() -> CoreMessage {
    CoreMessage::Attach(AttachMessage {
        protocol: PROTOCOL_VERSION,
        host: HostIdentity {
            app: "yaqmc".to_owned(),
            version: "0.1.0".to_owned(),
        },
        platform: PlatformAttach {
            main_window_handle: Some("0000000000123456".to_owned()),
            platform_kind: PlatformKind::Windows,
            display_backend: None,
        },
    })
}

#[test]
fn protocol_constants_match_the_binding_plan() {
    assert_eq!(PROTOCOL_VERSION, ProtocolVersion::V1 as u32);
    assert_eq!(PROTOCOL_VERSION, 1);
    assert_eq!(FRAME_HARD_CAP_BYTES, 32 * 1024 * 1024);
    assert_eq!(DEFAULT_METHOD_PAYLOAD_BYTES, 1024 * 1024);
    assert_eq!(HANDSHAKE_TIMEOUT, Duration::from_secs(10));
    assert_eq!(SHUTDOWN_TIMEOUT, Duration::from_secs(5));
}

#[test]
fn event_channel_names_match_adr004() {
    use yaqmc_protocol::{
        CHANNEL_ACCOUNT_CHANGED, CHANNEL_API_EVENT, CHANNEL_APP_OPEN_SETTINGS, CHANNEL_CORE_LOG,
        CHANNEL_HOST_COMMAND, CHANNEL_HOST_CORE_STATUS, CHANNEL_LYRICS_DOCUMENT,
        CHANNEL_LYRICS_PROJECTION, CHANNEL_LYRICS_SURFACE_CLOSED, CHANNEL_PLAYER_SNAPSHOT,
        CHANNEL_PLUGIN_CHANGED, CHANNEL_PREFERENCES_CHANGED, CORE_EVENT_CHANNELS,
        HOST_EVENT_CHANNELS,
    };
    assert_eq!(CHANNEL_API_EVENT, "api://event");
    assert_eq!(CHANNEL_PLAYER_SNAPSHOT, "player://snapshot");
    assert_eq!(CHANNEL_LYRICS_PROJECTION, "lyrics://projection");
    assert_eq!(CHANNEL_LYRICS_DOCUMENT, "lyrics://document");
    assert_eq!(CHANNEL_PLUGIN_CHANGED, "plugin://changed");
    assert_eq!(CHANNEL_PREFERENCES_CHANGED, "preferences://changed");
    assert_eq!(CHANNEL_LYRICS_SURFACE_CLOSED, "lyrics://surface-closed");
    assert_eq!(CHANNEL_APP_OPEN_SETTINGS, "app://open-settings");
    assert_eq!(CHANNEL_HOST_COMMAND, "host://command");
    assert_eq!(CHANNEL_HOST_CORE_STATUS, "host://core-status");
    assert_eq!(CHANNEL_CORE_LOG, "core://log");
    assert_eq!(CHANNEL_ACCOUNT_CHANGED, "account://changed");
    assert_eq!(CORE_EVENT_CHANNELS.len(), 9);
    assert_eq!(HOST_EVENT_CHANNELS.len(), 3);
}

#[test]
fn error_codes_match_the_infra_table() {
    assert_eq!(ErrorCode::CommandError.as_str(), "core.command_error");
    assert_eq!(ErrorCode::Unavailable.as_str(), "core.unavailable");
    assert_eq!(ErrorCode::Timeout.as_str(), "core.timeout");
    assert_eq!(ErrorCode::Protocol.as_str(), "core.protocol");
    assert_eq!(ErrorCode::Denied.as_str(), "host.denied");
}

#[test]
fn envelope_serde_snapshots_cover_every_kind() {
    let cases = [
        (
            hello_message(),
            r#"{"kind":"hello","protocol":1,"core":{"version":"0.1.0","commit":"0123456789abcdef0123456789abcdef01234567","channel":"stable"}}"#,
        ),
        (
            attach_message(),
            r#"{"kind":"attach","protocol":1,"host":{"app":"yaqmc","version":"0.1.0"},"platform":{"mainWindowHandle":"0000000000123456","platformKind":"windows"}}"#,
        ),
        (CoreMessage::Ready, r#"{"kind":"ready"}"#),
        (
            CoreMessage::Request {
                id: 7,
                method: "player_snapshot".to_owned(),
                params: None,
            },
            r#"{"kind":"request","id":7,"method":"player_snapshot"}"#,
        ),
        (
            CoreMessage::Request {
                id: 8,
                method: "player_seek".to_owned(),
                params: Some(serde_json::json!({"positionMs": 1000})),
            },
            r#"{"kind":"request","id":8,"method":"player_seek","params":{"positionMs":1000}}"#,
        ),
        (
            CoreMessage::Response {
                id: 7,
                body: ResponseBody::success(serde_json::json!({"ok":true})),
            },
            r#"{"kind":"response","id":7,"ok":true,"result":{"ok":true}}"#,
        ),
        (
            CoreMessage::Response {
                id: 7,
                body: ResponseBody::failure(CoreError {
                    code: ErrorCode::CommandError.as_str().to_owned(),
                    message: "not signed in".to_owned(),
                    details: None,
                    retryable: false,
                }),
            },
            r#"{"kind":"response","id":7,"ok":false,"error":{"code":"core.command_error","message":"not signed in","retryable":false}}"#,
        ),
        (
            CoreMessage::Event {
                seq: 3,
                channel: "player://snapshot".to_owned(),
                payload: serde_json::json!({"revision":1}),
            },
            r#"{"kind":"event","seq":3,"channel":"player://snapshot","payload":{"revision":1}}"#,
        ),
        (
            CoreMessage::Shutdown {
                reason: ShutdownReason::Quit,
            },
            r#"{"kind":"shutdown","reason":"quit"}"#,
        ),
        (CoreMessage::ShutdownAck, r#"{"kind":"shutdown-ack"}"#),
        (
            CoreMessage::Attach(AttachMessage {
                protocol: PROTOCOL_VERSION,
                host: HostIdentity {
                    app: "yaqmc".to_owned(),
                    version: "0.1.0".to_owned(),
                },
                platform: PlatformAttach {
                    main_window_handle: None,
                    platform_kind: PlatformKind::Linux,
                    display_backend: Some(DisplayBackend::Wayland),
                },
            }),
            r#"{"kind":"attach","protocol":1,"host":{"app":"yaqmc","version":"0.1.0"},"platform":{"platformKind":"linux","displayBackend":"wayland"}}"#,
        ),
    ];

    for (message, expected) in cases {
        let encoded = serde_json::to_string(&message).expect("serialize");
        assert_eq!(encoded, expected);
        let decoded: CoreMessage = serde_json::from_str(expected).expect("deserialize");
        assert_eq!(decoded, message);
    }
}

#[test]
fn stdio_and_duplex_transports_implement_the_core_transport_trait() {
    fn assert_transport<T: CoreTransport>() {}
    assert_transport::<StdioTransport>();
    assert_transport::<DuplexTransport>();
}

#[tokio::test]
async fn framing_round_trips_a_json_payload_across_split_writes() {
    let (mut writer, mut reader) = duplex(64);
    let payload = br#"{"kind":"ready"}"#;
    let mut frame = Vec::new();
    frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    frame.extend_from_slice(payload);

    for byte in frame {
        writer.write_all(&[byte]).await.expect("split write");
        writer.flush().await.expect("flush split write");
    }

    let decoded = read_frame(&mut reader, FRAME_HARD_CAP_BYTES)
        .await
        .expect("split-read frame");
    assert_eq!(decoded, payload);
}

#[tokio::test]
async fn framing_accepts_the_configured_max_and_rejects_one_byte_over() {
    let payload = vec![b'x'; 64];
    let (mut writer, mut reader) = duplex(128);
    write_frame(&mut writer, &payload, 64)
        .await
        .expect("max-size write");
    let decoded = read_frame(&mut reader, 64).await.expect("max-size read");
    assert_eq!(decoded, payload);

    let (mut writer, mut reader) = duplex(128);
    writer
        .write_all(&65u32.to_le_bytes())
        .await
        .expect("oversize prefix");
    writer.flush().await.expect("flush oversize prefix");
    let error = read_frame(&mut reader, 64).await.expect_err("oversize");
    assert!(matches!(
        error,
        ProtocolError::Frame(FrameError::TooLarge {
            length: 65,
            limit: 64
        })
    ));
    assert_eq!(error.code(), ErrorCode::Protocol);
}

#[tokio::test]
async fn oversize_hard_cap_is_rejected_before_the_body_is_read() {
    let (mut writer, mut reader) = duplex(16);
    writer
        .write_all(&(FRAME_HARD_CAP_BYTES + 1).to_le_bytes())
        .await
        .expect("hard-cap prefix");
    writer.flush().await.expect("flush hard-cap prefix");

    let error = tokio::time::timeout(
        Duration::from_millis(200),
        read_frame(&mut reader, u32::MAX),
    )
    .await
    .expect("length check must not wait for a body")
    .expect_err("hard cap");
    assert!(matches!(
        error,
        ProtocolError::Frame(FrameError::TooLarge {
            length,
            limit: FRAME_HARD_CAP_BYTES
        }) if length == FRAME_HARD_CAP_BYTES + 1
    ));
}

#[tokio::test]
async fn garbage_and_unknown_kind_poison_the_duplex_connection() {
    let (mut host, mut core) = duplex_pair();
    core.send_bytes(br#"{not-json"#)
        .await
        .expect("garbage frame");
    let error = host.recv().await.expect_err("garbage");
    assert!(matches!(
        error,
        ProtocolError::Frame(FrameError::InvalidJson(_))
    ));
    assert_eq!(error.code(), ErrorCode::Protocol);
    assert!(error.is_poisoning());
    assert!(matches!(
        host.recv().await.expect_err("poisoned after garbage"),
        ProtocolError::Poisoned
    ));

    let (mut host, mut core) = duplex_pair();
    core.send_bytes(br#"{"kind":"nope"}"#)
        .await
        .expect("unknown kind");
    let error = host.recv().await.expect_err("unknown kind");
    assert!(matches!(
        error,
        ProtocolError::Frame(FrameError::UnknownKind(_))
    ));
    assert!(error.is_poisoning());
    assert!(matches!(
        host.send(&CoreMessage::Ready)
            .await
            .expect_err("send after poison"),
        ProtocolError::Poisoned
    ));
}

#[tokio::test]
async fn hello_attach_ready_round_trips_over_duplex_transport() {
    let (mut host, mut core) = duplex_pair();
    let hello = hello_message();
    let attach = attach_message();
    let CoreMessage::Hello {
        core: expected_core,
        ..
    } = hello.clone()
    else {
        panic!("hello fixture");
    };
    let CoreMessage::Attach(expected_attach) = attach.clone() else {
        panic!("attach fixture");
    };

    let host_attach = expected_attach.clone();
    let host_task = tokio::spawn(async move {
        let identity = host_handshake(&mut host, host_attach, Some("0.1.0"))
            .await
            .expect("host handshake");
        (identity, host)
    });
    let attached = core_handshake(&mut core, expected_core.clone())
        .await
        .expect("core handshake");
    let (identity, mut host) = host_task.await.expect("host task");

    assert_eq!(identity, expected_core);
    assert_eq!(attached, expected_attach);

    host.send(&CoreMessage::Request {
        id: 1,
        method: "core_ping".to_owned(),
        params: None,
    })
    .await
    .expect("request after ready");
    let received = core.recv().await.expect("core receives post-ready request");
    assert_eq!(
        received,
        CoreMessage::Request {
            id: 1,
            method: "core_ping".to_owned(),
            params: None,
        }
    );
}

#[tokio::test]
async fn handshake_rejects_protocol_mismatch_and_wrong_first_frame() {
    let (mut host, mut core) = duplex_pair();
    core.send(&CoreMessage::Hello {
        protocol: 2,
        core: CoreIdentity {
            version: "0.1.0".to_owned(),
            commit: "deadbeef".to_owned(),
            channel: "stable".to_owned(),
        },
    })
    .await
    .expect("mismatch hello");
    let error = host_handshake(&mut host, attach_message_inner(), Some("0.1.0"))
        .await
        .expect_err("protocol mismatch");
    assert!(matches!(error, ProtocolError::Handshake(_)));
    assert_eq!(error.code(), ErrorCode::Protocol);

    let (mut host, mut core) = duplex_pair();
    core.send(&CoreMessage::Ready)
        .await
        .expect("wrong first frame");
    let error = host_handshake(&mut host, attach_message_inner(), None)
        .await
        .expect_err("expected hello");
    assert!(matches!(error, ProtocolError::Handshake(_)));
    assert!(error.is_poisoning());
}

#[tokio::test]
async fn handshake_times_out_before_the_ten_second_ready_budget() {
    let (mut host, _core) = duplex_pair();
    let error = host_handshake_with_timeout(
        &mut host,
        attach_message_inner(),
        None,
        Duration::from_millis(25),
    )
    .await
    .expect_err("timeout");
    assert!(matches!(error, ProtocolError::Handshake(_)));
    assert_eq!(error.code(), ErrorCode::Timeout);
}

fn attach_message_inner() -> AttachMessage {
    match attach_message() {
        CoreMessage::Attach(attach) => attach,
        _ => panic!("attach fixture"),
    }
}

#[tokio::test]
async fn transport_recv_resumes_after_select_timeout_mid_frame() {
    let (client, server) = duplex(1024);
    let (client_reader, client_writer) = split(client);
    let (_server_reader, mut server_writer) = split(server);
    let mut transport = PipeTransport::new(client_reader, client_writer);
    let payload = serde_json::to_vec(&CoreMessage::Ready).expect("ready json");
    let mut frame = Vec::new();
    frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    frame.extend_from_slice(&payload);

    server_writer
        .write_all(&frame[..2])
        .await
        .expect("partial prefix");
    server_writer.flush().await.expect("flush partial");
    tokio::time::timeout(Duration::from_millis(30), transport.recv())
        .await
        .expect_err("recv must wait for the rest of the frame");

    server_writer
        .write_all(&frame[2..])
        .await
        .expect("remaining frame");
    server_writer.flush().await.expect("flush remaining");
    let message = transport.recv().await.expect("resumed recv");
    assert_eq!(message, CoreMessage::Ready);
}
