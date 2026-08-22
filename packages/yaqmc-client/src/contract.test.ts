import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CORE_EVENT_CHANNELS,
  DEFAULT_METHOD_PAYLOAD_BYTES,
  ERROR_CODES,
  FRAME_HARD_CAP_BYTES,
  HANDSHAKE_TIMEOUT_MS,
  HOST_EVENT_CHANNELS,
  METHOD_NAMES,
  PROTOCOL_ONLY_METHODS,
  PROTOCOL_VERSION,
  SHUTDOWN_TIMEOUT_MS,
} from './index';

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');

function load(name: string): unknown {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8'));
}

describe('PROTO-09 contract fixtures', () => {
  it('matches protocol constants including the 32 MiB hard cap', () => {
    const constants = load('constants.json') as Record<string, unknown>;
    expect(constants.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(constants.frameHardCapBytes).toBe(FRAME_HARD_CAP_BYTES);
    expect(constants.frameHardCapBytes).toBe(32 * 1024 * 1024);
    expect(constants.defaultMethodPayloadBytes).toBe(DEFAULT_METHOD_PAYLOAD_BYTES);
    expect(constants.handshakeTimeoutMs).toBe(HANDSHAKE_TIMEOUT_MS);
    expect(constants.shutdownTimeoutMs).toBe(SHUTDOWN_TIMEOUT_MS);
    expect(constants.errorCodes).toEqual([...ERROR_CODES]);
    expect(constants.protocolOnlyMethods).toEqual([...PROTOCOL_ONLY_METHODS]);
  });

  it('lists every mirrored method without raising payload caps', () => {
    const rows = load('methods.json') as Array<{
      name: string;
      requestCap: number;
      responseCap: number;
    }>;
    expect(rows.map((row) => row.name)).toEqual([...METHOD_NAMES]);
    for (const row of rows) {
      expect(row.requestCap).toBeLessThanOrEqual(FRAME_HARD_CAP_BYTES);
      expect(row.responseCap).toBeLessThanOrEqual(FRAME_HARD_CAP_BYTES);
    }
  });

  it('mirrors ADR-004 channels', () => {
    const channels = load('channels.json') as Record<string, unknown>;
    expect(channels.core).toEqual([...CORE_EVENT_CHANNELS]);
    expect(channels.host).toEqual([...HOST_EVENT_CHANNELS]);
  });

  it('round-trips envelope kinds used by hello/attach/ready', () => {
    const envelopes = load('envelopes.json') as Record<string, { kind: string }>;
    expect(envelopes.hello?.kind).toBe('hello');
    expect(envelopes.attach?.kind).toBe('attach');
    expect(envelopes.ready?.kind).toBe('ready');
    expect(envelopes.shutdownAck?.kind).toBe('shutdown-ack');
  });

  it('validates hot player request and snapshot payloads', () => {
    const requests = load('requests.json') as Record<string, { method: string; params?: unknown }>;
    expect(requests.player_seek?.method).toBe('player_seek');
    expect(requests.player_seek?.params).toEqual({ positionMs: 4800 });
    expect(requests.player_snapshot?.method).toBe('player_snapshot');
    expect(requests.core_ping?.method).toBe('core_ping');

    const events = load('events.json') as Record<
      string,
      { kind: string; payload: { positionMs?: number; queue?: unknown[] } }
    >;
    const snapshot = events['player://snapshot']?.payload;
    expect(events['player://snapshot']?.kind).toBe('event');
    expect(snapshot?.positionMs).toBe(1200);
    expect(Array.isArray(snapshot?.queue)).toBe(true);
  });
});
