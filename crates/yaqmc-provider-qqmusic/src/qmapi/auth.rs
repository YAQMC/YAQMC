//! Typed authentication/profile calls delegated to qm-api-rs.

use qqmusic_api::Platform;
use serde_json::{json, Value};

use crate::qmapi::cgi::map_qmapi_error;
use crate::qmapi::credential::credential_from_session;
use crate::qmapi::qmapi_client_with;
use crate::qqmusic::{QQMusicError, SessionRecord};

/// Validate the current account and return the legacy envelope expected by
/// the provider's profile normalizer. The upstream route and credential
/// injection are owned by qm-api-rs.
pub(crate) async fn fetch_profile(
    session: &SessionRecord,
    cancellation: tokio_util::sync::CancellationToken,
) -> Result<Value, QQMusicError> {
    if cancellation.is_cancelled() {
        return Err(QQMusicError::Cancelled);
    }
    let credential = credential_from_session(session)?;
    let client = qmapi_client_with(Some(credential.clone()), Some(Platform::Web))
        .map_err(map_qmapi_error)?;
    let data = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(QQMusicError::Cancelled),
        result = client.user.raw_get_user_base_info(
            json!({"vec_uin": [session.uin], "need_profile": 1}),
            Some(&credential),
        ) => result.map_err(map_qmapi_error)?,
    };
    if cancellation.is_cancelled() {
        return Err(QQMusicError::Cancelled);
    }
    Ok(json!({"code": 0, "req": {"code": 0, "data": data}}))
}
