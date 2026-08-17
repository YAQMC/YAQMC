use std::sync::{
    Arc,
    atomic::{AtomicU8, Ordering},
};

use tauri::{
    AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
    webview::NewWindowResponse,
};
use yaqmc_core::qqmusic::{
    OAuthLoginProvider, ProviderResult, QQMusicError, QQMusicService, account::AccountSnapshot,
    url_matches_oauth_allowlist,
};
use yaqmc_core::server::ops;

const OAUTH_WINDOW_PREFIX: &str = "qqmusic-oauth-";
const WINDOW_OPEN: u8 = 0;
const WINDOW_COMPLETING: u8 = 1;
const WINDOW_FINISHED: u8 = 2;

pub(crate) async fn open_window(
    app: &AppHandle,
    main_window: &WebviewWindow,
    service: Arc<QQMusicService>,
    login_provider: OAuthLoginProvider,
) -> ProviderResult<AccountSnapshot> {
    close_all_windows(app);
    let prepared = ops::auth_oauth_prepare(&service, login_provider).await?;
    let label = window_label(&prepared.attempt_id);
    let phase = Arc::new(AtomicU8::new(WINDOW_OPEN));
    let authorization_url =
        reqwest::Url::parse(&prepared.url).map_err(|_| QQMusicError::Protocol)?;

    let navigation_phase = Arc::clone(&phase);
    let navigation_service = Arc::clone(&service);
    let navigation_app = app.clone();
    let navigation_label = label.clone();
    let navigation_attempt = prepared.attempt_id.clone();
    let allowlist = prepared.navigation_allowlist.clone();
    let callback_prefix = prepared.callback_matcher.url_prefix.clone();
    let (width, height, min_width, min_height) = window_dimensions(login_provider);
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(authorization_url))
        .title(window_title(login_provider))
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
            if url.as_str().starts_with(&callback_prefix) {
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
                        if let Err(error) = ops::auth_oauth_complete(
                            &callback_service,
                            &callback_attempt,
                            callback_url,
                        )
                        .await
                        {
                            tracing::warn!(
                                target: "qqmusic.auth",
                                provider = login_provider.as_str(),
                                error_code = error.code.as_str(),
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
            url_matches_oauth_allowlist(url, &allowlist)
        });
    let builder = match builder.parent(main_window) {
        Ok(builder) => builder,
        Err(_) => {
            let _ = ops::auth_oauth_cancel(&service, &prepared.attempt_id).await;
            return Err(QQMusicError::Protocol.into());
        }
    };
    let oauth_window = match builder.build() {
        Ok(window) => window,
        Err(_) => {
            let _ = ops::auth_oauth_cancel(&service, &prepared.attempt_id).await;
            return Err(QQMusicError::Protocol.into());
        }
    };

    let close_phase = Arc::clone(&phase);
    let close_service = Arc::clone(&service);
    let close_attempt = prepared.attempt_id.clone();
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
                let _ = ops::auth_oauth_cancel(&service, &attempt_id).await;
            });
        }
    });
    if oauth_window.show().is_err() || oauth_window.set_focus().is_err() {
        phase.store(WINDOW_FINISHED, Ordering::Release);
        let _ = oauth_window.close();
        let _ = ops::auth_oauth_cancel(&service, &prepared.attempt_id).await;
        return Err(QQMusicError::Protocol.into());
    }
    Ok(prepared.snapshot)
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

fn window_title(provider: OAuthLoginProvider) -> &'static str {
    match provider {
        OAuthLoginProvider::Qq => "QQ 官方登录 — YAQMC",
        OAuthLoginProvider::Wechat => "微信官方登录 — YAQMC",
    }
}

fn window_dimensions(provider: OAuthLoginProvider) -> (f64, f64, f64, f64) {
    match provider {
        OAuthLoginProvider::Qq => (920.0, 720.0, 720.0, 560.0),
        OAuthLoginProvider::Wechat => (520.0, 660.0, 440.0, 560.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::Url;

    #[test]
    fn official_login_windows_use_provider_specific_geometry() {
        let qq = window_dimensions(OAuthLoginProvider::Qq);
        let wechat = window_dimensions(OAuthLoginProvider::Wechat);
        assert!(qq.0 > wechat.0);
        assert!(wechat.0 >= wechat.2);
        assert!(wechat.1 >= wechat.3);
        assert_eq!(
            window_title(OAuthLoginProvider::Wechat),
            "微信官方登录 — YAQMC"
        );
    }

    #[test]
    fn window_code_consumes_prepare_allowlist_and_callback_prefix() {
        let source = include_str!("qqmusic_oauth_host.rs");
        assert!(source.contains("ops::auth_oauth_prepare"));
        assert!(source.contains("ops::auth_oauth_complete"));
        assert!(source.contains("ops::auth_oauth_cancel"));
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
}
