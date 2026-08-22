import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { FRAME_HARD_CAP_BYTES } from '@yaqmc/client';
import { FrameDecoder, FrameTooLargeError, encodeFrame, writeFrame } from './frames';

describe('protocol frames', () => {
  it('round-trips a JSON payload across split writes', () => {
    const payload = Buffer.from('{"kind":"ready"}');
    const frame = encodeFrame(payload);
    const decoder = new FrameDecoder();
    const decoded: Buffer[] = [];
    for (const byte of frame) {
      decoded.push(...decoder.push(Buffer.from([byte])));
    }
    expect(decoded).toEqual([payload]);
  });

  it('accepts the configured max and rejects one byte over', async () => {
    const payload = Buffer.alloc(64, 0x78);
    const stream = new PassThrough();
    const received: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => received.push(chunk));
    await writeFrame(stream, payload, 64);
    const decoder = new FrameDecoder(64);
    expect(decoder.push(Buffer.concat(received))).toEqual([payload]);

    const oversize = new FrameDecoder(64);
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(65, 0);
    try {
      oversize.push(prefix);
      throw new Error('expected oversize prefix to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(FrameTooLargeError);
      expect(error).toMatchObject({ length: 65, limit: 64, code: 'core.protocol' });
    }
  });

  it('rejects an oversize hard cap before the body is read', () => {
    const decoder = new FrameDecoder(Number.MAX_SAFE_INTEGER);
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(FRAME_HARD_CAP_BYTES + 1, 0);
    expect(FRAME_HARD_CAP_BYTES).toBe(32 * 1024 * 1024);
    try {
      decoder.push(prefix);
      throw new Error('expected hard-cap prefix to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(FrameTooLargeError);
      expect(error).toMatchObject({
        length: FRAME_HARD_CAP_BYTES + 1,
        limit: FRAME_HARD_CAP_BYTES,
      });
    }
    expect(decoder.isPoisoned).toBe(true);
  });
});
