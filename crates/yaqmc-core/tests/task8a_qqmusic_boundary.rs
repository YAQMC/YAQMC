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
async fn qqmusic_service_and_oauth_policy_are_core_owned() {
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
        .expect("Core QQ service"),
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
