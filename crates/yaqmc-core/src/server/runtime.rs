//! In-process Core runtime shared by protocol transports and native facades.

use std::sync::Arc;

use serde_json::Value;
use yaqmc_protocol::{CoreError, ResponseBody, WindowOrigin};

use super::{
    dispatch, spawn_account_restore_fanout, spawn_host_command_fanout, spawn_player_fanout,
    EventSink, HostDispatchHooks,
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
        spawn_player_fanout(
            &tokio::runtime::Handle::current(),
            core.player(),
            core.storage(),
            system_media,
            Arc::clone(&sink),
        );
        spawn_account_restore_fanout(
            &tokio::runtime::Handle::current(),
            Arc::clone(&core),
            Arc::clone(&sink),
        );
        spawn_host_command_fanout(&tokio::runtime::Handle::current(), host_commands, sink);

        Self {
            core,
            host: Arc::new(host),
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
        match dispatch(
            self.core.as_ref(),
            self.host.as_ref(),
            origin,
            method,
            params,
        )
        .await
        {
            Ok(value) => ResponseBody::success(value),
            Err(error) => ResponseBody::failure(error.into_core_error()),
        }
    }

    /// Persist playback state and stop all Core-owned workers.
    pub async fn shutdown(&self, graceful: bool) {
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
