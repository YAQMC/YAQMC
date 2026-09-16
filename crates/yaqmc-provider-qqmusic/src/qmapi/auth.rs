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
    client: Option<&qqmusic_api::Client>,
    session: &SessionRecord,
    cancellation: tokio_util::sync::CancellationToken,
) -> Result<Value, QQMusicError> {
    if cancellation.is_cancelled() {
        return Err(QQMusicError::Cancelled);
    }
    let credential = credential_from_session(session)?;
    let local_client;
    let client = match client {
        Some(client) => client,
        None => {
            local_client = qmapi_client_with(Some(credential.clone()), Some(Platform::Web))
                .map_err(map_qmapi_error)?;
            &local_client
        }
    };
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

    let profile_data = if let Some(map) = data.get("map_userinfo").and_then(Value::as_object) {
        let user_info = map
            .get(&session.uin)
            .or_else(|| map.values().next())
            .cloned()
            .unwrap_or_else(|| data.clone());
        json!({
            "info": user_info,
            "map_userinfo": data.get("map_userinfo"),
        })
    } else {
        data
    };

    Ok(json!({"code": 0, "req": {"code": 0, "data": profile_data}}))
}
