use yaqmc_core::system_media::{
    HostCommandPublisher, SystemMediaIntegration, SystemMediaStartConfig,
};
use yaqmc_core::HostCommand;

#[test]
fn system_media_boundary_is_core_owned_and_host_neutral() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("current-thread runtime");
    let host_commands = HostCommandPublisher::default();
    let config = SystemMediaStartConfig {
        windows_hwnd: None,
        windows_start_error: None,
        runtime: runtime.handle().clone(),
        host_commands: host_commands.clone(),
    };

    let _ = std::any::TypeId::of::<SystemMediaIntegration>();
    assert!(config.windows_hwnd.is_none());
    let _ = std::any::TypeId::of::<HostCommandPublisher>();
}

#[test]
fn host_command_subscription_precedes_native_callback_delivery() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("current-thread runtime");
    let host_commands = HostCommandPublisher::default();

    assert!(!host_commands.publish(HostCommand::RaiseMainWindow));
    let mut receiver = host_commands.subscribe();
    assert!(host_commands.publish(HostCommand::RaiseMainWindow));
    assert_eq!(
        runtime
            .block_on(receiver.recv())
            .expect("subscribed command"),
        HostCommand::RaiseMainWindow
    );
}
