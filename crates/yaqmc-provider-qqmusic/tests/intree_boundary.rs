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
        .split_once("async fn execute_account_transport(")
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
