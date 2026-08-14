import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { resetAccountRuntimeForTest, useAccountStore } from '../application/account-runtime';
import { defaultPreferences, usePreferencesStore } from '../application/preferences';
import { ProviderContext } from '../application/provider-context';
import type { AccountSnapshot } from '../domain/music';
import type { AccountMusicProvider, MusicProvider } from '../providers/music-provider';
import { SettingsPage } from './SettingsPage';

const capabilities = {
  qrLogin: true,
  favoriteRead: true,
  favoriteWrite: true,
  playlistRead: true,
  playlistWrite: true,
  recentHistoryRead: true,
};

function guestSnapshot(revision = 1): AccountSnapshot {
  return {
    state: 'guest',
    profile: null,
    entitlement: null,
    revision,
    capabilities,
  };
}

function authenticatedSnapshot(
  avatarUrl: string | null = 'https://thirdwx.qlogo.cn/synthetic-avatar.png',
): AccountSnapshot {
  return {
    state: 'authenticated',
    profile: {
      avatarUrl,
      nickname: 'Synthetic Listener',
      maskedIdentity: '10******01',
    },
    entitlement: {
      tier: 'green-diamond',
      membership: 'active',
      expiresAtMs: 1_800_000_000_000,
      permittedQualities: ['standard'],
      observedMaximumQuality: 'standard',
      restrictions: [],
    },
    revision: 2,
    capabilities,
  };
}

function accountProvider(overrides: Partial<AccountMusicProvider> = {}) {
  const unused = vi.fn().mockRejectedValue(new Error('unused test provider method'));
  const signOut = vi.fn().mockResolvedValue(guestSnapshot(3));
  const accountMethods = Object.fromEntries(
    [
      'getHome',
      'getAlbum',
      'getPlaylist',
      'getLibrary',
      'getLyrics',
      'search',
      'getAccountSnapshot',
      'startWebLogin',
      'startQrLogin',
      'heartbeatQrLogin',
      'cancelQrLogin',
      'refreshQrLogin',
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
    ].map((name) => [name, unused]),
  );
  return {
    value: {
      id: 'account-test',
      displayName: 'Account Test',
      ...accountMethods,
      signOut,
      ...overrides,
    } as unknown as MusicProvider & AccountMusicProvider,
    signOut,
  };
}

function renderSettings(provider: MusicProvider) {
  return render(
    <ProviderContext.Provider value={provider}>
      <SettingsPage />
    </ProviderContext.Provider>,
  );
}

describe('SettingsPage account section', () => {
  beforeEach(async () => {
    resetAccountRuntimeForTest();
    usePreferencesStore.setState({
      ...defaultPreferences,
      appearance: { ...defaultPreferences.appearance },
    });
    await i18n.changeLanguage('en-US');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('previews rapid color input without committing until the native change event', () => {
    const account = accountProvider();
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    renderSettings(account.value);
    const picker = screen.getByLabelText('Pick Primary color');

    fireEvent.input(picker, { target: { value: '#112233' } });
    fireEvent.input(picker, { target: { value: '#445566' } });

    expect(window.requestAnimationFrame).toHaveBeenCalledOnce();
    expect(usePreferencesStore.getState().appearance.primaryColor).toBe('#A8C95E');
    frames[0]?.(16);
    expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('#445566');

    fireEvent.change(picker, { target: { value: '#445566' } });
    expect(usePreferencesStore.getState().appearance.primaryColor).toBe('#445566');
  });

  it('opens the sanitized account dialog without starting login from Settings', () => {
    const account = accountProvider();
    useAccountStore.setState({ snapshot: guestSnapshot() });
    renderSettings(account.value);

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(useAccountStore.getState().dialogOpen).toBe(true);
    expect(account.value.startQrLogin).not.toHaveBeenCalled();
    expect(screen.getAllByText('Guest')).toHaveLength(2);
  });

  it('renders only sanitized profile and entitlement fields, then signs out through the runtime', async () => {
    const account = accountProvider();
    useAccountStore.setState({ snapshot: authenticatedSnapshot() });
    const { container } = renderSettings(account.value);

    expect(screen.getByText('Synthetic Listener')).toBeInTheDocument();
    expect(screen.getByText('10******01')).toBeInTheDocument();
    expect(screen.getByText('Green Diamond')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Synthetic Listener account avatar' })).toHaveAttribute(
      'src',
      'https://thirdwx.qlogo.cn/synthetic-avatar.png',
    );
    expect(container.innerHTML).not.toMatch(/qrsig|ptqrtoken|qm_keyst|cookie|attempt-id|lease-id/i);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out locally' }));
    await waitFor(() => expect(account.signOut).toHaveBeenCalledOnce());
    await waitFor(() => expect(useAccountStore.getState().snapshot.state).toBe('guest'));
  });

  it('renders verified secondary entitlements as understated account metadata', () => {
    const account = accountProvider();
    const snapshot = authenticatedSnapshot();
    if (snapshot.state !== 'authenticated') throw new Error('authenticated fixture expected');
    snapshot.entitlement.secondaryEntitlements = ['annual-green-diamond', 'family'];
    useAccountStore.setState({ snapshot });

    renderSettings(account.value);

    expect(screen.getByText('Additional entitlements')).toBeInTheDocument();
    expect(screen.getByText('Annual Green Diamond · Family entitlement')).toBeInTheDocument();
  });

  it('refuses an untrusted avatar origin', () => {
    const account = accountProvider();
    useAccountStore.setState({
      snapshot: authenticatedSnapshot('https://untrusted.example/a.png'),
    });
    const { container } = renderSettings(account.value);

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain('untrusted.example');
  });

  it('renders an out-of-range membership expiry as unknown instead of throwing', () => {
    const account = accountProvider();
    const snapshot = authenticatedSnapshot();
    if (snapshot.state !== 'authenticated') throw new Error('invalid authenticated fixture');
    useAccountStore.setState({
      snapshot: {
        ...snapshot,
        entitlement: { ...snapshot.entitlement, expiresAtMs: Number.MAX_VALUE },
      },
    });

    renderSettings(account.value);

    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('uses stable protocol copy without exposing the opaque attempt', () => {
    const account = accountProvider();
    useAccountStore.setState({
      snapshot: {
        state: 'protocol-error',
        attemptId: 'private-attempt-id',
        profile: null,
        entitlement: null,
        revision: 4,
        capabilities,
      },
      error: 'protocol',
    });
    const { container } = renderSettings(account.value);

    expect(screen.getByText('QQ Music returned an unexpected response.')).toBeInTheDocument();
    expect(container.textContent).not.toContain('private-attempt-id');
  });

  it('keeps preferred quality separate from the observed account maximum', async () => {
    const account = accountProvider();
    useAccountStore.setState({ snapshot: authenticatedSnapshot() });
    renderSettings(account.value);

    expect(screen.getByLabelText('Account can currently access')).toHaveTextContent('Standard');
    expect(screen.getByLabelText('Preferred playback quality')).toHaveTextContent('Automatic');

    const upgraded = authenticatedSnapshot();
    if (upgraded.state !== 'authenticated') throw new Error('invalid authenticated fixture');
    useAccountStore.setState({
      snapshot: {
        ...upgraded,
        revision: 3,
        entitlement: {
          ...upgraded.entitlement,
          permittedQualities: ['standard', 'high', 'lossless'],
          observedMaximumQuality: 'lossless',
        },
      },
    });

    await waitFor(() =>
      expect(screen.getByLabelText('Account can currently access')).toHaveTextContent('Lossless'),
    );
    expect(screen.getByLabelText('Preferred playback quality')).toHaveTextContent('Automatic');
  });

  it('ends with localized product identity, live project links, and safe diagnostic copy', async () => {
    const account = accountProvider();
    useAccountStore.setState({ snapshot: authenticatedSnapshot() });
    const { container } = renderSettings(account.value);

    expect(screen.getByRole('heading', { name: 'About' })).toBeInTheDocument();
    expect(screen.getByText('Yet Another QMusicClient')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /GitHub repository/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Third-party licenses/ })).toBeInTheDocument();
    expect(container.textContent).toContain('unofficial third-party QQ Music client');

    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledOnce());
    const copied = vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0];
    expect(copied).toContain('YAQMC version: 0.1.0');
    expect(copied).toContain('QQ provider mode: unavailable / authenticated');
    expect(copied).not.toMatch(/cookie|oauth|token|qrsig|ekey|authorization|private/iu);
  });
});
