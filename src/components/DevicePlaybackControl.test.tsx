import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DevicePlaybackPreview } from '@yaqmc/client';
import { ProviderContext } from '../application/provider-context';
import { resetAccountRuntimeForTest, useAccountStore } from '../application/account-runtime';
import { qqMusicProvider } from '../providers/qqmusic/qq-music-provider';
import { allSongs } from '../providers/fake/fixtures';
import i18n from '../i18n';
import { DevicePlaybackControl } from './DevicePlaybackControl';
import { ANDROID_MODAL_BACK_EVENT } from '../application/android-back-navigation';

const api = vi.hoisted(() => ({ invoke: vi.fn(), sharing: vi.fn() }));
vi.mock('../application/yaqmc-runtime', () => ({
  getYaqmcClient: () => ({
    invoke: (method: string, params: unknown) =>
      method.endsWith('_sharing') ? api.sharing(method, params) : api.invoke(method, params),
  }),
  getHostBridge: () => ({ kind: 'android' }),
}));
vi.mock('../application/native-player-runtime', () => ({ isNativeRuntime: true }));

const preview: DevicePlaybackPreview = {
  token: 'a'.repeat(32),
  currentSongId: allSongs[0]!.id,
  tracks: [allSongs[0]!],
  updatedAtMs: 1_800_000_000_000,
  queueTruncated: false,
  expiresInMs: 30_000,
};

function signedIn(profileId = 'default', identity = '1***1') {
  useAccountStore.setState({
    snapshot: {
      ...useAccountStore.getState().snapshot,
      state: 'authenticated',
      providerId: 'qqmusic',
      profileId,
      profile: { nickname: 'Listener', avatarUrl: null, maskedIdentity: identity },
      entitlement: {
        tier: 'free',
        membership: 'active',
        expiresAtMs: null,
        restrictions: [],
        permittedQualities: ['standard'],
        observedMaximumQuality: 'standard',
      },
    },
  });
}
function view(profileId = 'default') {
  return (
    <ProviderContext.Provider
      value={Object.assign(Object.create(qqMusicProvider) as typeof qqMusicProvider, { profileId })}
    >
      <DevicePlaybackControl />
    </ProviderContext.Provider>
  );
}
async function open() {
  fireEvent.click(
    screen.getByRole('button', { name: 'Resume from another device (experimental)' }),
  );
  await screen.findByRole('button', { name: 'Play here and try taking over' });
}

beforeEach(async () => {
  resetAccountRuntimeForTest();
  await i18n.changeLanguage('en-US');
  signedIn();
  api.invoke.mockReset();
  api.sharing.mockReset();
  api.sharing.mockResolvedValue({
    enabled: false,
    platform: 'android',
    reportStatus: 'not-sent',
    lastErrorCode: null,
    lastReportedAtMs: null,
  });
  api.invoke.mockImplementation(async (method: string) =>
    method.endsWith('_preview')
      ? preview
      : {
          localStarted: true,
          reportStatus: 'reported',
          reportErrorCode: null,
          remotePauseConfirmed: false,
        },
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('remote playback control', () => {
  it('only writes the sharing setting after a user gesture and displays native platform', async () => {
    render(view());
    await open();
    const toggle = screen.getByRole('checkbox', { name: 'Share playback with my other devices' });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).not.toBeChecked();
    expect(api.sharing).toHaveBeenCalledExactlyOnceWith('provider_device_playback_sharing', {
      providerId: 'qqmusic',
      profileId: 'default',
    });
    expect(screen.getByText('Device profile: Android')).toBeInTheDocument();
    api.sharing.mockResolvedValue({
      enabled: true,
      platform: 'android',
      reportStatus: 'reported',
      lastErrorCode: null,
      lastReportedAtMs: 1,
    });
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(api.sharing).toHaveBeenLastCalledWith('provider_device_playback_sharing', {
      providerId: 'qqmusic',
      profileId: 'default',
      enabled: true,
    });
    expect(screen.getByText('Playback report request returned.')).toBeInTheDocument();
    expect(api.invoke).toHaveBeenCalledTimes(1);
  });
  it('explains preview-only playback without implying a listening report was sent', async () => {
    api.invoke.mockImplementation(async (method: string) =>
      method.endsWith('_preview')
        ? preview
        : {
            localStarted: true,
            reportStatus: 'not-sent',
            reportErrorCode: 'preview-only',
            remotePauseConfirmed: false,
          },
    );
    render(view());
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Play here and try taking over' }));
    await screen.findByText(
      'Only an official preview is available here. No listening report was sent.',
    );
    expect(screen.queryByText(/listening report request returned/)).not.toBeInTheDocument();
  });
  it('consumes Android Back while the preview dialog is open', async () => {
    render(view());
    await open();
    const event = new Event(ANDROID_MODAL_BACK_EVENT, { cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const next = new Event(ANDROID_MODAL_BACK_EVENT, { cancelable: true });
    window.dispatchEvent(next);
    expect(next.defaultPrevented).toBe(false);
    expect(api.invoke).toHaveBeenCalledTimes(1);
  });
  it('reads a profile-scoped preview without writing until explicit confirmation', async () => {
    signedIn('work');
    render(view('work'));
    await open();
    expect(api.invoke).toHaveBeenCalledExactlyOnceWith('provider_device_playback_preview', {
      providerId: 'qqmusic',
      profileId: 'work',
    });
    expect(screen.getByText(/playback starts at the beginning/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Play here and try taking over' }));
    await screen.findByText('Playback started on this device.');
    expect(api.invoke).toHaveBeenLastCalledWith('provider_device_playback_takeover', {
      providerId: 'qqmusic',
      profileId: 'work',
      token: preview.token,
    });
    expect(screen.getByText(/does not confirm that the other device paused/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Play here and try taking over' }),
    ).not.toBeInTheDocument();
  });

  it('coalesces repeated confirmation and retains an uncertain report outcome without retry', async () => {
    let resolve!: (value: unknown) => void;
    api.invoke.mockImplementation((method: string) =>
      method.endsWith('_preview')
        ? Promise.resolve(preview)
        : new Promise((done) => {
            resolve = done;
          }),
    );
    render(view());
    await open();
    const confirm = screen.getByRole('button', { name: 'Play here and try taking over' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(api.invoke.mock.calls.filter(([method]) => method.endsWith('_takeover'))).toHaveLength(
      1,
    );
    await act(async () =>
      resolve({
        localStarted: true,
        reportStatus: 'unconfirmed',
        reportErrorCode: 'outcome-unknown',
        remotePauseConfirmed: false,
      }),
    );
    expect(screen.getByText(/outcome is uncertain. It was not retried/)).toBeInTheDocument();
    expect(api.invoke).toHaveBeenCalledTimes(2);
  });

  it('expires a preview and requires a new read before confirmation', async () => {
    api.invoke.mockResolvedValue({ ...preview, expiresInMs: 1 });
    render(view());
    await open();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Play here and try taking over' })).toBeDisabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Play here and try taking over' }));
    expect(api.invoke).toHaveBeenCalledTimes(1);
  });

  it('discards a late preview after the account/profile changes', async () => {
    let resolve!: (value: DevicePlaybackPreview) => void;
    api.invoke.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { rerender } = render(view());
    fireEvent.click(
      screen.getByRole('button', { name: 'Resume from another device (experimental)' }),
    );
    act(() => signedIn('work', '2***2'));
    rerender(view('work'));
    await act(async () => resolve(preview));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await open();
    expect(api.invoke).toHaveBeenLastCalledWith('provider_device_playback_preview', {
      providerId: 'qqmusic',
      profileId: 'work',
    });
  });

  it('blocks signed-out use and shows an empty or failed read without issuing a takeover', async () => {
    act(() => resetAccountRuntimeForTest());
    render(view());
    expect(
      screen.getByRole('button', { name: 'Sign in to QQ Music to try cross-device playback' }),
    ).toBeDisabled();
    expect(api.invoke).not.toHaveBeenCalled();
    act(() => signedIn());
    api.invoke.mockResolvedValueOnce(null);
    fireEvent.click(
      screen.getByRole('button', { name: 'Resume from another device (experimental)' }),
    );
    await screen.findByText(/No valid recent playback snapshot/);
    api.invoke.mockRejectedValueOnce(new Error('network'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh remote preview' }));
    await screen.findByText(/operation did not complete/);
    expect(api.invoke.mock.calls.every(([method]) => method.endsWith('_preview'))).toBe(true);
  });
});
