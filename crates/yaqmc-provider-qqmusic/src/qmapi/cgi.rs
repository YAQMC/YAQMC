//! Error mapping from the pinned `qqmusic-api` surface into YAQMC errors.
//! Production A/B signing stays on in-tree MD5 `zzb` (Keep).

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
    use qqmusic_api::{NetworkError, NetworkErrorKind, QmError};

    use super::*;
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
