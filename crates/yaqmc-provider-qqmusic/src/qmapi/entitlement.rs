//! Row H: library `user::get_vip_info` mapped through in-tree derivation.
//!
//! Quality-rights (`choose_source`, permitted qualities) stay in
//! `entitlement.rs`. Under `qmapi` (non-test) `fetch_entitlement` calls
//! library `vip_login_base` and falls back to in-tree HTTP on failure.

use qqmusic_api::models::user::UserVipInfoResponse;
use qqmusic_api::Platform;
use serde_json::json;

use crate::qmapi::cgi::map_qmapi_error;
use crate::qmapi::credential::credential_from_session;
use crate::qmapi::qmapi_client_with;
use crate::qqmusic::account::AccountEntitlement;
use crate::qqmusic::normalize_account_entitlement;
use crate::qqmusic::{QQMusicError, SessionRecord};

pub(crate) fn account_entitlement_from_qmapi(info: &UserVipInfoResponse) -> AccountEntitlement {
    normalize_account_entitlement(&json!({
        "req": {
            "data": {
                "svip": info.svip,
                "star": info.star,
                "ystar": info.ystar,
                "identity": {
                    "vip": info.identity.vip,
                    "HugeVip": info.identity.huge_vip,
                    "yearflag": info.identity.year_flag,
                    "HugeYearFlag": info.identity.huge_year_flag,
                    "twelve": info.identity.twelve,
                    "eight": info.identity.eight,
                    "ChildVip": info.identity.child_vip,
                    "ExpVip": info.identity.exp_vip,
                    "GroupVipFlag": info.identity.group_vip_flag,
                    "CPLoverFlag": info.identity.cp_lover_flag,
                    "AdVipFlag": info.identity.ad_vip_flag,
                },
                "userinfo": {
                    "expire": info.userinfo.expire,
                },
            }
        }
    }))
}

pub(crate) async fn fetch_account_entitlement(
    session: &SessionRecord,
) -> Result<AccountEntitlement, QQMusicError> {
    let credential = credential_from_session(session)?;
    let client = qmapi_client_with(Some(credential.clone()), Some(Platform::Web))
        .map_err(map_qmapi_error)?;
    let info = client
        .user
        .get_vip_info(Some(&credential))
        .await
        .map_err(map_qmapi_error)?;
    Ok(account_entitlement_from_qmapi(&info))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use qqmusic_api::{
        ApiTransport, Client, Credential, HttpBody, Platform, RetryClass, TransportRequest,
        TransportResponse,
    };
    use serde_json::Value;
    use yaqmc_provider_api::AudioQuality;

    use super::*;
    use crate::qqmusic::account::{EntitlementTier, MembershipState, SecondaryEntitlement};

    const VIP_OK: &[u8] = br#"{"code":0,"req_0":{"code":0,"data":{"svip":0,"star":0,"ystar":0,"identity":{"vip":1,"HugeVip":0,"yearflag":1,"GroupVipFlag":1},"userinfo":{"expire":4102444800}}}}"#;

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
            self.captured
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(CapturedRequest {
                    retry: request.retry,
                    body: request.body,
                });
            Ok(TransportResponse {
                status: 200,
                final_url: request.url,
                headers: Vec::new(),
                body: VIP_OK.to_vec(),
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

    #[test]
    fn library_vip_info_uses_intree_quality_derivation() {
        let envelope: Value = serde_json::from_slice(VIP_OK).expect("envelope");
        let info: UserVipInfoResponse =
            serde_json::from_value(envelope.pointer("/req_0/data").cloned().expect("vip data"))
                .expect("vip");
        let entitlement = account_entitlement_from_qmapi(&info);
        let expected = normalize_account_entitlement(&json!({
            "req": {
                "data": {
                    "svip": 0,
                    "identity": {
                        "vip": 1,
                        "HugeVip": 0,
                        "yearflag": 1,
                        "GroupVipFlag": 1
                    },
                    "userinfo": { "expire": 4_102_444_800_i64 }
                }
            }
        }));
        assert_eq!(entitlement, expected);
        assert_eq!(entitlement.tier, EntitlementTier::GreenDiamond);
        assert_eq!(entitlement.membership, MembershipState::Active);
        assert_eq!(entitlement.expires_at_ms, Some(4_102_444_800_000));
        assert_eq!(
            entitlement.secondary_entitlements,
            vec![
                SecondaryEntitlement::AnnualGreenDiamond,
                SecondaryEntitlement::Family
            ]
        );
        assert_eq!(
            entitlement.permitted_qualities,
            vec![
                AudioQuality::Standard,
                AudioQuality::High,
                AudioQuality::Lossless
            ]
        );
        assert_eq!(
            entitlement.observed_maximum_quality,
            Some(AudioQuality::Lossless)
        );
    }

    #[test]
    fn empty_vip_info_is_conservative() {
        let entitlement = account_entitlement_from_qmapi(&UserVipInfoResponse::default());
        assert_eq!(entitlement.tier, EntitlementTier::Free);
        assert_eq!(entitlement.membership, MembershipState::Inactive);
        assert_eq!(
            entitlement.permitted_qualities,
            vec![AudioQuality::Standard]
        );
    }

    #[tokio::test]
    async fn get_vip_info_uses_intree_module_as_safe_read() {
        let transport = std::sync::Arc::new(RecordingTransport::new());
        let client = Client::new_with_transport(
            Some(signed_in_credential()),
            Some(Platform::Web),
            transport.clone(),
        );
        let info = client.user.get_vip_info(None).await.expect("vip");
        let entitlement = account_entitlement_from_qmapi(&info);
        assert_eq!(entitlement.tier, EntitlementTier::GreenDiamond);
        let captured = transport.last();
        assert_eq!(captured.retry, RetryClass::SafeRead);
        let HttpBody::Json(payload) = captured.body else {
            panic!("CGI body must be JSON");
        };
        assert_eq!(
            payload.pointer("/req_0/module").and_then(Value::as_str),
            Some("VipLogin.VipLoginInter")
        );
        assert_eq!(
            payload.pointer("/req_0/method").and_then(Value::as_str),
            Some("vip_login_base")
        );
    }
}
