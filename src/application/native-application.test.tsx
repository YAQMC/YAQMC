import { act, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { NativeApplication } from './native-application';

const runtimeMocks = vi.hoisted(() => {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const invoke = vi.fn();
  return {
    invoke,
    on(channel: string, handler: (payload: unknown) => void) {
      const channelListeners = listeners.get(channel) ?? new Set();
      channelListeners.add(handler);
      listeners.set(channel, channelListeners);
      return () => channelListeners.delete(handler);
    },
    emit(channel: string, payload: unknown) {
      for (const listener of listeners.get(channel) ?? []) listener(payload);
    },
    reset() {
      invoke.mockReset();
      listeners.clear();
    },
  };
});

vi.mock('./yaqmc-runtime', () => ({
  getYaqmcClient: () => ({ invoke: runtimeMocks.invoke, on: runtimeMocks.on }),
}));

vi.mock('../providers/native/native-music-provider', () => ({
  createNativeMusicProvider: (descriptor: { providerId: string; displayName: string }) => ({
    id: descriptor.providerId,
    displayName: descriptor.displayName,
  }),
}));

vi.mock('../providers/qqmusic/qq-music-provider', () => ({
  qqMusicProvider: { id: 'qqmusic', displayName: 'QQ Music' },
}));

vi.mock('./provider-root', () => ({
  MusicProviderRoot: ({
    children,
    providerOptions,
  }: {
    children: ReactNode;
    providerOptions?: ReadonlyArray<{ id: string }>;
  }) => (
    <div data-testid="provider-options">
      {providerOptions?.map((provider) => provider.id).join(',') ?? 'fallback'}
      {children}
    </div>
  ),
}));

vi.mock('../App', () => ({ default: () => <div>Application ready</div> }));

describe('NativeApplication startup', () => {
  beforeEach(async () => {
    runtimeMocks.reset();
    await i18n.changeLanguage('en-US');
  });

  it('reloads providers when Core becomes ready after an early renderer request', async () => {
    runtimeMocks.invoke
      .mockRejectedValueOnce(new Error('Core is still starting'))
      .mockResolvedValueOnce([
        {
          providerId: 'provider.test',
          displayName: 'Test provider',
          isDefault: true,
          available: true,
          capabilities: {
            catalog: true,
            playback: true,
            recommendations: false,
            lyrics: false,
            share: false,
            account: false,
          },
        },
      ]);

    render(<NativeApplication />);
    await waitFor(() =>
      expect(screen.getByTestId('provider-options')).toHaveTextContent('fallback'),
    );

    act(() => runtimeMocks.emit('host://core-status', { status: 'ready' }));

    await waitFor(() =>
      expect(screen.getByTestId('provider-options')).toHaveTextContent('provider.test'),
    );
    expect(runtimeMocks.invoke).toHaveBeenCalledTimes(2);
  });
});
