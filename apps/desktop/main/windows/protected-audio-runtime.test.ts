import type { ComponentResult, ComponentStatus } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  prepareProtectedAudioRuntime,
  type ProtectedAudioComponents,
} from './protected-audio-runtime';

const CDM_ID = 'widevine-cdm';

function components(
  whenReady: (required?: string[]) => Promise<ComponentResult[]> = async () => [],
  status: ComponentStatus = { status: 'new', title: 'Widevine', version: '4.10.3112.0' },
): ProtectedAudioComponents {
  return {
    WIDEVINE_CDM_ID: CDM_ID,
    whenReady,
    status: vi.fn(() => ({ [CDM_ID]: status })),
  };
}

describe('protected audio runtime', () => {
  it('installs the Windows Widevine component before protected windows open', async () => {
    const whenReady = vi.fn(async () => []);
    const api = components(whenReady);
    await expect(prepareProtectedAudioRuntime('win32', api)).resolves.toEqual({
      ready: true,
      componentStatus: 'new',
      version: '4.10.3112.0',
    });
    expect(whenReady).toHaveBeenCalledWith([CDM_ID]);
  });

  it('reports installation failure without claiming protected playback is ready', async () => {
    const api = components(async () => Promise.reject(new Error('offline')), {
      status: 'failed',
      title: 'Widevine',
      version: null,
    });
    await expect(prepareProtectedAudioRuntime('win32', api)).resolves.toEqual({
      ready: false,
      componentStatus: 'failed',
      version: null,
    });
  });

  it('does not invoke the Windows component API on other platforms', async () => {
    const whenReady = vi.fn(async () => []);
    const api = components(whenReady);
    await expect(prepareProtectedAudioRuntime('linux', api)).resolves.toEqual({
      ready: true,
      componentStatus: null,
      version: null,
    });
    expect(whenReady).not.toHaveBeenCalled();
  });
});
