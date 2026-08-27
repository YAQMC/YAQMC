//! Stdio/duplex protocol server: handshake, request dispatch, event frames, EOF shutdown.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::mpsc;

use yaqmc_protocol::{
    core_handshake, CoreIdentity, CoreMessage, CoreTransport, HandshakeError, ProtocolError,
    ResponseBody, WindowOrigin, CHANNEL_PREFERENCES_CHANGED,
};

use super::{
    dispatch, spawn_host_command_fanout, spawn_player_fanout, EventSink, HostDispatchHooks,
};
use crate::diagnostics::AppSection;
use crate::platform::PlatformDiagnostics;
use crate::CoreHandle;

struct ChannelSink {
    sender: mpsc::UnboundedSender<CoreMessage>,
}

impl EventSink for ChannelSink {
    fn emit(&self, seq: u64, channel: &str, payload: &Value) {
        let _ = self.sender.send(CoreMessage::Event {
            seq,
            channel: channel.to_owned(),
            payload: payload.clone(),
        });
    }
}

/// Stdio composition: the host hook emits `preferences://changed`.
/// `NoopHost` is silent, so Electron never rebuilt the tray. Forward the stored
/// document as a JSON string, preserving the renderer event payload contract.
struct StdioNotifyHost<H> {
    inner: H,
    sink: Arc<dyn EventSink>,
    seq: AtomicU64,
}

impl<H> StdioNotifyHost<H> {
    fn new(inner: H, sink: Arc<dyn EventSink>) -> Self {
        Self {
            inner,
            sink,
            seq: AtomicU64::new(0),
        }
    }
}

impl<H: HostDispatchHooks> HostDispatchHooks for StdioNotifyHost<H> {
    fn platform_diagnostics(&self) -> PlatformDiagnostics {
        self.inner.platform_diagnostics()
    }

    fn download_dir(&self) -> PathBuf {
        self.inner.download_dir()
    }

    fn app_section(&self) -> AppSection {
        self.inner.app_section()
    }

    fn diagnostic_collector_script(&self) -> &'static str {
        self.inner.diagnostic_collector_script()
    }

    fn diagnostic_readme(&self) -> &'static str {
        self.inner.diagnostic_readme()
    }

    fn renderer_label(&self, platform: &PlatformDiagnostics) -> String {
        self.inner.renderer_label(platform)
    }

    fn notify_preferences_changed(&self, value: &str) {
        self.inner.notify_preferences_changed(value);
        let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        self.sink.emit(
            seq,
            CHANNEL_PREFERENCES_CHANGED,
            &Value::String(value.to_owned()),
        );
    }

    fn notify_plugin_changed(&self) {
        self.inner.notify_plugin_changed();
    }

    fn oauth_window_is_live(&self, attempt_id: &str) -> bool {
        self.inner.oauth_window_is_live(attempt_id)
    }

    fn close_oauth_window(&self, attempt_id: &str) {
        self.inner.close_oauth_window(attempt_id);
    }
}

fn identity_from_core(core: &CoreHandle) -> CoreIdentity {
    CoreIdentity {
        version: env!("CARGO_PKG_VERSION").to_owned(),
        commit: core.config().build_commit.clone(),
        channel: core.config().release_channel.clone(),
    }
}

/// Handshake, then serve requests/events until shutdown or stdin EOF.
pub async fn serve_protocol<T, H>(
    core: CoreHandle,
    host: H,
    mut transport: T,
) -> Result<(), ProtocolError>
where
    T: CoreTransport,
    H: HostDispatchHooks + 'static,
{
    let host_commands = core.subscribe_host_commands();
    let system_media = core.start_system_media();
    let attach = core_handshake(&mut transport, identity_from_core(&core)).await?;
    tracing::info!(
        target: "core.protocol",
        protocol = attach.protocol,
        "host attached"
    );

    if let Err(error) = core.local_api().start_if_enabled().await {
        // A persisted bind failure must remain visible through local_api_status,
        // but it must not prevent the desktop host from attaching.
        tracing::warn!(
            target: "local_api",
            error = %error,
            "failed to restore the enabled local API listener"
        );
    }

    // Electron composition point: position/EOS fan-out lives here.
    core.player()
        .start_clock_on_runtime(&tokio::runtime::Handle::current());
    // Restore the account session after bootstrap. Electron must
    // await it before the request loop: `account://changed` is unused, so a
    // first snapshot that still sees guest stays guest after restart.
    core.qq_music().restore_session().await;

    let core = Arc::new(core);
    let (events_tx, mut events_rx) = mpsc::unbounded_channel();
    let (replies_tx, mut replies_rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(ChannelSink { sender: events_tx });
    let host = Arc::new(StdioNotifyHost::new(host, Arc::clone(&sink)));
    spawn_player_fanout(
        &tokio::runtime::Handle::current(),
        core.player(),
        core.storage(),
        system_media,
        Arc::clone(&sink),
    );
    spawn_host_command_fanout(&tokio::runtime::Handle::current(), host_commands, sink);

    let mut events_open = true;
    let mut replies_open = true;
    loop {
        tokio::select! {
            event = events_rx.recv(), if events_open => {
                match event {
                    Some(event) => transport.send(&event).await?,
                    None => events_open = false,
                }
            }
            reply = replies_rx.recv(), if replies_open => {
                match reply {
                    Some((id, body)) => {
                        transport
                            .send(&CoreMessage::Response { id, body })
                            .await?;
                    }
                    None => replies_open = false,
                }
            }
            incoming = transport.recv() => {
                match incoming {
                    Ok(CoreMessage::Request {
                        id,
                        method,
                        params,
                        origin,
                    }) => {
                        // Catalog rebuilds (home refresh) can take several seconds.
                        // Await them on this task and Electron's 5s×3 ping watchdog
                        // kills a live Core; spawn so core_ping and player events
                        // still flush.
                        let origin = origin.unwrap_or(WindowOrigin::Host);
                        let core = Arc::clone(&core);
                        let host = Arc::clone(&host);
                        let replies_tx = replies_tx.clone();
                        tokio::spawn(async move {
                            let result = dispatch(
                                core.as_ref(),
                                host.as_ref(),
                                origin,
                                &method,
                                params,
                            )
                            .await;
                            let body = match result {
                                Ok(value) => ResponseBody::success(value),
                                Err(error) => ResponseBody::failure(error.into_core_error()),
                            };
                            let _ = replies_tx.send((id, body));
                        });
                    }
                    Ok(CoreMessage::Shutdown { .. }) => {
                        persist_queue(&core).await;
                        core.player().stop_clock();
                        // Mark the plugin journal clean on host Exit.
                        // Electron's graceful protocol shutdown must do the same,
                        // or the next boot treats a normal quit as a crash loop.
                        core.plugins().mark_clean_exit();
                        core.shutdown();
                        transport.send(&CoreMessage::ShutdownAck).await?;
                        break;
                    }
                    Ok(_) => {
                        return Err(ProtocolError::Handshake(HandshakeError::UnexpectedMessage));
                    }
                    Err(ProtocolError::Closed) => {
                        tracing::info!(target: "core.protocol", "stdin EOF; shutting down");
                        persist_queue(&core).await;
                        core.player().stop_clock();
                        core.shutdown();
                        break;
                    }
                    Err(error) => return Err(error),
                }
            }
        }
    }
    Ok(())
}

async fn persist_queue(core: &CoreHandle) {
    let snapshot = core.player().snapshot().await;
    if let Err(error) = core.storage().save_queue(&snapshot) {
        tracing::warn!(target: "storage", error = %error, "queue persistence failed during shutdown");
    }
}
