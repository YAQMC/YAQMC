//! Versioned Core protocol: JSON envelopes, length-prefixed stdio frames, and handshake.

mod envelope;
mod error;
mod framing;
mod handshake;
mod transport;

pub use envelope::{
    AttachMessage, CoreError, CoreIdentity, CoreMessage, DisplayBackend, HostIdentity,
    PlatformAttach, PlatformKind, ResponseBody, ShutdownReason,
};
pub use error::{ErrorCode, FrameError, HandshakeError, ProtocolError, ProtocolVersion};
pub use framing::{read_frame, write_frame, DEFAULT_METHOD_PAYLOAD_BYTES, FRAME_HARD_CAP_BYTES};
pub use handshake::{
    core_handshake, core_handshake_with_timeout, host_handshake, host_handshake_with_timeout,
    HANDSHAKE_TIMEOUT, SHUTDOWN_TIMEOUT,
};
pub use transport::{duplex_pair, CoreTransport, DuplexTransport, StdioTransport};

pub const PROTOCOL_VERSION: u32 = ProtocolVersion::V1 as u32;
