use std::fmt;
use std::io;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ProtocolVersion {
    V1 = 1,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ErrorCode {
    CommandError,
    Unavailable,
    Timeout,
    Protocol,
    Denied,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CommandError => "core.command_error",
            Self::Unavailable => "core.unavailable",
            Self::Timeout => "core.timeout",
            Self::Protocol => "core.protocol",
            Self::Denied => "host.denied",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FrameError {
    TooLarge { length: u32, limit: u32 },
    InvalidJson(String),
    UnknownKind(String),
}

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLarge { length, limit } => {
                write!(f, "frame length {length} exceeds limit {limit}")
            }
            Self::InvalidJson(error) => write!(f, "invalid JSON frame: {error}"),
            Self::UnknownKind(kind) => write!(f, "unknown message kind {kind}"),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HandshakeError {
    ProtocolMismatch { found: u32 },
    VersionMismatch { expected: String, found: String },
    UnexpectedMessage,
    Timeout,
}

impl fmt::Display for HandshakeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ProtocolMismatch { found } => {
                write!(f, "unsupported protocol version {found}")
            }
            Self::VersionMismatch { expected, found } => {
                write!(f, "core version {found} does not match host {expected}")
            }
            Self::UnexpectedMessage => write!(f, "unexpected handshake message"),
            Self::Timeout => write!(f, "handshake timed out"),
        }
    }
}

#[derive(Debug)]
pub enum ProtocolError {
    Frame(FrameError),
    Handshake(HandshakeError),
    Poisoned,
    Closed,
    Io(io::Error),
}

impl ProtocolError {
    pub fn code(&self) -> ErrorCode {
        match self {
            Self::Handshake(HandshakeError::Timeout) => ErrorCode::Timeout,
            _ => ErrorCode::Protocol,
        }
    }

    pub fn is_poisoning(&self) -> bool {
        match self {
            Self::Frame(_) | Self::Poisoned => true,
            Self::Handshake(HandshakeError::Timeout) => false,
            Self::Handshake(_) => true,
            Self::Closed | Self::Io(_) => false,
        }
    }
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Frame(error) => write!(f, "{error}"),
            Self::Handshake(error) => write!(f, "{error}"),
            Self::Poisoned => write!(f, "protocol connection is poisoned"),
            Self::Closed => write!(f, "protocol connection closed"),
            Self::Io(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for ProtocolError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for ProtocolError {
    fn from(error: io::Error) -> Self {
        if error.kind() == io::ErrorKind::UnexpectedEof {
            Self::Closed
        } else {
            Self::Io(error)
        }
    }
}
