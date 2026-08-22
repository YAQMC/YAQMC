import { FRAME_HARD_CAP_BYTES } from '@yaqmc/client';
import type { Writable } from 'node:stream';

export { DEFAULT_METHOD_PAYLOAD_BYTES, FRAME_HARD_CAP_BYTES } from '@yaqmc/client';

export class ProtocolError extends Error {
  readonly code = 'core.protocol' as const;
  readonly retryable = false;

  constructor(
    message: string,
    readonly poisoning = true,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export class FrameTooLargeError extends ProtocolError {
  constructor(
    readonly length: number,
    readonly limit: number,
  ) {
    super(`frame length ${length} exceeds limit ${limit}`, true);
    this.name = 'FrameTooLargeError';
  }
}

export function frameLimit(limit = FRAME_HARD_CAP_BYTES): number {
  return Math.min(limit, FRAME_HARD_CAP_BYTES);
}

export function encodeFrame(payload: Uint8Array, limit = FRAME_HARD_CAP_BYTES): Buffer {
  const cap = frameLimit(limit);
  if (payload.length > cap) {
    throw new FrameTooLargeError(payload.length, cap);
  }
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32LE(payload.length, 0);
  return Buffer.concat([prefix, Buffer.from(payload)]);
}

export function writeFrame(
  writable: Writable,
  payload: Uint8Array,
  limit = FRAME_HARD_CAP_BYTES,
): Promise<void> {
  const frame = encodeFrame(payload, limit);
  return new Promise((resolve, reject) => {
    writable.write(frame, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** Incremental u32-LE decoder. Oversize prefixes fail before a body is required. */
export class FrameDecoder {
  private buffer = Buffer.alloc(0);
  private poisoned = false;
  private readonly limit: number;

  constructor(limit = FRAME_HARD_CAP_BYTES) {
    this.limit = frameLimit(limit);
  }

  get isPoisoned(): boolean {
    return this.poisoned;
  }

  push(chunk: Uint8Array): Buffer[] {
    if (this.poisoned) {
      throw new ProtocolError('protocol connection is poisoned');
    }
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const frames: Buffer[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length === 0 || length > this.limit) {
        this.poisoned = true;
        throw new FrameTooLargeError(length, this.limit);
      }
      if (this.buffer.length < 4 + length) {
        return frames;
      }
      frames.push(Buffer.from(this.buffer.subarray(4, 4 + length)));
      this.buffer = Buffer.from(this.buffer.subarray(4 + length));
    }
    return frames;
  }
}
