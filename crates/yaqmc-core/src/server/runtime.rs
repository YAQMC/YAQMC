//! In-process Core runtime shared by protocol transports and native facades.

#[cfg(feature = "plugins")]
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::Value;
use yaqmc_protocol::{CoreError, ResponseBody, WindowOrigin};

use super::{
    dispatch, spawn_account_restore_fanout, spawn_host_command_fanout,
    spawn_player_fanout_with_profiles, EventSink, HostDispatchHooks,
};
use crate::CoreHandle;

/// A transport-independent Core session.
///
/// `CoreRuntime` owns the event fan-out workers and exposes the same authorized
/// dispatch path used by Electron. Transports only need to provide an
/// [`EventSink`] and forward responses returned by [`invoke`].
pub struct CoreRuntime<H> {
    core: Arc<CoreHandle>,
    host: Arc<H>,
    #[cfg(feature = "plugins")]
    plugin_events: Arc<dyn EventSink>,
    #[cfg(feature = "plugins")]
    plugin_event_sequence: Arc<AtomicU64>,
}

impl<H> CoreRuntime<H>
where
    H: HostDispatchHooks + 'static,
{
    /// Start the in-process services and event fan-out workers.
    pub async fn start(core: CoreHandle, host: H, sink: Arc<dyn EventSink>) -> Self {
        let host_commands = core.subscribe_host_commands();
        let system_media = core.start_system_media();

        if let Err(error) = core.local_api().start_if_enabled().await {
            // A persisted bind failure remains visible through local_api_status,
            // but must not prevent the host from attaching.
            tracing::warn!(
                target: "local_api",
                error = %error,
                "failed to restore the enabled local API listener"
            );
        }

        core.player()
            .start_clock_on_runtime(&tokio::runtime::Handle::current());
        let core = Arc::new(core);
        spawn_player_fanout_with_profiles(
            &tokio::runtime::Handle::current(),
            core.player(),
            core.storage(),
            system_media,
            core.provider_profiles(),
            Arc::clone(&sink),
        );
        spawn_account_restore_fanout(
            &tokio::runtime::Handle::current(),
            Arc::clone(&core),
            Arc::clone(&sink),
        );
        spawn_host_command_fanout(
            &tokio::runtime::Handle::current(),
            host_commands,
            Arc::clone(&sink),
        );

        #[cfg(feature = "plugins")]
        let plugin_event_sequence = Arc::new(AtomicU64::new(0));
        #[cfg(feature = "plugins")]
        {
            let plugins = core.plugins();
            if let Some(bridge) = plugins.local_files_bridge() {
                let mut requests = bridge.subscribe();
                let events = sink.clone();
                let shutdown = core.subscribe_shutdown();
                tokio::spawn(async move {
                    let mut shutdown = shutdown;
                    loop {
                        tokio::select! {
                            _ = shutdown.changed() => break,
                            result = requests.recv() => match result {
                                // Private native RPC is out-of-band and does not consume public event sequence IDs.
                                Ok(payload) => events.emit(0, crate::plugin::local_files::CHANNEL, &payload),
                                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                                Err(_) => break,
                            }
                        }
                    }
                });
            }
            plugins.start_update_service(Arc::downgrade(&core));
            let mut updates = plugins.subscribe_updates();
            let events = sink.clone();
            let sequence = plugin_event_sequence.clone();
            let weak = Arc::downgrade(&plugins);
            let shutdown = plugins.update_shutdown();
            tokio::spawn(async move {
                loop {
                    match tokio::select! { _ = shutdown.cancelled() => break, result = updates.recv() => result }
                    {
                        Ok(update) => {
                            events.emit(
                                sequence.fetch_add(1, Ordering::Relaxed) + 1,
                                yaqmc_protocol::CHANNEL_PLUGIN_UPDATE_PROGRESS,
                                &serde_json::to_value(&update).unwrap_or_default(),
                            );
                            if update.terminal() && update.runtime_changed {
                                if let (Some(plugins), Some(id)) =
                                    (weak.upgrade(), &update.plugin_id)
                                {
                                    let enabled =
                                        plugins.list().iter().any(|r| &r.id == id && r.enabled);
                                    events.emit(sequence.fetch_add(1, Ordering::Relaxed) + 1, yaqmc_protocol::CHANNEL_PLUGIN_CHANGED, &serde_json::json!({"pluginId": id, "enabled": enabled, "updateOperationId": update.operation_id}));
                                }
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(_) => break,
                    }
                }
            });
        }
        Self {
            core,
            host: Arc::new(host),
            #[cfg(feature = "plugins")]
            plugin_events: sink,
            #[cfg(feature = "plugins")]
            plugin_event_sequence,
        }
    }

    pub fn core(&self) -> &CoreHandle {
        self.core.as_ref()
    }

    pub fn core_arc(&self) -> Arc<CoreHandle> {
        Arc::clone(&self.core)
    }

    /// Dispatch one request on the shared Core method path.
    pub async fn invoke(
        &self,
        origin: WindowOrigin,
        method: &str,
        params: Option<Value>,
    ) -> ResponseBody {
        #[cfg(feature = "plugins")]
        let plugin_id = params
            .as_ref()
            .and_then(|params| params.get("request").unwrap_or(params).get("id"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        match dispatch(
            self.core.as_ref(),
            self.host.as_ref(),
            origin,
            method,
            params,
        )
        .await
        {
            Ok(value) => {
                #[cfg(feature = "plugins")]
                self.emit_plugin_mutation(method, plugin_id.as_deref(), &value);
                ResponseBody::success(value)
            }
            Err(error) => ResponseBody::failure(error.into_core_error()),
        }
    }

    #[cfg(feature = "plugins")]
    fn emit_plugin_mutation(&self, method: &str, plugin_id: Option<&str>, result: &Value) {
        let changes: Vec<(String, bool)> = match method {
            "plugin_install"
            | "plugin_install_from"
            | "plugin_install_unpacked"
            | "plugin_set_enabled"
            | "plugin_reload"
            | "plugin_mark_failed" => result
                .get("id")
                .and_then(Value::as_str)
                .zip(result.get("enabled").and_then(Value::as_bool))
                .map(|(id, enabled)| (id.to_owned(), enabled))
                .into_iter()
                .collect(),
            "plugin_settings_set" => self
                .core
                .plugins()
                .list()
                .into_iter()
                .find(|record| Some(record.id.as_str()) == plugin_id)
                .map(|record| (record.id, record.enabled))
                .into_iter()
                .collect(),
            "plugin_uninstall" => plugin_id
                .map(|id| (id.to_owned(), false))
                .into_iter()
                .collect(),
            "plugin_set_safe_mode" | "plugin_set_developer_mode" => self
                .core
                .plugins()
                .list()
                .into_iter()
                .map(|record| (record.id, record.enabled))
                .collect(),
            _ => return,
        };
        for (plugin_id, enabled) in changes {
            let sequence = self.plugin_event_sequence.fetch_add(1, Ordering::Relaxed) + 1;
            self.plugin_events.emit(
                sequence,
                yaqmc_protocol::CHANNEL_PLUGIN_CHANGED,
                &serde_json::json!({ "pluginId": plugin_id, "enabled": enabled }),
            );
        }
    }

    /// Persist playback state and stop all Core-owned workers.
    pub async fn shutdown(&self, graceful: bool) {
        #[cfg(feature = "plugins")]
        self.core.plugins().stop_update_service();
        let snapshot = self.core.player().snapshot().await;
        if let Err(error) = self.core.storage().save_queue(&snapshot) {
            tracing::warn!(target: "storage", error = %error, "queue persistence failed during shutdown");
        }
        self.core.player().stop_clock();
        if graceful {
            // A clean journal is required for the next boot not to enter the
            // crash-recovery path.
            self.core.plugins().mark_clean_exit();
        }
        self.core.shutdown();
    }
}

/// A small sink useful to native callers that only need serialized events.
pub struct JsonEventSink<F> {
    callback: F,
}

impl<F> JsonEventSink<F> {
    pub fn new(callback: F) -> Self {
        Self { callback }
    }
}

impl<F> EventSink for JsonEventSink<F>
where
    F: Fn(u64, &str, &Value) + Send + Sync + 'static,
{
    fn emit(&self, seq: u64, channel: &str, payload: &Value) {
        (self.callback)(seq, channel, payload)
    }
}

/// Construct a protocol-shaped unavailable error for platform-disabled APIs.
pub fn unavailable_error(feature: &'static str) -> CoreError {
    CoreError {
        code: "core.unavailable".to_owned(),
        message: format!("{feature} is unavailable in this Core build"),
        details: None,
        retryable: false,
    }
}
