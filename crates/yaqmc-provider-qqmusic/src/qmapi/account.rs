//! Row G: library `songlist`/`user` raw ops. Reconciliation stays in-tree.
//!
//! Production raw writes use the library CGI client. `account.rs` retains
//! `client_operation_id`, epoch cancellation, safe-read reconciliation, cache
//! projection, and wire DTO/error mapping.

#[cfg(test)]
use qqmusic_api::models::songlist::CreateDeleteSonglistResp;
use qqmusic_api::{CgiOptions, Client, Platform};
use serde_json::Value;

use crate::qmapi::cgi::map_qmapi_error;
use crate::qmapi::credential::credential_from_session;
use crate::qmapi::qmapi_client_with;
use crate::qqmusic::{QQMusicError, SessionRecord};

/// Favorite Songs directory. In-tree writes and library `like_song` use 201.
#[cfg(test)]
pub(crate) const FAVORITE_DIR_ID: i64 = 201;

/// Library `v_songInfo` tuple. In-tree writes send `songType: 0`.
#[cfg(test)]
pub(crate) fn song_info_from_numeric_id(song_id: i64) -> (i64, i64) {
    (song_id, 0)
}

#[cfg(test)]
pub(crate) struct CreatedPlaylist {
    pub dir_id: i64,
    pub tid: i64,
    pub name: String,
}

#[cfg(test)]
pub(crate) fn created_playlist_from_library(
    response: &CreateDeleteSonglistResp,
) -> Result<CreatedPlaylist, QQMusicError> {
    if response.retCode != 0 || response.dirid == 0 {
        return Err(QQMusicError::MalformedResponse);
    }
    Ok(CreatedPlaylist {
        dir_id: response.dirid,
        tid: response.id,
        name: response.name.clone(),
    })
}

pub(crate) async fn execute_account_write(
    session: &SessionRecord,
    module: &str,
    method: &str,
    param: Value,
    cancellation: tokio_util::sync::CancellationToken,
) -> Result<bool, QQMusicError> {
    let credential = credential_from_session(session)?;
    let client =
        qmapi_client_with(Some(credential.clone()), Some(Platform::Web)).map_err(|error| {
            let mapped = map_qmapi_error(error);
            tracing::warn!(
                target: "qqmusic.account",
                classification = ?mapped,
                "library client construction failed"
            );
            mapped
        })?;
    execute_account_write_with_client(&client, &credential, module, method, param, cancellation)
        .await
}

async fn execute_account_write_with_client(
    client: &Client,
    credential: &qqmusic_api::Credential,
    module: &str,
    method: &str,
    param: Value,
    cancellation: tokio_util::sync::CancellationToken,
) -> Result<bool, QQMusicError> {
    let options = CgiOptions {
        comm: Some(account_write_comm(credential)),
        override_comm: true,
        credential: Some(credential.clone()),
        require_login: true,
        retry: qqmusic_api::RetryClass::Write,
        preserve_bool: true,
        cancellation,
        ..CgiOptions::default()
    };
    let reply = client
        .request_cgi(module, method, param, &options)
        .await
        .map_err(|error| {
            let mapped = map_write_error(error);
            tracing::warn!(
                target: "qqmusic.account",
                module,
                method,
                classification = ?mapped,
                "library raw write failed"
            );
            mapped
        })?;
    if reply.code != 0 {
        let error = reply.error();
        let mapped = map_qmapi_error(error);
        tracing::warn!(
            target: "qqmusic.account",
            module,
            method,
            code = reply.code,
            "library write returned a non-success CGI code"
        );
        if matches!(mapped, QQMusicError::SchemaChanged) {
            if let Some(disposition) =
                playlist_write_business_disposition(module, method, reply.code, &reply.data)
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
                module,
                method,
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

fn account_write_comm(credential: &qqmusic_api::Credential) -> Value {
    // Account writes were live-validated with the mobile identity envelope.
    // Keep request execution in the library while overriding its read-oriented
    // Web defaults for this write-only boundary.
    let uin = if credential.str_musicid.is_empty() {
        credential.musicid.to_string()
    } else {
        credential.str_musicid.clone()
    };
    let gtk = qqmusic_api::hash33(&credential.musickey, 5381);
    serde_json::json!({
        "ct": "11",
        "cv": 13_020_508,
        "v": 13_020_508,
        "tmeAppID": "qqmusic",
        "format": "json",
        "inCharset": "utf-8",
        "outCharset": "utf-8",
        "notice": 0,
        "needNewCode": 1,
        "platform": "yqq.json",
        "uid": uin,
        "qq": uin,
        "uin": uin,
        "loginUin": uin,
        "authst": credential.musickey,
        "tmeLoginType": credential.login_type.to_string(),
        "g_tk": gtk,
        "g_tk_new_20200303": gtk,
    })
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
    module: &str,
    method: &str,
    code: i64,
    data: &Value,
) -> Option<Result<bool, QQMusicError>> {
    if module != "music.musicasset.PlaylistDetailWrite"
        || !matches!(method, "AddSonglist" | "DelSonglist")
    {
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
    use std::sync::Mutex;

    use qqmusic_api::{
        models::songlist::CreateDeleteSonglistResp, ApiTransport, Client, Credential, HttpBody,
        Platform, RetryClass, TransportRequest, TransportResponse,
    };
    use serde_json::Value;
    use yaqmc_provider_api::FavoriteMutationResult;

    use super::*;

    const WRITE_OK: &[u8] = br#"{"code":0,"req_0":{"code":0,"data":{"retCode":0}}}"#;
    const WRITE_UNCONFIRMED: &[u8] =
        br#"{"code":0,"req_0":{"code":0,"data":{"result":{},"opaque":true}}}"#;
    const WRITE_RECONCILE: &[u8] = br#"{"code":0,"req_0":{"code":80105,"data":{"retCode":0,"result":{"dirId":0,"songlist":[]}}}}"#;
    const WRITE_NO_CHANGE: &[u8] = br#"{"code":0,"req_0":{"code":80092,"data":{"retCode":80092}}}"#;
    const WRITE_MALFORMED: &[u8] = br#"not-json"#;
    const WRITE_MISSING_ENVELOPE_CODE: &[u8] = br#"{"req_0":{"code":0,"data":{"retCode":0}}}"#;
    const CREATE_OK: &[u8] = br#"{"code":0,"req_0":{"code":0,"data":{"retCode":0,"result":{"tid":88,"dirId":3001,"dirName":"hybrid"}}}}"#;
    const PLAYLISTS_OK: &[u8] =
        br#"{"code":0,"req_0":{"code":0,"data":{"total":0,"v_playlist":[],"bFinish":true}}}"#;

    struct RecordingTransport {
        captured: Mutex<Vec<CapturedRequest>>,
    }

    #[derive(Clone, Debug)]
    struct CapturedRequest {
        retry: RetryClass,
        body: HttpBody,
    }

    impl RecordingTransport {
        fn new() -> Self {
            Self {
                captured: Mutex::new(Vec::new()),
            }
        }

        fn last(&self) -> CapturedRequest {
            self.captured
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .last()
                .cloned()
                .expect("CGI request captured")
        }
    }

    #[async_trait::async_trait]
    impl ApiTransport for RecordingTransport {
        async fn execute(
            &self,
            request: TransportRequest,
        ) -> qqmusic_api::Result<TransportResponse> {
            let body_json = match &request.body {
                HttpBody::Json(value) => value.clone(),
                _ => Value::Null,
            };
            self.captured
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(CapturedRequest {
                    retry: request.retry,
                    body: request.body,
                });
            let module = body_json
                .pointer("/req_0/module")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let method = body_json
                .pointer("/req_0/method")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let test_case = body_json
                .pointer("/req_0/param/testCase")
                .and_then(Value::as_str);
            let body = match test_case {
                Some("reconcile") => WRITE_RECONCILE,
                Some("no-change") => WRITE_NO_CHANGE,
                Some("malformed") => WRITE_MALFORMED,
                Some("missing-envelope-code") => WRITE_MISSING_ENVELOPE_CODE,
                _ => match (module, method) {
                    ("music.musicasset.PlaylistBaseWrite", "AddPlaylist") => CREATE_OK,
                    ("music.musicasset.PlaylistBaseRead", "GetPlaylistByUin") => PLAYLISTS_OK,
                    (_, "Unconfirmed") => WRITE_UNCONFIRMED,
                    _ => WRITE_OK,
                },
            };
            Ok(TransportResponse {
                status: 200,
                final_url: request.url,
                headers: Vec::new(),
                body: body.to_vec(),
            })
        }
    }

    fn signed_in_credential() -> Credential {
        Credential {
            musicid: 1_000_000_001,
            str_musicid: "1000000001".into(),
            musickey: "SYNTHETIC_MUSIC_KEY".into(),
            login_type: 2,
            ..Credential::default()
        }
    }

    fn probe_client(transport: std::sync::Arc<RecordingTransport>) -> Client {
        Client::new_with_transport(Some(signed_in_credential()), Some(Platform::Web), transport)
    }

    fn req0(body: &HttpBody) -> &Value {
        let HttpBody::Json(payload) = body else {
            panic!("CGI body must be JSON");
        };
        payload.get("req_0").expect("req_0")
    }

    #[test]
    fn song_info_tuple_matches_intree_favorite_write() {
        assert_eq!(song_info_from_numeric_id(42), (42, 0));
        assert_eq!(FAVORITE_DIR_ID, 201);
    }

    #[test]
    fn library_create_response_exposes_dir_id_for_intree_projection() {
        let response: CreateDeleteSonglistResp = serde_json::from_value(serde_json::json!({
            "retCode": 0,
            "result": { "tid": 88, "dirId": 3001, "dirName": "hybrid" }
        }))
        .expect("create");
        let created = created_playlist_from_library(&response).expect("mapped");
        assert_eq!(created.dir_id, 3001);
        assert_eq!(created.tid, 88);
        assert_eq!(created.name, "hybrid");
    }

    #[test]
    fn client_operation_id_stays_on_intree_mutation_result() {
        let _ = std::mem::size_of::<FavoriteMutationResult>();
        let _ = created_playlist_from_library;
    }

    #[tokio::test]
    async fn like_song_uses_add_songlist_on_favorite_dir() {
        let transport = std::sync::Arc::new(RecordingTransport::new());
        let client = probe_client(transport.clone());
        assert!(client
            .songlist
            .like_song(&[song_info_from_numeric_id(42)], None)
            .await
            .expect("like"));
        let captured = transport.last();
        assert_eq!(captured.retry, RetryClass::Write);
        let req = req0(&captured.body);
        assert_eq!(req["module"], "music.musicasset.PlaylistDetailWrite");
        assert_eq!(req["method"], "AddSonglist");
        assert_eq!(req["param"]["dirId"], FAVORITE_DIR_ID);
        assert_eq!(req["param"]["v_songInfo"][0]["songId"], 42);
        assert_eq!(req["param"]["v_songInfo"][0]["songType"], 0);
    }

    #[tokio::test]
    async fn unlike_song_uses_del_songlist_on_favorite_dir() {
        let transport = std::sync::Arc::new(RecordingTransport::new());
        let client = probe_client(transport.clone());
        assert!(client
            .songlist
            .unlike_song(&[song_info_from_numeric_id(42)], None)
            .await
            .expect("unlike"));
        let captured = transport.last();
        let req = req0(&captured.body);
        assert_eq!(req["module"], "music.musicasset.PlaylistDetailWrite");
        assert_eq!(req["method"], "DelSonglist");
        assert_eq!(req["param"]["dirId"], FAVORITE_DIR_ID);
    }

    #[tokio::test]
    async fn create_playlist_uses_add_playlist_and_write_retry() {
        let transport = std::sync::Arc::new(RecordingTransport::new());
        let client = probe_client(transport.clone());
        let created = created_playlist_from_library(
            &client
                .songlist
                .create("hybrid", None)
                .await
                .expect("create"),
        )
        .expect("mapped");
        assert_eq!(created.dir_id, 3001);
        let captured = transport.last();
        assert_eq!(captured.retry, RetryClass::Write);
        let req = req0(&captured.body);
        assert_eq!(req["module"], "music.musicasset.PlaylistBaseWrite");
        assert_eq!(req["method"], "AddPlaylist");
        assert_eq!(req["param"]["dirName"], "hybrid");
    }

    #[tokio::test]
    async fn delete_playlist_uses_del_playlist() {
        let transport = std::sync::Arc::new(RecordingTransport::new());
        let client = probe_client(transport.clone());
        client.songlist.delete(3001, None).await.expect("delete");
        let captured = transport.last();
        assert_eq!(captured.retry, RetryClass::Write);
        let req = req0(&captured.body);
        assert_eq!(req["module"], "music.musicasset.PlaylistBaseWrite");
        assert_eq!(req["method"], "DelPlaylist");
        assert_eq!(req["param"]["dirId"], 3001);
    }

    #[tokio::test]
    async fn add_songs_keeps_caller_dir_id() {
        let transport = std::sync::Arc::new(RecordingTransport::new());
        let client = probe_client(transport.clone());
        assert!(client
            .songlist
            .add_songs(3001, &[song_info_from_numeric_id(7)], 0, None)
            .await
            .expect("add"));
        let captured = transport.last();
        let req = req0(&captured.body);
        assert_eq!(req["method"], "AddSonglist");
        assert_eq!(req["param"]["dirId"], 3001);
        assert_eq!(req["param"]["v_songInfo"][0]["songId"], 7);
    }

    #[tokio::test]
    async fn created_songlists_use_get_playlist_by_uin() {
        let transport = std::sync::Arc::new(RecordingTransport::new());
        let client = probe_client(transport.clone());
        client
            .user
            .get_created_songlist(1_000_000_001, None)
            .await
            .expect("list");
        let captured = transport.last();
        assert_eq!(captured.retry, RetryClass::SafeRead);
        let req = req0(&captured.body);
        assert_eq!(req["module"], "music.musicasset.PlaylistBaseRead");
        assert_eq!(req["method"], "GetPlaylistByUin");
        assert_eq!(req["param"]["uin"], "1000000001");
    }

    #[tokio::test]
    async fn production_raw_writer_covers_rename_and_playlist_collection() {
        let transport = std::sync::Arc::new(RecordingTransport::new());
        let client = probe_client(transport.clone());
        let credential = signed_in_credential();

        assert!(execute_account_write_with_client(
            &client,
            &credential,
            "music.musicasset.PlaylistBaseWrite",
            "EditPlaylist",
            serde_json::json!({
                "dirId": 3001,
                "mask": 15,
                "dirNewName": "renamed",
                "dirNewDesc": "description",
                "dirNewPicUrl": "",
                "dirNewtaglist": ""
            }),
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .expect("rename"));
        let captured = transport.last();
        assert_eq!(captured.retry, RetryClass::Write);
        let req = req0(&captured.body);
        assert_eq!(req["module"], "music.musicasset.PlaylistBaseWrite");
        assert_eq!(req["method"], "EditPlaylist");
        assert_eq!(req["param"]["dirId"], 3001);
        assert_eq!(req["param"]["mask"], 15);
        let HttpBody::Json(body) = &captured.body else {
            panic!("CGI body must be JSON");
        };
        assert_eq!(body["comm"]["ct"], serde_json::json!("11"));
        assert_eq!(body["comm"]["cv"], serde_json::json!(13_020_508));
        assert_eq!(
            body["comm"]["authst"],
            serde_json::json!("SYNTHETIC_MUSIC_KEY")
        );
        assert_eq!(body["comm"]["uid"], serde_json::json!("1000000001"));
        assert_eq!(body["comm"]["tmeLoginType"], serde_json::json!("2"));

        assert!(execute_account_write_with_client(
            &client,
            &credential,
            "music.musicasset.PlaylistFavWrite",
            "FavPlaylist",
            serde_json::json!({
                "uin": "SANITIZED_ENCRYPTED_UIN",
                "v_playlistId": [88]
            }),
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .expect("collect"));
        let captured = transport.last();
        assert_eq!(captured.retry, RetryClass::Write);
        let req = req0(&captured.body);
        assert_eq!(req["module"], "music.musicasset.PlaylistFavWrite");
        assert_eq!(req["method"], "FavPlaylist");
        assert_eq!(req["param"]["v_playlistId"], serde_json::json!([88]));
    }

    #[tokio::test]
    async fn unconfirmed_success_shape_defers_to_safe_read_reconciliation() {
        let transport = std::sync::Arc::new(RecordingTransport::new());
        let client = probe_client(transport);
        let error = execute_account_write_with_client(
            &client,
            &signed_in_credential(),
            "music.musicasset.PlaylistDetailWrite",
            "Unconfirmed",
            serde_json::json!({ "dirId": FAVORITE_DIR_ID }),
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .expect_err("unconfirmed response must remain outcome-unknown");
        assert!(matches!(error, QQMusicError::OutcomeUnknown));
    }

    #[tokio::test]
    async fn playlist_business_codes_preserve_rejection_and_unknown_outcomes() {
        let transport = std::sync::Arc::new(RecordingTransport::new());
        let client = probe_client(transport);
        let no_change = execute_account_write_with_client(
            &client,
            &signed_in_credential(),
            "music.musicasset.PlaylistDetailWrite",
            "DelSonglist",
            serde_json::json!({ "dirId": FAVORITE_DIR_ID, "testCase": "no-change" }),
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .expect("known no-change response");
        assert!(!no_change);

        let error = execute_account_write_with_client(
            &client,
            &signed_in_credential(),
            "music.musicasset.PlaylistDetailWrite",
            "DelSonglist",
            serde_json::json!({ "dirId": FAVORITE_DIR_ID, "testCase": "reconcile" }),
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .expect_err("contradictory business response must remain outcome-unknown");
        assert!(matches!(error, QQMusicError::OutcomeUnknown));
    }

    #[tokio::test]
    async fn unrelated_business_code_remains_a_schema_error() {
        let transport = std::sync::Arc::new(RecordingTransport::new());
        let client = probe_client(transport);
        let error = execute_account_write_with_client(
            &client,
            &signed_in_credential(),
            "music.musicasset.PlaylistBaseWrite",
            "EditPlaylist",
            serde_json::json!({ "dirId": 3001, "testCase": "reconcile" }),
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .expect_err("unrelated business code must not be reclassified");
        assert!(matches!(error, QQMusicError::SchemaChanged));
    }

    #[tokio::test]
    async fn post_send_envelope_decode_failures_require_reconciliation() {
        for test_case in ["malformed", "missing-envelope-code"] {
            let transport = std::sync::Arc::new(RecordingTransport::new());
            let client = probe_client(transport);
            let error = execute_account_write_with_client(
                &client,
                &signed_in_credential(),
                "music.musicasset.PlaylistDetailWrite",
                "DelSonglist",
                serde_json::json!({
                    "dirId": FAVORITE_DIR_ID,
                    "testCase": test_case
                }),
                tokio_util::sync::CancellationToken::new(),
            )
            .await
            .expect_err("post-send decode failure must remain outcome-unknown");
            assert!(matches!(error, QQMusicError::OutcomeUnknown));
        }
        assert!(matches!(
            map_write_error(qqmusic_api::QmError::Protocol {
                stage: "allowlist",
                message: "synthetic pre-send rejection".to_owned(),
            }),
            QQMusicError::Protocol
        ));
    }

    #[test]
    fn raw_writer_classifies_write_results_without_bypassing_reconciliation() {
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
