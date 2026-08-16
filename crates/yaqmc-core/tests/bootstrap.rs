use std::path::PathBuf;

use yaqmc_core::{bootstrap, CoreConfig, CorePaths, HostCommand};

fn supplied_config() -> CoreConfig {
    CoreConfig {
        paths: CorePaths {
            data_dir: PathBuf::from("D:/test-data/not-the-default"),
            cache_dir: PathBuf::from("E:/test-cache/not-the-default"),
            log_dir: PathBuf::from("F:/test-logs/not-the-default"),
            local_api_config_path: PathBuf::from("G:/separate-config/local-api.json"),
        },
        release_channel: "test-channel".to_owned(),
        build_commit: "0123456789abcdef0123456789abcdef01234567".to_owned(),
    }
}

#[test]
fn bootstrap_preserves_all_injected_paths_and_config_without_path_discovery() {
    let config = supplied_config();
    let handle = bootstrap(config.clone()).expect("explicit configuration should bootstrap");

    assert_eq!(handle.config(), &config);
    assert_eq!(
        handle.config().paths.local_api_config_path,
        PathBuf::from("G:/separate-config/local-api.json"),
    );
    assert_ne!(
        handle.config().paths.local_api_config_path,
        handle.config().paths.data_dir.join("local-api.json"),
    );
}

#[test]
fn subscribers_receive_typed_host_commands_in_request_order() {
    let handle = bootstrap(supplied_config()).expect("configuration should bootstrap");
    let mut commands = handle.subscribe_host_commands();

    handle
        .request_host_control(HostCommand::RaiseMainWindow)
        .expect("subscriber should receive raise request");
    handle
        .request_host_control(HostCommand::Quit)
        .expect("subscriber should receive quit request");

    assert_eq!(
        commands.try_recv().expect("first command"),
        HostCommand::RaiseMainWindow,
    );
    assert_eq!(
        commands.try_recv().expect("second command"),
        HostCommand::Quit,
    );
}

#[test]
fn host_command_is_an_exhaustive_typed_surface() {
    fn describe(command: HostCommand) -> &'static str {
        match command {
            HostCommand::RaiseMainWindow => "raise",
            HostCommand::Quit => "quit",
        }
    }

    assert_eq!(describe(HostCommand::RaiseMainWindow), "raise");
    assert_eq!(describe(HostCommand::Quit), "quit");
}

#[test]
fn shutdown_is_idempotent_and_propagates_owned_cancellation_state() {
    let handle = bootstrap(supplied_config()).expect("configuration should bootstrap");
    let mut shutdown = handle.subscribe_shutdown();

    assert!(!handle.is_shutdown());
    assert!(!*shutdown.borrow());

    handle.shutdown();
    let shutdown_changed = shutdown
        .has_changed()
        .expect("core-owned shutdown sender should still exist");
    assert!(shutdown_changed);
    assert!(handle.is_shutdown());
    assert!(*shutdown.borrow_and_update());

    handle.shutdown();
    assert!(handle.is_shutdown());
    assert!(
        !shutdown
            .has_changed()
            .expect("shutdown sender is still owned"),
        "the idempotent second shutdown must not emit another state transition",
    );
}
