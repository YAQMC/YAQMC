//! Row A/B probe: library CGI over injected transport; production signed HTTP
//! stays in-tree (Keep).
//!
//! `zzc_sign` is private in `qqmusic-api`. Capture the `sign` query from a
//! recording `ApiTransport` instead of duplicating the SHA1 scramble.
//! Production `musics.fcg` keeps in-tree MD5 `zzb` (encrypted evkey). Do not
//! add `zzb` to qm-api-rs. Unsigned library CGI already uses `musicu.fcg`.

use qqmusic_api::{NetworkErrorKind, QmError};

use crate::qqmusic::QQMusicError;

pub(crate) fn map_qmapi_error(error: QmError) -> QQMusicError {
    match error {
        QmError::Network(network) => match network.kind {
            NetworkErrorKind::Timeout => QQMusicError::Timeout,
            NetworkErrorKind::Cancelled => QQMusicError::Cancelled,
            NetworkErrorKind::Connect
            | NetworkErrorKind::Builder
            | NetworkErrorKind::Redirect
            | NetworkErrorKind::Body
            | NetworkErrorKind::Other => QQMusicError::Offline,
        },
        QmError::Http {
            status: 401 | 403, ..
        } => QQMusicError::AuthenticationExpired,
        QmError::Http { status: 404, .. } => QQMusicError::NotFound,
        QmError::Http { status: 429, .. } => QQMusicError::RateLimited,
        QmError::Http { status: 408, .. } => QQMusicError::Timeout,
        QmError::Http { .. } => QQMusicError::Offline,
        QmError::RateLimited => QQMusicError::RateLimited,
        QmError::CredentialExpired(_)
        | QmError::CredentialInvalid(_)
        | QmError::Login { .. }
        | QmError::CredentialRefresh(_) => QQMusicError::AuthenticationExpired,
        QmError::GlobalApi { .. } | QmError::CgiApi { .. } => QQMusicError::SchemaChanged,
        QmError::SignatureRequired | QmError::Protocol { .. } => QQMusicError::Protocol,
        QmError::Deserialize(_) | QmError::ApiData(_) | QmError::JsonPath(_) => {
            QQMusicError::MalformedResponse
        }
        QmError::ValueError(_) => QQMusicError::InvalidRequest,
        QmError::Io(_) | QmError::Other(_) => QQMusicError::Offline,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use qqmusic_api::{
        ApiTransport, CgiOptions, Client, HttpBody, NetworkError, NetworkErrorKind, Platform,
        QmError, TransportRequest, TransportResponse,
    };
    use serde_json::json;

    use super::*;
    use crate::qqmusic::qq_request_signature;

    const CGI_OK: &[u8] = br#"{"code":0,"req_0":{"code":0,"data":{}}}"#;

    struct RecordingTransport {
        captured: Mutex<Vec<CapturedRequest>>,
    }

    #[derive(Clone, Debug)]
    struct CapturedRequest {
        url: String,
        query: Vec<(String, String)>,
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
            self.captured
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(CapturedRequest {
                    url: request.url.clone(),
                    query: request.query.clone(),
                    body: request.body,
                });
            Ok(TransportResponse {
                status: 200,
                final_url: request.url,
                headers: Vec::new(),
                body: CGI_OK.to_vec(),
            })
        }
    }

    fn web_cgi_options(sign: bool) -> CgiOptions {
        CgiOptions {
            platform: Some(Platform::Web),
            sign,
            ..CgiOptions::default()
        }
    }

    fn query_value<'a>(query: &'a [(String, String)], name: &str) -> Option<&'a str> {
        query
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    async fn probe_cgi(sign: bool) -> CapturedRequest {
        let transport = std::sync::Arc::new(RecordingTransport::new());
        let client = Client::new_with_transport(None, None, transport.clone());
        client
            .request_cgi(
                "music.musichallSong.PlayLyricInfo",
                "GetPlayLyricInfo",
                json!({ "songMid": "TRACK" }),
                &web_cgi_options(sign),
            )
            .await
            .expect("recording CGI");
        transport.last()
    }

    #[tokio::test]
    async fn signed_cgi_uses_musics_fcg_and_zzc_query() {
        let captured = probe_cgi(true).await;
        assert!(
            captured.url.ends_with("/musics.fcg"),
            "signed CGI must use musics.fcg, got {}",
            captured.url
        );
        let sign = query_value(&captured.query, "sign").expect("sign query");
        assert!(sign.starts_with("zzc"), "library sign is zzc, got {sign}");
        assert!(
            (40..=48).contains(&sign.len()),
            "zzc sign length should stay near the published 44-char vector, got {} ({sign})",
            sign.len()
        );
        let HttpBody::Json(payload) = captured.body else {
            panic!("signed CGI body must be JSON");
        };
        let zzb = qq_request_signature(payload.to_string().as_bytes());
        assert!(zzb.starts_with("zzb"));
        assert_ne!(zzb, sign);
    }

    #[tokio::test]
    async fn unsigned_cgi_uses_musicu_fcg_without_zzc() {
        let captured = probe_cgi(false).await;
        assert!(
            captured.url.ends_with("/musicu.fcg"),
            "unsigned CGI must use musicu.fcg, got {}",
            captured.url
        );
        assert_eq!(query_value(&captured.query, "sign"), None);
    }

    #[test]
    fn map_qmapi_error_preserves_timeout_cancel_rate_limit_and_auth() {
        assert!(matches!(
            map_qmapi_error(QmError::Network(NetworkError {
                kind: NetworkErrorKind::Timeout,
                message: "t".into(),
            })),
            QQMusicError::Timeout
        ));
        assert!(matches!(
            map_qmapi_error(QmError::Network(NetworkError {
                kind: NetworkErrorKind::Cancelled,
                message: "c".into(),
            })),
            QQMusicError::Cancelled
        ));
        assert!(matches!(
            map_qmapi_error(QmError::RateLimited),
            QQMusicError::RateLimited
        ));
        assert!(matches!(
            map_qmapi_error(QmError::CredentialExpired("x".into())),
            QQMusicError::AuthenticationExpired
        ));
        assert!(matches!(
            map_qmapi_error(QmError::Http {
                status: 401,
                body: String::new(),
            }),
            QQMusicError::AuthenticationExpired
        ));
        assert!(matches!(
            map_qmapi_error(QmError::Http {
                status: 404,
                body: String::new(),
            }),
            QQMusicError::NotFound
        ));
        assert!(matches!(
            map_qmapi_error(QmError::GlobalApi {
                code: -1,
                data: String::new(),
            }),
            QQMusicError::SchemaChanged
        ));
        assert!(matches!(
            map_qmapi_error(QmError::SignatureRequired),
            QQMusicError::Protocol
        ));
        assert!(matches!(
            map_qmapi_error(QmError::ValueError("bad".into())),
            QQMusicError::InvalidRequest
        ));
    }
}
