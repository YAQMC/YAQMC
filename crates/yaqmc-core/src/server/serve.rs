//! Stdio/duplex protocol server: handshake, request dispatch, event frames, EOF shutdown.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::mpsc;

use yaqmc_protocol::{
    core_handshake, CoreIdentity, CoreMessage, CoreTransport, HandshakeError, ProtocolError,
    WindowOrigin, CHANNEL_PREFERENCES_CHANGED,
};

use super::{CoreRuntime, EventSink, HostDispatchHooks};
use crate::diagnostics::AppSection;
use crate::platform::PlatformDiagnostics;
use crate::CoreHandle;

struct ChannelSink {
    sender: mpsc::UnboundedSender<CoreMessage>,
    seq: AtomicU64,
}

impl EventSink for ChannelSink {
    fn emit(&self, _source_seq: u64, channel: &str, payload: &Value) {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
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
    let attach = core_handshake(&mut transport, identity_from_core(&core)).await?;
    tracing::info!(
        target: "core.protocol",
        protocol = attach.protocol,
        "host attached"
    );

    let (events_tx, mut events_rx) = mpsc::unbounded_channel();
    let (replies_tx, mut replies_rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(ChannelSink {
        sender: events_tx,
        seq: AtomicU64::new(0),
    });
    let host = StdioNotifyHost::new(host, Arc::clone(&sink));
    let runtime = Arc::new(CoreRuntime::start(core, host, sink).await);

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
                        let runtime = Arc::clone(&runtime);
                        let replies_tx = replies_tx.clone();
                        tokio::spawn(async move {
                            let body = runtime.invoke(origin, &method, params).await;
                            let _ = replies_tx.send((id, body));
                        });
                    }
                    Ok(CoreMessage::Shutdown { .. }) => {
                        runtime.shutdown(true).await;
                        transport.send(&CoreMessage::ShutdownAck).await?;
                        break;
                    }
                    Ok(_) => {
                        return Err(ProtocolError::Handshake(HandshakeError::UnexpectedMessage));
                    }
                    Err(ProtocolError::Closed) => {
                        tracing::info!(target: "core.protocol", "stdin EOF; shutting down");
                        runtime.shutdown(false).await;
                        break;
                    }
                    Err(error) => return Err(error),
                }
            }
        }
    }
    Ok(())
}
