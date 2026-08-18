//! Stdio/duplex protocol server: handshake, request dispatch, event frames, EOF shutdown.

use std::sync::Arc;

use serde_json::Value;
use tokio::sync::mpsc;

use yaqmc_protocol::{
    core_handshake, CoreIdentity, CoreMessage, CoreTransport, HandshakeError, ProtocolError,
    ResponseBody, WindowOrigin,
};

use super::{
    dispatch, spawn_host_command_fanout, spawn_player_fanout, EventSink, HostDispatchHooks,
};
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

fn identity_from_core(core: &CoreHandle) -> CoreIdentity {
    CoreIdentity {
        version: env!("CARGO_PKG_VERSION").to_owned(),
        commit: core.config().build_commit.clone(),
        channel: core.config().release_channel.clone(),
    }
}

/// Handshake, then serve requests/events until shutdown or stdin EOF.
pub async fn serve_protocol<T: CoreTransport>(
    core: CoreHandle,
    host: &dyn HostDispatchHooks,
    mut transport: T,
) -> Result<(), ProtocolError> {
    let host_commands = core.subscribe_host_commands();
    let system_media = core.start_system_media();
    let attach = core_handshake(&mut transport, identity_from_core(&core)).await?;
    tracing::info!(
        target: "core.protocol",
        protocol = attach.protocol,
        "host attached"
    );

    let (events_tx, mut events_rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(ChannelSink { sender: events_tx });
    spawn_player_fanout(
        &tokio::runtime::Handle::current(),
        core.player(),
        core.storage(),
        system_media,
        Arc::clone(&sink),
    );
    spawn_host_command_fanout(&tokio::runtime::Handle::current(), host_commands, sink);

    let mut events_open = true;
    loop {
        tokio::select! {
            event = events_rx.recv(), if events_open => {
                match event {
                    Some(event) => transport.send(&event).await?,
                    None => events_open = false,
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
                        let origin = origin.unwrap_or(WindowOrigin::Host);
                        let result = dispatch(&core, host, origin, &method, params).await;
                        let body = match result {
                            Ok(value) => ResponseBody::success(value),
                            Err(error) => ResponseBody::failure(error.into_core_error()),
                        };
                        transport
                            .send(&CoreMessage::Response { id, body })
                            .await?;
                    }
                    Ok(CoreMessage::Shutdown { .. }) => {
                        persist_queue(&core).await;
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
