import { describe, expect, it, vi } from 'vitest';
import { createElectronBridge } from './electron';

describe('Electron result envelope', () => {
  it('routes opaque plugin file requests through native host IPC', async () => {
    const invoke = vi.fn().mockResolvedValue({ handle: 'opaque' });
    const bridge = createElectronBridge({ invoke, on: () => () => {} });
    const request = {
      token: 'runtime',
      method: 'files.pickDirectory',
      payload: { writable: true },
    };
    await expect(bridge.pluginFiles?.invoke(request)).resolves.toEqual({ handle: 'opaque' });
    await bridge.pluginFiles?.release('runtime');
    expect(invoke).toHaveBeenCalledWith('plugin_files', { request });
    expect(invoke).toHaveBeenCalledWith('plugin_files_release', { token: 'runtime' });
  });
  it('reconstructs provider error details on the renderer side', async () => {
    const details = {
      code: 'provider-not-configured',
      message: 'Configure Spotify',
      retryable: false,
    };
    const invoke = vi.fn();
    const bridge = createElectronBridge({
      invoke,
      on: () => () => {},
      invokeResult: async () => ({
        ok: false,
        error: { code: 'core.provider', message: 'Configure Spotify', retryable: false, details },
      }),
    });
    await expect(
      bridge.invoke('provider_account_snapshot', { providerId: 'spotify' }),
    ).rejects.toMatchObject({ code: 'core.provider', details });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps older preloads working', async () => {
    const bridge = createElectronBridge({ invoke: async () => [], on: () => () => {} });
    await expect(bridge.invoke('provider_list')).resolves.toEqual([]);
  });
});
