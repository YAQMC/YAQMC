import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CacheStats } from '@yaqmc/client';
import i18n from '../i18n';
import { resetAccountRuntimeForTest, useAccountStore } from '../application/account-runtime';
import { defaultPreferences, usePreferencesStore } from '../application/preferences';
import { resolveLyricsPreset } from '../application/lyrics-preset';
import {
  ProviderContext,
  ProviderSelectionContext,
  useMusicProviderSelection,
  type MusicProviderSelection,
} from '../application/provider-context';
import { getYaqmcClient } from '../application/yaqmc-runtime';
import type { AccountSnapshot } from '../domain/music';
import type { AccountMusicProvider, MusicProvider } from '../providers/music-provider';
import { SettingsPage } from './SettingsPage';

const storageSettings = vi.hoisted(() => ({
  available: true,
  cache: null as CacheStats | null,
  loading: false,
  clearing: false,
  error: null as 'read' | 'clear' | null,
  refresh: vi.fn(),
  clearCache: vi.fn(),
}));
const runtime = vi.hoisted(() => ({ android: false }));
vi.mock('../application/storage-settings', () => ({ useStorageSettings: () => storageSettings }));

vi.mock('../application/host-capabilities', () => {
  const desktop = {
    windowControls: true,
    lyricsSurfaces: true,
    plugins: true,
    localApi: true,
    fileExport: true,
    fileImport: true,
    nativeShare: false,
    deepLinks: true,
    updateMode: 'install',
  } as const;
  return {
    hostCapabilities: () => desktop,
    hasHostCapability: (capability: keyof typeof desktop) => Boolean(desktop[capability]),
    isAndroidRuntime: () => runtime.android,
    supportsLyricsSurfaces: () => true,
    supportsWindowControls: () => true,
  };
});

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
    profileId: 'default',
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
    profileId: 'default',
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
      'refreshAccount',
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

function LegacySelectionProbe() {
  const selection = useMusicProviderSelection();
  return <output data-testid="legacy-selection-render">{selection.providers.length}</output>;
}

function renderProfileSettings(provider: MusicProvider) {
  const selection: MusicProviderSelection = {
    active: { providerId: 'qqmusic', profileId: 'default' },
    activeSelection: { providerId: 'qqmusic', profileId: 'default' },
    activeId: 'qqmusic',
    activeProfileId: 'default',
    providers: [
      {
        id: 'qqmusic',
        profileId: 'default',
        displayName: 'QQ Music',
        available: true,
      },
      {
        id: 'qqmusic',
        profileId: 'secondary',
        displayName: 'Secondary account',
        available: true,
      },
    ],
    selectProvider: vi.fn(),
    selectProviderProfile: vi.fn(),
  };
  return render(
    <ProviderSelectionContext.Provider value={selection}>
      <ProviderContext.Provider value={provider}>
        <SettingsPage />
      </ProviderContext.Provider>
    </ProviderSelectionContext.Provider>,
  );
}

function mockProfileInvoke(result: unknown) {
  return vi.spyOn(getYaqmcClient(), 'invoke').mockImplementation((method) => {
    if (method === 'plugin_list') return Promise.resolve([] as never);
    if (method === 'lyrics_surface_capabilities') {
      return Promise.resolve({
        backend: 'test',
        reliableAlwaysOnTop: true,
        reliableClickThrough: true,
        limitations: [],
      } as never);
    }
    return Promise.resolve(result as never);
  });
}

describe('SettingsPage account section', () => {
  beforeEach(async () => {
    runtime.android = false;
    Object.assign(storageSettings, { cache: null, loading: false, clearing: false, error: null });
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

  it('disables system Fluid Cloud on Android even with an old enabled island preference', async () => {
    runtime.android = true;
    usePreferencesStore.setState({
      surfaces: {
        ...defaultPreferences.surfaces,
        desktop: {
          ...defaultPreferences.surfaces.desktop,
          enabled: true,
          interaction: 'passive-locked',
        },
        island: { ...defaultPreferences.surfaces.island, enabled: true },
      },
    });
    mockProfileInvoke(null);
    renderSettings(accountProvider().value);
    const island = screen.getByRole('switch', {
      name: 'Enable System island / Fluid Cloud',
    });
    expect(island).toBeDisabled();
    expect(island).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Enable Floating lyrics' })).toBeChecked();
    expect(
      screen.getByText(/Touches pass through locked lyrics and the toolbar is hidden/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Plugin development' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Contribute an adapter' })).toBeEnabled();
  });

  it('renders host cache files including component entries and calls host maintenance actions', async () => {
    storageSettings.cache = {
      totalBytes: 2048,
      mediaBytes: 1024,
      artworkBytes: 512,
      componentBytes: 512,
      mediaEntries: 1,
      artworkEntries: 2,
      componentEntries: 3,
      metadataEntries: 4,
      lyricEntries: 5,
      mediaLimitBytes: 4096,
      artworkLimitBytes: 4096,
    };
    renderSettings(accountProvider().value);
    expect(
      screen.getByText(/2 KiB across 6 files, 4 metadata records, and 5 lyric records/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear cache' }));
    expect(storageSettings.clearCache).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh cache usage' }));
    expect(storageSettings.refresh).toHaveBeenCalled();
  });

  it('reports a native cache read failure instead of claiming desktop runtime is unavailable', async () => {
    storageSettings.error = 'read';
    renderSettings(accountProvider().value);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not read local cache usage. Please retry.',
    );
    expect(
      screen.queryByText('Cache management requires the native app runtime.'),
    ).not.toBeInTheDocument();
  });

  it('keeps the legacy ProviderContext selection stable while rendering Settings', () => {
    const account = accountProvider();
    render(
      <ProviderContext.Provider value={account.value}>
        <LegacySelectionProbe />
      </ProviderContext.Provider>,
    );
    expect(screen.getByTestId('legacy-selection-render')).toHaveTextContent('1');
  });

  it('creates a QQ profile from the profile manager', async () => {
    const invoke = mockProfileInvoke({
      providerId: 'qqmusic',
      profileId: 'new-profile',
      label: 'Travel account',
      enabled: true,
    });
    const account = accountProvider();
    renderProfileSettings(account.value);
    fireEvent.change(screen.getByLabelText('New QQ Music profile'), {
      target: { value: 'Travel account' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add profile' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('provider_profile_create', {
        providerId: 'qqmusic',
        label: 'Travel account',
      }),
    );
    expect(await screen.findByText('Travel account')).toBeInTheDocument();
  });

  it('disables a profile and confirms deletion errors, while protecting default', async () => {
    const invoke = mockProfileInvoke({
      providerId: 'qqmusic',
      profileId: 'secondary',
      label: 'Secondary account',
      enabled: false,
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const account = accountProvider();
    renderProfileSettings(account.value);
    expect(screen.getAllByRole('button', { name: 'Disable' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('provider_profile_disable', {
        providerId: 'qqmusic',
        profileId: 'secondary',
      }),
    );
    invoke.mockRejectedValue(new Error('profile delete failed'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(confirm).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('profile change'));
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

  it('adjusts and persists the interface font size separately from lyrics', async () => {
    const account = accountProvider();
    renderSettings(account.value);

    const fontScale = screen.getByLabelText('Interface font size');
    expect(fontScale).toHaveValue('100');

    fireEvent.change(fontScale, { target: { value: '120' } });

    expect(usePreferencesStore.getState().appearance.interfaceFontScale).toBe(120);
    expect(usePreferencesStore.getState().lyrics.fontSize).toBe('medium');
  });

  it('selects a curated interface font without accepting a custom CSS value', () => {
    const account = accountProvider();
    renderSettings(account.value);

    fireEvent.click(screen.getByRole('combobox', { name: 'Interface font' }));
    fireEvent.click(screen.getByRole('option', { name: 'Monospace' }));

    expect(usePreferencesStore.getState().appearance.interfaceFontFamily).toBe('monospace');
  });

  it('shows clipboard deep-link parsing as an explicit opt-in desktop setting', () => {
    const account = accountProvider();
    renderSettings(account.value);

    const fallback = screen.getByRole('switch', { name: 'Clipboard link fallback' });
    expect(fallback).not.toBeChecked();
    expect(fallback).toBeDisabled();
    expect(
      screen.getByText(
        'Checks once when YAQMC regains focus. Opens each valid yaqmc:// song target only once per app session and ignores links copied by YAQMC.',
      ),
    ).toBeInTheDocument();
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

  it('displays NetEase account avatars and falls back cleanly on image errors', () => {
    const account = accountProvider({
      id: 'org.yaqmc.providers.music.netease',
      profileId: 'default',
    });
    const url = 'https://p2.music.126.net/synthetic-account-avatar.jpg';
    useAccountStore.setState({ snapshot: authenticatedSnapshot(url) });
    const { container } = renderSettings(account.value);
    const avatar = screen.getByRole('img', { name: 'Synthetic Listener account avatar' });
    expect(avatar).toHaveAttribute('src', url);
    fireEvent.error(avatar);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(container.querySelector('.settings-account-profile__avatar')).toHaveTextContent('S');
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
        profileId: 'default',
        attemptId: 'private-attempt-id',
        profile: null,
        entitlement: null,
        revision: 4,
        capabilities,
      },
      error: 'protocol',
    });
    const { container } = renderSettings(account.value);

    expect(screen.getByText('Account Test returned an unexpected response.')).toBeInTheDocument();
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

  it('ends with localized product identity and project links without duplicating diagnostic controls', async () => {
    const account = accountProvider();
    useAccountStore.setState({ snapshot: authenticatedSnapshot() });
    const { container } = renderSettings(account.value);

    expect(screen.getByRole('heading', { name: 'About' })).toBeInTheDocument();
    expect(screen.getByText('Yet Another QMusicClient')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /GitHub repository/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Third-party licenses/ })).toBeInTheDocument();
    expect(container.textContent).toContain('unofficial third-party QQ Music client');
    expect(screen.queryByRole('button', { name: 'Copy diagnostics' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Diagnostics & logging' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Debug' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export bundle' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export diagnostics' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Report a problem' })).toHaveLength(1);
    expect(screen.getByRole('switch', { name: 'Show frame rate' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Report an issue/ })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Classic' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Immersive' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Vinyl' })).toBeInTheDocument();
  });

  it('toggles lyrics word jump on and off', () => {
    const account = accountProvider();
    renderSettings(account.value);

    const wordJump = screen.getByRole('switch', { name: 'Word jump' });
    expect(wordJump).toBeChecked();
    expect(usePreferencesStore.getState().lyrics.wordEffect).toBe('jump');

    fireEvent.click(wordJump);

    expect(usePreferencesStore.getState().lyrics.wordEffect).toBe('fill');
    expect(wordJump).not.toBeChecked();
  });

  it('selects the card-free fullscreen controls independently and preserves them through hydration', () => {
    const { unmount } = renderSettings(accountProvider().value);
    fireEvent.click(screen.getByRole('combobox', { name: 'Fullscreen lyrics bar' }));
    fireEvent.click(screen.getByRole('option', { name: 'Below cover (no card)' }));
    const saved = usePreferencesStore.getState().transport;
    expect(saved).toEqual({
      ...defaultPreferences.transport,
      fullscreen: 'builtin.transport.window',
    });
    unmount();
    usePreferencesStore.getState().hydrate({ ...defaultPreferences, transport: saved });
    renderSettings(accountProvider().value);
    expect(screen.getByRole('combobox', { name: 'Fullscreen lyrics bar' })).toHaveTextContent(
      'Below cover (no card)',
    );
  });

  it('offers a persistent Traditional Chinese interface choice independent of lyrics', () => {
    renderSettings(accountProvider().value);
    fireEvent.click(screen.getByRole('combobox', { name: 'Application language' }));
    fireEvent.click(screen.getByRole('option', { name: '繁體中文' }));
    expect(usePreferencesStore.getState().locale).toBe('zh-TW');
    expect(usePreferencesStore.getState().lyrics.chineseScript).toBe(
      defaultPreferences.lyrics.chineseScript,
    );
    expect(window.localStorage.getItem('yaqmc.locale')).toBe('zh-TW');
  });

  it('sets Traditional Chinese lyrics without changing the interface locale', () => {
    renderSettings(accountProvider().value);
    fireEvent.click(screen.getByRole('combobox', { name: 'Chinese lyric script' }));
    fireEvent.click(screen.getByRole('option', { name: 'Traditional Chinese (Taiwan)' }));
    expect(usePreferencesStore.getState().lyrics.chineseScript).toBe('traditional');
    expect(usePreferencesStore.getState().locale).toBe(defaultPreferences.locale);
  });

  it('adjusts the secondary font independently for each lyrics surface', () => {
    usePreferencesStore.setState({
      surfaces: {
        desktop: { ...defaultPreferences.surfaces.desktop, enabled: true },
        island: { ...defaultPreferences.surfaces.island, enabled: true },
      },
    });
    renderSettings(accountProvider().value);
    const sliders = screen.getAllByRole('slider', {
      name: 'Translation and romanization font size',
    });
    fireEvent.change(sliders[0]!, { target: { value: '22' } });
    expect(usePreferencesStore.getState().surfaces.desktop.secondaryFontSize).toBe(22);
    expect(usePreferencesStore.getState().surfaces.desktop.fontSize).toBe(30);
    expect(usePreferencesStore.getState().surfaces.island.secondaryFontSize).toBe(8.84);
  });

  it('moves active-preset typography and lyrics weight into the settings page', () => {
    const account = accountProvider();
    renderSettings(account.value);

    const fontSize = screen.getByRole('slider', { name: 'Lyrics font size' });
    expect(Number.parseFloat(fontSize.style.getPropertyValue('--range-progress'))).toBeCloseTo(40);

    fireEvent.change(fontSize, {
      target: { value: '1.25' },
    });
    fireEvent.change(screen.getByRole('slider', { name: 'Lyrics line spacing' }), {
      target: { value: '1.4' },
    });
    fireEvent.click(screen.getByRole('combobox', { name: 'Lyrics font weight' }));
    fireEvent.click(screen.getByRole('option', { name: 'Semibold (600)' }));

    expect(resolveLyricsPreset(usePreferencesStore.getState().lyricsPresets).typography).toEqual({
      fontScale: 1.25,
      lineHeight: 1.4,
    });
    expect(usePreferencesStore.getState().lyrics.fontWeight).toBe('600');
  });

  it('updates AMLL renderer preferences from the lyrics settings', () => {
    const account = accountProvider();
    renderSettings(account.value);

    fireEvent.click(screen.getByRole('switch', { name: 'Spring scrolling' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Hide passed lines' }));
    fireEvent.change(screen.getByRole('slider', { name: 'Word transition width' }), {
      target: { value: '0.75' },
    });

    expect(usePreferencesStore.getState().amll).toEqual({
      ...defaultPreferences.amll,
      enableSpring: false,
      hidePassedLines: true,
      wordFadeWidth: 0.75,
    });
  });
});
