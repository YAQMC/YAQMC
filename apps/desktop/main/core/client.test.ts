import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { FRAME_HARD_CAP_BYTES } from '@yaqmc/client';
import {
  CONTROL_TIMEOUT_MS,
  CoreClient,
  type CoreInvokeError,
  LONG_TIMEOUT_MS,
  STANDARD_TIMEOUT_MS,
  methodTimeoutMs,
} from './client';
import { encodeFrame } from './frames';

const fixturesRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/yaqmc-client/fixtures',
);

function mockStream() {
  const readable = new PassThrough();
  const writable = new PassThrough();
  const client = new CoreClient({ readable, writable });
  client.start();
  return { client, readable, writable };
}

function pushMessage(readable: PassThrough, message: unknown) {
  readable.write(encodeFrame(Buffer.from(JSON.stringify(message))));
}

describe('CoreClient', () => {
  it('keeps the 32 MiB framing cap from the protocol mirror', () => {
    expect(FRAME_HARD_CAP_BYTES).toBe(32 * 1024 * 1024);
  });

  it('matches contract fixture timeout classes', () => {
    const rows = JSON.parse(
      readFileSync(path.join(fixturesRoot, 'methods.json'), 'utf8'),
    ) as Array<{
      name: string;
      timeoutMs: number;
    }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(methodTimeoutMs(row.name), row.name).toBe(row.timeoutMs);
    }
    expect(methodTimeoutMs('player_snapshot')).toBe(CONTROL_TIMEOUT_MS);
    expect(methodTimeoutMs('core_ping')).toBe(CONTROL_TIMEOUT_MS);
    expect(methodTimeoutMs('plugin_install')).toBe(LONG_TIMEOUT_MS);
    expect(methodTimeoutMs('qqmusic_home')).toBe(STANDARD_TIMEOUT_MS);
  });

  it('resolves the promise map from a framed response', async () => {
    const { client, readable, writable } = mockStream();
    const chunks: Buffer[] = [];
    writable.on('data', (chunk: Buffer) => chunks.push(chunk));
    const pending = client.invoke('player_snapshot');
    await vi.waitFor(() => expect(Buffer.concat(chunks).length).toBeGreaterThan(4));
    pushMessage(readable, { kind: 'response', id: 1, ok: true, result: { positionMs: 0 } });
    await expect(pending).resolves.toEqual({ positionMs: 0 });
    client.close();
  });

  it('demuxes events and emits resync on a seq gap', async () => {
    const { client, readable } = mockStream();
    const events: Array<{ seq: number; channel: string }> = [];
    const gaps: Array<{ previous: number; seq: number }> = [];
    client.on('event', (message: { seq: number; channel: string }) => events.push(message));
    client.on('resync', (gap: { previous: number; seq: number }) => gaps.push(gap));
    pushMessage(readable, {
      kind: 'event',
      seq: 1,
      channel: 'player://snapshot',
      payload: { revision: 1 },
    });
    pushMessage(readable, {
      kind: 'event',
      seq: 3,
      channel: 'player://snapshot',
      payload: { revision: 3 },
    });
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(gaps).toEqual([{ previous: 1, seq: 3 }]);
    client.close();
  });

  it('rejects player_* invokes as core.timeout after 10s', async () => {
    vi.useFakeTimers();
    const { client } = mockStream();
    const pending = client.invoke('player_snapshot');
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'CoreInvokeError',
      code: 'core.timeout',
      retryable: true,
    } satisfies Partial<CoreInvokeError>);
    await vi.advanceTimersByTimeAsync(CONTROL_TIMEOUT_MS);
    await assertion;
    vi.useRealTimers();
    client.close();
  });
});
