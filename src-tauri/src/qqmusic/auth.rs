#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the guarded Tauri auth commands are introduced in the next implementation task"
    )
)]
#![cfg_attr(
    test,
    allow(
        dead_code,
        reason = "the complete auth API is exercised across this task and the next command-wiring task"
    )
)]

#[cfg(test)]
use super::account::{EntitlementTier, MembershipState};
use super::{
    account::{
        AccountCapabilities, AccountEntitlement, AccountProfile, AccountSnapshot, AccountState,
    },
    cache::{AccountEpoch, OpaqueAccountScope, ACCOUNT_CACHE_KIND},
    clock::Clock,
    entitlement::normalize_account_entitlement,
    oauth::{parse_callback, OAuthCallback, OAuthLaunch, OAuthLoginProvider},
    transport::{QqTransport, RedirectMode, RetryClass, TransportRequest, TransportResponse},
    QQMusicError, QQ_MUSICU_URL,
};
#[cfg(test)]
use crate::player::AudioQuality;
use crate::{
    credentials::SpawnBlockingCredentialStore,
    media::PlaybackEpochClock,
    storage::{StorageError, StorageService},
};
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use reqwest::{
    header::{self, HeaderMap, HeaderValue},
    Method, StatusCode, Url,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::Duration,
};
use subtle::ConstantTimeEq;
#[cfg(test)]
use tokio::sync::Notify;
use tokio::sync::{Mutex, RwLock};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

pub(crate) const ACTIVE_SESSION: &str = "qqmusic-session";
pub(crate) const STAGING_SESSION: &str = "qqmusic-session-staging";
const MIN_POLL_INTERVAL_MS: u64 = 1_500;
const MAX_ATTEMPT_MS: u64 = 5 * 60 * 1_000;
const DEFAULT_QR_LIFETIME_MS: u64 = 2 * 60 * 1_000;
const OWNER_LEASE_MS: u64 = 7_000;
const MAX_QR_BYTES: usize = 256 * 1_024;
const SESSION_VERSION: u8 = 1;

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionRecord {
    pub(crate) version: u8,
    pub(crate) uin: String,
    pub(crate) cookie_header: String,
    pub(crate) expires_at_ms: u64,
    pub(crate) account_cache_scope: OpaqueAccountScope,
}

pub(crate) struct AuthenticatedAccountContext {
    pub(crate) session: SessionRecord,
    pub(crate) epoch: AccountEpoch,
    pub(crate) cancellation: CancellationToken,
    pub(crate) auth_revision: u64,
    pub(crate) profile: AccountProfile,
    pub(crate) entitlement: AccountEntitlement,
}

pub(crate) struct AuthChallenge {
    qr_bytes: Vec<u8>,
    mime_type: String,
    poll_secret: String,
    expires_at_ms: u64,
}

impl AuthChallenge {
    fn poll_copy(&self) -> Self {
        Self {
            qr_bytes: Vec::new(),
            mime_type: String::new(),
            poll_secret: self.poll_secret.clone(),
            expires_at_ms: self.expires_at_ms,
        }
    }
}

pub(crate) enum AuthPollResult {
    WaitingForScan,
    WaitingForConfirmation,
    Confirmed(SessionRecord),
    Expired,
    Rejected,
}

#[derive(Clone, PartialEq)]
pub(crate) struct ValidatedAccount {
    pub(crate) profile: AccountProfile,
    pub(crate) entitlement: AccountEntitlement,
}

#[async_trait]
pub(crate) trait QQMusicAuthProtocol: Send + Sync {
    async fn create_challenge(
        &self,
        cancellation: CancellationToken,
    ) -> Result<AuthChallenge, QQMusicError>;

    async fn poll_challenge(
        &self,
        challenge: &AuthChallenge,
        cancellation: CancellationToken,
    ) -> Result<AuthPollResult, QQMusicError>;

    async fn exchange_oauth_code(
        &self,
        provider: OAuthLoginProvider,
        code: &str,
        cancellation: CancellationToken,
    ) -> Result<SessionRecord, QQMusicError>;

    async fn validate_session(
        &self,
        session: &SessionRecord,
        cancellation: CancellationToken,
    ) -> Result<ValidatedAccount, QQMusicError>;
}

pub(crate) struct TransportQQMusicAuthProtocol {
    transport: Arc<dyn QqTransport>,
    clock: Arc<dyn Clock>,
}

impl TransportQQMusicAuthProtocol {
    pub(crate) fn new(transport: Arc<dyn QqTransport>, clock: Arc<dyn Clock>) -> Self {
        Self { transport, clock }
    }

    async fn fetch_entitlement(
        &self,
        session: &SessionRecord,
        cancellation: CancellationToken,
    ) -> Result<AccountEntitlement, QQMusicError> {
        let payload = json!({
            "comm": {
                "ct": 24,
                "cv": 0,
                "format": "json",
                "uin": session.uin,
            },
            "req": {
                "module": "VipLogin.VipLoginInter",
                "method": "vip_login_base",
                "param": {},
            },
        });
        let mut headers = referer_headers("https://y.qq.com/")?;
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json; charset=utf-8"),
        );
        headers.insert(header::ORIGIN, HeaderValue::from_static("https://y.qq.com"));
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(&session.cookie_header).map_err(|_| QQMusicError::Protocol)?,
        );
        let response = self
            .transport
            .execute(TransportRequest {
                operation: "auth.entitlement.validate",
                method: Method::POST,
                url: Url::parse(QQ_MUSICU_URL).map_err(|_| QQMusicError::Protocol)?,
                headers,
                body: Some(serde_json::to_vec(&payload).map_err(|_| QQMusicError::Protocol)?),
                retry: RetryClass::SafeRead,
                redirects: RedirectMode::FollowValidated,
                response_shape: "account-entitlement",
                cancellation,
            })
            .await?;
        require_success(&response)?;
        let payload: Value =
            serde_json::from_slice(&response.body).map_err(|_| QQMusicError::MalformedResponse)?;
        if json_code(&payload).unwrap_or(-1) != 0
            || payload
                .pointer("/req/code")
                .or_else(|| payload.pointer("/req_0/code"))
                .and_then(Value::as_i64)
                .unwrap_or(-1)
                != 0
            || payload
                .pointer("/req/data")
                .or_else(|| payload.pointer("/req_0/data"))
                .is_none()
        {
            return Err(QQMusicError::SchemaChanged);
        }
        Ok(normalize_account_entitlement(&payload))
    }

    async fn exchange_code(
        &self,
        provider: OAuthLoginProvider,
        code: &str,
        gtk: Option<u32>,
        mut cookies: SecretCookieJar,
        cancellation: CancellationToken,
    ) -> Result<SessionRecord, QQMusicError> {
        if code.is_empty() || code.len() > 2_048 || code.bytes().any(|byte| byte.is_ascii_control())
        {
            return Err(QQMusicError::Protocol);
        }
        let (operation, module, method, param, login_type) = match provider {
            OAuthLoginProvider::Qq => (
                "auth.qq.exchange",
                "QQConnectLogin.LoginServer",
                "QQLogin",
                json!({ "code": code }),
                2,
            ),
            OAuthLoginProvider::Wechat => (
                "auth.wechat.exchange",
                "music.login.LoginServer",
                "Login",
                json!({ "code": code, "strAppid": "wx48db31d50e334801" }),
                1,
            ),
        };
        let mut comm = json!({
            "platform": "yqq",
            "ct": 24,
            "cv": 0,
            "tmeLoginType": login_type,
        });
        if let Some(gtk) = gtk {
            comm["g_tk"] = json!(gtk);
        }
        let login_payload = json!({
            "comm": comm,
            "req": {
                "module": module,
                "method": method,
                "param": param,
            }
        });
        let mut login_headers = if cookies.values.is_empty() {
            referer_headers("https://y.qq.com/")?
        } else {
            authenticated_headers(&cookies, Some("https://y.qq.com/"))?
        };
        login_headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        login_headers.insert(header::ORIGIN, HeaderValue::from_static("https://y.qq.com"));
        let login = self
            .transport
            .execute(TransportRequest {
                operation,
                method: Method::POST,
                url: Url::parse(QQ_MUSICU_URL).map_err(|_| QQMusicError::Protocol)?,
                headers: login_headers,
                body: Some(serde_json::to_vec(&login_payload).map_err(|_| QQMusicError::Protocol)?),
                retry: RetryClass::AuthPoll,
                redirects: RedirectMode::FollowValidated,
                response_shape: "oauth-login-session",
                cancellation,
            })
            .await?;
        require_success(&login)?;
        cookies.absorb_set_cookie(&login.headers)?;
        let payload: Value =
            serde_json::from_slice(&login.body).map_err(|_| QQMusicError::MalformedResponse)?;
        self.session_from_login_payload(&payload, cookies)
    }

    fn session_from_login_payload(
        &self,
        payload: &Value,
        mut cookies: SecretCookieJar,
    ) -> Result<SessionRecord, QQMusicError> {
        if json_code(payload).unwrap_or(-1) != 0
            || payload
                .pointer("/req/code")
                .or_else(|| payload.pointer("/req_0/code"))
                .and_then(|value| value.as_i64().or_else(|| value.as_str()?.parse().ok()))
                .unwrap_or(-1)
                != 0
        {
            return Err(QQMusicError::AuthorizationRejected);
        }
        let data = payload
            .pointer("/req/data")
            .or_else(|| payload.pointer("/req_0/data"))
            .or_else(|| payload.pointer("/req"))
            .ok_or(QQMusicError::MalformedResponse)?;
        let uin = first_string(data, &["/str_musicid", "/musicid", "/uin"])
            .filter(|value| {
                !value.is_empty() && value.chars().all(|character| character.is_ascii_digit())
            })
            .ok_or(QQMusicError::MalformedResponse)?;
        let music_key = first_string(data, &["/musickey", "/musicKey"])
            .filter(|value| !value.is_empty())
            .ok_or(QQMusicError::MalformedResponse)?;
        cookies.insert("uin", &format!("o{uin}"))?;
        cookies.insert("qqmusic_uin", &uin)?;
        cookies.insert("qm_keyst", &music_key)?;
        cookies.insert("qqmusic_key", &music_key)?;
        cookies.remove("qrsig");
        cookies.remove("pt_login_sig");

        let created = numeric_u64(data, &["/musickeyCreateTime", "/musickey_create_time"]);
        let lifetime = numeric_u64(data, &["/keyExpiresIn", "/key_expires_in"]);
        let expires_at_ms = match (created, lifetime) {
            (Some(created), Some(lifetime)) if lifetime > 0 => {
                let created_ms = if created >= 1_000_000_000_000 {
                    created
                } else {
                    created.saturating_mul(1_000)
                };
                created_ms.saturating_add(lifetime.saturating_mul(1_000))
            }
            _ => self.clock.now_ms().saturating_add(24 * 60 * 60 * 1_000),
        };

        Ok(SessionRecord {
            version: SESSION_VERSION,
            uin,
            cookie_header: cookies.header_value(),
            expires_at_ms,
            account_cache_scope: OpaqueAccountScope::generate(),
        })
    }

    async fn complete_qq_exchange(
        &self,
        callback_url: &str,
        poll_headers: &HeaderMap,
        poll_secret: &str,
        cancellation: CancellationToken,
    ) -> Result<SessionRecord, QQMusicError> {
        let check_sig_url = Url::parse(callback_url).map_err(|_| QQMusicError::Protocol)?;
        require_endpoint(&check_sig_url, "ssl.ptlogin2.graph.qq.com", "/check_sig")?;

        let mut cookies = SecretCookieJar::default();
        cookies.insert("qrsig", poll_secret)?;
        cookies.absorb_set_cookie(poll_headers)?;
        let check_sig = self
            .transport
            .execute(TransportRequest {
                operation: "auth.qq.check-sig",
                method: Method::GET,
                url: check_sig_url,
                headers: authenticated_headers(&cookies, Some("https://xui.ptlogin2.qq.com/"))?,
                body: None,
                retry: RetryClass::AuthPoll,
                redirects: RedirectMode::ReturnResponse,
                response_shape: "qq-check-sig-redirect",
                cancellation: cancellation.clone(),
            })
            .await?;
        require_redirect(&check_sig)?;
        cookies.absorb_set_cookie(&check_sig.headers)?;
        let p_skey = cookies.get("p_skey").ok_or(QQMusicError::Protocol)?;
        let gtk = hash33(p_skey, 5_381);

        let authorize_url = Url::parse("https://graph.qq.com/oauth2.0/authorize")
            .map_err(|_| QQMusicError::Protocol)?;
        let body = form_body(&[
            ("response_type", "code".to_owned()),
            ("client_id", "100497308".to_owned()),
            (
                "redirect_uri",
                "https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/"
                    .to_owned(),
            ),
            ("scope", "get_user_info,get_app_friends".to_owned()),
            ("state", "state".to_owned()),
            ("switch", String::new()),
            ("from_ptlogin", "1".to_owned()),
            ("src", "1".to_owned()),
            ("update_auth", "1".to_owned()),
            ("openapi", "1010_1030".to_owned()),
            ("g_tk", gtk.to_string()),
            ("auth_time", self.clock.now_ms().to_string()),
            ("ui", random_opaque_id()),
        ])?;
        let mut authorize_headers = authenticated_headers(&cookies, Some("https://graph.qq.com/"))?;
        authorize_headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/x-www-form-urlencoded"),
        );
        let authorize = self
            .transport
            .execute(TransportRequest {
                operation: "auth.qq.authorize",
                method: Method::POST,
                url: authorize_url,
                headers: authorize_headers,
                body: Some(body),
                retry: RetryClass::AuthPoll,
                redirects: RedirectMode::ReturnResponse,
                response_shape: "qq-oauth-redirect",
                cancellation: cancellation.clone(),
            })
            .await?;
        require_redirect(&authorize)?;
        cookies.absorb_set_cookie(&authorize.headers)?;
        let location = authorize
            .headers
            .get(header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .ok_or(QQMusicError::Protocol)?;
        let location = authorize
            .final_url
            .join(location)
            .map_err(|_| QQMusicError::Protocol)?;
        require_endpoint(&location, "y.qq.com", "/portal/wx_redirect.html")?;
        let code = location
            .query_pairs()
            .find_map(|(key, value)| (key == "code").then(|| value.into_owned()))
            .filter(|value| !value.is_empty())
            .ok_or(QQMusicError::Protocol)?;

        self.exchange_code(
            OAuthLoginProvider::Qq,
            &code,
            Some(gtk),
            cookies,
            cancellation,
        )
        .await
    }
}

#[async_trait]
impl QQMusicAuthProtocol for TransportQQMusicAuthProtocol {
    async fn create_challenge(
        &self,
        cancellation: CancellationToken,
    ) -> Result<AuthChallenge, QQMusicError> {
        let mut url = Url::parse("https://ssl.ptlogin2.qq.com/ptqrshow")
            .map_err(|_| QQMusicError::Protocol)?;
        url.query_pairs_mut()
            .append_pair("appid", "716027609")
            .append_pair("e", "2")
            .append_pair("l", "M")
            .append_pair("s", "3")
            .append_pair("d", "72")
            .append_pair("v", "4")
            .append_pair("t", &format!("0.{}", self.clock.now_ms()))
            .append_pair("daid", "383")
            .append_pair("pt_3rd_aid", "100497308")
            .append_pair("u1", "https://graph.qq.com/oauth2.0/login_jump");
        let response = self
            .transport
            .execute(TransportRequest {
                operation: "auth.qq.create",
                method: Method::GET,
                url,
                headers: referer_headers("https://xui.ptlogin2.qq.com/")?,
                body: None,
                retry: RetryClass::SafeRead,
                redirects: RedirectMode::FollowValidated,
                response_shape: "qr-image",
                cancellation,
            })
            .await?;
        require_success(&response)?;
        let mime_type = response
            .headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(normalize_image_mime)
            .ok_or(QQMusicError::MalformedResponse)?;
        if response.body.is_empty() || response.body.len() > MAX_QR_BYTES {
            return Err(QQMusicError::MalformedResponse);
        }
        let mut cookies = SecretCookieJar::default();
        cookies.absorb_set_cookie(&response.headers)?;
        let poll_secret = cookies
            .get("qrsig")
            .filter(|value| !value.is_empty())
            .ok_or(QQMusicError::MalformedResponse)?
            .to_owned();

        Ok(AuthChallenge {
            qr_bytes: response.body,
            mime_type: mime_type.to_owned(),
            poll_secret,
            expires_at_ms: self.clock.now_ms().saturating_add(DEFAULT_QR_LIFETIME_MS),
        })
    }

    async fn poll_challenge(
        &self,
        challenge: &AuthChallenge,
        cancellation: CancellationToken,
    ) -> Result<AuthPollResult, QQMusicError> {
        let mut url = Url::parse("https://ssl.ptlogin2.qq.com/ptqrlogin")
            .map_err(|_| QQMusicError::Protocol)?;
        url.query_pairs_mut()
            .append_pair("u1", "https://graph.qq.com/oauth2.0/login_jump")
            .append_pair(
                "ptqrtoken",
                &hash33(&challenge.poll_secret, 5_381).to_string(),
            )
            .append_pair("ptredirect", "0")
            .append_pair("h", "1")
            .append_pair("t", "1")
            .append_pair("g", "1")
            .append_pair("from_ui", "1")
            .append_pair("ptlang", "2052")
            .append_pair("action", &format!("0-0-{}", self.clock.now_ms()))
            .append_pair("js_ver", "20102616")
            .append_pair("js_type", "1")
            .append_pair("pt_uistyle", "40")
            .append_pair("aid", "716027609")
            .append_pair("daid", "383")
            .append_pair("pt_3rd_aid", "100497308")
            .append_pair("has_onekey", "1");
        let mut cookies = SecretCookieJar::default();
        cookies.insert("qrsig", &challenge.poll_secret)?;
        let response = self
            .transport
            .execute(TransportRequest {
                operation: "auth.qq.poll",
                method: Method::GET,
                url,
                headers: authenticated_headers(&cookies, Some("https://xui.ptlogin2.qq.com/"))?,
                body: None,
                retry: RetryClass::AuthPoll,
                redirects: RedirectMode::ReturnResponse,
                response_shape: "qr-status",
                cancellation: cancellation.clone(),
            })
            .await?;
        require_success(&response)?;
        let body =
            std::str::from_utf8(&response.body).map_err(|_| QQMusicError::MalformedResponse)?;
        let args = parse_ptui_callback(body)?;
        match args.first().map(String::as_str) {
            Some("66") => Ok(AuthPollResult::WaitingForScan),
            Some("67") => Ok(AuthPollResult::WaitingForConfirmation),
            Some("65") => Ok(AuthPollResult::Expired),
            Some("68") => Ok(AuthPollResult::Rejected),
            Some("0") => {
                let callback_url = args.get(2).ok_or(QQMusicError::MalformedResponse)?;
                let session = self
                    .complete_qq_exchange(
                        callback_url,
                        &response.headers,
                        &challenge.poll_secret,
                        cancellation,
                    )
                    .await?;
                Ok(AuthPollResult::Confirmed(session))
            }
            _ => Err(QQMusicError::MalformedResponse),
        }
    }

    async fn exchange_oauth_code(
        &self,
        provider: OAuthLoginProvider,
        code: &str,
        cancellation: CancellationToken,
    ) -> Result<SessionRecord, QQMusicError> {
        self.exchange_code(
            provider,
            code,
            None,
            SecretCookieJar::default(),
            cancellation,
        )
        .await
    }

    async fn validate_session(
        &self,
        session: &SessionRecord,
        cancellation: CancellationToken,
    ) -> Result<ValidatedAccount, QQMusicError> {
        if session.version != SESSION_VERSION
            || session.uin.is_empty()
            || session.cookie_header.is_empty()
            || session.expires_at_ms <= self.clock.now_ms()
        {
            return Err(QQMusicError::AuthenticationExpired);
        }
        let profile_payload = json!({
            "comm": {
                "ct": 24,
                "cv": 0,
                "format": "json",
                "platform": "yqq.json",
                "uin": session.uin,
            },
            "req": {
                "module": "music.UserInfo.userInfoServer",
                "method": "GetLoginUserInfo",
                "param": {},
            },
        });
        let mut headers = referer_headers("https://y.qq.com/")?;
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json; charset=utf-8"),
        );
        headers.insert(header::ORIGIN, HeaderValue::from_static("https://y.qq.com"));
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(&session.cookie_header).map_err(|_| QQMusicError::Protocol)?,
        );
        let response = self
            .transport
            .execute(TransportRequest {
                operation: "auth.session.validate",
                method: Method::POST,
                url: Url::parse(QQ_MUSICU_URL).map_err(|_| QQMusicError::Protocol)?,
                headers,
                body: Some(
                    serde_json::to_vec(&profile_payload).map_err(|_| QQMusicError::Protocol)?,
                ),
                retry: RetryClass::SafeRead,
                redirects: RedirectMode::FollowValidated,
                response_shape: "account-profile",
                cancellation: cancellation.clone(),
            })
            .await?;
        require_success(&response)?;
        let payload: Value =
            serde_json::from_slice(&response.body).map_err(|_| QQMusicError::MalformedResponse)?;
        let request = payload
            .get("req")
            .or_else(|| payload.get("req_0"))
            .ok_or(QQMusicError::SchemaChanged)?;
        if json_code(&payload).unwrap_or(-1) != 0 || json_code(request).unwrap_or(-1) != 0 {
            return Err(QQMusicError::AuthenticationExpired);
        }
        let data = request.get("data").ok_or(QQMusicError::SchemaChanged)?;
        let profile = data
            .get("userInfo")
            .or_else(|| data.get("info"))
            .unwrap_or(data);
        let nickname = first_string(
            profile,
            &["/nick", "/nickname", "/name", "/Name", "/NickName"],
        )
        .filter(|value| !value.trim().is_empty())
        .ok_or(QQMusicError::SchemaChanged)?;
        let raw_avatar_url = first_string(
            profile,
            &[
                "/headurl",
                "/headUrl",
                "/avatar",
                "/avatarUrl",
                "/Avatar",
                "/logo",
                "/ifpicurl",
            ],
        );
        let avatar_url = raw_avatar_url.filter(|url| is_sanitized_avatar_url(url));

        let entitlement = match self.fetch_entitlement(session, cancellation).await {
            Ok(entitlement) => entitlement,
            Err(QQMusicError::Cancelled) => return Err(QQMusicError::Cancelled),
            Err(_) => normalize_account_entitlement(&Value::Null),
        };

        Ok(ValidatedAccount {
            profile: AccountProfile {
                avatar_url,
                nickname,
                masked_identity: mask_identity(&session.uin),
            },
            entitlement,
        })
    }
}

struct ActiveAttempt {
    attempt_id: String,
    owner_lease_id: String,
    generation: u64,
    owner_deadline: Instant,
    expires_at_ms: u64,
    poll_after_ms: u64,
    challenge: Option<AuthChallenge>,
    oauth: Option<OAuthAttempt>,
    cancellation: CancellationToken,
}

struct OAuthAttempt {
    provider: OAuthLoginProvider,
    state: String,
    deadline: Instant,
    completing: bool,
}

struct OwnerSignal {
    attempt_id: String,
    generation: u64,
    cancellation: CancellationToken,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LifecycleBoundary {
    CandidateValidated,
    BeforeStagingSave,
    AfterStagingSave,
    AfterStagingReadback,
    AfterStagedValidation,
    BeforeActiveSave,
    AfterActiveSave,
    AfterActiveReadback,
    AfterStagingDelete,
    BeforePublish,
    RestoreActiveLoaded,
    RestoreValidated,
    RestoreBeforePublish,
}

#[cfg(test)]
struct LifecycleBarrier {
    boundary: LifecycleBoundary,
    entered: Notify,
    release: Notify,
}

pub(crate) struct QQMusicAuthService {
    protocol: Arc<dyn QQMusicAuthProtocol>,
    credentials: SpawnBlockingCredentialStore,
    clock: Arc<dyn Clock>,
    storage: Arc<StorageService>,
    snapshot: RwLock<AccountSnapshot>,
    active_session: RwLock<Option<SessionRecord>>,
    active_attempt: Mutex<Option<ActiveAttempt>>,
    owner_signal: StdMutex<Option<OwnerSignal>>,
    lifecycle: Mutex<()>,
    generation: AtomicU64,
    generation_token: StdMutex<CancellationToken>,
    playback_epoch: Arc<PlaybackEpochClock>,
    #[cfg(test)]
    lifecycle_barrier: StdMutex<Option<Arc<LifecycleBarrier>>>,
}

impl QQMusicAuthService {
    pub(crate) fn new(
        protocol: Arc<dyn QQMusicAuthProtocol>,
        credentials: SpawnBlockingCredentialStore,
        clock: Arc<dyn Clock>,
        storage: Arc<StorageService>,
    ) -> Self {
        Self {
            protocol,
            credentials,
            clock,
            storage,
            snapshot: RwLock::new(AccountSnapshot {
                account: AccountState::Guest {
                    profile: (),
                    entitlement: (),
                },
                revision: 0,
                capabilities: guest_capabilities(),
            }),
            active_session: RwLock::new(None),
            active_attempt: Mutex::new(None),
            owner_signal: StdMutex::new(None),
            lifecycle: Mutex::new(()),
            generation: AtomicU64::new(0),
            generation_token: StdMutex::new(CancellationToken::new()),
            playback_epoch: Arc::new(PlaybackEpochClock::default()),
            #[cfg(test)]
            lifecycle_barrier: StdMutex::new(None),
        }
    }

    pub(crate) async fn snapshot(&self) -> AccountSnapshot {
        self.snapshot.read().await.clone()
    }

    pub(crate) fn playback_epoch_clock(&self) -> Arc<PlaybackEpochClock> {
        Arc::clone(&self.playback_epoch)
    }

    pub(crate) fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    pub(crate) async fn current_session(&self) -> Option<SessionRecord> {
        self.active_session.read().await.clone()
    }

    pub(crate) async fn capture_account_context(
        &self,
    ) -> Result<AuthenticatedAccountContext, QQMusicError> {
        let _lifecycle = self.lifecycle.lock().await;
        let (generation, cancellation) = self.capture_generation();
        self.ensure_generation_current(generation)?;
        let session = self
            .active_session
            .read()
            .await
            .clone()
            .ok_or(QQMusicError::AuthenticationExpired)?;
        if session.expires_at_ms <= self.clock.now_ms() {
            return Err(QQMusicError::AuthenticationExpired);
        }
        let snapshot = self.snapshot.read().await.clone();
        let (profile, entitlement) = match snapshot.account {
            AccountState::Authenticated {
                profile,
                entitlement,
            } => (profile, entitlement),
            _ => return Err(QQMusicError::AuthenticationExpired),
        };
        let epoch = AccountEpoch {
            generation,
            scope: session.account_cache_scope.clone(),
        };
        self.ensure_current(&epoch).await?;
        Ok(AuthenticatedAccountContext {
            session,
            epoch,
            cancellation,
            auth_revision: snapshot.revision,
            profile,
            entitlement,
        })
    }

    pub(crate) async fn ensure_current(&self, epoch: &AccountEpoch) -> Result<(), QQMusicError> {
        self.ensure_generation_current(epoch.generation)?;
        let session = self.active_session.read().await;
        if session
            .as_ref()
            .is_some_and(|current| current.account_cache_scope == epoch.scope)
        {
            Ok(())
        } else {
            Err(QQMusicError::Cancelled)
        }
    }

    pub(crate) async fn commit_account_cache_if_current<T, F>(
        &self,
        epoch: &AccountEpoch,
        commit: F,
    ) -> Result<T, QQMusicError>
    where
        F: FnOnce() -> Result<T, StorageError>,
    {
        let _lifecycle = self.lifecycle.lock().await;
        self.ensure_current(epoch).await?;
        let value = commit().map_err(|_| QQMusicError::Storage)?;
        self.ensure_current(epoch).await?;
        Ok(value)
    }

    pub(crate) async fn require_reauthentication_if_current(
        &self,
        epoch: &AccountEpoch,
    ) -> Result<(), QQMusicError> {
        let _lifecycle = self.lifecycle.lock().await;
        self.ensure_current(epoch).await?;
        let (profile, entitlement) = match self.snapshot.read().await.account.clone() {
            AccountState::Authenticated {
                profile,
                entitlement,
            } => (Some(profile), Some(entitlement)),
            _ => return Err(QQMusicError::Cancelled),
        };
        let (generation, _) = self.begin_generation().await;
        let _ = self.credentials.delete(ACTIVE_SESSION).await;
        let _ = self.storage.delete_provider_cache_kind(ACCOUNT_CACHE_KIND);
        *self.active_session.write().await = None;
        self.playback_epoch.replace(None);
        if !self
            .publish_if_current(
                generation,
                AccountState::ReauthenticationRequired {
                    profile,
                    entitlement,
                },
            )
            .await
        {
            return Err(QQMusicError::Cancelled);
        }
        Ok(())
    }

    pub(crate) async fn start(self: &Arc<Self>) -> Result<AccountSnapshot, QQMusicError> {
        let (generation, cancellation) = self.begin_generation().await;
        let attempt_id = random_opaque_id();
        let owner_lease_id = random_opaque_id();
        let poll_after_ms = MIN_POLL_INTERVAL_MS;
        self.install_owner_signal(OwnerSignal {
            attempt_id: attempt_id.clone(),
            generation,
            cancellation: cancellation.clone(),
        });
        {
            let mut active = self.active_attempt.lock().await;
            if !self.is_current(generation) || cancellation.is_cancelled() {
                self.clear_owner_signal(&attempt_id);
                return Err(QQMusicError::Cancelled);
            }
            if let Some(previous) = active.take() {
                previous.cancellation.cancel();
            }
            *active = Some(ActiveAttempt {
                attempt_id: attempt_id.clone(),
                owner_lease_id: owner_lease_id.clone(),
                generation,
                owner_deadline: Instant::now() + Duration::from_millis(OWNER_LEASE_MS),
                expires_at_ms: self.clock.now_ms().saturating_add(MAX_ATTEMPT_MS),
                poll_after_ms,
                challenge: None,
                oauth: None,
                cancellation: cancellation.clone(),
            });
        }
        if !self
            .publish_if_current(
                generation,
                AccountState::StartingLogin {
                    attempt_id: attempt_id.clone(),
                    owner_lease_id: owner_lease_id.clone(),
                    poll_after_ms,
                    profile: (),
                    entitlement: (),
                },
            )
            .await
        {
            self.take_attempt(generation, &attempt_id, true).await;
            return Err(QQMusicError::Cancelled);
        }

        let mut challenge = match self.protocol.create_challenge(cancellation.clone()).await {
            Ok(challenge) => challenge,
            Err(error) => {
                if self.is_current(generation) {
                    self.finish_attempt_with_error(generation, &attempt_id, &error)
                        .await;
                }
                return Err(error);
            }
        };
        if let Err(error) = validate_challenge(&challenge) {
            if self.is_current(generation) {
                self.finish_attempt_with_error(generation, &attempt_id, &error)
                    .await;
            }
            return Err(error);
        }
        challenge.mime_type = normalize_image_mime(&challenge.mime_type)
            .ok_or(QQMusicError::MalformedResponse)?
            .to_owned();
        if !self.is_current(generation) || cancellation.is_cancelled() {
            return Err(QQMusicError::Cancelled);
        }
        let expires_at_ms = challenge
            .expires_at_ms
            .min(self.clock.now_ms().saturating_add(MAX_ATTEMPT_MS));
        if expires_at_ms <= self.clock.now_ms() {
            let error = QQMusicError::MalformedResponse;
            self.finish_attempt_with_error(generation, &attempt_id, &error)
                .await;
            return Err(error);
        }
        let image = format!(
            "data:{};base64,{}",
            challenge.mime_type,
            BASE64.encode(&challenge.qr_bytes)
        );
        {
            let mut active = self.active_attempt.lock().await;
            let Some(current) = active.as_mut().filter(|current| {
                current.generation == generation && current.attempt_id == attempt_id
            }) else {
                return Err(QQMusicError::Cancelled);
            };
            current.expires_at_ms = expires_at_ms;
            current.owner_deadline = Instant::now() + Duration::from_millis(OWNER_LEASE_MS);
            current.challenge = Some(challenge);
        }
        if !self
            .publish_if_current(
                generation,
                AccountState::WaitingForScan {
                    attempt_id: attempt_id.clone(),
                    owner_lease_id,
                    qr_image_data_uri: image,
                    expires_at_ms,
                    poll_after_ms,
                    profile: (),
                    entitlement: (),
                },
            )
            .await
        {
            self.take_attempt(generation, &attempt_id, true).await;
            return Err(QQMusicError::Cancelled);
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            if let Some(service) = weak.upgrade() {
                service.poll_loop(generation, attempt_id).await;
            }
        });
        Ok(self.snapshot().await)
    }

    pub(crate) async fn start_oauth(
        self: &Arc<Self>,
        provider: OAuthLoginProvider,
    ) -> Result<OAuthLaunch, QQMusicError> {
        let state = random_opaque_id();
        let authorization_url = provider.authorization_url(&state)?;
        let (generation, cancellation) = self.begin_generation().await;
        let attempt_id = random_opaque_id();
        let owner_lease_id = random_opaque_id();
        let poll_after_ms = MIN_POLL_INTERVAL_MS;
        let expires_at_ms = self.clock.now_ms().saturating_add(MAX_ATTEMPT_MS);
        self.install_owner_signal(OwnerSignal {
            attempt_id: attempt_id.clone(),
            generation,
            cancellation: cancellation.clone(),
        });
        {
            let mut active = self.active_attempt.lock().await;
            if !self.is_current(generation) || cancellation.is_cancelled() {
                self.clear_owner_signal(&attempt_id);
                return Err(QQMusicError::Cancelled);
            }
            if let Some(previous) = active.take() {
                previous.cancellation.cancel();
            }
            *active = Some(ActiveAttempt {
                attempt_id: attempt_id.clone(),
                owner_lease_id: owner_lease_id.clone(),
                generation,
                owner_deadline: Instant::now() + Duration::from_millis(OWNER_LEASE_MS),
                expires_at_ms,
                poll_after_ms,
                challenge: None,
                oauth: Some(OAuthAttempt {
                    provider,
                    state,
                    deadline: Instant::now() + Duration::from_millis(MAX_ATTEMPT_MS),
                    completing: false,
                }),
                cancellation: cancellation.clone(),
            });
        }
        if !self
            .publish_if_current(
                generation,
                AccountState::WaitingForConfirmation {
                    attempt_id: attempt_id.clone(),
                    owner_lease_id,
                    expires_at_ms,
                    poll_after_ms,
                    profile: (),
                    entitlement: (),
                },
            )
            .await
        {
            self.take_attempt(generation, &attempt_id, true).await;
            return Err(QQMusicError::Cancelled);
        }
        let weak = Arc::downgrade(self);
        let watched_attempt = attempt_id.clone();
        tokio::spawn(async move {
            if let Some(service) = weak.upgrade() {
                service.oauth_owner_loop(generation, watched_attempt).await;
            }
        });
        Ok(OAuthLaunch {
            attempt_id,
            authorization_url,
            snapshot: self.snapshot().await,
        })
    }

    pub(crate) async fn complete_oauth_callback(
        &self,
        attempt_id: &str,
        provider: OAuthLoginProvider,
        callback_url: Url,
    ) -> Result<AccountSnapshot, QQMusicError> {
        let (generation, cancellation, expected_state) = {
            let mut active = self.active_attempt.lock().await;
            let current = active
                .as_mut()
                .filter(|current| {
                    current.attempt_id == attempt_id
                        && self.is_current(current.generation)
                        && !current.cancellation.is_cancelled()
                })
                .ok_or(QQMusicError::Cancelled)?;
            let oauth = current
                .oauth
                .as_mut()
                .filter(|oauth| oauth.provider == provider)
                .ok_or(QQMusicError::AuthorizationRejected)?;
            if oauth.completing {
                return Err(QQMusicError::MutationInProgress);
            }
            oauth.completing = true;
            (
                current.generation,
                current.cancellation.clone(),
                oauth.state.clone(),
            )
        };

        let outcome = match parse_callback(provider, &callback_url, &expected_state) {
            Ok(outcome) => outcome,
            Err(error) => {
                self.finish_attempt_with_error(generation, attempt_id, &error)
                    .await;
                return Err(error);
            }
        };
        let OAuthCallback::Code(code) = outcome else {
            self.finish_attempt(
                generation,
                attempt_id,
                AccountState::Rejected {
                    attempt_id: Some(attempt_id.to_owned()),
                    profile: (),
                    entitlement: (),
                },
            )
            .await;
            return Err(QQMusicError::AuthorizationRejected);
        };
        let candidate = match self
            .protocol
            .exchange_oauth_code(provider, &code, cancellation.clone())
            .await
        {
            Ok(candidate) => candidate,
            Err(error) => {
                self.finish_attempt_with_error(generation, attempt_id, &error)
                    .await;
                return Err(error);
            }
        };
        match self
            .promote_session(generation, cancellation, candidate)
            .await
        {
            Ok(snapshot) => {
                self.take_attempt(generation, attempt_id, false).await;
                self.clear_owner_signal(attempt_id);
                Ok(snapshot)
            }
            Err(error) => {
                if self.is_current(generation)
                    && self.snapshot().await.state_name() != "secure-store-unavailable"
                {
                    self.finish_attempt_with_error(generation, attempt_id, &error)
                        .await;
                }
                Err(error)
            }
        }
    }

    pub(crate) async fn heartbeat(
        &self,
        attempt_id: &str,
        owner_lease_id: &str,
    ) -> Result<AccountSnapshot, QQMusicError> {
        let mut active = self.active_attempt.lock().await;
        let Some(current) = active.as_mut().filter(|current| {
            current.attempt_id == attempt_id
                && current.owner_lease_id == owner_lease_id
                && self.is_current(current.generation)
                && !current.cancellation.is_cancelled()
        }) else {
            return Err(QQMusicError::Cancelled);
        };
        current.owner_deadline = Instant::now() + Duration::from_millis(OWNER_LEASE_MS);
        drop(active);
        Ok(self.snapshot().await)
    }

    pub(crate) async fn is_oauth_attempt(&self, attempt_id: &str) -> bool {
        self.active_attempt
            .lock()
            .await
            .as_ref()
            .is_some_and(|attempt| {
                attempt.attempt_id == attempt_id
                    && attempt.oauth.is_some()
                    && self.is_current(attempt.generation)
                    && !attempt.cancellation.is_cancelled()
            })
    }

    pub(crate) async fn cancel(&self, attempt_id: &str) -> Result<AccountSnapshot, QQMusicError> {
        let mut active = self.active_attempt.lock().await;
        let Some(current) = active.as_ref().filter(|current| {
            current.attempt_id == attempt_id && self.is_current(current.generation)
        }) else {
            return Err(QQMusicError::Cancelled);
        };
        let cancelled_attempt = current.attempt_id.clone();
        current.cancellation.cancel();
        active.take();
        drop(active);
        self.clear_owner_signal(&cancelled_attempt);
        let (generation, _) = self.begin_generation().await;
        self.publish_if_current(
            generation,
            AccountState::Cancelled {
                attempt_id: Some(cancelled_attempt),
                profile: (),
                entitlement: (),
            },
        )
        .await;
        Ok(self.snapshot().await)
    }

    pub(crate) fn has_active_owner(&self) -> bool {
        let generation = self.generation.load(Ordering::Acquire);
        self.owner_signal
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .is_some_and(|owner| {
                owner.generation == generation && !owner.cancellation.is_cancelled()
            })
    }

    pub(crate) fn cancel_login_owner(self: &Arc<Self>, reason: &'static str) -> bool {
        let (owner, generation) = {
            let mut generation_token = self
                .generation_token
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let current_generation = self.generation.load(Ordering::Acquire);
            let mut owner_signal = self
                .owner_signal
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(owner) = owner_signal.take() else {
                return false;
            };
            owner.cancellation.cancel();
            if owner.generation != current_generation {
                return false;
            }
            let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
            generation_token.cancel();
            *generation_token = CancellationToken::new();
            (owner, generation)
        };

        tracing::info!(target: "qqmusic.auth", reason, "login owner was released");
        let service = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            service
                .cleanup_owner_loss(generation, owner.attempt_id)
                .await;
        });
        true
    }

    pub(crate) async fn refresh(
        self: &Arc<Self>,
        attempt_id: Option<&str>,
    ) -> Result<AccountSnapshot, QQMusicError> {
        let active_attempt_id = self
            .active_attempt
            .lock()
            .await
            .as_ref()
            .map(|attempt| attempt.attempt_id.clone());
        match (attempt_id, active_attempt_id.as_deref()) {
            (Some(expected), Some(active)) if expected == active => {
                self.cancel(expected).await?;
            }
            (Some(expected), None)
                if self
                    .snapshot()
                    .await
                    .attempt_id()
                    .is_some_and(|id| id == expected) => {}
            (None, None) => {}
            _ => return Err(QQMusicError::Cancelled),
        }
        self.start().await
    }

    pub(crate) async fn complete_confirmation(
        &self,
        session: SessionRecord,
    ) -> Result<AccountSnapshot, QQMusicError> {
        let (generation, cancellation) = self.capture_generation();
        self.promote_session(generation, cancellation, session)
            .await
    }

    pub(crate) async fn restore(&self) -> Result<AccountSnapshot, QQMusicError> {
        let (generation, cancellation) = self.capture_generation();
        let _lifecycle = self.lifecycle.lock().await;
        self.ensure_generation_current(generation)?;
        if !self
            .publish_if_current(
                generation,
                AccountState::RestoringSession {
                    profile: (),
                    entitlement: (),
                },
            )
            .await
        {
            return Err(QQMusicError::Cancelled);
        }
        let raw = match self.credentials.load(ACTIVE_SESSION).await {
            Ok(raw) => raw,
            Err(_) => {
                self.ensure_generation_current(generation)?;
                self.publish_secure_store_unavailable_if_current(generation)
                    .await;
                return Err(QQMusicError::Storage);
            }
        };
        self.hit_lifecycle_boundary(LifecycleBoundary::RestoreActiveLoaded)
            .await;
        self.ensure_generation_current(generation)?;
        let Some(raw) = raw else {
            *self.active_session.write().await = None;
            self.playback_epoch.replace(None);
            self.publish_if_current(generation, guest_state()).await;
            return Ok(self.snapshot().await);
        };
        let session: SessionRecord = match serde_json::from_str(&raw) {
            Ok(session) => session,
            Err(_) => {
                *self.active_session.write().await = None;
                self.playback_epoch.replace(None);
                self.publish_if_current(
                    generation,
                    AccountState::ReauthenticationRequired {
                        profile: None,
                        entitlement: None,
                    },
                )
                .await;
                return Err(QQMusicError::AuthenticationExpired);
            }
        };
        if session.expires_at_ms <= self.clock.now_ms() {
            *self.active_session.write().await = None;
            self.playback_epoch.replace(None);
            self.publish_if_current(
                generation,
                AccountState::ReauthenticationRequired {
                    profile: None,
                    entitlement: None,
                },
            )
            .await;
            return Err(QQMusicError::AuthenticationExpired);
        }
        let validated = match self.protocol.validate_session(&session, cancellation).await {
            Ok(validated) => validated,
            Err(error) => {
                tracing::warn!(
                    error_code = error.code(),
                    "QQ Music secure session restore validation failed"
                );
                self.ensure_generation_current(generation)?;
                *self.active_session.write().await = None;
                self.playback_epoch.replace(None);
                let state = restore_error_state(&error);
                self.publish_if_current(generation, state).await;
                return Err(error);
            }
        };
        self.hit_lifecycle_boundary(LifecycleBoundary::RestoreValidated)
            .await;
        self.ensure_generation_current(generation)?;
        self.hit_lifecycle_boundary(LifecycleBoundary::RestoreBeforePublish)
            .await;
        self.ensure_generation_current(generation)?;
        *self.active_session.write().await = Some(session);
        let epoch = self
            .active_session
            .read()
            .await
            .as_ref()
            .map(|session| AccountEpoch {
                generation,
                scope: session.account_cache_scope.clone(),
            });
        self.playback_epoch.replace(epoch);
        if !self
            .publish_authenticated_if_current(generation, validated)
            .await
        {
            *self.active_session.write().await = None;
            self.playback_epoch.replace(None);
            return Err(QQMusicError::Cancelled);
        }
        Ok(self.snapshot().await)
    }

    pub(crate) async fn logout(&self) -> Result<AccountSnapshot, QQMusicError> {
        let (generation, _) = self.begin_generation().await;
        {
            let mut active = self.active_attempt.lock().await;
            if active
                .as_ref()
                .is_some_and(|attempt| attempt.generation < generation)
            {
                if let Some(attempt) = active.take() {
                    attempt.cancellation.cancel();
                }
            }
        }
        self.cancel_owner_signals_before(generation);
        let _lifecycle = self.lifecycle.lock().await;
        let staging = self.credentials.delete(STAGING_SESSION).await;
        let active = self.credentials.delete(ACTIVE_SESSION).await;
        let account_cache = self.storage.delete_provider_cache_kind(ACCOUNT_CACHE_KIND);
        *self.active_session.write().await = None;
        self.playback_epoch.replace(None);
        if staging.is_err() || active.is_err() {
            self.publish_secure_store_unavailable_if_current(generation)
                .await;
            return Err(QQMusicError::Storage);
        }
        if !self.publish_if_current(generation, guest_state()).await {
            return Err(QQMusicError::Cancelled);
        }
        if account_cache.is_err() {
            return Err(QQMusicError::Storage);
        }
        Ok(self.snapshot().await)
    }

    async fn poll_loop(self: Arc<Self>, generation: u64, attempt_id: String) {
        loop {
            let Some((challenge, cancellation, owner_deadline, expires_at_ms, poll_after_ms)) =
                self.poll_context(generation, &attempt_id).await
            else {
                return;
            };
            if self.clock.now_ms() >= expires_at_ms {
                self.finish_attempt(
                    generation,
                    &attempt_id,
                    AccountState::Expired {
                        attempt_id: Some(attempt_id.clone()),
                        profile: (),
                        entitlement: (),
                    },
                )
                .await;
                return;
            }
            let poll = self
                .protocol
                .poll_challenge(&challenge, cancellation.clone());
            let result = tokio::select! {
                biased;
                _ = cancellation.cancelled() => return,
                _ = tokio::time::sleep_until(owner_deadline) => {
                    if self.expire_owner_if_due(generation, &attempt_id).await {
                        return;
                    }
                    continue;
                }
                result = poll => result,
            };
            if !self.is_current(generation) || cancellation.is_cancelled() {
                return;
            }
            match result {
                Ok(AuthPollResult::WaitingForScan) => {
                    self.publish_waiting(generation, &attempt_id, false).await;
                }
                Ok(AuthPollResult::WaitingForConfirmation) => {
                    self.publish_waiting(generation, &attempt_id, true).await;
                }
                Ok(AuthPollResult::Expired) => {
                    self.finish_attempt(
                        generation,
                        &attempt_id,
                        AccountState::Expired {
                            attempt_id: Some(attempt_id.clone()),
                            profile: (),
                            entitlement: (),
                        },
                    )
                    .await;
                    return;
                }
                Ok(AuthPollResult::Rejected) => {
                    self.finish_attempt(
                        generation,
                        &attempt_id,
                        AccountState::Rejected {
                            attempt_id: Some(attempt_id.clone()),
                            profile: (),
                            entitlement: (),
                        },
                    )
                    .await;
                    return;
                }
                Ok(AuthPollResult::Confirmed(session)) => {
                    if !self.take_attempt(generation, &attempt_id, false).await {
                        return;
                    }
                    let promotion = self
                        .promote_session(generation, cancellation.clone(), session)
                        .await;
                    self.clear_owner_signal(&attempt_id);
                    if let Err(error) = promotion {
                        if self.is_current(generation)
                            && self.snapshot().await.state_name() != "secure-store-unavailable"
                        {
                            self.publish_if_current(generation, error_state(&attempt_id, &error))
                                .await;
                        }
                    }
                    return;
                }
                Err(error) => {
                    self.finish_attempt_with_error(generation, &attempt_id, &error)
                        .await;
                    return;
                }
            }

            let Some((_, cancellation, owner_deadline, _, _)) =
                self.poll_context(generation, &attempt_id).await
            else {
                return;
            };
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => return,
                _ = tokio::time::sleep_until(owner_deadline) => {
                    if self.expire_owner_if_due(generation, &attempt_id).await {
                        return;
                    }
                }
                _ = tokio::time::sleep(Duration::from_millis(poll_after_ms)) => {}
            }
        }
    }

    async fn oauth_owner_loop(self: Arc<Self>, generation: u64, attempt_id: String) {
        loop {
            let Some((cancellation, owner_deadline, attempt_deadline)) =
                self.oauth_context(generation, &attempt_id).await
            else {
                return;
            };
            let deadline = owner_deadline.min(attempt_deadline);
            tokio::select! {
                _ = cancellation.cancelled() => return,
                _ = tokio::time::sleep_until(deadline) => {}
            }
            if Instant::now() >= attempt_deadline {
                self.finish_attempt(
                    generation,
                    &attempt_id,
                    AccountState::Expired {
                        attempt_id: Some(attempt_id.clone()),
                        profile: (),
                        entitlement: (),
                    },
                )
                .await;
                return;
            }
            if self.expire_owner_if_due(generation, &attempt_id).await {
                return;
            }
        }
    }

    async fn promote_session(
        &self,
        generation: u64,
        cancellation: CancellationToken,
        candidate: SessionRecord,
    ) -> Result<AccountSnapshot, QQMusicError> {
        let _candidate_validation = self
            .protocol
            .validate_session(&candidate, cancellation.clone())
            .await?;
        self.hit_lifecycle_boundary(LifecycleBoundary::CandidateValidated)
            .await;
        self.ensure_generation_current(generation)?;
        let _lifecycle = self.lifecycle.lock().await;
        self.ensure_generation_current(generation)?;

        let prior = match self.credentials.load(ACTIVE_SESSION).await {
            Ok(prior) => prior,
            Err(_) => {
                self.publish_secure_store_unavailable_if_current(generation)
                    .await;
                return Err(QQMusicError::Storage);
            }
        };
        self.ensure_generation_current(generation)?;
        let serialized = serde_json::to_string(&candidate).map_err(|_| QQMusicError::Protocol)?;

        self.hit_lifecycle_boundary(LifecycleBoundary::BeforeStagingSave)
            .await;
        self.ensure_generation_current(generation)?;

        if self
            .credentials
            .save(STAGING_SESSION, &serialized)
            .await
            .is_err()
        {
            return self
                .fail_before_active(generation, QQMusicError::Storage)
                .await;
        }
        self.hit_lifecycle_boundary(LifecycleBoundary::AfterStagingSave)
            .await;
        if let Err(error) = self.ensure_generation_current(generation) {
            return self.fail_before_active(generation, error).await;
        }
        let staged_raw = match self.credentials.load(STAGING_SESSION).await {
            Ok(Some(raw)) if constant_time_equivalent(&raw, &serialized) => raw,
            _ => {
                return self
                    .fail_before_active(generation, QQMusicError::Storage)
                    .await;
            }
        };
        self.hit_lifecycle_boundary(LifecycleBoundary::AfterStagingReadback)
            .await;
        if let Err(error) = self.ensure_generation_current(generation) {
            return self.fail_before_active(generation, error).await;
        }
        let staged: SessionRecord = match serde_json::from_str(&staged_raw) {
            Ok(staged) => staged,
            Err(_) => {
                return self
                    .fail_before_active(generation, QQMusicError::Storage)
                    .await;
            }
        };
        let validated = match self.protocol.validate_session(&staged, cancellation).await {
            Ok(validated) => validated,
            Err(error) => return self.fail_before_active(generation, error).await,
        };
        self.hit_lifecycle_boundary(LifecycleBoundary::AfterStagedValidation)
            .await;
        if let Err(error) = self.ensure_generation_current(generation) {
            return self.fail_before_active(generation, error).await;
        }

        self.hit_lifecycle_boundary(LifecycleBoundary::BeforeActiveSave)
            .await;
        if let Err(error) = self.ensure_generation_current(generation) {
            return self.fail_before_active(generation, error).await;
        }

        if self
            .credentials
            .save(ACTIVE_SESSION, &serialized)
            .await
            .is_err()
        {
            return self
                .rollback_after_active(generation, prior.as_deref(), QQMusicError::Storage)
                .await;
        }
        self.hit_lifecycle_boundary(LifecycleBoundary::AfterActiveSave)
            .await;
        if let Err(error) = self.ensure_generation_current(generation) {
            return self
                .rollback_after_active(generation, prior.as_deref(), error)
                .await;
        }
        match self.credentials.load(ACTIVE_SESSION).await {
            Ok(Some(active)) if constant_time_equivalent(&active, &serialized) => {}
            _ => {
                return self
                    .rollback_after_active(generation, prior.as_deref(), QQMusicError::Storage)
                    .await;
            }
        }
        self.hit_lifecycle_boundary(LifecycleBoundary::AfterActiveReadback)
            .await;
        if let Err(error) = self.ensure_generation_current(generation) {
            return self
                .rollback_after_active(generation, prior.as_deref(), error)
                .await;
        }
        if self.credentials.delete(STAGING_SESSION).await.is_err() {
            return self
                .rollback_after_active(generation, prior.as_deref(), QQMusicError::Storage)
                .await;
        }
        self.hit_lifecycle_boundary(LifecycleBoundary::AfterStagingDelete)
            .await;
        if let Err(error) = self.ensure_generation_current(generation) {
            return self
                .rollback_after_active(generation, prior.as_deref(), error)
                .await;
        }
        if self
            .storage
            .delete_provider_cache_kind(ACCOUNT_CACHE_KIND)
            .is_err()
        {
            return self
                .rollback_after_active(generation, prior.as_deref(), QQMusicError::Storage)
                .await;
        }
        if let Err(error) = self.ensure_generation_current(generation) {
            return self
                .rollback_after_active(generation, prior.as_deref(), error)
                .await;
        }

        self.hit_lifecycle_boundary(LifecycleBoundary::BeforePublish)
            .await;
        if let Err(error) = self.ensure_generation_current(generation) {
            return self
                .rollback_after_active(generation, prior.as_deref(), error)
                .await;
        }

        *self.active_session.write().await = Some(candidate);
        let epoch = self
            .active_session
            .read()
            .await
            .as_ref()
            .map(|session| AccountEpoch {
                generation,
                scope: session.account_cache_scope.clone(),
            });
        self.playback_epoch.replace(epoch);
        if !self
            .publish_authenticated_if_current(generation, validated)
            .await
        {
            *self.active_session.write().await = None;
            self.playback_epoch.replace(None);
            return self
                .rollback_after_active(generation, prior.as_deref(), QQMusicError::Cancelled)
                .await;
        }
        Ok(self.snapshot().await)
    }

    async fn fail_before_active<T>(
        &self,
        generation: u64,
        error: QQMusicError,
    ) -> Result<T, QQMusicError> {
        if self.credentials.delete(STAGING_SESSION).await.is_err() {
            self.publish_secure_store_unavailable_if_current(generation)
                .await;
            return Err(QQMusicError::Storage);
        }
        Err(error)
    }

    async fn rollback_after_active<T>(
        &self,
        generation: u64,
        prior: Option<&str>,
        error: QQMusicError,
    ) -> Result<T, QQMusicError> {
        let restore = if let Some(prior) = prior {
            self.credentials.save(ACTIVE_SESSION, prior).await
        } else {
            self.credentials.delete(ACTIVE_SESSION).await
        };
        let active = self.credentials.load(ACTIVE_SESSION).await;
        let restored = match (prior, active) {
            (Some(expected), Ok(Some(actual))) => constant_time_equivalent(expected, &actual),
            (None, Ok(None)) => true,
            _ => false,
        };
        let staging = self.credentials.delete(STAGING_SESSION).await;
        if restore.is_err() || !restored || staging.is_err() {
            self.publish_secure_store_unavailable_if_current(generation)
                .await;
            return Err(QQMusicError::Storage);
        }
        Err(error)
    }

    async fn poll_context(
        &self,
        generation: u64,
        attempt_id: &str,
    ) -> Option<(AuthChallenge, CancellationToken, Instant, u64, u64)> {
        let active = self.active_attempt.lock().await;
        let current = active.as_ref().filter(|current| {
            current.generation == generation
                && current.attempt_id == attempt_id
                && self.is_current(generation)
        })?;
        Some((
            current.challenge.as_ref()?.poll_copy(),
            current.cancellation.clone(),
            current.owner_deadline,
            current.expires_at_ms,
            current.poll_after_ms,
        ))
    }

    async fn oauth_context(
        &self,
        generation: u64,
        attempt_id: &str,
    ) -> Option<(CancellationToken, Instant, Instant)> {
        let active = self.active_attempt.lock().await;
        let current = active.as_ref().filter(|current| {
            current.generation == generation
                && current.attempt_id == attempt_id
                && self.is_current(generation)
        })?;
        let oauth = current.oauth.as_ref()?;
        Some((
            current.cancellation.clone(),
            current.owner_deadline,
            oauth.deadline,
        ))
    }

    async fn publish_waiting(&self, generation: u64, attempt_id: &str, scanned: bool) {
        let mut active = self.active_attempt.lock().await;
        let Some(current) = active.as_mut().filter(|current| {
            current.generation == generation
                && current.attempt_id == attempt_id
                && self.is_current(generation)
        }) else {
            return;
        };
        let state = if scanned {
            if let Some(challenge) = current.challenge.as_mut() {
                challenge.qr_bytes.clear();
                challenge.qr_bytes.shrink_to_fit();
            }
            AccountState::WaitingForConfirmation {
                attempt_id: current.attempt_id.clone(),
                owner_lease_id: current.owner_lease_id.clone(),
                expires_at_ms: current.expires_at_ms,
                poll_after_ms: current.poll_after_ms,
                profile: (),
                entitlement: (),
            }
        } else {
            let Some(challenge) = current.challenge.as_ref() else {
                return;
            };
            if challenge.qr_bytes.is_empty() {
                return;
            }
            AccountState::WaitingForScan {
                attempt_id: current.attempt_id.clone(),
                owner_lease_id: current.owner_lease_id.clone(),
                qr_image_data_uri: format!(
                    "data:{};base64,{}",
                    challenge.mime_type,
                    BASE64.encode(&challenge.qr_bytes)
                ),
                expires_at_ms: current.expires_at_ms,
                poll_after_ms: current.poll_after_ms,
                profile: (),
                entitlement: (),
            }
        };
        drop(active);
        self.publish_if_current(generation, state).await;
    }

    async fn expire_owner_if_due(self: &Arc<Self>, generation: u64, attempt_id: &str) -> bool {
        let active = self.active_attempt.lock().await;
        let Some(current) = active
            .as_ref()
            .filter(|current| current.generation == generation && current.attempt_id == attempt_id)
        else {
            return true;
        };
        if Instant::now() < current.owner_deadline {
            return false;
        }
        drop(active);
        self.cancel_login_owner("owner-lease-expired") || !self.is_current(generation)
    }

    async fn take_attempt(&self, generation: u64, attempt_id: &str, cancel: bool) -> bool {
        let mut active = self.active_attempt.lock().await;
        let matches = active.as_ref().is_some_and(|current| {
            current.generation == generation && current.attempt_id == attempt_id
        });
        if !matches {
            return false;
        }
        let removed = active.take();
        if let Some(current) = removed.as_ref().filter(|_| cancel) {
            current.cancellation.cancel();
        }
        drop(active);
        if cancel {
            self.clear_owner_signal(attempt_id);
        }
        true
    }

    async fn finish_attempt(&self, generation: u64, attempt_id: &str, state: AccountState) {
        if self.take_attempt(generation, attempt_id, true).await {
            self.publish_if_current(generation, state).await;
        }
    }

    async fn finish_attempt_with_error(
        &self,
        generation: u64,
        attempt_id: &str,
        error: &QQMusicError,
    ) {
        self.finish_attempt(generation, attempt_id, error_state(attempt_id, error))
            .await;
    }

    async fn begin_generation(&self) -> (u64, CancellationToken) {
        let _state_order = self.snapshot.write().await;
        self.advance_generation()
    }

    fn advance_generation(&self) -> (u64, CancellationToken) {
        let mut token = self
            .generation_token
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        token.cancel();
        self.playback_epoch.replace(None);
        *token = CancellationToken::new();
        (generation, token.clone())
    }

    fn install_owner_signal(&self, signal: OwnerSignal) {
        let mut current = self
            .owner_signal
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(previous) = current.replace(signal) {
            previous.cancellation.cancel();
        }
    }

    fn clear_owner_signal(&self, attempt_id: &str) {
        let mut current = self
            .owner_signal
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if current
            .as_ref()
            .is_some_and(|owner| owner.attempt_id == attempt_id)
        {
            current.take();
        }
    }

    fn cancel_owner_signals_before(&self, generation: u64) {
        let mut current = self
            .owner_signal
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if current
            .as_ref()
            .is_some_and(|owner| owner.generation < generation)
        {
            if let Some(owner) = current.take() {
                owner.cancellation.cancel();
            }
        }
    }

    fn release_owner_signal_for_generation(&self, generation: u64) {
        let mut current = self
            .owner_signal
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if current
            .as_ref()
            .is_some_and(|owner| owner.generation == generation)
        {
            current.take();
        }
    }

    async fn cleanup_owner_loss(&self, generation: u64, attempt_id: String) {
        let _lifecycle = self.lifecycle.lock().await;
        let mut active = self.active_attempt.lock().await;
        if active.as_ref().is_some_and(|attempt| {
            attempt.attempt_id == attempt_id && attempt.generation < generation
        }) {
            if let Some(attempt) = active.take() {
                attempt.cancellation.cancel();
            }
        }
        drop(active);
        self.publish_if_current(
            generation,
            AccountState::Cancelled {
                attempt_id: Some(attempt_id),
                profile: (),
                entitlement: (),
            },
        )
        .await;
    }

    fn capture_generation(&self) -> (u64, CancellationToken) {
        let token = self
            .generation_token
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        (self.generation.load(Ordering::Acquire), token.clone())
    }

    fn is_current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::Acquire) == generation
    }

    fn ensure_generation_current(&self, generation: u64) -> Result<(), QQMusicError> {
        if self.is_current(generation) {
            Ok(())
        } else {
            Err(QQMusicError::Cancelled)
        }
    }

    async fn publish_if_current(&self, generation: u64, account: AccountState) -> bool {
        let mut snapshot = self.snapshot.write().await;
        let _generation_commit = self
            .generation_token
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !self.is_current(generation) {
            return false;
        }
        Self::write_account(&mut snapshot, account);
        true
    }

    fn write_account(snapshot: &mut AccountSnapshot, account: AccountState) {
        snapshot.revision = snapshot.revision.saturating_add(1);
        snapshot.capabilities = capabilities_for(&account);
        snapshot.account = account;
    }

    async fn publish_authenticated_if_current(
        &self,
        generation: u64,
        validated: ValidatedAccount,
    ) -> bool {
        let mut snapshot = self.snapshot.write().await;
        let _generation_commit = self
            .generation_token
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !self.is_current(generation) {
            return false;
        }
        self.release_owner_signal_for_generation(generation);
        Self::write_account(
            &mut snapshot,
            AccountState::Authenticated {
                profile: validated.profile,
                entitlement: validated.entitlement,
            },
        );
        true
    }

    async fn publish_secure_store_unavailable_if_current(&self, generation: u64) -> bool {
        let mut snapshot = self.snapshot.write().await;
        let _generation_commit = self
            .generation_token
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !self.is_current(generation) {
            return false;
        }
        let (profile, entitlement) = match &snapshot.account {
            AccountState::Authenticated {
                profile,
                entitlement,
            }
            | AccountState::SessionExpired {
                profile: Some(profile),
                entitlement: Some(entitlement),
            }
            | AccountState::ReauthenticationRequired {
                profile: Some(profile),
                entitlement: Some(entitlement),
            }
            | AccountState::SecureStoreUnavailable {
                profile: Some(profile),
                entitlement: Some(entitlement),
            } => (Some(profile.clone()), Some(entitlement.clone())),
            _ => (None, None),
        };
        Self::write_account(
            &mut snapshot,
            AccountState::SecureStoreUnavailable {
                profile,
                entitlement,
            },
        );
        true
    }

    async fn hit_lifecycle_boundary(&self, boundary: LifecycleBoundary) {
        #[cfg(test)]
        {
            let barrier = self
                .lifecycle_barrier
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .as_ref()
                .filter(|barrier| barrier.boundary == boundary)
                .cloned();
            if let Some(barrier) = barrier {
                barrier.entered.notify_one();
                barrier.release.notified().await;
            }
        }
        #[cfg(not(test))]
        let _ = boundary;
    }

    #[cfg(test)]
    fn set_lifecycle_barrier(&self, boundary: LifecycleBoundary) -> Arc<LifecycleBarrier> {
        let barrier = Arc::new(LifecycleBarrier {
            boundary,
            entered: Notify::new(),
            release: Notify::new(),
        });
        *self
            .lifecycle_barrier
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::clone(&barrier));
        barrier
    }

    #[cfg(test)]
    async fn challenge_bytes_for_test(&self) -> Option<Vec<u8>> {
        self.active_attempt
            .lock()
            .await
            .as_ref()
            .and_then(|attempt| attempt.challenge.as_ref())
            .map(|challenge| challenge.qr_bytes.clone())
    }

    #[cfg(test)]
    async fn poll_task_is_cancelled(&self) -> bool {
        self.active_attempt
            .lock()
            .await
            .as_ref()
            .is_none_or(|attempt| attempt.cancellation.is_cancelled())
    }
}

fn validate_challenge(challenge: &AuthChallenge) -> Result<(), QQMusicError> {
    if challenge.qr_bytes.is_empty()
        || challenge.qr_bytes.len() > MAX_QR_BYTES
        || normalize_image_mime(&challenge.mime_type).is_none()
        || challenge.poll_secret.is_empty()
    {
        Err(QQMusicError::MalformedResponse)
    } else {
        Ok(())
    }
}

fn guest_state() -> AccountState {
    AccountState::Guest {
        profile: (),
        entitlement: (),
    }
}

fn guest_capabilities() -> AccountCapabilities {
    AccountCapabilities {
        qr_login: true,
        favorite_read: false,
        favorite_write: false,
        playlist_read: false,
        playlist_write: false,
        recent_history_read: false,
    }
}

fn capabilities_for(state: &AccountState) -> AccountCapabilities {
    if matches!(state, AccountState::Authenticated { .. }) {
        AccountCapabilities {
            qr_login: true,
            favorite_read: true,
            favorite_write: true,
            playlist_read: true,
            playlist_write: true,
            recent_history_read: true,
        }
    } else {
        guest_capabilities()
    }
}

fn error_state(attempt_id: &str, error: &QQMusicError) -> AccountState {
    let attempt_id = Some(attempt_id.to_owned());
    match error {
        QQMusicError::Cancelled => AccountState::Cancelled {
            attempt_id,
            profile: (),
            entitlement: (),
        },
        QQMusicError::Offline | QQMusicError::Timeout | QQMusicError::RateLimited => {
            AccountState::NetworkError {
                attempt_id,
                profile: (),
                entitlement: (),
            }
        }
        QQMusicError::AuthorizationRejected | QQMusicError::AuthenticationExpired => {
            AccountState::Rejected {
                attempt_id,
                profile: (),
                entitlement: (),
            }
        }
        _ => AccountState::ProtocolError {
            attempt_id,
            profile: (),
            entitlement: (),
        },
    }
}

fn restore_error_state(error: &QQMusicError) -> AccountState {
    match error {
        QQMusicError::Offline | QQMusicError::Timeout | QQMusicError::RateLimited => {
            AccountState::NetworkError {
                attempt_id: None,
                profile: (),
                entitlement: (),
            }
        }
        QQMusicError::AuthenticationExpired | QQMusicError::AuthorizationRejected => {
            AccountState::ReauthenticationRequired {
                profile: None,
                entitlement: None,
            }
        }
        _ => AccountState::ProtocolError {
            attempt_id: None,
            profile: (),
            entitlement: (),
        },
    }
}

pub(super) fn constant_time_equivalent(left: &str, right: &str) -> bool {
    left.len() == right.len() && bool::from(left.as_bytes().ct_eq(right.as_bytes()))
}

fn random_opaque_id() -> String {
    format!("{:032x}", rand::random::<u128>())
}

fn mask_identity(value: &str) -> String {
    let characters = value.chars().collect::<Vec<_>>();
    if characters.len() <= 4 {
        return "*".repeat(characters.len().max(4));
    }
    format!(
        "{}{}{}",
        characters[..2].iter().collect::<String>(),
        "*".repeat(characters.len() - 4),
        characters[characters.len() - 2..]
            .iter()
            .collect::<String>()
    )
}

fn normalize_image_mime(value: &str) -> Option<&'static str> {
    match value
        .split(';')
        .next()?
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "image/png" => Some("image/png"),
        "image/jpeg" => Some("image/jpeg"),
        _ => None,
    }
}

fn is_sanitized_avatar_url(value: &str) -> bool {
    Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.port_or_known_default() == Some(443)
            && matches!(
                url.host_str(),
                Some("qpic.y.qq.com" | "q.qlogo.cn" | "thirdwx.qlogo.cn" | "thirdqq.qlogo.cn")
            )
            && url.username().is_empty()
            && url.password().is_none()
    })
}

fn require_endpoint(url: &Url, host: &str, path: &str) -> Result<(), QQMusicError> {
    if url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.host_str() == Some(host)
        && url.path() == path
        && url.username().is_empty()
        && url.password().is_none()
    {
        Ok(())
    } else {
        Err(QQMusicError::Protocol)
    }
}

fn require_success(response: &TransportResponse) -> Result<(), QQMusicError> {
    if response.status.is_success() {
        Ok(())
    } else {
        Err(QQMusicError::Protocol)
    }
}

fn require_redirect(response: &TransportResponse) -> Result<(), QQMusicError> {
    if matches!(
        response.status,
        StatusCode::MOVED_PERMANENTLY
            | StatusCode::FOUND
            | StatusCode::SEE_OTHER
            | StatusCode::TEMPORARY_REDIRECT
            | StatusCode::PERMANENT_REDIRECT
    ) && response.headers.contains_key(header::LOCATION)
    {
        Ok(())
    } else {
        Err(QQMusicError::Protocol)
    }
}

fn referer_headers(referer: &str) -> Result<HeaderMap, QQMusicError> {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::REFERER,
        HeaderValue::from_str(referer).map_err(|_| QQMusicError::Protocol)?,
    );
    Ok(headers)
}

fn authenticated_headers(
    cookies: &SecretCookieJar,
    referer: Option<&str>,
) -> Result<HeaderMap, QQMusicError> {
    let mut headers = match referer {
        Some(referer) => referer_headers(referer)?,
        None => HeaderMap::new(),
    };
    headers.insert(
        header::COOKIE,
        HeaderValue::from_str(&cookies.header_value()).map_err(|_| QQMusicError::Protocol)?,
    );
    Ok(headers)
}

#[derive(Default)]
struct SecretCookieJar {
    values: BTreeMap<String, String>,
}

impl SecretCookieJar {
    fn insert(&mut self, name: &str, value: &str) -> Result<(), QQMusicError> {
        if name.is_empty()
            || value.is_empty()
            || name
                .bytes()
                .any(|byte| !byte.is_ascii_alphanumeric() && byte != b'_' && byte != b'-')
            || value
                .bytes()
                .any(|byte| byte.is_ascii_control() || matches!(byte, b';' | b'\r' | b'\n'))
        {
            return Err(QQMusicError::Protocol);
        }
        self.values.insert(name.to_owned(), value.to_owned());
        Ok(())
    }

    fn get(&self, name: &str) -> Option<&str> {
        self.values.get(name).map(String::as_str)
    }

    fn remove(&mut self, name: &str) {
        self.values.remove(name);
    }

    fn absorb_set_cookie(&mut self, headers: &HeaderMap) -> Result<(), QQMusicError> {
        for value in headers.get_all(header::SET_COOKIE) {
            let value = value.to_str().map_err(|_| QQMusicError::Protocol)?;
            let pair = value.split(';').next().ok_or(QQMusicError::Protocol)?;
            let (name, value) = pair.split_once('=').ok_or(QQMusicError::Protocol)?;
            if !value.is_empty() {
                self.insert(name.trim(), value.trim())?;
            }
        }
        Ok(())
    }

    fn header_value(&self) -> String {
        self.values
            .iter()
            .map(|(name, value)| format!("{name}={value}"))
            .collect::<Vec<_>>()
            .join("; ")
    }
}

fn form_body(pairs: &[(&str, String)]) -> Result<Vec<u8>, QQMusicError> {
    let mut url = Url::parse("https://yaqmc.invalid/").map_err(|_| QQMusicError::Protocol)?;
    {
        let mut query = url.query_pairs_mut();
        for (key, value) in pairs {
            query.append_pair(key, value);
        }
    }
    Ok(url.query().unwrap_or_default().as_bytes().to_vec())
}

fn hash33(value: &str, seed: u32) -> u32 {
    value.bytes().fold(seed, |hash, byte| {
        hash.wrapping_add(hash.wrapping_shl(5))
            .wrapping_add(u32::from(byte))
    }) & 0x7fff_ffff
}

fn parse_ptui_callback(value: &str) -> Result<Vec<String>, QQMusicError> {
    let start = value
        .find("ptuiCB(")
        .ok_or(QQMusicError::MalformedResponse)?
        + 7;
    let end = value[start..]
        .find(')')
        .map(|offset| start + offset)
        .ok_or(QQMusicError::MalformedResponse)?;
    let mut arguments = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut escaped = false;
    for character in value[start..end].chars() {
        if escaped {
            current.push(character);
            escaped = false;
        } else if character == '\\' && quoted {
            escaped = true;
        } else if character == '\'' {
            if quoted {
                arguments.push(std::mem::take(&mut current));
            }
            quoted = !quoted;
        } else if quoted {
            current.push(character);
        }
    }
    if quoted || escaped || arguments.is_empty() {
        Err(QQMusicError::MalformedResponse)
    } else {
        Ok(arguments)
    }
}

fn json_code(value: &Value) -> Option<i64> {
    value
        .get("code")
        .and_then(|value| value.as_i64().or_else(|| value.as_str()?.parse().ok()))
}

fn first_string(value: &Value, paths: &[&str]) -> Option<String> {
    paths.iter().find_map(|path| {
        let value = value.pointer(path)?;
        value
            .as_str()
            .map(ToOwned::to_owned)
            .or_else(|| value.as_u64().map(|value| value.to_string()))
    })
}

fn numeric_u64(value: &Value, paths: &[&str]) -> Option<u64> {
    paths.iter().find_map(|path| {
        let value = value.pointer(path)?;
        value
            .as_u64()
            .or_else(|| value.as_str()?.parse::<u64>().ok())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        credentials::{CredentialError, CredentialStore},
        media::{PlaybackEpochGuard, PlaybackSourceError},
        qqmusic::{clock::ManualClock, transport::TransportResponse},
        storage::StorageService,
    };
    use std::{
        collections::{BTreeMap, VecDeque},
        sync::{
            atomic::{AtomicBool, AtomicUsize},
            Mutex as StdMutex,
        },
    };
    use tokio::sync::Notify;

    fn session(label: &str) -> SessionRecord {
        let scope_seed = label.bytes().fold(0_u128, |value, byte| {
            value.wrapping_mul(257).wrapping_add(byte as u128)
        });
        SessionRecord {
            version: SESSION_VERSION,
            uin: "1000000001".to_owned(),
            cookie_header: format!("synthetic_session={label}"),
            expires_at_ms: 1_800_000_000_000,
            account_cache_scope: OpaqueAccountScope::parse(format!("{scope_seed:032x}"))
                .expect("valid synthetic scope"),
        }
    }

    fn validated_account() -> ValidatedAccount {
        ValidatedAccount {
            profile: AccountProfile {
                avatar_url: Some("https://qpic.y.qq.com/synthetic-avatar.png".to_owned()),
                nickname: "Synthetic Listener".to_owned(),
                masked_identity: "10******01".to_owned(),
            },
            entitlement: AccountEntitlement {
                tier: EntitlementTier::Unknown,
                membership: MembershipState::Unknown,
                expires_at_ms: None,
                permitted_qualities: vec![AudioQuality::Standard],
                observed_maximum_quality: None,
                restrictions: Vec::new(),
            },
        }
    }

    #[test]
    fn avatar_url_sanitizer_allows_only_exact_tencent_https_hosts() {
        for trusted in [
            "https://qpic.y.qq.com/synthetic-avatar.png",
            "https://q.qlogo.cn/synthetic-avatar.png",
            "https://thirdwx.qlogo.cn/synthetic-avatar.png",
            "https://thirdqq.qlogo.cn/synthetic-avatar.png",
        ] {
            assert!(
                is_sanitized_avatar_url(trusted),
                "expected trusted: {trusted}"
            );
        }

        for untrusted in [
            "http://thirdwx.qlogo.cn/synthetic-avatar.png",
            "https://thirdwx.qlogo.cn:444/synthetic-avatar.png",
            "https://user:pass@thirdwx.qlogo.cn/synthetic-avatar.png",
            "https://thirdwx.qlogo.cn.evil.example/synthetic-avatar.png",
            "https://qlogo.cn/synthetic-avatar.png",
        ] {
            assert!(
                !is_sanitized_avatar_url(untrusted),
                "expected untrusted: {untrusted}"
            );
        }
    }

    struct FakeProtocol {
        results: Mutex<VecDeque<AuthPollResult>>,
        validation_count: AtomicUsize,
        poll_entered: Notify,
        poll_release: Notify,
        hold_poll: AtomicBool,
        blocked_validation_call: AtomicUsize,
        validation_entered: Notify,
        validation_release: Notify,
        invalid_challenge: AtomicBool,
        validation_error: StdMutex<Option<QQMusicError>>,
        oauth_exchange: StdMutex<Option<(OAuthLoginProvider, String)>>,
    }

    impl FakeProtocol {
        fn new(results: Vec<AuthPollResult>) -> Self {
            Self {
                results: Mutex::new(results.into()),
                validation_count: AtomicUsize::new(0),
                poll_entered: Notify::new(),
                poll_release: Notify::new(),
                hold_poll: AtomicBool::new(false),
                blocked_validation_call: AtomicUsize::new(0),
                validation_entered: Notify::new(),
                validation_release: Notify::new(),
                invalid_challenge: AtomicBool::new(false),
                validation_error: StdMutex::new(None),
                oauth_exchange: StdMutex::new(None),
            }
        }

        fn hold_poll(&self) {
            self.hold_poll.store(true, Ordering::Release);
        }

        fn block_validation(&self, call: usize) {
            self.blocked_validation_call.store(call, Ordering::Release);
        }

        fn return_invalid_challenge(&self) {
            self.invalid_challenge.store(true, Ordering::Release);
        }

        fn fail_validation(&self, error: QQMusicError) {
            *self.validation_error.lock().expect("validation error lock") = Some(error);
        }
    }

    #[async_trait]
    impl QQMusicAuthProtocol for FakeProtocol {
        async fn create_challenge(
            &self,
            _cancellation: CancellationToken,
        ) -> Result<AuthChallenge, QQMusicError> {
            Ok(AuthChallenge {
                qr_bytes: if self.invalid_challenge.load(Ordering::Acquire) {
                    Vec::new()
                } else {
                    b"synthetic-image".to_vec()
                },
                mime_type: "image/png".to_owned(),
                poll_secret: "synthetic-poll-secret".to_owned(),
                expires_at_ms: 1_800_000_000_000,
            })
        }

        async fn poll_challenge(
            &self,
            _challenge: &AuthChallenge,
            _cancellation: CancellationToken,
        ) -> Result<AuthPollResult, QQMusicError> {
            if self.hold_poll.load(Ordering::Acquire) {
                self.poll_entered.notify_one();
                self.poll_release.notified().await;
            }
            match self.results.lock().await.pop_front() {
                Some(result) => Ok(result),
                None => std::future::pending().await,
            }
        }

        async fn exchange_oauth_code(
            &self,
            provider: OAuthLoginProvider,
            code: &str,
            _cancellation: CancellationToken,
        ) -> Result<SessionRecord, QQMusicError> {
            *self.oauth_exchange.lock().expect("OAuth exchange lock") =
                Some((provider, code.to_owned()));
            Ok(session("oauth"))
        }

        async fn validate_session(
            &self,
            _session: &SessionRecord,
            _cancellation: CancellationToken,
        ) -> Result<ValidatedAccount, QQMusicError> {
            let call = self.validation_count.fetch_add(1, Ordering::AcqRel) + 1;
            if self.blocked_validation_call.load(Ordering::Acquire) == call {
                self.validation_entered.notify_one();
                self.validation_release.notified().await;
            }
            if let Some(error) = self
                .validation_error
                .lock()
                .expect("validation error lock")
                .take()
            {
                return Err(error);
            }
            Ok(validated_account())
        }
    }

    #[derive(Clone, Copy)]
    enum CredentialFault {
        PartialActiveSave,
        ActiveReadback,
        StagingSave,
        StagingDelete,
        StagingDeleteAlways,
    }

    #[derive(Default)]
    struct RecordingCredentialStore {
        values: StdMutex<BTreeMap<String, String>>,
        operations: StdMutex<Vec<String>>,
        fault: StdMutex<Option<CredentialFault>>,
        active_save_seen: AtomicBool,
    }

    impl RecordingCredentialStore {
        fn with_fault(fault: CredentialFault) -> Self {
            Self {
                fault: StdMutex::new(Some(fault)),
                ..Self::default()
            }
        }

        fn operations(&self) -> Vec<String> {
            self.operations.lock().expect("operations lock").clone()
        }

        fn value(&self, account: &str) -> Option<String> {
            self.values
                .lock()
                .expect("values lock")
                .get(account)
                .cloned()
        }

        fn seed(&self, account: &str, value: String) {
            self.values
                .lock()
                .expect("values lock")
                .insert(account.to_owned(), value);
        }

        fn consume_fault(&self, expected: CredentialFault) -> bool {
            let mut fault = self.fault.lock().expect("fault lock");
            if fault.as_ref().is_some_and(|actual| {
                std::mem::discriminant(actual) == std::mem::discriminant(&expected)
            }) {
                fault.take();
                true
            } else {
                false
            }
        }
    }

    impl CredentialStore for RecordingCredentialStore {
        fn load(&self, account: &str) -> Result<Option<String>, CredentialError> {
            self.operations
                .lock()
                .expect("operations lock")
                .push(format!("load:{account}"));
            if account == ACTIVE_SESSION
                && self.active_save_seen.load(Ordering::Acquire)
                && self.consume_fault(CredentialFault::ActiveReadback)
            {
                return Err(CredentialError::OperationFailed);
            }
            Ok(self.value(account))
        }

        fn save(&self, account: &str, secret: &str) -> Result<(), CredentialError> {
            self.operations
                .lock()
                .expect("operations lock")
                .push(format!("save:{account}"));
            if account == STAGING_SESSION && self.consume_fault(CredentialFault::StagingSave) {
                self.seed(account, secret.to_owned());
                return Err(CredentialError::OperationFailed);
            }
            self.seed(account, secret.to_owned());
            if account == ACTIVE_SESSION {
                self.active_save_seen.store(true, Ordering::Release);
                if self.consume_fault(CredentialFault::PartialActiveSave) {
                    return Err(CredentialError::OperationFailed);
                }
            }
            Ok(())
        }

        fn delete(&self, account: &str) -> Result<(), CredentialError> {
            self.operations
                .lock()
                .expect("operations lock")
                .push(format!("delete:{account}"));
            if account == STAGING_SESSION
                && ((self.active_save_seen.load(Ordering::Acquire)
                    && self.consume_fault(CredentialFault::StagingDelete))
                    || self.consume_fault(CredentialFault::StagingDeleteAlways))
            {
                return Err(CredentialError::OperationFailed);
            }
            self.values.lock().expect("values lock").remove(account);
            Ok(())
        }
    }

    fn auth_service(
        protocol: Arc<FakeProtocol>,
        credentials: Arc<RecordingCredentialStore>,
    ) -> Arc<QQMusicAuthService> {
        auth_service_with_storage(protocol, credentials).0
    }

    fn auth_service_with_storage(
        protocol: Arc<FakeProtocol>,
        credentials: Arc<RecordingCredentialStore>,
    ) -> (Arc<QQMusicAuthService>, Arc<StorageService>) {
        let clock: Arc<dyn Clock> = Arc::new(ManualClock::new(1_700_000_000_000));
        let protocol: Arc<dyn QQMusicAuthProtocol> = protocol;
        let credentials: Arc<dyn CredentialStore> = credentials;
        let storage = Arc::new(StorageService::temporary());
        (
            Arc::new(QQMusicAuthService::new(
                protocol,
                SpawnBlockingCredentialStore::new(credentials),
                clock,
                Arc::clone(&storage),
            )),
            storage,
        )
    }

    async fn wait_for_state(service: &QQMusicAuthService, expected: &str) {
        for _ in 0..1_000 {
            if service.snapshot().await.state_name() == expected {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!(
            "state did not converge: expected {expected}, got {}",
            service.snapshot().await.state_name()
        );
    }

    async fn wait_for_notification(notification: &Notify) {
        let notified = notification.notified();
        tokio::pin!(notified);
        for _ in 0..1_000 {
            tokio::select! {
                _ = &mut notified => return,
                _ = tokio::task::yield_now() => {}
            }
        }
        panic!("notification did not arrive");
    }

    #[test]
    fn sanitized_auth_fixtures_contain_no_secret_material() {
        for fixture in [
            include_str!("../../tests/fixtures/qqmusic/account/auth-waiting.json"),
            include_str!("../../tests/fixtures/qqmusic/account/auth-confirmed.json"),
            include_str!("../../tests/fixtures/qqmusic/account/profile.json"),
        ] {
            let lower = fixture.to_ascii_lowercase();
            for forbidden in [
                "qm_keyst",
                "qrsig",
                "ptqrtoken",
                "set-cookie",
                "authorization",
                "cookie:",
            ] {
                assert!(!lower.contains(forbidden));
            }
            serde_json::from_str::<Value>(fixture).expect("fixture JSON");
        }
    }

    #[test]
    fn callback_parser_accepts_quoted_status_and_rejects_malformed_input() {
        assert_eq!(
            parse_ptui_callback("ptuiCB('67','0','','0','scanned');").expect("callback"),
            ["67", "0", "", "0", "scanned"]
        );
        assert!(parse_ptui_callback("ptuiCB('67)").is_err());
        assert!(parse_ptui_callback("not-a-callback").is_err());
    }

    #[test]
    fn challenge_validation_is_mime_and_size_bounded() {
        let valid = AuthChallenge {
            qr_bytes: vec![1],
            mime_type: "image/png; charset=binary".to_owned(),
            poll_secret: "synthetic".to_owned(),
            expires_at_ms: 100,
        };
        assert!(validate_challenge(&valid).is_ok());
        let invalid = AuthChallenge {
            qr_bytes: vec![0; MAX_QR_BYTES + 1],
            mime_type: "image/svg+xml".to_owned(),
            poll_secret: "synthetic".to_owned(),
            expires_at_ms: 100,
        };
        assert!(validate_challenge(&invalid).is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn qr_flow_clears_image_when_scanned_and_on_terminal_state() {
        let protocol = Arc::new(FakeProtocol::new(vec![
            AuthPollResult::WaitingForScan,
            AuthPollResult::WaitingForConfirmation,
            AuthPollResult::Expired,
        ]));
        let service = auth_service(
            Arc::clone(&protocol),
            Arc::new(RecordingCredentialStore::default()),
        );

        let started = service.start().await.expect("start");
        assert_eq!(started.state_name(), "waiting-for-scan");
        assert!(started.qr_image_data_uri().is_some());
        let serialized = serde_json::to_string(&started).expect("snapshot JSON");
        assert!(!serialized.contains("synthetic-poll-secret"));
        assert!(!serialized.contains("pollSecret"));
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
        tokio::time::advance(Duration::from_millis(1_600)).await;
        wait_for_state(&service, "waiting-for-confirmation").await;
        assert!(service.snapshot().await.qr_image_data_uri().is_none());
        assert_eq!(service.challenge_bytes_for_test().await, Some(Vec::new()));
        tokio::time::advance(Duration::from_millis(1_600)).await;
        wait_for_state(&service, "expired").await;
        assert!(service.snapshot().await.qr_image_data_uri().is_none());
        assert!(service.challenge_bytes_for_test().await.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn owner_lease_expiry_cancels_poll_and_releases_all_qr_material() {
        let protocol = Arc::new(FakeProtocol::new(Vec::new()));
        protocol.hold_poll();
        let service = auth_service(
            Arc::clone(&protocol),
            Arc::new(RecordingCredentialStore::default()),
        );
        service.start().await.expect("start");
        tokio::time::advance(Duration::from_secs(8)).await;
        wait_for_state(&service, "cancelled").await;
        assert!(service.challenge_bytes_for_test().await.is_none());
        assert!(service.poll_task_is_cancelled().await);
    }

    #[tokio::test]
    async fn official_oauth_callback_exchanges_only_the_code_and_promotes_the_session() {
        let protocol = Arc::new(FakeProtocol::new(Vec::new()));
        let service = auth_service(
            Arc::clone(&protocol),
            Arc::new(RecordingCredentialStore::default()),
        );
        let launch = service
            .start_oauth(OAuthLoginProvider::Qq)
            .await
            .expect("OAuth start");
        assert_eq!(launch.snapshot.state_name(), "waiting-for-confirmation");
        assert!(launch.snapshot.qr_image_data_uri().is_none());
        let state = launch
            .authorization_url
            .query_pairs()
            .find_map(|(key, value)| (key == "state").then(|| value.into_owned()))
            .expect("state");
        let callback = Url::parse(&format!(
            "https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https%3A%2F%2Fy.qq.com%2F&code=SYNTHETIC_CODE&state={state}"
        ))
        .expect("callback URL");

        let authenticated = service
            .complete_oauth_callback(&launch.attempt_id, OAuthLoginProvider::Qq, callback)
            .await
            .expect("OAuth completion");

        assert_eq!(authenticated.state_name(), "authenticated");
        assert!(!service.has_active_owner());
        assert!(service.active_attempt.lock().await.is_none());
        assert_eq!(
            *protocol.oauth_exchange.lock().expect("OAuth exchange lock"),
            Some((OAuthLoginProvider::Qq, "SYNTHETIC_CODE".to_owned()))
        );
    }

    #[tokio::test]
    async fn oauth_state_mismatch_fails_closed_without_exchanging_or_persisting() {
        let protocol = Arc::new(FakeProtocol::new(Vec::new()));
        let credentials = Arc::new(RecordingCredentialStore::default());
        let service = auth_service(Arc::clone(&protocol), Arc::clone(&credentials));
        let launch = service
            .start_oauth(OAuthLoginProvider::Wechat)
            .await
            .expect("OAuth start");
        let callback = Url::parse(
            "https://y.qq.com/portal/wx_redirect.html?login_type=2&surl=https%3A%2F%2Fy.qq.com%2F&code=SYNTHETIC_CODE&state=attacker",
        )
        .expect("callback URL");

        assert!(service
            .complete_oauth_callback(&launch.attempt_id, OAuthLoginProvider::Wechat, callback,)
            .await
            .is_err());
        assert_eq!(service.snapshot().await.state_name(), "protocol-error");
        assert!(protocol
            .oauth_exchange
            .lock()
            .expect("OAuth exchange lock")
            .is_none());
        assert!(credentials.value(ACTIVE_SESSION).is_none());
        assert!(credentials.value(STAGING_SESSION).is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn oauth_owner_lease_expiry_cancels_a_window_without_a_live_dialog() {
        let protocol = Arc::new(FakeProtocol::new(Vec::new()));
        let service = auth_service(protocol, Arc::new(RecordingCredentialStore::default()));
        service
            .start_oauth(OAuthLoginProvider::Qq)
            .await
            .expect("OAuth start");

        tokio::time::advance(Duration::from_secs(8)).await;
        wait_for_state(&service, "cancelled").await;
        assert!(!service.has_active_owner());
        assert!(service.active_attempt.lock().await.is_none());
    }

    #[tokio::test]
    async fn synchronous_owner_loss_invalidates_generation_before_delayed_poll_returns() {
        let protocol = Arc::new(FakeProtocol::new(vec![AuthPollResult::Confirmed(session(
            "late-owner",
        ))]));
        protocol.hold_poll();
        let credentials = Arc::new(RecordingCredentialStore::default());
        let service = auth_service(Arc::clone(&protocol), Arc::clone(&credentials));
        service.start().await.expect("start");
        wait_for_notification(&protocol.poll_entered).await;
        let before = service.generation();

        assert!(service.has_active_owner());
        assert!(service.cancel_login_owner("navigation-started"));
        assert!(service.generation() > before);
        assert!(!service.has_active_owner());
        protocol.poll_release.notify_waiters();

        wait_for_state(&service, "cancelled").await;
        assert!(service.challenge_bytes_for_test().await.is_none());
        assert!(credentials.value(ACTIVE_SESSION).is_none());
        assert!(credentials.value(STAGING_SESSION).is_none());
    }

    #[tokio::test]
    async fn owner_loss_at_final_promotion_boundary_rolls_back_candidate() {
        let protocol = Arc::new(FakeProtocol::new(vec![AuthPollResult::Confirmed(session(
            "late-promotion",
        ))]));
        let credentials = Arc::new(RecordingCredentialStore::default());
        let service = auth_service(Arc::clone(&protocol), Arc::clone(&credentials));
        let barrier = service.set_lifecycle_barrier(LifecycleBoundary::BeforePublish);
        service.start().await.expect("start");
        wait_for_notification(&barrier.entered).await;

        assert!(service.has_active_owner());
        assert!(service.cancel_login_owner("main-window-destroyed"));
        barrier.release.notify_one();

        wait_for_state(&service, "cancelled").await;
        assert!(credentials.value(ACTIVE_SESSION).is_none());
        assert!(credentials.value(STAGING_SESSION).is_none());
        assert_ne!(service.snapshot().await.state_name(), "authenticated");
    }

    #[tokio::test]
    async fn successful_owner_release_keeps_the_authenticated_generation_token_live() {
        let protocol = Arc::new(FakeProtocol::new(vec![AuthPollResult::Confirmed(session(
            "authenticated-owner",
        ))]));
        let service = auth_service(
            Arc::clone(&protocol),
            Arc::new(RecordingCredentialStore::default()),
        );
        service.start().await.expect("start");
        wait_for_state(&service, "authenticated").await;

        let (_, token) = service.capture_generation();
        assert!(!token.is_cancelled());
        assert!(!service.has_active_owner());
    }

    #[tokio::test]
    async fn invalid_challenge_releases_attempt_and_publishes_protocol_error() {
        let protocol = Arc::new(FakeProtocol::new(Vec::new()));
        protocol.return_invalid_challenge();
        let service = auth_service(
            Arc::clone(&protocol),
            Arc::new(RecordingCredentialStore::default()),
        );

        assert!(service.start().await.is_err());
        assert_eq!(service.snapshot().await.state_name(), "protocol-error");
        assert!(service.challenge_bytes_for_test().await.is_none());
        assert!(service.poll_task_is_cancelled().await);
    }

    #[tokio::test]
    async fn refresh_requires_the_current_or_last_terminal_attempt_id() {
        let protocol = Arc::new(FakeProtocol::new(vec![AuthPollResult::Expired]));
        let service = auth_service(
            Arc::clone(&protocol),
            Arc::new(RecordingCredentialStore::default()),
        );
        let first = service.start().await.expect("first start");
        let first_id = first.attempt_id().expect("first attempt").to_owned();
        wait_for_state(&service, "expired").await;

        assert!(service.refresh(Some("stale-attempt")).await.is_err());
        assert_eq!(service.snapshot().await.state_name(), "expired");
        let refreshed = service
            .refresh(Some(&first_id))
            .await
            .expect("terminal refresh");
        assert_eq!(refreshed.state_name(), "waiting-for-scan");
        assert_ne!(refreshed.attempt_id(), Some(first_id.as_str()));
        assert!(service.refresh(Some("stale-attempt")).await.is_err());
        assert_eq!(
            service.snapshot().await.attempt_id(),
            refreshed.attempt_id()
        );
    }

    #[tokio::test]
    async fn cancelled_generation_rejects_late_confirmation() {
        let protocol = Arc::new(FakeProtocol::new(vec![AuthPollResult::Confirmed(session(
            "candidate",
        ))]));
        protocol.hold_poll();
        let credentials = Arc::new(RecordingCredentialStore::default());
        let service = auth_service(Arc::clone(&protocol), Arc::clone(&credentials));
        let started = service.start().await.expect("start");
        wait_for_notification(&protocol.poll_entered).await;

        service
            .cancel(started.attempt_id().expect("attempt"))
            .await
            .expect("cancel");
        protocol.poll_release.notify_waiters();
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }

        assert_eq!(service.snapshot().await.state_name(), "cancelled");
        assert_eq!(credentials.value(ACTIVE_SESSION), None);
    }

    #[tokio::test(start_paused = true)]
    async fn heartbeat_extends_only_the_matching_owner_lease() {
        let protocol = Arc::new(FakeProtocol::new(Vec::new()));
        protocol.hold_poll();
        let service = auth_service(
            Arc::clone(&protocol),
            Arc::new(RecordingCredentialStore::default()),
        );
        let started = service.start().await.expect("start");
        tokio::time::advance(Duration::from_secs(6)).await;
        service
            .heartbeat(
                started.attempt_id().expect("attempt"),
                started.owner_lease_id().expect("owner lease"),
            )
            .await
            .expect("heartbeat");
        assert!(service.heartbeat("wrong", "wrong").await.is_err());
        tokio::time::advance(Duration::from_secs(2)).await;
        assert_eq!(service.snapshot().await.state_name(), "waiting-for-scan");
        tokio::time::advance(Duration::from_secs(6)).await;
        wait_for_state(&service, "cancelled").await;
    }

    #[tokio::test]
    async fn confirmation_stages_reads_validates_promotes_reads_then_publishes() {
        let protocol = Arc::new(FakeProtocol::new(Vec::new()));
        let credentials = Arc::new(RecordingCredentialStore::default());
        let service = auth_service(Arc::clone(&protocol), Arc::clone(&credentials));

        let snapshot = service
            .complete_confirmation(session("candidate"))
            .await
            .expect("promotion");

        assert_eq!(snapshot.state_name(), "authenticated");
        assert_eq!(protocol.validation_count.load(Ordering::Acquire), 2);
        assert_eq!(
            credentials.operations(),
            [
                "load:qqmusic-session",
                "save:qqmusic-session-staging",
                "load:qqmusic-session-staging",
                "save:qqmusic-session",
                "load:qqmusic-session",
                "delete:qqmusic-session-staging",
            ]
        );
        assert!(credentials.value(STAGING_SESSION).is_none());
        assert!(credentials.value(ACTIVE_SESSION).is_some());
    }

    #[tokio::test]
    async fn playback_epoch_guard_tracks_account_scope_changes_and_logout() {
        let protocol = Arc::new(FakeProtocol::new(Vec::new()));
        let credentials = Arc::new(RecordingCredentialStore::default());
        let service = auth_service(protocol, credentials);

        service
            .complete_confirmation(session("first"))
            .await
            .expect("first promotion");
        let first = service
            .capture_account_context()
            .await
            .expect("first context");
        let first_guard = PlaybackEpochGuard::account_bound(
            first.epoch,
            first.cancellation,
            service.playback_epoch_clock(),
        );
        first_guard.validate().expect("first epoch is current");

        service
            .complete_confirmation(session("second"))
            .await
            .expect("second promotion");
        assert_eq!(first_guard.validate(), Err(PlaybackSourceError::Cancelled));
        let second = service
            .capture_account_context()
            .await
            .expect("second context");
        let second_guard = PlaybackEpochGuard::account_bound(
            second.epoch,
            second.cancellation,
            service.playback_epoch_clock(),
        );
        second_guard.validate().expect("second epoch is current");

        service.logout().await.expect("logout");
        assert_eq!(second_guard.validate(), Err(PlaybackSourceError::Cancelled));
    }

    #[tokio::test]
    async fn active_save_that_writes_then_errors_restores_and_verifies_prior_value() {
        let protocol = Arc::new(FakeProtocol::new(Vec::new()));
        let credentials = Arc::new(RecordingCredentialStore::with_fault(
            CredentialFault::PartialActiveSave,
        ));
        let prior = serde_json::to_string(&session("prior")).expect("prior JSON");
        credentials.seed(ACTIVE_SESSION, prior.clone());
        let service = auth_service(Arc::clone(&protocol), Arc::clone(&credentials));
        let before = service.snapshot().await;

        assert!(service
            .complete_confirmation(session("candidate"))
            .await
            .is_err());

        assert_eq!(credentials.value(ACTIVE_SESSION), Some(prior));
        assert!(credentials.value(STAGING_SESSION).is_none());
        assert!(service.snapshot().await == before);
        assert!(credentials
            .operations()
            .windows(2)
            .any(|operations| operations == ["save:qqmusic-session", "load:qqmusic-session"]));
    }

    #[tokio::test]
    async fn partial_active_save_without_prior_leaves_active_absent() {
        let protocol = Arc::new(FakeProtocol::new(Vec::new()));
        let credentials = Arc::new(RecordingCredentialStore::with_fault(
            CredentialFault::PartialActiveSave,
        ));
        let service = auth_service(Arc::clone(&protocol), Arc::clone(&credentials));

        assert!(service
            .complete_confirmation(session("candidate"))
            .await
            .is_err());

        assert!(credentials.value(ACTIVE_SESSION).is_none());
        assert!(credentials.value(STAGING_SESSION).is_none());
        assert_ne!(service.snapshot().await.state_name(), "authenticated");
    }

    #[tokio::test]
    async fn active_readback_failure_restores_prior_session_and_projection() {
        let protocol = Arc::new(FakeProtocol::new(Vec::new()));
        let credentials = Arc::new(RecordingCredentialStore::with_fault(
            CredentialFault::ActiveReadback,
        ));
        let prior = serde_json::to_string(&session("prior")).expect("prior JSON");
        credentials.seed(ACTIVE_SESSION, prior.clone());
        let service = auth_service(Arc::clone(&protocol), Arc::clone(&credentials));
        let before = service.snapshot().await;

        assert!(service
            .complete_confirmation(session("candidate"))
            .await
            .is_err());

        assert_eq!(credentials.value(ACTIVE_SESSION), Some(prior));
        assert!(service.snapshot().await == before);
        assert!(credentials.value(STAGING_SESSION).is_none());
    }

    #[tokio::test]
    async fn partial_staging_save_is_cleaned_without_touching_active() {
        let protocol = Arc::new(FakeProtocol::new(Vec::new()));
        let credentials = Arc::new(RecordingCredentialStore::with_fault(
            CredentialFault::StagingSave,
        ));
        let prior = serde_json::to_string(&session("prior")).expect("prior JSON");
        credentials.seed(ACTIVE_SESSION, prior.clone());
        let service = auth_service(Arc::clone(&protocol), Arc::clone(&credentials));

        assert!(service
            .complete_confirmation(session("candidate"))
            .await
            .is_err());

        assert_eq!(credentials.value(ACTIVE_SESSION), Some(prior));
        assert!(credentials.value(STAGING_SESSION).is_none());
    }

    #[tokio::test]
    async fn staging_delete_failure_after_active_write_rolls_back_prior_session() {
        let protocol = Arc::new(FakeProtocol::new(Vec::new()));
        let credentials = Arc::new(RecordingCredentialStore::with_fault(
            CredentialFault::StagingDelete,
        ));
        let prior = serde_json::to_string(&session("prior")).expect("prior JSON");
        credentials.seed(ACTIVE_SESSION, prior.clone());
        let service = auth_service(Arc::clone(&protocol), Arc::clone(&credentials));

        assert!(service
            .complete_confirmation(session("candidate"))
            .await
            .is_err());

        assert_eq!(credentials.value(ACTIVE_SESSION), Some(prior));
        assert!(credentials.value(STAGING_SESSION).is_none());
        assert_ne!(service.snapshot().await.state_name(), "authenticated");
    }

    #[tokio::test]
    async fn logout_interleaving_with_staged_validation_cannot_resurrect_candidate() {
        let protocol = Arc::new(FakeProtocol::new(Vec::new()));
        protocol.block_validation(2);
        let credentials = Arc::new(RecordingCredentialStore::default());
        let service = auth_service(Arc::clone(&protocol), Arc::clone(&credentials));
        let promoting = {
            let service = Arc::clone(&service);
            tokio::spawn(async move { service.complete_confirmation(session("candidate")).await })
        };
        wait_for_notification(&protocol.validation_entered).await;
        let logging_out = {
            let service = Arc::clone(&service);
            tokio::spawn(async move { service.logout().await })
        };
        while service.generation() == 0 {
            tokio::task::yield_now().await;
        }
        protocol.validation_release.notify_waiters();

        assert!(promoting.await.expect("promotion joins").is_err());
        assert_eq!(
            logging_out
                .await
                .expect("logout joins")
                .expect("logout")
                .state_name(),
            "guest"
        );
        assert!(credentials.value(ACTIVE_SESSION).is_none());
        assert!(credentials.value(STAGING_SESSION).is_none());
        assert_eq!(service.snapshot().await.state_name(), "guest");
    }

    #[tokio::test]
    async fn logout_interleaving_with_restore_cannot_publish_stale_session() {
        let protocol = Arc::new(FakeProtocol::new(Vec::new()));
        protocol.block_validation(1);
        let credentials = Arc::new(RecordingCredentialStore::default());
        credentials.seed(
            ACTIVE_SESSION,
            serde_json::to_string(&session("prior")).expect("session JSON"),
        );
        let service = auth_service(Arc::clone(&protocol), Arc::clone(&credentials));
        let restoring = {
            let service = Arc::clone(&service);
            tokio::spawn(async move { service.restore().await })
        };
        wait_for_notification(&protocol.validation_entered).await;
        let logging_out = {
            let service = Arc::clone(&service);
            tokio::spawn(async move { service.logout().await })
        };
        while service.generation() == 0 {
            tokio::task::yield_now().await;
        }
        protocol.validation_release.notify_waiters();

        assert!(restoring.await.expect("restore joins").is_err());
        assert_eq!(
            logging_out
                .await
                .expect("logout joins")
                .expect("logout")
                .state_name(),
            "guest"
        );
        assert_eq!(service.snapshot().await.state_name(), "guest");
        assert!(credentials.value(ACTIVE_SESSION).is_none());
    }

    #[tokio::test]
    async fn restore_validates_before_authenticated_and_maps_invalid_material_to_reauth() {
        let valid_protocol = Arc::new(FakeProtocol::new(Vec::new()));
        let valid_credentials = Arc::new(RecordingCredentialStore::default());
        valid_credentials.seed(
            ACTIVE_SESSION,
            serde_json::to_string(&session("valid")).expect("session JSON"),
        );
        let valid = auth_service(valid_protocol, valid_credentials);
        valid.restore().await.expect("valid restore");
        assert_eq!(valid.snapshot().await.state_name(), "authenticated");

        let malformed_protocol = Arc::new(FakeProtocol::new(Vec::new()));
        let malformed_credentials = Arc::new(RecordingCredentialStore::default());
        malformed_credentials.seed(ACTIVE_SESSION, "not-json".to_owned());
        let malformed = auth_service(malformed_protocol, malformed_credentials);
        assert!(malformed.restore().await.is_err());
        assert_eq!(
            malformed.snapshot().await.state_name(),
            "reauthentication-required"
        );

        let expired_protocol = Arc::new(FakeProtocol::new(Vec::new()));
        let expired_credentials = Arc::new(RecordingCredentialStore::default());
        let mut expired_session = session("expired");
        expired_session.expires_at_ms = 1_600_000_000_000;
        expired_credentials.seed(
            ACTIVE_SESSION,
            serde_json::to_string(&expired_session).expect("expired session JSON"),
        );
        let expired = auth_service(expired_protocol, expired_credentials);
        assert!(expired.restore().await.is_err());
        assert_eq!(
            expired.snapshot().await.state_name(),
            "reauthentication-required"
        );
    }

    #[tokio::test]
    async fn restore_maps_offline_validation_to_network_error_without_profile() {
        let protocol = Arc::new(FakeProtocol::new(Vec::new()));
        protocol.fail_validation(QQMusicError::Offline);
        let credentials = Arc::new(RecordingCredentialStore::default());
        credentials.seed(
            ACTIVE_SESSION,
            serde_json::to_string(&session("offline")).expect("session JSON"),
        );
        let service = auth_service(protocol, credentials);

        assert!(service.restore().await.is_err());
        assert_eq!(service.snapshot().await.state_name(), "network-error");
        assert!(service.current_session().await.is_none());
    }

    #[tokio::test]
    async fn logout_and_successful_promotion_clear_only_account_cache_entries() {
        let protocol = Arc::new(FakeProtocol::new(Vec::new()));
        let credentials = Arc::new(RecordingCredentialStore::default());
        let (service, storage) =
            auth_service_with_storage(Arc::clone(&protocol), Arc::clone(&credentials));
        storage
            .put_json("qqmusic:home", "metadata", &vec!["guest"], 60_000)
            .expect("guest cache write");
        storage
            .put_json(
                "qqmusic:account:old:favorites",
                "qqmusic-account",
                &vec!["private"],
                60_000,
            )
            .expect("old account cache write");

        service
            .complete_confirmation(session("candidate"))
            .await
            .expect("promotion");
        assert!(storage
            .get_json::<Vec<String>>("qqmusic:account:old:favorites", true)
            .expect("account cache read")
            .is_none());
        assert!(storage
            .get_json::<Vec<String>>("qqmusic:home", true)
            .expect("guest cache read")
            .is_some());

        storage
            .put_json(
                "qqmusic:account:new:favorites",
                "qqmusic-account",
                &vec!["new-private"],
                60_000,
            )
            .expect("new account cache write");
        service.logout().await.expect("logout");
        assert!(storage
            .get_json::<Vec<String>>("qqmusic:account:new:favorites", true)
            .expect("account cache read")
            .is_none());
        assert!(storage
            .get_json::<Vec<String>>("qqmusic:home", true)
            .expect("guest cache read")
            .is_some());
    }

    #[tokio::test]
    async fn logout_continues_cleanup_and_never_publishes_guest_on_credential_delete_failure() {
        let protocol = Arc::new(FakeProtocol::new(Vec::new()));
        let credentials = Arc::new(RecordingCredentialStore::with_fault(
            CredentialFault::StagingDeleteAlways,
        ));
        credentials.seed(STAGING_SESSION, "stale-stage".to_owned());
        credentials.seed(
            ACTIVE_SESSION,
            serde_json::to_string(&session("active")).expect("active session JSON"),
        );
        let (service, storage) = auth_service_with_storage(protocol, Arc::clone(&credentials));
        storage
            .put_json(
                "qqmusic:account:active:favorites",
                ACCOUNT_CACHE_KIND,
                &vec!["private"],
                60_000,
            )
            .expect("account cache write");

        assert!(service.logout().await.is_err());
        assert_eq!(
            service.snapshot().await.state_name(),
            "secure-store-unavailable"
        );
        assert!(credentials.value(ACTIVE_SESSION).is_none());
        assert!(storage
            .get_json::<Vec<String>>("qqmusic:account:active:favorites", true)
            .expect("account cache read")
            .is_none());
        assert!(credentials
            .operations()
            .iter()
            .any(|operation| operation == "delete:qqmusic-session"));
    }

    #[tokio::test]
    async fn cache_only_logout_failure_publishes_guest_but_returns_error() {
        let protocol = Arc::new(FakeProtocol::new(Vec::new()));
        let credentials = Arc::new(RecordingCredentialStore::default());
        credentials.seed(
            ACTIVE_SESSION,
            serde_json::to_string(&session("active")).expect("active session JSON"),
        );
        let (service, storage) = auth_service_with_storage(protocol, Arc::clone(&credentials));
        storage.fail_provider_cache_delete_for_test();

        assert!(service.logout().await.is_err());
        assert_eq!(service.snapshot().await.state_name(), "guest");
        assert!(credentials.value(ACTIVE_SESSION).is_none());
        assert!(credentials.value(STAGING_SESSION).is_none());
    }

    #[tokio::test]
    async fn promotion_rolls_back_active_when_old_account_cache_cannot_be_cleared() {
        let protocol = Arc::new(FakeProtocol::new(Vec::new()));
        let credentials = Arc::new(RecordingCredentialStore::default());
        let (service, storage) = auth_service_with_storage(protocol, Arc::clone(&credentials));
        storage.fail_provider_cache_delete_for_test();

        assert!(service
            .complete_confirmation(session("candidate"))
            .await
            .is_err());
        assert!(credentials.value(ACTIVE_SESSION).is_none());
        assert!(credentials.value(STAGING_SESSION).is_none());
        assert_ne!(service.snapshot().await.state_name(), "authenticated");
    }

    #[tokio::test]
    async fn logout_at_every_promotion_boundary_removes_candidate_without_publishing_it() {
        let boundaries = [
            LifecycleBoundary::CandidateValidated,
            LifecycleBoundary::BeforeStagingSave,
            LifecycleBoundary::AfterStagingSave,
            LifecycleBoundary::AfterStagingReadback,
            LifecycleBoundary::AfterStagedValidation,
            LifecycleBoundary::BeforeActiveSave,
            LifecycleBoundary::AfterActiveSave,
            LifecycleBoundary::AfterActiveReadback,
            LifecycleBoundary::AfterStagingDelete,
            LifecycleBoundary::BeforePublish,
        ];
        for boundary in boundaries {
            let protocol = Arc::new(FakeProtocol::new(Vec::new()));
            let credentials = Arc::new(RecordingCredentialStore::default());
            let service = auth_service(Arc::clone(&protocol), Arc::clone(&credentials));
            let barrier = service.set_lifecycle_barrier(boundary);
            let promoting = {
                let service = Arc::clone(&service);
                tokio::spawn(
                    async move { service.complete_confirmation(session("candidate")).await },
                )
            };
            wait_for_notification(&barrier.entered).await;
            let generation = service.generation();
            let logging_out = {
                let service = Arc::clone(&service);
                tokio::spawn(async move { service.logout().await })
            };
            while service.generation() == generation {
                tokio::task::yield_now().await;
            }
            assert_ne!(service.snapshot().await.state_name(), "authenticated");
            barrier.release.notify_one();

            assert!(promoting.await.expect("promotion joins").is_err());
            assert_eq!(
                logging_out
                    .await
                    .expect("logout joins")
                    .expect("logout")
                    .state_name(),
                "guest"
            );
            assert!(credentials.value(ACTIVE_SESSION).is_none());
            assert!(credentials.value(STAGING_SESSION).is_none());
            assert!(service.current_session().await.is_none());
            assert_eq!(service.snapshot().await.state_name(), "guest");
        }
    }

    #[tokio::test]
    async fn logout_at_every_restore_boundary_prevents_stale_publication() {
        for boundary in [
            LifecycleBoundary::RestoreActiveLoaded,
            LifecycleBoundary::RestoreValidated,
            LifecycleBoundary::RestoreBeforePublish,
        ] {
            let protocol = Arc::new(FakeProtocol::new(Vec::new()));
            let credentials = Arc::new(RecordingCredentialStore::default());
            credentials.seed(
                ACTIVE_SESSION,
                serde_json::to_string(&session("prior")).expect("session JSON"),
            );
            let service = auth_service(Arc::clone(&protocol), Arc::clone(&credentials));
            let barrier = service.set_lifecycle_barrier(boundary);
            let restoring = {
                let service = Arc::clone(&service);
                tokio::spawn(async move { service.restore().await })
            };
            wait_for_notification(&barrier.entered).await;
            let generation = service.generation();
            let logging_out = {
                let service = Arc::clone(&service);
                tokio::spawn(async move { service.logout().await })
            };
            while service.generation() == generation {
                tokio::task::yield_now().await;
            }
            barrier.release.notify_one();

            assert!(restoring.await.expect("restore joins").is_err());
            assert_eq!(
                logging_out
                    .await
                    .expect("logout joins")
                    .expect("logout")
                    .state_name(),
                "guest"
            );
            assert!(service.current_session().await.is_none());
            assert!(credentials.value(ACTIVE_SESSION).is_none());
            assert_eq!(service.snapshot().await.state_name(), "guest");
        }
    }

    #[derive(Clone)]
    struct ObservedTransportRequest {
        operation: &'static str,
        retry: RetryClass,
        redirects: RedirectMode,
        host: String,
        path: String,
        body: Option<Value>,
        has_cookie: bool,
        has_json_content_type: bool,
        has_qq_origin: bool,
    }

    struct ScriptedTransport {
        responses: Mutex<VecDeque<Result<TransportResponse, QQMusicError>>>,
        requests: Mutex<Vec<ObservedTransportRequest>>,
    }

    #[async_trait]
    impl QqTransport for ScriptedTransport {
        async fn execute(
            &self,
            request: TransportRequest,
        ) -> Result<TransportResponse, QQMusicError> {
            self.requests.lock().await.push(ObservedTransportRequest {
                operation: request.operation,
                retry: request.retry,
                redirects: request.redirects,
                host: request.url.host_str().unwrap_or_default().to_owned(),
                path: request.url.path().to_owned(),
                body: request
                    .body
                    .as_deref()
                    .and_then(|body| serde_json::from_slice(body).ok()),
                has_cookie: request.headers.contains_key(header::COOKIE),
                has_json_content_type: request
                    .headers
                    .get(header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .is_some_and(|value| value.starts_with("application/json")),
                has_qq_origin: request
                    .headers
                    .get(header::ORIGIN)
                    .and_then(|value| value.to_str().ok())
                    == Some("https://y.qq.com"),
            });
            self.responses
                .lock()
                .await
                .pop_front()
                .unwrap_or(Err(QQMusicError::Protocol))
        }
    }

    fn response(
        status: StatusCode,
        url: &str,
        headers: HeaderMap,
        body: impl Into<Vec<u8>>,
    ) -> Result<TransportResponse, QQMusicError> {
        Ok(TransportResponse {
            status,
            final_url: Url::parse(url).expect("fixture URL"),
            headers,
            body: body.into(),
        })
    }

    fn headers(values: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in values {
            headers.append(
                header::HeaderName::from_static(name),
                HeaderValue::from_static(value),
            );
        }
        headers
    }

    #[tokio::test]
    async fn qr_create_requires_a_bounded_image_and_extracts_only_the_poll_secret() {
        let transport = Arc::new(ScriptedTransport {
            responses: Mutex::new(
                vec![
                    response(
                        StatusCode::OK,
                        "https://ssl.ptlogin2.qq.com/ptqrshow",
                        headers(&[
                            ("content-type", "image/png"),
                            ("set-cookie", "qrsig=SYNTHETIC_QR_SECRET; Secure; HttpOnly"),
                        ]),
                        b"synthetic-png".to_vec(),
                    ),
                    response(
                        StatusCode::OK,
                        "https://ssl.ptlogin2.qq.com/ptqrshow",
                        headers(&[
                            ("content-type", "text/html"),
                            ("set-cookie", "qrsig=SYNTHETIC_QR_SECRET; Secure"),
                        ]),
                        b"not-an-image".to_vec(),
                    ),
                    response(
                        StatusCode::OK,
                        "https://ssl.ptlogin2.qq.com/ptqrshow",
                        headers(&[
                            ("content-type", "image/png"),
                            ("set-cookie", "qrsig=SYNTHETIC_QR_SECRET; Secure"),
                        ]),
                        Vec::new(),
                    ),
                    response(
                        StatusCode::OK,
                        "https://ssl.ptlogin2.qq.com/ptqrshow",
                        headers(&[
                            ("content-type", "image/png"),
                            ("set-cookie", "qrsig=SYNTHETIC_QR_SECRET; Secure"),
                        ]),
                        vec![0; MAX_QR_BYTES + 1],
                    ),
                ]
                .into(),
            ),
            requests: Mutex::new(Vec::new()),
        });
        let clock: Arc<dyn Clock> = Arc::new(ManualClock::new(1_700_000_000_000));
        let protocol = TransportQQMusicAuthProtocol::new(transport.clone(), clock);

        let challenge = protocol
            .create_challenge(CancellationToken::new())
            .await
            .expect("valid challenge");
        assert_eq!(challenge.qr_bytes, b"synthetic-png");
        assert_eq!(challenge.mime_type, "image/png");
        assert_eq!(challenge.poll_secret, "SYNTHETIC_QR_SECRET");
        assert!(protocol
            .create_challenge(CancellationToken::new())
            .await
            .is_err());
        assert!(protocol
            .create_challenge(CancellationToken::new())
            .await
            .is_err());
        assert!(protocol
            .create_challenge(CancellationToken::new())
            .await
            .is_err());

        let requests = transport.requests.lock().await;
        assert!(requests.iter().all(|request| {
            request.operation == "auth.qq.create"
                && request.host == "ssl.ptlogin2.qq.com"
                && request.path == "/ptqrshow"
                && request.retry == RetryClass::SafeRead
                && request.redirects == RedirectMode::FollowValidated
        }));
    }

    #[tokio::test]
    async fn qr_poll_maps_all_selected_non_success_status_codes_without_retry() {
        let transport = Arc::new(ScriptedTransport {
            responses: Mutex::new(
                ["66", "67", "65", "68"]
                    .into_iter()
                    .map(|code| {
                        response(
                            StatusCode::OK,
                            "https://ssl.ptlogin2.qq.com/ptqrlogin",
                            HeaderMap::new(),
                            format!("ptuiCB('{code}','0','','0','synthetic');"),
                        )
                    })
                    .collect(),
            ),
            requests: Mutex::new(Vec::new()),
        });
        let clock: Arc<dyn Clock> = Arc::new(ManualClock::new(1_700_000_000_000));
        let protocol = TransportQQMusicAuthProtocol::new(transport.clone(), clock);
        let challenge = AuthChallenge {
            qr_bytes: Vec::new(),
            mime_type: String::new(),
            poll_secret: "SYNTHETIC_QR_SECRET".to_owned(),
            expires_at_ms: 1_800_000_000_000,
        };

        assert!(matches!(
            protocol
                .poll_challenge(&challenge, CancellationToken::new())
                .await,
            Ok(AuthPollResult::WaitingForScan)
        ));
        assert!(matches!(
            protocol
                .poll_challenge(&challenge, CancellationToken::new())
                .await,
            Ok(AuthPollResult::WaitingForConfirmation)
        ));
        assert!(matches!(
            protocol
                .poll_challenge(&challenge, CancellationToken::new())
                .await,
            Ok(AuthPollResult::Expired)
        ));
        assert!(matches!(
            protocol
                .poll_challenge(&challenge, CancellationToken::new())
                .await,
            Ok(AuthPollResult::Rejected)
        ));
        assert!(transport.requests.lock().await.iter().all(|request| {
            request.operation == "auth.qq.poll"
                && request.retry == RetryClass::AuthPoll
                && request.redirects == RedirectMode::ReturnResponse
        }));
    }

    #[tokio::test]
    async fn selected_qq_flow_uses_manual_exchange_and_returns_validatable_session() {
        let transport = Arc::new(ScriptedTransport {
            responses: Mutex::new(
                vec![
                    response(
                        StatusCode::OK,
                        "https://ssl.ptlogin2.qq.com/ptqrlogin",
                        headers(&[("set-cookie", "pt_login_sig=SYNTHETIC; Secure")]),
                        "ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?uin=1000000001&ptsigx=SYNTHETIC_SIG&s_url=x','0','ok');",
                    ),
                    response(
                        StatusCode::FOUND,
                        "https://ssl.ptlogin2.graph.qq.com/check_sig",
                        headers(&[
                            ("location", "https://graph.qq.com/oauth2.0/login_jump"),
                            ("set-cookie", "p_skey=SYNTHETIC_P_SKEY; Secure; HttpOnly"),
                        ]),
                        Vec::new(),
                    ),
                    response(
                        StatusCode::FOUND,
                        "https://graph.qq.com/oauth2.0/authorize",
                        headers(&[(
                            "location",
                            "https://y.qq.com/portal/wx_redirect.html?login_type=1&code=SYNTHETIC_CODE&state=state",
                        )]),
                        Vec::new(),
                    ),
                    response(
                        StatusCode::OK,
                        "https://u.y.qq.com/cgi-bin/musicu.fcg",
                        HeaderMap::new(),
                        serde_json::to_vec(&json!({
                            "code": 0,
                            "req": {
                                "code": 0,
                                "data": {
                                    "musicid": 1000000001_u64,
                                    "musickey": "SYNTHETIC_MUSIC_KEY",
                                    "musickeyCreateTime": 1_700_000_000_u64,
                                    "keyExpiresIn": 86_400_u64
                                }
                            }
                        }))
                        .expect("login response"),
                    ),
                    response(
                        StatusCode::OK,
                        "https://c6.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg",
                        HeaderMap::new(),
                        include_str!("../../tests/fixtures/qqmusic/account/profile.json"),
                    ),
                    response(
                        StatusCode::OK,
                        "https://u.y.qq.com/cgi-bin/musicu.fcg",
                        HeaderMap::new(),
                        include_str!(
                            "../../tests/fixtures/qqmusic/account/entitlement-vip.json"
                        ),
                    ),
                ]
                .into(),
            ),
            requests: Mutex::new(Vec::new()),
        });
        let clock: Arc<dyn Clock> = Arc::new(ManualClock::new(1_700_000_000_000));
        let protocol = TransportQQMusicAuthProtocol::new(transport.clone(), clock);
        let challenge = AuthChallenge {
            qr_bytes: Vec::new(),
            mime_type: String::new(),
            poll_secret: "SYNTHETIC_QR_SECRET".to_owned(),
            expires_at_ms: 1_800_000_000_000,
        };

        let confirmed = protocol
            .poll_challenge(&challenge, CancellationToken::new())
            .await
            .expect("poll");
        let AuthPollResult::Confirmed(session) = confirmed else {
            panic!("expected confirmed session");
        };
        assert_eq!(session.uin, "1000000001");
        assert_eq!(session.version, SESSION_VERSION);
        assert!(session.cookie_header.contains("qqmusic_key="));
        assert!(session.cookie_header.contains("qm_keyst="));
        assert!(!session.cookie_header.contains("qrsig="));
        assert!(!session.cookie_header.contains("pt_login_sig="));
        assert_eq!(session.account_cache_scope.as_str().len(), 32);
        let validated = protocol
            .validate_session(&session, CancellationToken::new())
            .await
            .expect("validate");
        assert_eq!(validated.profile.nickname, "Synthetic Listener");
        assert_eq!(
            validated.profile.avatar_url.as_deref(),
            Some("https://thirdwx.qlogo.cn/synthetic-avatar.png")
        );
        assert_eq!(validated.profile.masked_identity, "10******01");
        assert_eq!(validated.entitlement.tier, EntitlementTier::MusicVip);
        assert_eq!(validated.entitlement.membership, MembershipState::Active);
        assert_eq!(
            validated.entitlement.observed_maximum_quality,
            Some(AudioQuality::Lossless)
        );

        let requests = transport.requests.lock().await;
        assert_eq!(requests.len(), 6);
        assert_eq!(requests[0].operation, "auth.qq.poll");
        assert_eq!(requests[0].retry, RetryClass::AuthPoll);
        assert_eq!(requests[0].redirects, RedirectMode::ReturnResponse);
        assert_eq!(requests[1].host, "ssl.ptlogin2.graph.qq.com");
        assert_eq!(requests[1].path, "/check_sig");
        assert_eq!(requests[2].redirects, RedirectMode::ReturnResponse);
        assert_eq!(requests[3].host, "u.y.qq.com");
        assert_eq!(requests[4].operation, "auth.session.validate");
        assert_eq!(requests[4].host, "u.y.qq.com");
        assert_eq!(requests[4].path, "/cgi-bin/musicu.fcg");
        assert!(requests[4].has_cookie);
        assert!(requests[4].has_json_content_type);
        assert!(requests[4].has_qq_origin);
        assert_eq!(
            requests[4]
                .body
                .as_ref()
                .and_then(|body| body.pointer("/req/module"))
                .and_then(Value::as_str),
            Some("music.UserInfo.userInfoServer")
        );
        assert_eq!(
            requests[4]
                .body
                .as_ref()
                .and_then(|body| body.pointer("/req/method"))
                .and_then(Value::as_str),
            Some("GetLoginUserInfo")
        );
        assert_eq!(requests[5].operation, "auth.entitlement.validate");
        assert_eq!(requests[5].host, "u.y.qq.com");
        assert_eq!(requests[5].path, "/cgi-bin/musicu.fcg");
        assert_eq!(requests[5].retry, RetryClass::SafeRead);
        assert_eq!(requests[5].redirects, RedirectMode::FollowValidated);
        assert!(requests[5].has_cookie);
        assert!(requests[5].has_json_content_type);
        assert!(requests[5].has_qq_origin);
        assert_eq!(
            requests[5]
                .body
                .as_ref()
                .and_then(|body| body.pointer("/req/module").and_then(Value::as_str)),
            Some("VipLogin.VipLoginInter")
        );
        assert_eq!(
            requests[5]
                .body
                .as_ref()
                .and_then(|body| body.pointer("/req/method").and_then(Value::as_str)),
            Some("vip_login_base")
        );
    }

    #[tokio::test]
    async fn official_qq_and_wechat_codes_exchange_without_browser_cookies() {
        let login_response = || {
            response(
                StatusCode::OK,
                "https://u.y.qq.com/cgi-bin/musicu.fcg",
                HeaderMap::new(),
                serde_json::to_vec(&json!({
                    "code": 0,
                    "req": {
                        "code": 0,
                        "data": {
                            "str_musicid": "1000000001",
                            "musickey": "SYNTHETIC_MUSIC_KEY",
                            "musickeyCreateTime": 1_700_000_000_u64,
                            "keyExpiresIn": 86_400_u64
                        }
                    }
                }))
                .expect("login response"),
            )
        };
        let transport = Arc::new(ScriptedTransport {
            responses: Mutex::new(vec![login_response(), login_response()].into()),
            requests: Mutex::new(Vec::new()),
        });
        let clock: Arc<dyn Clock> = Arc::new(ManualClock::new(1_700_000_000_000));
        let protocol = TransportQQMusicAuthProtocol::new(transport.clone(), clock);

        for provider in [OAuthLoginProvider::Qq, OAuthLoginProvider::Wechat] {
            let session = protocol
                .exchange_oauth_code(provider, "SYNTHETIC_CODE", CancellationToken::new())
                .await
                .expect("OAuth code exchange");
            assert_eq!(session.uin, "1000000001");
            assert!(session
                .cookie_header
                .contains("qm_keyst=SYNTHETIC_MUSIC_KEY"));
        }

        let requests = transport.requests.lock().await;
        assert_eq!(requests.len(), 2);
        assert!(requests.iter().all(|request| {
            request.host == "u.y.qq.com"
                && request.path == "/cgi-bin/musicu.fcg"
                && request.retry == RetryClass::AuthPoll
                && request.redirects == RedirectMode::FollowValidated
                && !request.has_cookie
                && request.has_json_content_type
                && request.has_qq_origin
        }));
        assert_eq!(requests[0].operation, "auth.qq.exchange");
        assert_eq!(
            requests[0]
                .body
                .as_ref()
                .and_then(|body| body.pointer("/req/module"))
                .and_then(Value::as_str),
            Some("QQConnectLogin.LoginServer")
        );
        assert_eq!(
            requests[0]
                .body
                .as_ref()
                .and_then(|body| body.pointer("/comm/tmeLoginType"))
                .and_then(Value::as_i64),
            Some(2)
        );
        assert_eq!(requests[1].operation, "auth.wechat.exchange");
        assert_eq!(
            requests[1]
                .body
                .as_ref()
                .and_then(|body| body.pointer("/req/param/strAppid"))
                .and_then(Value::as_str),
            Some("wx48db31d50e334801")
        );
        assert_eq!(
            requests[1]
                .body
                .as_ref()
                .and_then(|body| body.pointer("/comm/tmeLoginType"))
                .and_then(Value::as_i64),
            Some(1)
        );
    }

    #[tokio::test]
    async fn entitlement_failure_is_conservative_but_cancellation_is_not_swallowed() {
        fn profile_response() -> Result<TransportResponse, QQMusicError> {
            response(
                StatusCode::OK,
                "https://u.y.qq.com/cgi-bin/musicu.fcg",
                HeaderMap::new(),
                include_str!("../../tests/fixtures/qqmusic/account/profile.json"),
            )
        }

        let session = SessionRecord {
            version: SESSION_VERSION,
            uin: "1000000001".to_owned(),
            cookie_header: "qqmusic_key=SYNTHETIC_MUSIC_KEY".to_owned(),
            expires_at_ms: 1_800_000_000_000,
            account_cache_scope: OpaqueAccountScope::parse("0123456789abcdef0123456789abcdef")
                .expect("scope"),
        };
        let clock: Arc<dyn Clock> = Arc::new(ManualClock::new(1_700_000_000_000));
        let degraded_transport = Arc::new(ScriptedTransport {
            responses: Mutex::new(
                vec![
                    profile_response(),
                    response(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "https://u.y.qq.com/cgi-bin/musicu.fcg",
                        HeaderMap::new(),
                        Vec::new(),
                    ),
                ]
                .into(),
            ),
            requests: Mutex::new(Vec::new()),
        });
        let degraded = TransportQQMusicAuthProtocol::new(degraded_transport, Arc::clone(&clock))
            .validate_session(&session, CancellationToken::new())
            .await
            .expect("profile remains usable");
        assert_eq!(degraded.entitlement.tier, EntitlementTier::Unknown);
        assert_eq!(degraded.entitlement.membership, MembershipState::Unknown);
        assert_eq!(
            degraded.entitlement.permitted_qualities,
            vec![AudioQuality::Standard]
        );

        let cancelled_transport = Arc::new(ScriptedTransport {
            responses: Mutex::new(vec![profile_response(), Err(QQMusicError::Cancelled)].into()),
            requests: Mutex::new(Vec::new()),
        });
        let cancelled = TransportQQMusicAuthProtocol::new(cancelled_transport, clock)
            .validate_session(&session, CancellationToken::new())
            .await;
        assert!(matches!(cancelled, Err(QQMusicError::Cancelled)));
    }
}
