import { describe, expect, it } from 'vitest';
import { FRAME_HARD_CAP_BYTES, PROTOCOL_VERSION, YaqmcClient } from './index';
import type { HostBridge } from './bridge';

function unusedBridge(): HostBridge {
  return {
    kind: 'fake',
    windowRole: 'main',
    invoke: async () => undefined,
    listen: () => () => undefined,
  };
}

describe('@yaqmc/client scaffold', () => {
  it('exports protocol v1 and the 32 MiB hard cap', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(FRAME_HARD_CAP_BYTES).toBe(32 * 1024 * 1024);
  });

  it('constructs YaqmcClient over a HostBridge', () => {
    const bridge = unusedBridge();
    expect(new YaqmcClient(bridge).bridge).toBe(bridge);
  });
});
