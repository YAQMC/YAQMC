//! Versioned Core protocol: JSON envelopes, length-prefixed stdio frames, and handshake.

mod channels;
mod envelope;
mod error;
mod framing;
mod handshake;
mod registry;
mod transport;

pub use channels::{
    CHANNEL_ACCOUNT_CHANGED, CHANNEL_API_EVENT, CHANNEL_APP_OPEN_SETTINGS, CHANNEL_CORE_LOG,
    CHANNEL_HOST_COMMAND, CHANNEL_LYRICS_DOCUMENT, CHANNEL_LYRICS_PROJECTION,
    CHANNEL_LYRICS_SURFACE_CLOSED, CHANNEL_PLAYER_SNAPSHOT, CHANNEL_PLUGIN_CHANGED,
    CHANNEL_PREFERENCES_CHANGED, CORE_EVENT_CHANNELS, HOST_EVENT_CHANNELS,
};
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
pub use registry::{
    authorize, method, methods, AclDenied, MethodOwner, MethodSpec, TimeoutClass, WindowOrigin,
};
pub use transport::{duplex_pair, CoreTransport, DuplexTransport, StdioTransport};

pub const PROTOCOL_VERSION: u32 = ProtocolVersion::V1 as u32;
