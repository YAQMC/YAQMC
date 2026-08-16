use std::sync::Arc;

use tempfile::tempdir;
use yaqmc_core::{
    credentials::MemoryCredentialStore,
    local_api::{LocalApiRunState, LocalApiService},
    player::PlayerService,
};

#[tokio::test]
async fn core_local_api_constructs_with_an_injected_config_path_and_is_disabled_by_default() {
    let directory = tempdir().expect("temporary directory");
    let service = LocalApiService::new(
        directory.path().join("local-api.json"),
        Arc::new(PlayerService::new()),
        Arc::new(MemoryCredentialStore::default()),
    )
    .expect("service constructs from Core-owned collaborators");

    let status = service
        .start_if_enabled()
        .await
        .expect("disabled service reports status");
    assert_eq!(status.state, LocalApiRunState::Disabled);
    assert!(!status.enabled);
    assert_eq!(status.bound_port, None);
}
