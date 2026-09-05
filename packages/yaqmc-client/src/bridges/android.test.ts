import { describe, expect, it, vi } from 'vitest';
import { createAndroidBridge, readCapacitorAndroidApi } from './android';

describe('createAndroidBridge', () => {
  it('exposes Android capabilities and routes native share to the host', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const on = vi.fn().mockReturnValue(() => undefined);
    const share = vi.fn().mockResolvedValue(undefined);
    const bridge = createAndroidBridge({ invoke, on, share, platform: 'android' });

    expect(bridge.kind).toBe('android');
    expect(bridge.capabilities).toMatchObject({
      windowControls: false,
      lyricsSurfaces: false,
      plugins: false,
      localApi: false,
      fileExport: false,
      fileImport: true,
      nativeShare: true,
      deepLinks: true,
      updateMode: 'notify',
    });
    expect(bridge.window).toBeUndefined();
    await bridge.share?.share({ text: 'Quiet Light', title: 'Quiet Light' });
    expect(share).toHaveBeenCalledWith({ text: 'Quiet Light', title: 'Quiet Light' });
  });

  it('uses an explicit invoke fallback when the native share function is absent', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const bridge = createAndroidBridge({ invoke, on: vi.fn().mockReturnValue(() => undefined) });
    await bridge.share?.share({ text: 'YAQMC' });
    expect(invoke).toHaveBeenCalledWith('nativeShare', { text: 'YAQMC' });
  });

  it('uses the native photo picker and converts private paths into WebView URLs', async () => {
    const plugin = {
      invoke: vi.fn().mockResolvedValue({
        value: {
          reference: 'backgrounds/custom-background.png',
          dataUri: '',
          nativePath: '/data/user/0/org.yaqmc.android/files/backgrounds/custom-background.png',
        },
      }),
      shell: vi.fn().mockResolvedValue(undefined),
      clipboardSet: vi.fn().mockResolvedValue(undefined),
      nativeShare: vi.fn().mockResolvedValue(undefined),
      pickBackgroundImage: vi.fn().mockResolvedValue({ path: '/private/selected.image' }),
      addListener: vi.fn().mockResolvedValue({ remove: vi.fn().mockResolvedValue(undefined) }),
    };
    const api = readCapacitorAndroidApi({
      Capacitor: {
        getPlatform: () => 'android',
        isNativePlatform: () => true,
        convertFileSrc: (path: string) => `https://localhost/_capacitor_file_/${path}`,
        Plugins: { YaqmcNative: plugin },
      },
    } as unknown as typeof globalThis);
    expect(api).toBeDefined();

    await expect(
      api?.invoke('appearance_background_load', { reference: 'backgrounds/a.png' }),
    ).resolves.toMatchObject({
      reference: 'backgrounds/custom-background.png',
      dataUri:
        'https://localhost/_capacitor_file_//data/user/0/org.yaqmc.android/files/backgrounds/custom-background.png',
    });
    await expect(api?.dialog?.pickFile({ kind: 'background-image' })).resolves.toBe(
      '/private/selected.image',
    );
  });

  it('delivers a retained cold-start deep link once the renderer subscribes', () => {
    const listeners = new Map<string, (payload: Record<string, unknown>) => void>();
    const plugin = {
      invoke: vi.fn().mockResolvedValue({ value: null }),
      shell: vi.fn().mockResolvedValue(undefined),
      clipboardSet: vi.fn().mockResolvedValue(undefined),
      nativeShare: vi.fn().mockResolvedValue(undefined),
      pickBackgroundImage: vi.fn().mockResolvedValue({ path: null }),
      addListener: vi.fn((event: string, listener: (payload: Record<string, unknown>) => void) => {
        listeners.set(event, listener);
        return Promise.resolve({ remove: vi.fn().mockResolvedValue(undefined) });
      }),
    };
    const api = readCapacitorAndroidApi({
      Capacitor: {
        getPlatform: () => 'android',
        isNativePlatform: () => true,
        Plugins: { YaqmcNative: plugin },
      },
    } as unknown as typeof globalThis);
    const target = {
      providerId: 'qqmusic',
      entityId: 'qqmusic:track:0039MnYb0qxYhV',
    };

    listeners.get('deepLink')?.(target);
    const first = vi.fn();
    const stop = api?.on('app://open-catalog-song', first);
    expect(first).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledWith(target);
    stop?.();

    const second = vi.fn();
    api?.on('app://open-catalog-song', second);
    expect(second).not.toHaveBeenCalled();
  });
});
