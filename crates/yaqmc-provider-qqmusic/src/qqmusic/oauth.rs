use super::{account::AccountSnapshot, QQMusicError};
use reqwest::Url;
use serde::{Deserialize, Serialize};

const QQ_CLIENT_ID: &str = "100497308";
const WECHAT_APP_ID: &str = "wx48db31d50e334801";
const QQ_REDIRECT_URI: &str =
    "https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/";
const WECHAT_REDIRECT_URI: &str =
    "https://y.qq.com/portal/wx_redirect.html?login_type=2&surl=https://y.qq.com/";
const QQ_DESKTOP_AUTHORIZATION_URL: &str = "https://graph.qq.com/oauth2.0/show";
const QQ_MOBILE_AUTHORIZATION_URL: &str = "https://graph.qq.com/oauth2.0/authorize";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum OAuthLoginProvider {
    Qq,
    Wechat,
}

impl OAuthLoginProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Qq => "qq",
            Self::Wechat => "wechat",
        }
    }

    fn login_type(self) -> &'static str {
        match self {
            Self::Qq => "1",
            Self::Wechat => "2",
        }
    }

    pub(crate) fn authorization_url(self, state: &str) -> Result<Url, QQMusicError> {
        self.authorization_url_for_presentation(state, false)
    }

    pub(crate) fn mobile_authorization_url(self, state: &str) -> Result<Option<Url>, QQMusicError> {
        match self {
            Self::Qq => self
                .authorization_url_for_presentation(state, true)
                .map(Some),
            Self::Wechat => Ok(None),
        }
    }

    fn authorization_url_for_presentation(
        self,
        state: &str,
        mobile: bool,
    ) -> Result<Url, QQMusicError> {
        if state.len() != 32 || !state.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(QQMusicError::Protocol);
        }
        let mut url = match self {
            Self::Qq => Url::parse(if mobile {
                QQ_MOBILE_AUTHORIZATION_URL
            } else {
                QQ_DESKTOP_AUTHORIZATION_URL
            }),
            Self::Wechat => Url::parse("https://open.weixin.qq.com/connect/qrconnect"),
        }
        .map_err(|_| QQMusicError::Protocol)?;
        {
            let mut query = url.query_pairs_mut();
            match self {
                Self::Qq => {
                    query
                        .append_pair("which", "Login")
                        .append_pair("display", if mobile { "mobile" } else { "pc" })
                        .append_pair("response_type", "code")
                        .append_pair("client_id", QQ_CLIENT_ID)
                        .append_pair("redirect_uri", QQ_REDIRECT_URI)
                        .append_pair("scope", "get_user_info,get_app_friends")
                        .append_pair("state", state);
                }
                Self::Wechat => {
                    query
                        .append_pair("appid", WECHAT_APP_ID)
                        .append_pair("redirect_uri", WECHAT_REDIRECT_URI)
                        .append_pair("response_type", "code")
                        .append_pair("scope", "snsapi_login")
                        .append_pair("state", state)
                        .append_pair(
                            "href",
                            "https://y.qq.com/mediastyle/music_v17/src/css/popup_wechat.css",
                        );
                }
            }
        }
        if self == Self::Wechat {
            url.set_fragment(Some("wechat_redirect"));
        }
        Ok(url)
    }

    pub(crate) fn callback_matcher_url(self, state: &str) -> Result<Url, QQMusicError> {
        if state.len() != 32 || !state.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(QQMusicError::Protocol);
        }
        let mut url = Url::parse(self.callback_url_prefix()).map_err(|_| QQMusicError::Protocol)?;
        url.query_pairs_mut()
            .append_pair("login_type", self.login_type())
            .append_pair("surl", "https://y.qq.com/")
            .append_pair("state", state);
        Ok(url)
    }

    pub fn is_callback_url(self, url: &Url) -> bool {
        secure_https_url(url)
            && url.host_str() == Some("y.qq.com")
            && url.path() == "/portal/wx_redirect.html"
            && exactly_one_query_value(url, "login_type").as_deref() == Some(self.login_type())
    }

    pub fn allows_navigation(self, url: &Url) -> bool {
        url_matches_oauth_allowlist(url, &self.navigation_allowlist())
    }

    pub fn callback_url_prefix(self) -> &'static str {
        "https://y.qq.com/portal/wx_redirect.html"
    }

    pub fn navigation_allowlist(self) -> Vec<String> {
        let hosts: &[&str] = match self {
            Self::Qq => &[
                "graph.qq.com",
                "connect.qq.com",
                "openmobile.qq.com",
                "open.mobile.qq.com",
                "qm.qq.com",
                "xui.ptlogin2.qq.com",
                "ssl.ptlogin2.qq.com",
                "ssl.ptlogin2.graph.qq.com",
                "ui.ptlogin2.qq.com",
            ],
            Self::Wechat => &["open.weixin.qq.com", "lp.open.weixin.qq.com"],
        };
        let mut allowlist: Vec<String> = hosts
            .iter()
            .map(|host| format!("https://{host}/**"))
            .collect();
        allowlist.push(format!("{}**", self.callback_url_prefix()));
        allowlist
    }

    pub fn external_navigation_rules(self) -> Vec<OAuthExternalNavigationRule> {
        match self {
            Self::Qq => vec![OAuthExternalNavigationRule {
                scheme: "wtloginmqq".to_owned(),
                host: "ptlogin".to_owned(),
                path: "/qlogin".to_owned(),
                android_packages: vec![
                    "com.tencent.mobileqq".to_owned(),
                    "com.tencent.tim".to_owned(),
                ],
            }],
            Self::Wechat => vec![
                OAuthExternalNavigationRule {
                    scheme: "weixin".to_owned(),
                    host: "dl".to_owned(),
                    path: "/business/".to_owned(),
                    android_packages: vec!["com.tencent.mm".to_owned()],
                },
                OAuthExternalNavigationRule {
                    scheme: "weixin".to_owned(),
                    host: "scanqrcode".to_owned(),
                    path: String::new(),
                    android_packages: vec!["com.tencent.mm".to_owned()],
                },
            ],
        }
    }
}

pub fn url_matches_oauth_allowlist(url: &Url, allowlist: &[String]) -> bool {
    if !secure_https_url(url) {
        return false;
    }
    allowlist.iter().any(|glob| {
        if let Some(prefix) = glob.strip_suffix("/**") {
            return Url::parse(prefix).is_ok_and(|base| {
                url.scheme() == base.scheme()
                    && url.host_str() == base.host_str()
                    && url.port() == base.port()
            });
        }
        glob.strip_suffix("**")
            .map(|prefix| url.as_str().starts_with(prefix))
            .unwrap_or_else(|| url.as_str() == glob)
    })
}

pub(crate) enum OAuthCallback {
    Code(String),
    Rejected,
}

pub(crate) fn parse_callback(
    provider: OAuthLoginProvider,
    url: &Url,
    expected_state: &str,
) -> Result<OAuthCallback, QQMusicError> {
    if !provider.is_callback_url(url)
        || exactly_one_query_value(url, "surl").as_deref() != Some("https://y.qq.com/")
    {
        return Err(QQMusicError::Protocol);
    }
    let state = exactly_one_query_value(url, "state").ok_or(QQMusicError::Protocol)?;
    if !super::auth::constant_time_equivalent(&state, expected_state) {
        return Err(QQMusicError::Protocol);
    }
    if exactly_one_query_value(url, "error").is_some() {
        return Ok(OAuthCallback::Rejected);
    }
    let code = exactly_one_query_value(url, "code")
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 2_048
                && value.bytes().all(|byte| !byte.is_ascii_control())
        })
        .ok_or(QQMusicError::Protocol)?;
    Ok(OAuthCallback::Code(code))
}

pub struct OAuthLaunch {
    pub attempt_id: String,
    pub authorization_url: Url,
    pub mobile_authorization_url: Option<Url>,
    pub callback_matcher_url: Url,
    pub snapshot: AccountSnapshot,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthExternalNavigationRule {
    pub scheme: String,
    pub host: String,
    pub path: String,
    pub android_packages: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthCallbackMatcher {
    pub url_prefix: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthPrepareResult {
    pub attempt_id: String,
    pub url: String,
    pub mobile_url: Option<String>,
    pub navigation_allowlist: Vec<String>,
    pub external_navigation_rules: Vec<OAuthExternalNavigationRule>,
    pub callback_matcher: OAuthCallbackMatcher,
    #[serde(skip)]
    pub snapshot: AccountSnapshot,
}

impl OAuthPrepareResult {
    pub fn from_launch(kind: OAuthLoginProvider, launch: OAuthLaunch) -> Self {
        Self {
            attempt_id: launch.attempt_id,
            url: launch.authorization_url.to_string(),
            mobile_url: launch.mobile_authorization_url.map(|url| url.to_string()),
            navigation_allowlist: kind.navigation_allowlist(),
            external_navigation_rules: kind.external_navigation_rules(),
            callback_matcher: OAuthCallbackMatcher {
                url_prefix: launch.callback_matcher_url.to_string(),
            },
            snapshot: launch.snapshot,
        }
    }
}

fn secure_https_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
}

fn exactly_one_query_value(url: &Url, key: &str) -> Option<String> {
    let mut matches = url
        .query_pairs()
        .filter_map(|(candidate, value)| (candidate == key).then(|| value.into_owned()));
    let value = matches.next()?;
    matches.next().is_none().then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATE: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn authorization_urls_use_the_registered_qq_music_redirects_and_fresh_state() {
        let qq = OAuthLoginProvider::Qq
            .authorization_url(STATE)
            .expect("QQ URL");
        assert_eq!(qq.host_str(), Some("graph.qq.com"));
        assert_eq!(qq.path(), "/oauth2.0/show");
        assert_eq!(
            exactly_one_query_value(&qq, "client_id").as_deref(),
            Some(QQ_CLIENT_ID)
        );
        assert_eq!(
            exactly_one_query_value(&qq, "redirect_uri").as_deref(),
            Some(QQ_REDIRECT_URI)
        );
        assert_eq!(
            exactly_one_query_value(&qq, "state").as_deref(),
            Some(STATE)
        );
        let qq_mobile = OAuthLoginProvider::Qq
            .mobile_authorization_url(STATE)
            .expect("mobile QQ URL")
            .expect("QQ has a mobile URL");
        assert_eq!(qq_mobile.path(), "/oauth2.0/authorize");
        assert_eq!(
            exactly_one_query_value(&qq_mobile, "display").as_deref(),
            Some("mobile")
        );

        let wechat = OAuthLoginProvider::Wechat
            .authorization_url(STATE)
            .expect("WeChat URL");
        assert_eq!(wechat.host_str(), Some("open.weixin.qq.com"));
        assert_eq!(wechat.path(), "/connect/qrconnect");
        assert_eq!(
            exactly_one_query_value(&wechat, "appid").as_deref(),
            Some(WECHAT_APP_ID)
        );
        assert_eq!(
            exactly_one_query_value(&wechat, "redirect_uri").as_deref(),
            Some(WECHAT_REDIRECT_URI)
        );
        assert_eq!(wechat.fragment(), Some("wechat_redirect"));
        assert!(OAuthLoginProvider::Wechat
            .mobile_authorization_url(STATE)
            .expect("mobile presentation")
            .is_none());
        assert!(OAuthLoginProvider::Qq
            .authorization_url("predictable")
            .is_err());
    }

    #[test]
    fn callback_matcher_requires_provider_redirect_state_and_surl() {
        let matcher = OAuthLoginProvider::Qq
            .callback_matcher_url(STATE)
            .expect("callback matcher");
        assert_eq!(matcher.host_str(), Some("y.qq.com"));
        assert_eq!(matcher.path(), "/portal/wx_redirect.html");
        assert_eq!(
            exactly_one_query_value(&matcher, "login_type").as_deref(),
            Some("1")
        );
        assert_eq!(
            exactly_one_query_value(&matcher, "surl").as_deref(),
            Some("https://y.qq.com/")
        );
        assert_eq!(
            exactly_one_query_value(&matcher, "state").as_deref(),
            Some(STATE)
        );
    }

    #[test]
    fn mobile_external_navigation_is_provider_declared_and_package_scoped() {
        assert_eq!(
            OAuthLoginProvider::Qq.external_navigation_rules(),
            vec![OAuthExternalNavigationRule {
                scheme: "wtloginmqq".to_owned(),
                host: "ptlogin".to_owned(),
                path: "/qlogin".to_owned(),
                android_packages: vec![
                    "com.tencent.mobileqq".to_owned(),
                    "com.tencent.tim".to_owned(),
                ],
            }]
        );
    }

    #[test]
    fn navigation_policy_is_exact_origin_fail_closed() {
        for allowed in [
            "https://graph.qq.com/oauth2.0/show",
            "https://graph.qq.com/oauth2.0/authorize?display=mobile",
            "https://connect.qq.com/widget/shareqq/index.html",
            "https://openmobile.qq.com/oauth2.0/m_authorize",
            "https://xui.ptlogin2.qq.com/cgi-bin/xlogin",
            "https://ssl.ptlogin2.qq.com/login",
            "https://ssl.ptlogin2.graph.qq.com/check_sig",
        ] {
            assert!(OAuthLoginProvider::Qq.allows_navigation(&Url::parse(allowed).unwrap()));
        }
        for rejected in [
            "http://graph.qq.com/oauth2.0/show",
            "https://graph.qq.com.evil.example/oauth2.0/show",
            "https://user@graph.qq.com/oauth2.0/show",
            "https://evil.example/",
            "file:///etc/passwd",
        ] {
            assert!(!OAuthLoginProvider::Qq.allows_navigation(&Url::parse(rejected).unwrap()));
        }
        assert!(OAuthLoginProvider::Wechat.allows_navigation(
            &Url::parse("https://open.weixin.qq.com/connect/qrconnect").unwrap()
        ));
        assert!(!OAuthLoginProvider::Wechat
            .allows_navigation(&Url::parse("https://graph.qq.com/oauth2.0/show").unwrap()));
        let allowlist = OAuthLoginProvider::Qq.navigation_allowlist();
        assert!(url_matches_oauth_allowlist(
            &Url::parse("https://graph.qq.com/oauth2.0/show").unwrap(),
            &allowlist
        ));
        assert!(!url_matches_oauth_allowlist(
            &Url::parse("https://graph.qq.com.evil.example/oauth2.0/show").unwrap(),
            &allowlist
        ));
    }

    #[test]
    fn callback_requires_exact_redirect_shape_single_state_and_matching_provider() {
        let valid = Url::parse(&format!(
            "https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https%3A%2F%2Fy.qq.com%2F&code=SAFE_CODE&state={STATE}"
        ))
        .unwrap();
        let OAuthCallback::Code(code) =
            parse_callback(OAuthLoginProvider::Qq, &valid, STATE).expect("callback")
        else {
            panic!("expected authorization code");
        };
        assert_eq!(code, "SAFE_CODE");

        for rejected in [
            format!("https://y.qq.com/portal/wx_redirect.html?login_type=2&surl=https%3A%2F%2Fy.qq.com%2F&code=SAFE_CODE&state={STATE}"),
            format!("https://y.qq.com.evil.example/portal/wx_redirect.html?login_type=1&surl=https%3A%2F%2Fy.qq.com%2F&code=SAFE_CODE&state={STATE}"),
            "https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https%3A%2F%2Fy.qq.com%2F&code=SAFE_CODE&state=wrong".to_owned(),
            format!("https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https%3A%2F%2Fy.qq.com%2F&code=SAFE_CODE&state={STATE}&state={STATE}"),
        ] {
            assert!(parse_callback(OAuthLoginProvider::Qq, &Url::parse(&rejected).unwrap(), STATE).is_err());
        }
    }
}
