use serde::de::{Deserializer, Error as DeError};
use serde::ser::{SerializeMap, Serializer};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::registry::WindowOrigin;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CoreIdentity {
    pub version: String,
    pub commit: String,
    pub channel: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HostIdentity {
    pub app: String,
    pub version: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlatformKind {
    Windows,
    Linux,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DisplayBackend {
    X11,
    Wayland,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformAttach {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub main_window_handle: Option<String>,
    pub platform_kind: PlatformKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_backend: Option<DisplayBackend>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AttachMessage {
    pub protocol: u32,
    pub host: HostIdentity,
    pub platform: PlatformAttach,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShutdownReason {
    Quit,
    Restart,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CoreError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    pub retryable: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ResponseBody {
    Success { result: Value },
    Failure { error: CoreError },
}

impl ResponseBody {
    pub fn success(result: Value) -> Self {
        Self::Success { result }
    }

    pub fn failure(error: CoreError) -> Self {
        Self::Failure { error }
    }
}

impl Serialize for ResponseBody {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Success { result } => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("ok", &true)?;
                map.serialize_entry("result", result)?;
                map.end()
            }
            Self::Failure { error } => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("ok", &false)?;
                map.serialize_entry("error", error)?;
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for ResponseBody {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Raw {
            ok: bool,
            result: Option<Value>,
            error: Option<CoreError>,
        }

        let raw = Raw::deserialize(deserializer)?;
        match (raw.ok, raw.result, raw.error) {
            (true, result, None) => Ok(Self::Success {
                result: result.unwrap_or(Value::Null),
            }),
            (false, None, Some(error)) => Ok(Self::Failure { error }),
            _ => Err(D::Error::custom(
                "response must be {ok:true, result} or {ok:false, error}",
            )),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum CoreMessage {
    #[serde(rename = "hello")]
    Hello { protocol: u32, core: CoreIdentity },
    #[serde(rename = "attach")]
    Attach(AttachMessage),
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "request")]
    Request {
        id: u64,
        method: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        params: Option<Value>,
        /// Assigned only by Electron Main after IpcRouter authorizes the window.
        /// Omitted requests keep host origin (true host-internal calls).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        origin: Option<WindowOrigin>,
    },
    #[serde(rename = "response")]
    Response {
        id: u64,
        #[serde(flatten)]
        body: ResponseBody,
    },
    #[serde(rename = "event")]
    Event {
        seq: u64,
        channel: String,
        payload: Value,
    },
    #[serde(rename = "shutdown")]
    Shutdown { reason: ShutdownReason },
    #[serde(rename = "shutdown-ack")]
    ShutdownAck,
}

const KNOWN_KINDS: &[&str] = &[
    "hello",
    "attach",
    "ready",
    "request",
    "response",
    "event",
    "shutdown",
    "shutdown-ack",
];

pub(crate) fn decode_message(payload: &[u8]) -> Result<CoreMessage, super::ProtocolError> {
    use super::{FrameError, ProtocolError};

    let value: Value = serde_json::from_slice(payload)
        .map_err(|error| ProtocolError::Frame(FrameError::InvalidJson(error.to_string())))?;
    let kind = value
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| ProtocolError::Frame(FrameError::InvalidJson("missing kind".to_owned())))?
        .to_owned();
    match serde_json::from_value::<CoreMessage>(value) {
        Ok(message) => Ok(message),
        Err(_) if !KNOWN_KINDS.contains(&kind.as_str()) => {
            Err(ProtocolError::Frame(FrameError::UnknownKind(kind)))
        }
        Err(error) => Err(ProtocolError::Frame(FrameError::InvalidJson(
            error.to_string(),
        ))),
    }
}
