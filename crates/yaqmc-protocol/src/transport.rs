use std::future::Future;

use tokio::io::{
    AsyncReadExt, BufReader, DuplexStream, ReadHalf, Stdin, Stdout, WriteHalf, split, stdin, stdout,
};

use crate::envelope::decode_message;
use crate::error::FrameError;
use crate::framing::{FRAME_HARD_CAP_BYTES, write_frame};
use crate::{CoreMessage, ProtocolError};

/// Incremental frame reader so `recv` stays correct if `select!` cancels it.
enum FrameRead {
    Prefix { buf: [u8; 4], filled: usize },
    Body { buf: Vec<u8>, filled: usize },
}

impl Default for FrameRead {
    fn default() -> Self {
        Self::Prefix {
            buf: [0; 4],
            filled: 0,
        }
    }
}

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
    read: FrameRead,
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
            read: FrameRead::default(),
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
            let payload = self.read_payload().await?;
            decode_message(&payload)
        }
        .await;
        self.capture(result)
    }

    async fn read_payload(&mut self) -> Result<Vec<u8>, ProtocolError> {
        if matches!(self.read, FrameRead::Prefix { .. }) {
            let length = self.read_prefix().await?;
            if length == 0 || length > self.limit {
                return Err(ProtocolError::Frame(FrameError::TooLarge {
                    length,
                    limit: self.limit,
                }));
            }
            self.read = FrameRead::Body {
                buf: vec![0_u8; length as usize],
                filled: 0,
            };
        }
        self.read_body().await
    }

    async fn read_prefix(&mut self) -> Result<u32, ProtocolError> {
        let FrameRead::Prefix { buf, filled } = &mut self.read else {
            unreachable!("prefix state");
        };
        while *filled < 4 {
            let n = self.reader.read(&mut buf[*filled..]).await?;
            if n == 0 {
                return Err(ProtocolError::Closed);
            }
            *filled += n;
        }
        Ok(u32::from_le_bytes(*buf))
    }

    async fn read_body(&mut self) -> Result<Vec<u8>, ProtocolError> {
        {
            let FrameRead::Body { buf, filled } = &mut self.read else {
                unreachable!("body state");
            };
            while *filled < buf.len() {
                let n = self.reader.read(&mut buf[*filled..]).await?;
                if n == 0 {
                    return Err(ProtocolError::Closed);
                }
                *filled += n;
            }
        }
        let FrameRead::Body { buf, .. } = std::mem::take(&mut self.read)
        else {
            unreachable!("body state");
        };
        Ok(buf)
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

pub struct PipeTransport<R, W> {
    inner: Framed<BufReader<R>, W>,
}

impl<R, W> PipeTransport<R, W>
where
    R: tokio::io::AsyncRead + Unpin + Send,
    W: tokio::io::AsyncWrite + Unpin + Send,
{
    pub fn new(reader: R, writer: W) -> Self {
        Self {
            inner: Framed::new(BufReader::new(reader), writer, FRAME_HARD_CAP_BYTES),
        }
    }
}

impl<R, W> CoreTransport for PipeTransport<R, W>
where
    R: tokio::io::AsyncRead + Unpin + Send,
    W: tokio::io::AsyncWrite + Unpin + Send,
{
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
