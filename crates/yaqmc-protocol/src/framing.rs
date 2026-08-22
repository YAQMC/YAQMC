use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::{FrameError, ProtocolError};

pub const FRAME_HARD_CAP_BYTES: u32 = 32 * 1024 * 1024;
pub const DEFAULT_METHOD_PAYLOAD_BYTES: u32 = 1024 * 1024;

pub async fn write_frame<W>(writer: &mut W, payload: &[u8], limit: u32) -> Result<(), ProtocolError>
where
    W: AsyncWrite + Unpin,
{
    let limit = limit.min(FRAME_HARD_CAP_BYTES);
    let length = u32::try_from(payload.len()).unwrap_or(u32::MAX);
    if payload.len() > usize::try_from(limit).unwrap_or(usize::MAX) {
        return Err(ProtocolError::Frame(FrameError::TooLarge { length, limit }));
    }

    writer.write_all(&length.to_le_bytes()).await?;
    writer.write_all(payload).await?;
    writer.flush().await?;
    Ok(())
}

pub async fn read_frame<R>(reader: &mut R, limit: u32) -> Result<Vec<u8>, ProtocolError>
where
    R: AsyncRead + Unpin,
{
    let limit = limit.min(FRAME_HARD_CAP_BYTES);
    let mut prefix = [0_u8; 4];
    reader.read_exact(&mut prefix).await?;
    let length = u32::from_le_bytes(prefix);
    if length == 0 || length > limit {
        return Err(ProtocolError::Frame(FrameError::TooLarge { length, limit }));
    }

    let mut payload = vec![0_u8; length as usize];
    reader.read_exact(&mut payload).await?;
    Ok(payload)
}
