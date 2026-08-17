import { describe, expect, it, vi } from 'vitest';
import { CoreInvokeError } from './core/client';
import { handleRendererInvoke, type InvokeTarget } from './ipc';

function mockClient(impl: InvokeTarget['invoke']): InvokeTarget {
  return { invoke: impl };
}

describe('renderer invoke routing', () => {
  it('proxies player_snapshot to the core client', async () => {
    const invoke = vi.fn(async () => ({ playbackState: 'paused', positionMs: 0 }));
    const reply = await handleRendererInvoke(mockClient(invoke), { method: 'player_snapshot' });
    expect(invoke).toHaveBeenCalledWith('player_snapshot', undefined);
    expect(reply).toEqual({
      ok: true,
      result: { playbackState: 'paused', positionMs: 0 },
    });
  });

  it('returns a structured error when core is down', async () => {
    await expect(handleRendererInvoke(undefined, { method: 'player_snapshot' })).resolves.toEqual({
      ok: false,
      error: {
        code: 'core.unavailable',
        message: 'core supervisor is not running',
        retryable: true,
      },
    });
  });

  it('does not throw on unknown or host-owned methods', async () => {
    const invoke = vi.fn(async (method: string) => {
      throw new CoreInvokeError('host.denied', `${method} is implemented by the host`, false);
    });
    const unknown = await handleRendererInvoke(mockClient(invoke), { method: 'not_a_method' });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error).toMatchObject({
        code: 'host.denied',
        retryable: false,
      });
    }
    const hostOwned = await handleRendererInvoke(mockClient(invoke), {
      method: 'system_integration_status',
    });
    expect(hostOwned).toEqual({
      ok: false,
      error: {
        code: 'host.denied',
        message: 'system_integration_status is implemented by the host',
        retryable: false,
      },
    });
  });

  it('rejects a missing method name without crashing', async () => {
    await expect(handleRendererInvoke(mockClient(vi.fn()), undefined)).resolves.toEqual({
      ok: false,
      error: { code: 'core.protocol', message: 'missing method', retryable: false },
    });
  });
});
