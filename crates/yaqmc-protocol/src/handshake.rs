use std::time::Duration;

use crate::{
    AttachMessage, CoreIdentity, CoreMessage, CoreTransport, HandshakeError, ProtocolError,
    PROTOCOL_VERSION,
};

pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
pub const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

pub async fn core_handshake<T: CoreTransport>(
    transport: &mut T,
    identity: CoreIdentity,
) -> Result<AttachMessage, ProtocolError> {
    core_handshake_with_timeout(transport, identity, HANDSHAKE_TIMEOUT).await
}

pub async fn core_handshake_with_timeout<T: CoreTransport>(
    transport: &mut T,
    identity: CoreIdentity,
    timeout: Duration,
) -> Result<AttachMessage, ProtocolError> {
    match tokio::time::timeout(timeout, async {
        transport
            .send(&CoreMessage::Hello {
                protocol: PROTOCOL_VERSION,
                core: identity,
            })
            .await?;
        match transport.recv().await? {
            CoreMessage::Attach(attach) if attach.protocol == PROTOCOL_VERSION => {
                transport.send(&CoreMessage::Ready).await?;
                Ok(attach)
            }
            CoreMessage::Attach(attach) => {
                Err(ProtocolError::Handshake(HandshakeError::ProtocolMismatch {
                    found: attach.protocol,
                }))
            }
            _ => Err(ProtocolError::Handshake(HandshakeError::UnexpectedMessage)),
        }
    })
    .await
    {
        Ok(result) => result,
        Err(_) => Err(ProtocolError::Handshake(HandshakeError::Timeout)),
    }
}

pub async fn host_handshake<T: CoreTransport>(
    transport: &mut T,
    attach: AttachMessage,
    expected_core_version: Option<&str>,
) -> Result<CoreIdentity, ProtocolError> {
    host_handshake_with_timeout(transport, attach, expected_core_version, HANDSHAKE_TIMEOUT).await
}

pub async fn host_handshake_with_timeout<T: CoreTransport>(
    transport: &mut T,
    attach: AttachMessage,
    expected_core_version: Option<&str>,
    timeout: Duration,
) -> Result<CoreIdentity, ProtocolError> {
    match tokio::time::timeout(timeout, async {
        let identity = match transport.recv().await? {
            CoreMessage::Hello { protocol, core } if protocol == PROTOCOL_VERSION => {
                if let Some(expected) = expected_core_version {
                    if core.version != expected {
                        return Err(ProtocolError::Handshake(HandshakeError::VersionMismatch {
                            expected: expected.to_owned(),
                            found: core.version,
                        }));
                    }
                }
                core
            }
            CoreMessage::Hello { protocol, .. } => {
                return Err(ProtocolError::Handshake(HandshakeError::ProtocolMismatch {
                    found: protocol,
                }))
            }
            _ => return Err(ProtocolError::Handshake(HandshakeError::UnexpectedMessage)),
        };
        transport.send(&CoreMessage::Attach(attach)).await?;
        match transport.recv().await? {
            CoreMessage::Ready => Ok(identity),
            _ => Err(ProtocolError::Handshake(HandshakeError::UnexpectedMessage)),
        }
    })
    .await
    {
        Ok(result) => result,
        Err(_) => Err(ProtocolError::Handshake(HandshakeError::Timeout)),
    }
}
