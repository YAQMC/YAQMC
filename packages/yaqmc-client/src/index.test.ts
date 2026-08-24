import { describe, expect, it } from 'vitest';
import {
  CORE_EVENT_CHANNELS,
  FRAME_HARD_CAP_BYTES,
  HOST_EVENT_CHANNELS,
  METHOD_NAMES,
  MIGRATED_METHOD_NAMES,
  PROTOCOL_ONLY_METHODS,
  PROTOCOL_VERSION,
  YaqmcClient,
} from './index';
import type { HostBridge } from './bridge';

function unusedBridge(): HostBridge {
  return {
    kind: 'fake',
    windowRole: 'main',
    window: {
      minimize: async () => undefined,
      toggleMaximize: async () => undefined,
      close: async () => undefined,
      setFullscreen: async () => undefined,
    },
    shell: {
      openExternal: async () => undefined,
    },
    invoke: async () => {
      throw new Error('unused');
    },
    listen: () => () => undefined,
  };
}

describe('@yaqmc/client protocol mirror', () => {
  it('exports protocol v1 and the 32 MiB hard cap', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(FRAME_HARD_CAP_BYTES).toBe(32 * 1024 * 1024);
  });

  it('mirrors 118 migrated methods plus 12 protocol-only methods', () => {
    expect(MIGRATED_METHOD_NAMES).toHaveLength(118);
    expect(PROTOCOL_ONLY_METHODS).toHaveLength(12);
    expect(METHOD_NAMES).toHaveLength(130);
    expect(new Set(METHOD_NAMES).size).toBe(130);
  });

  it('mirrors ADR-004 core and host event channels', () => {
    expect([...CORE_EVENT_CHANNELS]).toEqual([
      'api://event',
      'player://snapshot',
      'lyrics://projection',
      'lyrics://document',
      'plugin://changed',
      'preferences://changed',
      'host://command',
      'core://log',
      'account://changed',
    ]);
    expect([...HOST_EVENT_CHANNELS]).toEqual([
      'lyrics://surface-closed',
      'lyrics://surface-interaction',
      'app://open-settings',
      'host://core-status',
      'host://update',
    ]);
  });

  it('constructs YaqmcClient over a HostBridge', () => {
    const bridge = unusedBridge();
    expect(new YaqmcClient(bridge).bridge).toBe(bridge);
  });
});
