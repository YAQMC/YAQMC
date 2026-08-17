use std::future::Future;

use tokio::io::{
    split, stdin, stdout, BufReader, DuplexStream, ReadHalf, Stdin, Stdout, WriteHalf,
};

use crate::envelope::decode_message;
use crate::framing::{read_frame, write_frame, FRAME_HARD_CAP_BYTES};
use crate::{CoreMessage, ProtocolError};

pub trait CoreTransport: Send {
    fn send(
        &mut self,
        message: &CoreMessage,
    ) -> impl Future<Output = Result<(), ProtocolError>> + Send;
    fn recv(&mut self) -> impl Future<Output = Result<CoreMessage, ProtocolError>> + Send;
}

struct Framed<R, W> {
    reader: R,
    writer: W,
    limit: u32,
    poisoned: bool,
}

impl<R, W> Framed<R, W>
where
    R: tokio::io::AsyncRead + Unpin + Send,
    W: tokio::io::AsyncWrite + Unpin + Send,
{
    fn new(reader: R, writer: W, limit: u32) -> Self {
        Self {
            reader,
            writer,
            limit: limit.min(FRAME_HARD_CAP_BYTES),
            poisoned: false,
        }
    }

    fn ensure_open(&self) -> Result<(), ProtocolError> {
        if self.poisoned {
            Err(ProtocolError::Poisoned)
        } else {
            Ok(())
        }
    }

    fn capture<T>(&mut self, result: Result<T, ProtocolError>) -> Result<T, ProtocolError> {
        if result.as_ref().is_err_and(ProtocolError::is_poisoning) {
            self.poisoned = true;
        }
        result
    }

    async fn send(&mut self, message: &CoreMessage) -> Result<(), ProtocolError> {
        self.ensure_open()?;
        let payload = serde_json::to_vec(message).map_err(|error| {
            ProtocolError::Frame(crate::FrameError::InvalidJson(error.to_string()))
        })?;
        let result = write_frame(&mut self.writer, &payload, self.limit).await;
        self.capture(result)
    }

    async fn send_bytes(&mut self, payload: &[u8]) -> Result<(), ProtocolError> {
        self.ensure_open()?;
        let result = write_frame(&mut self.writer, payload, self.limit).await;
        self.capture(result)
    }

    async fn recv(&mut self) -> Result<CoreMessage, ProtocolError> {
        self.ensure_open()?;
        let result = async {
            let payload = read_frame(&mut self.reader, self.limit).await?;
            decode_message(&payload)
        }
        .await;
        self.capture(result)
    }
}

pub struct StdioTransport {
    inner: Framed<BufReader<Stdin>, Stdout>,
}

impl StdioTransport {
    pub fn new() -> Self {
        Self {
            inner: Framed::new(BufReader::new(stdin()), stdout(), FRAME_HARD_CAP_BYTES),
        }
    }
}

impl Default for StdioTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl CoreTransport for StdioTransport {
    fn send(
        &mut self,
        message: &CoreMessage,
    ) -> impl Future<Output = Result<(), ProtocolError>> + Send {
        self.inner.send(message)
    }

    fn recv(&mut self) -> impl Future<Output = Result<CoreMessage, ProtocolError>> + Send {
        self.inner.recv()
    }
}

pub struct DuplexTransport {
    inner: Framed<BufReader<ReadHalf<DuplexStream>>, WriteHalf<DuplexStream>>,
}

impl DuplexTransport {
    pub async fn send_bytes(&mut self, payload: &[u8]) -> Result<(), ProtocolError> {
        self.inner.send_bytes(payload).await
    }
}

impl CoreTransport for DuplexTransport {
    fn send(
        &mut self,
        message: &CoreMessage,
    ) -> impl Future<Output = Result<(), ProtocolError>> + Send {
        self.inner.send(message)
    }

    fn recv(&mut self) -> impl Future<Output = Result<CoreMessage, ProtocolError>> + Send {
        self.inner.recv()
    }
}

pub fn duplex_pair() -> (DuplexTransport, DuplexTransport) {
    let (left, right) = tokio::io::duplex(64 * 1024);
    (wrap_duplex(left), wrap_duplex(right))
}

fn wrap_duplex(stream: DuplexStream) -> DuplexTransport {
    let (reader, writer) = split(stream);
    DuplexTransport {
        inner: Framed::new(BufReader::new(reader), writer, FRAME_HARD_CAP_BYTES),
    }
}
