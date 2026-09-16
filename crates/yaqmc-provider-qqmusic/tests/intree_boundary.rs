use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use reqwest::Url;
use tempfile::tempdir;
use yaqmc_core::{
    credentials::{CredentialError, CredentialStore},
    storage::StorageService,
};
use yaqmc_provider_qqmusic::qqmusic::{OAuthLoginProvider, QQMusicService};

#[test]
fn account_writes_have_no_legacy_encoder_or_test_only_execution_path() {
    let service = include_str!("../src/qqmusic/account.rs");
    let adapter = include_str!("../src/qmapi/account.rs")
        .split("#[cfg(test)]")
        .next()
        .expect("production adapter source");
    for retired in [
        "typed_write_from_legacy",
        "authenticated_musicu_write_request",
        "EditPlaylistPayload",
    ] {
        assert!(!service.contains(retired), "retired encoder: {retired}");
        assert!(!adapter.contains(retired), "retired adapter: {retired}");
    }
    assert!(!adapter.contains("music.musicasset."));
    assert!(!adapter.contains("request_cgi("));
    assert!(adapter.contains("operation: AccountWrite,"));
    let write = service
        .split_once("async fn execute_playlist_write(")
        .unwrap()
        .1
        .split_once("async fn fetch_all_playlist_summaries(")
        .unwrap()
        .0;
    assert!(
        !write.contains("#[cfg("),
        "tests must use the production path"
    );
    assert!(write.contains("write: AccountWrite,"));
    assert!(write.contains("crate::qmapi::account::execute_account_write("));
    assert_eq!(
        write
            .matches("self.auth.ensure_current(&context.epoch)")
            .count(),
        2
    );
    let detail_read = service
        .split_once("async fn fetch_playlist_page(")
        .unwrap()
        .1
        .split_once("async fn playlist_contains_track(")
        .unwrap()
        .0;
    assert!(detail_read.contains(".read_account_page("));
    assert!(detail_read.contains("AccountRead::PlaylistTracks"));
    assert!(!detail_read.contains("musicu_request("));
    assert!(!detail_read.contains("CgiGetDiss"));
}

#[test]
fn account_lists_have_no_business_http_or_legacy_request_builder() {
    let source = include_str!("../src/qqmusic/account.rs");
    for retired in [
        "fn musicu_request(",
        "fn account_headers(",
        "async fn execute_read(",
        "async fn execute_account_transport(",
        "fn cookie_value",
        ".execute(TransportRequest",
        ".request_http(",
        ".request_cgi(",
    ] {
        assert!(!source.contains(retired), "retired account HTTP: {retired}");
    }
    let production = source.split("mod tests {").next().unwrap();
    for endpoint in [
        "GetPlaylistByUin",
        "CgiGetPlaylistFavInfo",
        "music.musicasset.",
    ] {
        assert!(
            !production.contains(endpoint),
            "wire endpoint belongs in qm-api-rs: {endpoint}"
        );
    }
    assert!(production.contains("AccountRead::OwnedPlaylists"));
    assert!(production.contains("AccountRead::CollectedPlaylists"));
}

// The host maps UI fields; upstream artwork URL/size decoding belongs to the library.
#[test]
fn artwork_mapping_does_not_construct_upstream_photo_urls() {
    let source = include_str!("../src/qqmusic/artwork.rs");
    let production = source.split("#[cfg(test)]").next().unwrap();
    assert!(production.contains("qqmusic_api::artwork::album(mid)"));
    assert!(production.contains("qqmusic_api::artwork::from_url(source)"));
    for forbidden in [
        "https://",
        "T002R",
        "photo_new",
        "Url::parse",
        "VERIFIED_ALBUM_SIZES",
    ] {
        assert!(
            !production.contains(forbidden),
            "artwork protocol duplicated: {forbidden}"
        );
    }
}

#[test]
fn artwork_downloads_cross_the_library_and_provider_neutral_cache_boundary() {
    let service = include_str!("../src/qqmusic.rs");
    assert!(!service.contains("artwork_http"));
    assert!(service.contains("QmapiArtworkFetcher(&self.client.catalog)"));
    let cache_api = include_str!("../../yaqmc-provider-api/src/storage.rs");
    assert!(!cache_api.contains("reqwest::Client"));
    assert!(cache_api.contains("fetcher: &dyn ArtworkFetcher"));
    let adapter = include_str!("../src/qmapi/artwork.rs");
    assert!(adapter.contains("qqmusic_api::artwork::download"));
    assert!(!adapter.contains("https://"));
}

#[test]
fn oauth_exchange_sends_only_through_the_library() {
    let source = include_str!("../src/qqmusic/auth.rs");
    let start = source
        .find("async fn exchange_code(")
        .expect("exchange_code must exist")
        + "async fn exchange_code(".len();
    let rest = &source[start..];
    let end = rest
        .find("\n    async fn ")
        .expect("exchange_code must be followed by another method");
    let exchange = &rest[..end];
    assert!(exchange.contains("qqmusic_api::auth::exchange_oauth_code("));
    for forbidden in [
        "TransportRequest",
        "login_payload",
        "session_from_login_payload",
        "#[cfg(",
        "https://",
    ] {
        assert!(
            !exchange.contains(forbidden),
            "duplicated exchange protocol: {forbidden}"
        );
    }
    assert!(!source.contains("fn session_from_login_payload("));
}

#[test]
fn session_validation_delegates_to_qmapi_without_test_forks() {
    let source = include_str!("../src/qqmusic/auth.rs");
    let start = source
        .find("async fn validate_session(")
        .expect("validate_session must exist")
        + "async fn validate_session(".len();
    let rest = &source[start..];
    let end = rest
        .find("\nstruct ActiveAttempt")
        .expect("validate_session ends before ActiveAttempt");
    let validation = &rest[..end];
    assert!(validation.contains("crate::qmapi::auth::fetch_profile("));
    for forbidden in [
        "TransportRequest",
        "GetLoginUserInfo",
        "#[cfg(",
        "QQ_MUSICU_URL",
        "https://",
    ] {
        assert!(
            !validation.contains(forbidden),
            "unwanted legacy construct in validate_session: {forbidden}"
        );
    }
}

#[derive(Default)]
struct TestCredentialStore {
    secrets: Mutex<HashMap<String, String>>,
}

impl CredentialStore for TestCredentialStore {
    fn load(&self, account: &str) -> Result<Option<String>, CredentialError> {
        Ok(self
            .secrets
            .lock()
            .expect("credential lock")
            .get(account)
            .cloned())
    }

    fn save(&self, account: &str, secret: &str) -> Result<(), CredentialError> {
        self.secrets
            .lock()
            .expect("credential lock")
            .insert(account.to_owned(), secret.to_owned());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), CredentialError> {
        self.secrets
            .lock()
            .expect("credential lock")
            .remove(account);
        Ok(())
    }
}

#[tokio::test]
async fn qqmusic_service_and_oauth_policy_are_provider_owned() {
    let fixture = include_str!("fixtures/qqmusic/search-song.json");
    assert!(fixture.contains("SANITIZED_TRACK_MID"));
    let root = tempdir().expect("temporary storage root");
    let service = Arc::new(
        QQMusicService::new(
            Arc::new(
                StorageService::open(root.path().join("data"), root.path().join("cache"))
                    .expect("temporary storage"),
            ),
            Arc::new(TestCredentialStore::default()),
            root.path().join("fixtures"),
        )
        .expect("in-tree QQ Music provider"),
    );
    assert_eq!(OAuthLoginProvider::Qq.as_str(), "qq");
    assert!(OAuthLoginProvider::Qq.allows_navigation(
        &Url::parse("https://graph.qq.com/oauth2.0/show").expect("allowlisted URL")
    ));
    assert!(!OAuthLoginProvider::Qq.allows_navigation(
        &Url::parse("https://graph.qq.com.evil.example/").expect("rejected URL")
    ));

    let launch = service
        .start_oauth_login(OAuthLoginProvider::Wechat)
        .await
        .expect("portable OAuth launch");
    assert_eq!(
        launch.authorization_url.host_str(),
        Some("open.weixin.qq.com")
    );
    service
        .cancel_oauth_login(&launch.attempt_id)
        .await
        .expect("portable OAuth cancellation");
}
