//! Typed account writes. Endpoint selection and request encoding live in qm-api-rs.
//! The provider retains business-result mapping and safe-read reconciliation.

use qqmusic_api::{account::AccountWrite, Client};
use serde_json::Value;

use crate::qmapi::cgi::map_qmapi_error;
use crate::qqmusic::QQMusicError;

pub(crate) async fn execute_account_write(
    client: &Client,
    credential: &qqmusic_api::Credential,
    operation: AccountWrite,
    cancellation: tokio_util::sync::CancellationToken,
) -> Result<bool, QQMusicError> {
    let operation_kind = match &operation {
        AccountWrite::FavoriteSong { .. } => "favorite-song",
        AccountWrite::PlaylistTracks { .. } => "playlist-tracks",
        AccountWrite::CreatePlaylist { .. } => "create-playlist",
        AccountWrite::DeletePlaylist { .. } => "delete-playlist",
        AccountWrite::EditPlaylist { .. } => "edit-playlist",
        AccountWrite::CollectPlaylist { .. } => "collect-playlist",
    };
    let track_write = matches!(
        &operation,
        AccountWrite::FavoriteSong { .. } | AccountWrite::PlaylistTracks { .. }
    );
    let reply = qqmusic_api::account::write(client, credential, operation, cancellation)
        .await
        .map_err(|error| {
            let mapped = map_write_error(error);
            tracing::warn!(
                target: "qqmusic.account",
                operation_kind,
                classification = ?mapped,
                "library typed write failed"
            );
            mapped
        })?;
    if reply.code != 0 {
        let mapped = map_qmapi_error(reply.error());
        tracing::warn!(
            target: "qqmusic.account",
            operation_kind,
            code = reply.code,
            "library write returned a non-success CGI code"
        );
        if matches!(mapped, QQMusicError::SchemaChanged) {
            if let Some(disposition) =
                playlist_write_business_disposition(track_write, reply.code, &reply.data)
            {
                return disposition;
            }
        }
        return Err(mapped);
    }
    match account_write_accepted(&reply.data) {
        Ok(accepted) => Ok(accepted),
        Err(QQMusicError::SchemaChanged) => {
            let (data_kind, data_keys, result_kind) = response_shape(&reply.data);
            tracing::warn!(
                target: "qqmusic.account",
                operation_kind,
                data_kind,
                data_keys = ?data_keys,
                result_kind,
                "library write acceptance was unconfirmed; reconciling with a safe read"
            );
            Err(QQMusicError::OutcomeUnknown)
        }
        Err(error) => Err(error),
    }
}

fn map_write_error(error: qqmusic_api::QmError) -> QQMusicError {
    // With YAQMC's production transport, `request_cgi` produces these only
    // after the write response arrives and its CGI envelope cannot be decoded.
    // The remote outcome is uncertain, so callers must use a safe read.
    if matches!(
        &error,
        qqmusic_api::QmError::Deserialize(_)
            | qqmusic_api::QmError::Protocol {
                stage: "cgi-envelope" | "cgi-req",
                ..
            }
    ) {
        return QQMusicError::OutcomeUnknown;
    }
    match map_qmapi_error(error) {
        QQMusicError::Offline | QQMusicError::Timeout => QQMusicError::OutcomeUnknown,
        other => other,
    }
}

fn playlist_write_business_disposition(
    track_write: bool,
    code: i64,
    data: &Value,
) -> Option<Result<bool, QQMusicError>> {
    if !track_write {
        return None;
    }
    if code == 80092 {
        return Some(Ok(false));
    }
    let ret_code = data
        .get("retCode")
        .and_then(|value| value.as_i64().or_else(|| value.as_str()?.parse().ok()));
    (code == 80105 && ret_code == Some(0)).then_some(Err(QQMusicError::OutcomeUnknown))
}

fn account_write_accepted(data: &Value) -> Result<bool, QQMusicError> {
    let failed = ["v_failedPlaylistId", "v_failTids"].into_iter().any(|key| {
        data.get(key)
            .and_then(Value::as_array)
            .is_some_and(|values| !values.is_empty())
    });
    if failed {
        return Ok(false);
    }
    let ret_code = data
        .get("retCode")
        .and_then(|value| value.as_i64().or_else(|| value.as_str()?.parse().ok()));
    if ret_code.is_some_and(|code| code != 0) {
        return Ok(false);
    }
    if let Some(update_time) = data
        .pointer("/result/updateTime")
        .or_else(|| data.get("updateTime"))
    {
        return valid_update_time(update_time)
            .then_some(true)
            .ok_or(QQMusicError::SchemaChanged);
    }
    let code = ret_code
        .or_else(|| {
            data.get("result")
                .filter(|value| !value.is_object())
                .and_then(|value| value.as_i64().or_else(|| value.as_str()?.parse().ok()))
        })
        .ok_or(QQMusicError::SchemaChanged)?;
    Ok(code == 0)
}

fn valid_update_time(value: &Value) -> bool {
    value
        .as_u64()
        .or_else(|| value.as_str()?.trim().parse::<u64>().ok())
        .is_some_and(|value| value > 0)
}

fn response_shape(data: &Value) -> (&'static str, Vec<String>, &'static str) {
    let data_kind = value_kind(data);
    let mut data_keys: Vec<String> = data
        .as_object()
        .map(|object| object.keys().cloned().collect())
        .unwrap_or_default();
    data_keys.sort();
    let result_kind = data.get("result").map(value_kind).unwrap_or("missing");
    (data_kind, data_keys, result_kind)
}

fn value_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use qqmusic_api::{
        ApiTransport, Credential, HttpBody, NetworkError, NetworkErrorKind, Platform, RetryClass,
        TransportRequest, TransportResponse,
    };
    use serde_json::json;
    use tokio_util::sync::CancellationToken;

    use super::*;

    #[derive(Clone, Debug)]
    struct CapturedRequest {
        retry: RetryClass,
        url: String,
        body: HttpBody,
    }

    struct RecordingTransport {
        captured: Mutex<Vec<CapturedRequest>>,
        response: &'static str,
        status: u16,
        timeout: bool,
        cancel_after_send: bool,
    }

    impl RecordingTransport {
        fn new(response: &'static str) -> Self {
            Self {
                captured: Mutex::new(Vec::new()),
                response,
                status: 200,
                timeout: false,
                cancel_after_send: false,
            }
        }

        fn count(&self) -> usize {
            self.captured.lock().unwrap().len()
        }

        fn last(&self) -> CapturedRequest {
            self.captured
                .lock()
                .unwrap()
                .last()
                .cloned()
                .expect("request")
        }
    }

    #[async_trait::async_trait]
    impl ApiTransport for RecordingTransport {
        async fn execute(
            &self,
            request: TransportRequest,
        ) -> qqmusic_api::Result<TransportResponse> {
            self.captured.lock().unwrap().push(CapturedRequest {
                retry: request.retry,
                url: request.url.clone(),
                body: request.body,
            });
            if self.cancel_after_send {
                request.cancellation.cancel();
            }
            if self.timeout {
                return Err(qqmusic_api::QmError::Network(NetworkError {
                    kind: NetworkErrorKind::Timeout,
                    message: "synthetic timeout".into(),
                }));
            }
            Ok(TransportResponse {
                status: self.status,
                final_url: request.url,
                headers: Vec::new(),
                body: self.response.as_bytes().to_vec(),
            })
        }
    }

    const WRITE_OK: &str = r#"{"code":0,"req_0":{"code":0,"data":{"retCode":0}}}"#;

    fn signed_in_credential() -> Credential {
        Credential {
            musicid: 1_000_000_001,
            str_musicid: "1000000001".into(),
            musickey: "SYNTHETIC_MUSIC_KEY".into(),
            encrypt_uin: "SANITIZED_ENCRYPTED_UIN".into(),
            login_type: 2,
            ..Credential::default()
        }
    }

    fn probe_client(transport: Arc<RecordingTransport>) -> Client {
        // An unrelated default identity must never replace the explicit one.
        Client::new_with_transport(
            Some(Credential {
                musicid: 2_000_000_001,
                musickey: "SYNTHETIC_OTHER_KEY".into(),
                ..Credential::default()
            }),
            Some(Platform::Android),
            transport,
        )
    }

    fn favorite(add: bool) -> AccountWrite {
        AccountWrite::FavoriteSong {
            add,
            song_id: 42,
            song_type: 0,
        }
    }

    fn rename() -> AccountWrite {
        AccountWrite::EditPlaylist {
            dir_id: 3001,
            mask: 15,
            name: "renamed".into(),
            description: "description".into(),
            picture_url: String::new(),
            tag_list: String::new(),
        }
    }

    #[tokio::test]
    async fn every_typed_write_uses_the_library_contract_and_explicit_identity() {
        let cases = [
            (
                favorite(true),
                "music.musicasset.PlaylistDetailWrite",
                "AddSonglist",
                json!({"dirId":201,"tid":0,"bFmtUtf8":true,"v_songInfo":[{"songId":42,"songType":0}]}),
            ),
            (
                favorite(false),
                "music.musicasset.PlaylistDetailWrite",
                "DelSonglist",
                json!({"dirId":201,"tid":0,"bFmtUtf8":true,"v_songInfo":[{"songId":42,"songType":0}]}),
            ),
            (
                AccountWrite::PlaylistTracks {
                    add: true,
                    dir_id: 3001,
                    tid: 0,
                    songs: vec![(7, 0)],
                },
                "music.musicasset.PlaylistDetailWrite",
                "AddSonglist",
                json!({"dirId":3001,"tid":0,"bFmtUtf8":true,"v_songInfo":[{"songId":7,"songType":0}]}),
            ),
            (
                AccountWrite::PlaylistTracks {
                    add: false,
                    dir_id: 3001,
                    tid: 0,
                    songs: vec![(7, 0)],
                },
                "music.musicasset.PlaylistDetailWrite",
                "DelSonglist",
                json!({"dirId":3001,"tid":0,"bFmtUtf8":true,"v_songInfo":[{"songId":7,"songType":0}]}),
            ),
            (
                AccountWrite::CreatePlaylist {
                    name: "created".into(),
                },
                "music.musicasset.PlaylistBaseWrite",
                "AddPlaylist",
                json!({"dirName":"created"}),
            ),
            (
                AccountWrite::DeletePlaylist { dir_id: 3001 },
                "music.musicasset.PlaylistBaseWrite",
                "DelPlaylist",
                json!({"dirId":3001}),
            ),
            (
                rename(),
                "music.musicasset.PlaylistBaseWrite",
                "EditPlaylist",
                json!({"dirId":3001,"mask":15,"dirNewName":"renamed","dirNewDesc":"description",
                    "dirNewPicUrl":"","dirNewtaglist":""}),
            ),
            (
                AccountWrite::CollectPlaylist {
                    collect: true,
                    playlist_id: 88,
                },
                "music.musicasset.PlaylistFavWrite",
                "FavPlaylist",
                json!({"uin":"SANITIZED_ENCRYPTED_UIN","v_playlistId":[88]}),
            ),
            (
                AccountWrite::CollectPlaylist {
                    collect: false,
                    playlist_id: 88,
                },
                "music.musicasset.PlaylistFavWrite",
                "CancelFavPlaylist",
                json!({"uin":"SANITIZED_ENCRYPTED_UIN","v_playlistId":[88]}),
            ),
        ];
        for (operation, module, method, expected) in cases {
            let transport = Arc::new(RecordingTransport::new(WRITE_OK));
            let client = probe_client(transport.clone());
            assert!(execute_account_write(
                &client,
                &signed_in_credential(),
                operation,
                CancellationToken::new()
            )
            .await
            .expect("accepted"));
            assert_eq!(
                transport.count(),
                1,
                "writes must not negotiate a session or retry"
            );
            let captured = transport.last();
            assert_eq!(captured.retry, RetryClass::Write);
            assert_eq!(captured.url, "https://u.y.qq.com/cgi-bin/musicu.fcg");
            let HttpBody::Json(body) = captured.body else {
                panic!("JSON body");
            };
            assert_eq!(
                body["req_0"],
                json!({"module":module,"method":method,"param":expected})
            );
            assert_eq!(body["comm"]["ct"], "11");
            assert_eq!(body["comm"]["cv"], 13_020_508);
            assert_eq!(body["comm"]["uid"], "1000000001");
            assert_eq!(body["comm"]["authst"], "SYNTHETIC_MUSIC_KEY");
            assert_eq!(body["comm"]["tmeLoginType"], "2");
            assert!(!body.to_string().contains("SYNTHETIC_OTHER_KEY"));
        }
    }

    #[tokio::test]
    async fn invalid_typed_inputs_and_missing_collection_identity_never_send() {
        let transport = Arc::new(RecordingTransport::new(WRITE_OK));
        let client = probe_client(transport.clone());
        for operation in [
            AccountWrite::FavoriteSong {
                add: true,
                song_id: 0,
                song_type: 0,
            },
            AccountWrite::DeletePlaylist { dir_id: -1 },
            AccountWrite::CreatePlaylist {
                name: String::new(),
            },
            AccountWrite::PlaylistTracks {
                add: true,
                dir_id: 3001,
                tid: 0,
                songs: Vec::new(),
            },
            AccountWrite::CollectPlaylist {
                collect: true,
                playlist_id: 0,
            },
        ] {
            assert!(matches!(
                execute_account_write(
                    &client,
                    &signed_in_credential(),
                    operation,
                    CancellationToken::new()
                )
                .await,
                Err(QQMusicError::InvalidRequest)
            ));
        }
        let mut credential = signed_in_credential();
        credential.encrypt_uin.clear();
        assert!(matches!(
            execute_account_write(
                &client,
                &credential,
                AccountWrite::CollectPlaylist {
                    collect: true,
                    playlist_id: 88
                },
                CancellationToken::new()
            )
            .await,
            Err(QQMusicError::AuthenticationExpired)
        ));
        assert_eq!(transport.count(), 0);
    }

    #[tokio::test]
    async fn cancellation_before_and_after_send_cannot_publish_success() {
        let transport = Arc::new(RecordingTransport::new(WRITE_OK));
        let client = probe_client(transport.clone());
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        assert!(matches!(
            execute_account_write(
                &client,
                &signed_in_credential(),
                favorite(true),
                cancellation
            )
            .await,
            Err(QQMusicError::Cancelled)
        ));
        assert_eq!(transport.count(), 0);

        let transport = Arc::new(RecordingTransport {
            cancel_after_send: true,
            ..RecordingTransport::new(WRITE_OK)
        });
        let client = probe_client(transport.clone());
        assert!(matches!(
            execute_account_write(
                &client,
                &signed_in_credential(),
                favorite(true),
                CancellationToken::new()
            )
            .await,
            Err(QQMusicError::Cancelled)
        ));
        assert_eq!(transport.count(), 1);
    }

    #[tokio::test]
    async fn post_send_failures_are_unknown_and_never_replayed() {
        for response in [
            r#"not-json"#,
            r#"{"req_0":{"code":0,"data":{"retCode":0}}}"#,
            r#"{"code":0,"req_0":{"code":0,"data":{"result":{},"opaque":true}}}"#,
            r#"{"code":0,"req_0":{"code":80105,"data":{"retCode":0}}}"#,
        ] {
            let transport = Arc::new(RecordingTransport::new(response));
            let client = probe_client(transport.clone());
            assert!(matches!(
                execute_account_write(
                    &client,
                    &signed_in_credential(),
                    favorite(true),
                    CancellationToken::new()
                )
                .await,
                Err(QQMusicError::OutcomeUnknown)
            ));
            assert_eq!(transport.count(), 1);
        }
        for transport in [
            RecordingTransport {
                timeout: true,
                ..RecordingTransport::new(WRITE_OK)
            },
            RecordingTransport {
                status: 503,
                ..RecordingTransport::new(WRITE_OK)
            },
        ] {
            let transport = Arc::new(transport);
            let client = probe_client(transport.clone());
            assert!(matches!(
                execute_account_write(
                    &client,
                    &signed_in_credential(),
                    favorite(false),
                    CancellationToken::new()
                )
                .await,
                Err(QQMusicError::OutcomeUnknown)
            ));
            assert_eq!(transport.count(), 1);
        }
        assert!(matches!(
            map_write_error(qqmusic_api::QmError::Protocol {
                stage: "allowlist",
                message: "synthetic pre-send rejection".into()
            }),
            QQMusicError::Protocol
        ));
    }

    #[tokio::test]
    async fn no_change_is_rejected_but_only_track_writes_use_track_business_codes() {
        let transport = Arc::new(RecordingTransport::new(
            r#"{"code":0,"req_0":{"code":80092,"data":{"retCode":80092}}}"#,
        ));
        let client = probe_client(transport);
        assert!(!execute_account_write(
            &client,
            &signed_in_credential(),
            favorite(false),
            CancellationToken::new()
        )
        .await
        .unwrap());
        let transport = Arc::new(RecordingTransport::new(
            r#"{"code":0,"req_0":{"code":80105,"data":{"retCode":0}}}"#,
        ));
        let client = probe_client(transport);
        assert!(matches!(
            execute_account_write(
                &client,
                &signed_in_credential(),
                rename(),
                CancellationToken::new()
            )
            .await,
            Err(QQMusicError::SchemaChanged)
        ));
    }

    #[tokio::test]
    async fn authorization_and_rate_limit_errors_remain_distinct() {
        for (status, expected) in [(401, "auth"), (403, "auth"), (429, "rate")] {
            let transport = Arc::new(RecordingTransport {
                status,
                ..RecordingTransport::new(WRITE_OK)
            });
            let client = probe_client(transport.clone());
            let error = execute_account_write(
                &client,
                &signed_in_credential(),
                favorite(true),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
            assert!(matches!(
                (expected, error),
                ("auth", QQMusicError::AuthenticationExpired) | ("rate", QQMusicError::RateLimited)
            ));
            assert_eq!(transport.count(), 1);
        }
    }

    #[test]
    fn typed_bridge_classifies_write_results_without_bypassing_reconciliation() {
        assert!(account_write_accepted(&serde_json::json!({ "retCode": 0 })).unwrap());
        assert!(!account_write_accepted(&serde_json::json!({ "retCode": 1 })).unwrap());
        assert!(account_write_accepted(&serde_json::json!({
            "result": { "updateTime": 1 }
        }))
        .unwrap());
        assert!(!account_write_accepted(&serde_json::json!({
            "result": 0,
            "v_failedPlaylistId": [88]
        }))
        .unwrap());
        assert!(!account_write_accepted(&serde_json::json!({
            "result": { "updateTime": 1 },
            "v_failedPlaylistId": [],
            "v_failTids": [42]
        }))
        .unwrap());
        assert!(!account_write_accepted(&serde_json::json!({
            "retCode": 1,
            "result": { "updateTime": 1 }
        }))
        .unwrap());
        for invalid_update_time in [
            serde_json::Value::Null,
            serde_json::json!(0),
            serde_json::json!(""),
        ] {
            assert!(matches!(
                account_write_accepted(&serde_json::json!({
                    "result": { "updateTime": invalid_update_time }
                })),
                Err(QQMusicError::SchemaChanged)
            ));
        }
        assert!(account_write_accepted(&serde_json::json!({
            "result": { "updateTime": "1800000000" }
        }))
        .unwrap());
        assert!(matches!(
            account_write_accepted(&serde_json::json!({ "result": {} })),
            Err(QQMusicError::SchemaChanged)
        ));
        assert_eq!(
            response_shape(&serde_json::json!({ "result": {}, "opaque": true })),
            (
                "object",
                vec!["opaque".to_owned(), "result".to_owned()],
                "object"
            )
        );
    }
}
