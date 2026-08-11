use super::{account::AccountSnapshot, QQMusicError, QQMusicService};
use reqwest::Url;
use serde::Deserialize;
use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc,
};
use tauri::{
    webview::NewWindowResponse, AppHandle, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

const QQ_CLIENT_ID: &str = "100497308";
const WECHAT_APP_ID: &str = "wx48db31d50e334801";
const QQ_REDIRECT_URI: &str =
    "https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/";
const WECHAT_REDIRECT_URI: &str =
    "https://y.qq.com/portal/wx_redirect.html?login_type=2&surl=https://y.qq.com/";
const OAUTH_WINDOW_PREFIX: &str = "qqmusic-oauth-";
const WINDOW_OPEN: u8 = 0;
const WINDOW_COMPLETING: u8 = 1;
const WINDOW_FINISHED: u8 = 2;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum OAuthLoginProvider {
    Qq,
    Wechat,
}

impl OAuthLoginProvider {
    pub(crate) fn as_str(self) -> &'static str {
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

    fn title(self) -> &'static str {
        match self {
            Self::Qq => "QQ 官方登录 — YAQMC",
            Self::Wechat => "微信官方登录 — YAQMC",
        }
    }

    fn window_dimensions(self) -> (f64, f64, f64, f64) {
        match self {
            Self::Qq => (920.0, 720.0, 720.0, 560.0),
            Self::Wechat => (520.0, 660.0, 440.0, 560.0),
        }
    }

    pub(crate) fn authorization_url(self, state: &str) -> Result<Url, QQMusicError> {
        if state.len() != 32 || !state.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(QQMusicError::Protocol);
        }
        let mut url = match self {
            Self::Qq => Url::parse("https://graph.qq.com/oauth2.0/show"),
            Self::Wechat => Url::parse("https://open.weixin.qq.com/connect/qrconnect"),
        }
        .map_err(|_| QQMusicError::Protocol)?;
        {
            let mut query = url.query_pairs_mut();
            match self {
                Self::Qq => {
                    query
                        .append_pair("which", "Login")
                        .append_pair("display", "pc")
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

    pub(crate) fn is_callback_url(self, url: &Url) -> bool {
        secure_https_url(url)
            && url.host_str() == Some("y.qq.com")
            && url.path() == "/portal/wx_redirect.html"
            && exactly_one_query_value(url, "login_type").as_deref() == Some(self.login_type())
    }

    pub(crate) fn allows_navigation(self, url: &Url) -> bool {
        if self.is_callback_url(url) {
            return true;
        }
        if !secure_https_url(url) {
            return false;
        }
        let host = url.host_str();
        match self {
            Self::Qq => matches!(
                host,
                Some(
                    "graph.qq.com"
                        | "xui.ptlogin2.qq.com"
                        | "ssl.ptlogin2.qq.com"
                        | "ssl.ptlogin2.graph.qq.com"
                        | "ui.ptlogin2.qq.com"
                )
            ),
            Self::Wechat => matches!(host, Some("open.weixin.qq.com" | "lp.open.weixin.qq.com")),
        }
    }
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

pub(crate) struct OAuthLaunch {
    pub(crate) attempt_id: String,
    pub(crate) authorization_url: Url,
    pub(crate) snapshot: AccountSnapshot,
}

pub(crate) async fn open_window(
    app: &AppHandle,
    main_window: &WebviewWindow,
    service: Arc<QQMusicService>,
    login_provider: OAuthLoginProvider,
) -> Result<AccountSnapshot, QQMusicError> {
    close_all_windows(app);
    let launch = service.start_oauth_login(login_provider).await?;
    let label = window_label(&launch.attempt_id);
    let phase = Arc::new(AtomicU8::new(WINDOW_OPEN));

    let navigation_phase = Arc::clone(&phase);
    let navigation_service = Arc::clone(&service);
    let navigation_app = app.clone();
    let navigation_label = label.clone();
    let navigation_attempt = launch.attempt_id.clone();
    let (width, height, min_width, min_height) = login_provider.window_dimensions();
    let builder = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::External(launch.authorization_url.clone()),
    )
    .title(login_provider.title())
    .inner_size(width, height)
    .min_inner_size(min_width, min_height)
    .resizable(true)
    .decorations(true)
    .incognito(true)
    .general_autofill_enabled(false)
    .devtools(false)
    .visible(false)
    .center()
    .on_new_window(|_, _| NewWindowResponse::Deny)
    .on_navigation(move |url| {
        if login_provider.is_callback_url(url) {
            if navigation_phase
                .compare_exchange(
                    WINDOW_OPEN,
                    WINDOW_COMPLETING,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .is_ok()
            {
                let callback_url = url.clone();
                let callback_service = Arc::clone(&navigation_service);
                let callback_app = navigation_app.clone();
                let callback_label = navigation_label.clone();
                let callback_attempt = navigation_attempt.clone();
                let callback_phase = Arc::clone(&navigation_phase);
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = callback_service
                        .complete_oauth_login(&callback_attempt, login_provider, callback_url)
                        .await
                    {
                        tracing::warn!(
                            target: "qqmusic.auth",
                            provider = login_provider.as_str(),
                            error_code = error.error_code().as_str(),
                            "official OAuth callback did not complete"
                        );
                    }
                    callback_phase.store(WINDOW_FINISHED, Ordering::Release);
                    if let Some(window) = callback_app.get_webview_window(&callback_label) {
                        let _ = window.close();
                    }
                });
            }
            return false;
        }
        login_provider.allows_navigation(url)
    });
    let builder = match builder.parent(main_window) {
        Ok(builder) => builder,
        Err(_) => {
            let _ = service.cancel_oauth_login(&launch.attempt_id).await;
            return Err(QQMusicError::Protocol);
        }
    };
    let oauth_window = match builder.build() {
        Ok(window) => window,
        Err(_) => {
            let _ = service.cancel_oauth_login(&launch.attempt_id).await;
            return Err(QQMusicError::Protocol);
        }
    };

    let close_phase = Arc::clone(&phase);
    let close_service = Arc::clone(&service);
    let close_attempt = launch.attempt_id.clone();
    oauth_window.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
        ) && close_phase
            .compare_exchange(
                WINDOW_OPEN,
                WINDOW_FINISHED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
        {
            let service = Arc::clone(&close_service);
            let attempt_id = close_attempt.clone();
            tauri::async_runtime::spawn(async move {
                let _ = service.cancel_oauth_login(&attempt_id).await;
            });
        }
    });
    if oauth_window.show().is_err() || oauth_window.set_focus().is_err() {
        phase.store(WINDOW_FINISHED, Ordering::Release);
        let _ = oauth_window.close();
        let _ = service.cancel_oauth_login(&launch.attempt_id).await;
        return Err(QQMusicError::Protocol);
    }
    Ok(launch.snapshot)
}

pub(crate) fn close_window_for_attempt(app: &AppHandle, attempt_id: &str) {
    if let Some(window) = app.get_webview_window(&window_label(attempt_id)) {
        let _ = window.close();
    }
}

pub(crate) fn window_is_live(app: &AppHandle, attempt_id: &str) -> bool {
    app.get_webview_window(&window_label(attempt_id))
        .is_some_and(|window| window.url().is_ok())
}

pub(crate) fn close_all_windows(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if label.starts_with(OAUTH_WINDOW_PREFIX) {
            let _ = window.close();
        }
    }
}

fn window_label(attempt_id: &str) -> String {
    format!("{OAUTH_WINDOW_PREFIX}{attempt_id}")
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
        assert!(OAuthLoginProvider::Qq
            .authorization_url("predictable")
            .is_err());
    }

    #[test]
    fn official_login_windows_use_provider_specific_geometry() {
        let qq = OAuthLoginProvider::Qq.window_dimensions();
        let wechat = OAuthLoginProvider::Wechat.window_dimensions();
        assert!(qq.0 > wechat.0);
        assert!(wechat.0 >= wechat.2);
        assert!(wechat.1 >= wechat.3);
        assert_eq!(OAuthLoginProvider::Wechat.title(), "微信官方登录 — YAQMC");
    }

    #[test]
    fn navigation_policy_is_exact_origin_fail_closed() {
        for allowed in [
            "https://graph.qq.com/oauth2.0/show",
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
