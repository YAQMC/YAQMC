import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAccountRuntimeForTest, useAccountStore } from '../application/account-runtime';
import { ProviderContext } from '../application/provider-context';
import type { AccountSnapshot } from '../domain/music';
import type { AccountMusicProvider, MusicProvider } from '../providers/music-provider';
import { AccountDialog } from './AccountDialog';

const capabilities = {
  qrLogin: true,
  favoriteRead: false,
  favoriteWrite: false,
  playlistRead: false,
  playlistWrite: false,
  recentHistoryRead: false,
};

const base = { revision: 1, capabilities };
const profile = {
  avatarUrl: 'https://qpic.y.qq.com/synthetic-avatar.png',
  nickname: 'Synthetic Listener',
  maskedIdentity: '10******01',
};
const entitlement = {
  tier: 'music-vip' as const,
  membership: 'active' as const,
  expiresAtMs: 1_800_000_000_000,
  permittedQualities: ['standard' as const],
  observedMaximumQuality: 'standard' as const,
  restrictions: [],
};

function stateSnapshot(state: AccountSnapshot['state']): AccountSnapshot {
  switch (state) {
    case 'guest':
    case 'restoring-session':
      return { ...base, state, profile: null, entitlement: null };
    case 'starting-login':
      return {
        ...base,
        state,
        attemptId: 'attempt-a',
        ownerLeaseId: 'lease-a',
        pollAfterMs: 2_000,
        profile: null,
        entitlement: null,
      };
    case 'waiting-for-scan':
      return {
        ...base,
        state,
        attemptId: 'attempt-a',
        ownerLeaseId: 'lease-a',
        qrImageDataUri: 'data:image/png;base64,AA==',
        expiresAtMs: 1_800_000_000_000,
        pollAfterMs: 2_000,
        profile: null,
        entitlement: null,
      };
    case 'waiting-for-confirmation':
      return {
        ...base,
        state,
        attemptId: 'attempt-a',
        ownerLeaseId: 'lease-a',
        expiresAtMs: 1_800_000_000_000,
        pollAfterMs: 2_000,
        profile: null,
        entitlement: null,
      };
    case 'authenticated':
      return { ...base, state, profile, entitlement };
    case 'session-expired':
    case 'reauthentication-required':
    case 'secure-store-unavailable':
      return { ...base, state, profile, entitlement };
    default:
      return {
        ...base,
        state,
        attemptId: 'attempt-a',
        profile: null,
        entitlement: null,
      };
  }
}

function provider() {
  const cancelQrLogin = vi.fn().mockResolvedValue(stateSnapshot('cancelled'));
  const startWebLogin = vi.fn().mockResolvedValue(stateSnapshot('waiting-for-confirmation'));
  const startQrLogin = vi.fn().mockResolvedValue(stateSnapshot('waiting-for-scan'));
  const refreshQrLogin = vi.fn().mockResolvedValue(stateSnapshot('waiting-for-scan'));
  const fallback = vi.fn().mockRejectedValue(new Error('unused test provider method'));
  const account = Object.fromEntries(
    [
      'getHome',
      'getAlbum',
      'getPlaylist',
      'getLibrary',
      'getLyrics',
      'search',
      'getAccountSnapshot',
      'heartbeatQrLogin',
      'signOut',
      'getFavoriteSongs',
      'getAccountPlaylists',
      'getAccountPlaylistTracks',
      'getAccountRecentlyPlayed',
      'setFavorite',
      'createPlaylist',
      'renamePlaylist',
      'addPlaylistTrack',
      'removePlaylistTrack',
      'deletePlaylist',
      'setPlaylistCollected',
    ].map((name) => [name, fallback]),
  );
  return {
    value: {
      id: 'account-test',
      displayName: 'Account Test',
      ...account,
      cancelQrLogin,
      startWebLogin,
      startQrLogin,
      refreshQrLogin,
    } as unknown as MusicProvider & AccountMusicProvider,
    cancelQrLogin,
    startWebLogin,
    startQrLogin,
    refreshQrLogin,
  };
}

function renderDialog(snapshot: AccountSnapshot, displayedQrImageDataUri: string | null = null) {
  const account = provider();
  useAccountStore.setState({ snapshot, displayedQrImageDataUri, dialogOpen: true });
  const view = render(
    <ProviderContext.Provider value={account.value}>
      <AccountDialog />
    </ProviderContext.Provider>,
  );
  return { ...view, ...account };
}

describe('AccountDialog', () => {
  beforeEach(() => resetAccountRuntimeForTest());

  it.each([
    ['guest', 'Choose QQ or WeChat to authorize QQ Music'],
    ['restoring-session', 'Restoring your account session'],
    ['starting-login', 'Opening the official authorization window'],
    ['waiting-for-confirmation', 'Complete sign-in in the official authorization window'],
    ['expired', 'This authorization attempt expired'],
    ['rejected', 'QQ Music rejected this sign-in'],
    ['cancelled', 'Sign-in was cancelled'],
    ['network-error', 'QQ Music could not be reached'],
    ['protocol-error', 'QQ Music returned an unexpected response'],
    ['authenticated', 'Signed in as Synthetic Listener'],
    ['session-expired', 'Your QQ Music session expired'],
    ['reauthentication-required', 'Authorize this account again'],
    ['secure-store-unavailable', 'The secure credential store is unavailable'],
  ] as const)('renders the %s state without raw native errors', (state, message) => {
    const { unmount } = renderDialog(stateSnapshot(state));
    expect(screen.getByRole('dialog', { name: 'QQ Music sign in' })).toBeInTheDocument();
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeVisible();
    expect(document.body.textContent).not.toContain('private native detail');
    unmount();
  });

  it('renders only the sanitized projected QR image and cancels once on unmount', () => {
    const waiting = stateSnapshot('waiting-for-scan');
    if (waiting.state !== 'waiting-for-scan') throw new Error('invalid test fixture');
    const { container, unmount, cancelQrLogin } = renderDialog(waiting, waiting.qrImageDataUri);

    expect(screen.getByRole('img', { name: 'Scan with QQ to sign in' })).toHaveAttribute(
      'src',
      'data:image/png;base64,AA==',
    );
    expect(container.innerHTML).not.toMatch(
      /qrsig|ptqrtoken|qm_keyst|cookie|https?:\/\/|attempt-a|lease-a|qrImageDataUri/i,
    );
    unmount();
    expect(cancelQrLogin).toHaveBeenCalledOnce();
  });

  it('refuses a non-data QR projection even when the native state is waiting', () => {
    renderDialog(stateSnapshot('waiting-for-scan'), 'https://untrusted.example/qr.png');
    expect(screen.queryByRole('img', { name: 'Scan with QQ to sign in' })).not.toBeInTheDocument();
    expect(screen.getByText('QQ Music returned an unexpected response.')).toBeInTheDocument();
  });

  it('routes QQ and WeChat OAuth, cancel, and close through the account store', async () => {
    const guest = renderDialog(stateSnapshot('guest'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue with QQ' }));
    expect(guest.startWebLogin).toHaveBeenCalledWith('qq', undefined);
    expect(guest.startQrLogin).not.toHaveBeenCalled();
    guest.unmount();

    resetAccountRuntimeForTest();
    const wechat = renderDialog(stateSnapshot('expired'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue with WeChat' }));
    expect(wechat.startWebLogin).toHaveBeenCalledWith('wechat', undefined);
    expect(wechat.refreshQrLogin).not.toHaveBeenCalled();
    wechat.unmount();

    resetAccountRuntimeForTest();
    const waiting = renderDialog(stateSnapshot('waiting-for-scan'), 'data:image/png;base64,AA==');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
    expect(waiting.cancelQrLogin).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(useAccountStore.getState().displayedQrImageDataUri).toBeNull();
    expect(waiting.cancelQrLogin).toHaveBeenCalledOnce();
  });

  it('contains keyboard focus and closes on Escape', () => {
    const { cancelQrLogin } = renderDialog(stateSnapshot('guest'));
    const close = screen.getByRole('button', { name: 'Close' });
    const qq = screen.getByRole('button', { name: 'Continue with QQ' });
    const wechat = screen.getByRole('button', { name: 'Continue with WeChat' });
    expect(close).toHaveFocus();

    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(wechat).toHaveFocus();
    fireEvent.keyDown(wechat, { key: 'Tab' });
    expect(close).toHaveFocus();
    expect(qq).toBeVisible();
    fireEvent.keyDown(close, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(cancelQrLogin).not.toHaveBeenCalled();
  });
});
