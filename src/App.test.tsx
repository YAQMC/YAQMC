import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PreferencesModule from './application/preferences';
import i18n from './i18n';
import { defaultPreferences, usePreferencesStore } from './application/preferences';
import { resetAccountRuntimeForTest, useAccountStore } from './application/account-runtime';
import { initialPlayerState, usePlayerStore } from './application/player-store';
import { resetLyricsStageForTests } from './application/lyrics-stage-machine';
import type { AppRoute } from './application/navigation';
import {
  ProviderContext,
  ProviderRegistryContext,
  ProviderSelectionContext,
} from './application/provider-context';
import {
  setFullscreenPortForTests,
  useLyricsPresentationStore,
  type FullscreenPort,
} from './application/lyrics-presentation';
import type { AccountPlaylistDetail, AccountSnapshot } from './domain/music';
import type { AccountMusicProvider, MusicProvider } from './providers/music-provider';
import { fakeMusicProvider } from './providers/fake/fake-music-provider';
import { MusicProviderRegistry } from './providers/provider-registry';
import { allSongs, homeFeed, librarySnapshot, playlists } from './providers/fake/fixtures';
import App from './App';

const appCatalog = vi.hoisted(() => ({
  value: {
    status: 'loading' as 'loading' | 'ready',
    home: null as typeof homeFeed | null,
    library: null as typeof librarySnapshot | null,
    message: null as string | null,
  },
}));

vi.mock('./application/native-player-runtime', () => ({
  isNativeRuntime: false,
  useNativePlayerRuntime: vi.fn(),
}));

vi.mock('./application/use-lyrics-coordinator', () => ({ useLyricsCoordinator: vi.fn() }));
vi.mock('./application/platform-integration', () => ({
  usePlatformDiagnosticsRuntime: vi.fn(),
}));
vi.mock('./application/use-theme', () => ({
  useTheme: () => ({ theme: 'dark', toggleTheme: vi.fn() }),
}));
vi.mock('./application/use-catalog', () => ({
  useCatalog: () => appCatalog.value,
}));
vi.mock('./application/preferences', async (importOriginal) => {
  const actual = await importOriginal<typeof PreferencesModule>();
  return { ...actual, usePreferencesRuntime: vi.fn() };
});

vi.mock('./components/AppBackground', () => ({ AppBackground: () => null }));
vi.mock('./components/PlayerBar', async () => {
  const { useNavigate } = await import('./application/navigation-context');
  return {
    PlayerBar: () => {
      const navigate = useNavigate();
      return (
        <button type="button" onClick={() => navigate?.({ page: 'search' })}>
          Navigate from player bar
        </button>
      );
    },
  };
});
vi.mock('./components/QueuePanel', () => ({ QueuePanel: () => null }));
vi.mock('./pages/StatisticsPage', () => ({
  StatisticsPage: () => <h1>Statistics route content</h1>,
}));
vi.mock('./components/LyricsPanel', () => ({
  LyricsPanel: ({ fullscreen }: { fullscreen: boolean }) => (
    <output data-testid="lyrics-presentation-mode">{fullscreen ? 'fullscreen' : 'windowed'}</output>
  ),
}));
vi.mock('./components/Sidebar', () => ({
  Sidebar: ({ route, onNavigate }: { route: AppRoute; onNavigate: (route: AppRoute) => void }) => (
    <aside>
      <output data-testid="active-route">{route.page}</output>
      <output data-testid="active-playlist-reference">
        {route.page === 'account-playlist'
          ? `${route.playlist.reference.kind}:${'tid' in route.playlist.reference ? route.playlist.reference.tid : route.playlist.reference.dirId}`
          : ''}
      </output>
      <button type="button" onClick={() => onNavigate({ page: 'search' })}>
        Navigate to search
      </button>
      <button
        type="button"
        onClick={() =>
          onNavigate({ page: 'account-playlist', playlist: accountPlaylistDetail().summary })
        }
      >
        Navigate to account playlist
      </button>
      <button type="button" onClick={() => onNavigate({ page: 'song', id: 'quiet-light' })}>
        Navigate to song
      </button>
      <button
        type="button"
        onClick={() =>
          onNavigate({
            page: 'song',
            id: 'plugin-song',
            providerId: 'plugin.example',
          })
        }
      >
        Navigate to plugin song
      </button>
      <button type="button" onClick={() => onNavigate({ page: 'artist', id: 'artist-mira-vale' })}>
        Navigate to artist
      </button>
      <button type="button" onClick={() => onNavigate({ page: 'statistics' })}>
        Navigate to statistics
      </button>
    </aside>
  ),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function renderApp(provider: MusicProvider = fakeMusicProvider) {
  return render(
    <ProviderContext.Provider value={provider}>
      <App />
    </ProviderContext.Provider>,
  );
}

const accountCapabilities = {
  qrLogin: true,
  favoriteRead: true,
  favoriteWrite: true,
  playlistRead: true,
  playlistWrite: true,
  recentHistoryRead: true,
};

function authenticatedSnapshot(): AccountSnapshot {
  return {
    state: 'authenticated',
    profile: {
      avatarUrl: null,
      nickname: 'Synthetic Listener',
      maskedIdentity: '10******01',
    },
    entitlement: {
      tier: 'green-diamond',
      membership: 'active',
      expiresAtMs: null,
      permittedQualities: ['standard'],
      observedMaximumQuality: 'standard',
      restrictions: [],
    },
    revision: 7,
    capabilities: accountCapabilities,
  };
}

function accountPlaylistDetail(): AccountPlaylistDetail {
  const playlist = playlists[0]!;
  return {
    summary: {
      id: 'account-playlist-a',
      reference: { kind: 'owned', tid: 'account-playlist-a', dirId: 3001 },
      title: 'Private synthetic playlist',
      description: playlist.description,
      owner: { id: 'account-owner', displayName: 'Synthetic Listener' },
      artwork: playlist.artwork,
      ownership: 'owned',
      capabilities: {
        canAddTracks: true,
        canRemoveTracks: true,
        canRename: true,
        canDelete: true,
        canReorder: false,
      },
      trackCount: 1,
      updatedAtMs: null,
    },
    tracks: {
      items: [allSongs[0]!],
      nextCursor: null,
      total: 1,
      fetchedAtMs: 1_800_000_000_000,
      stale: false,
      authRevision: 7,
    },
  };
}

function accountProvider() {
  const getPlaylist = vi.fn();
  const getAccountPlaylistTracks = vi.fn().mockResolvedValue(accountPlaylistDetail());
  const unused = vi.fn().mockRejectedValue(new Error('unused account test method'));
  return {
    value: Object.assign(Object.create(fakeMusicProvider) as MusicProvider, {
      id: 'qqmusic',
      getPlaylist,
      getAccountSnapshot: unused,
      startWebLogin: unused,
      startQrLogin: unused,
      heartbeatQrLogin: unused,
      cancelQrLogin: unused,
      refreshQrLogin: unused,
      signOut: unused,
      getFavoriteSongs: unused,
      getAccountPlaylists: unused,
      getAccountPlaylistTracks,
      getAccountRecentlyPlayed: unused,
      setFavorite: unused,
      createPlaylist: unused,
      renamePlaylist: unused,
      addPlaylistTrack: unused,
      removePlaylistTrack: unused,
      deletePlaylist: unused,
      setPlaylistCollected: unused,
    }) as MusicProvider & AccountMusicProvider,
    getPlaylist,
    getAccountPlaylistTracks,
  };
}

class ControlledFullscreenPort implements FullscreenPort {
  fullscreen = false;
  failWrite = false;
  writeGate: Promise<void> | null = null;
  writes: boolean[] = [];

  async read() {
    return this.fullscreen;
  }

  async write(value: boolean) {
    this.writes.push(value);
    if (this.writeGate) await this.writeGate;
    if (this.failWrite) throw new Error('native fullscreen denial');
    this.fullscreen = value;
  }

  async subscribe() {
    return () => undefined;
  }
}

describe('App TopBar history navigation', () => {
  let port: ControlledFullscreenPort;
  let restorePort: () => void;

  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
    port = new ControlledFullscreenPort();
    restorePort = setFullscreenPortForTests(port);
    usePlayerStore.setState(initialPlayerState);
    resetLyricsStageForTests();
    usePreferencesStore.setState(defaultPreferences);
    resetAccountRuntimeForTest();
    appCatalog.value = { status: 'loading', home: null, library: null, message: null };
  });

  afterEach(() => {
    cleanup();
    resetLyricsStageForTests();
    resetAccountRuntimeForTest();
    restorePort();
    appCatalog.value = { status: 'loading', home: null, library: null, message: null };
  });

  it('gates TopBar Back and Forward on confirmed fullscreen exit', async () => {
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'Navigate to search' }));
    await waitFor(() => expect(screen.getByTestId('active-route')).toHaveTextContent('search'));

    const delayedExit = deferred<void>();
    port.fullscreen = true;
    port.writeGate = delayedExit.promise;
    act(() => {
      usePlayerStore.setState({ lyricsOpen: true });
      useLyricsPresentationStore.setState({ fullscreen: true });
    });

    fireEvent.click(screen.getByTitle('Go back'));
    expect(screen.getByTestId('active-route')).toHaveTextContent('search');
    await waitFor(() => expect(port.writes).toEqual([false]));

    delayedExit.resolve();
    await waitFor(() => expect(screen.getByTestId('active-route')).toHaveTextContent('home'));

    port.writeGate = null;
    port.failWrite = true;
    port.fullscreen = true;
    act(() => {
      usePlayerStore.setState({ lyricsOpen: true });
      useLyricsPresentationStore.setState({ fullscreen: true });
    });

    fireEvent.click(screen.getByTitle('Go forward'));
    expect(screen.getByTestId('active-route')).toHaveTextContent('home');
    await waitFor(() => {
      expect(useLyricsPresentationStore.getState()).toEqual(
        expect.objectContaining({ pending: false, error: 'native fullscreen denial' }),
      );
    });
    expect(screen.getByTestId('active-route')).toHaveTextContent('home');

    port.failWrite = false;
    fireEvent.click(screen.getByTitle('Go forward'));
    await waitFor(() => expect(screen.getByTestId('active-route')).toHaveTextContent('search'));
  });

  it('provides App navigation to the PlayerBar shell consumer', async () => {
    renderApp();

    fireEvent.click(screen.getByRole('button', { name: 'Navigate from player bar' }));
    await waitFor(() => expect(screen.getByTestId('active-route')).toHaveTextContent('search'));
  });

  it('opens the local Statistics route without waiting for catalog data', async () => {
    appCatalog.value = { status: 'loading', home: null, library: null, message: null };
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'Navigate to statistics' }));
    expect(await screen.findByRole('heading', { name: 'Statistics route content' })).toBeVisible();
    expect(screen.getByTestId('active-route')).toHaveTextContent('statistics');
  });

  it('enters and exits fullscreen through F11 and Escape without changing playback', async () => {
    renderApp();
    const song = allSongs[0]!;
    act(() => {
      usePlayerStore.setState({
        queue: [song],
        currentIndex: 0,
        lyricsOpen: true,
        isPlaying: true,
        playbackState: 'playing',
        positionMs: 24_000,
      });
    });

    fireEvent.keyDown(window, { key: 'F11' });
    await waitFor(() => expect(port.writes).toEqual([true]));
    expect(screen.getByTestId('lyrics-presentation-mode')).toHaveTextContent('fullscreen');
    expect(usePlayerStore.getState()).toMatchObject({
      lyricsOpen: true,
      isPlaying: true,
      positionMs: 24_000,
    });

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(port.writes).toEqual([true, false]));
    expect(screen.getByTestId('lyrics-presentation-mode')).toHaveTextContent('windowed');
    expect(usePlayerStore.getState()).toMatchObject({
      lyricsOpen: true,
      isPlaying: true,
      positionMs: 24_000,
    });

    fireEvent.keyDown(window, { key: 'F11' });
    await waitFor(() => expect(port.writes).toEqual([true, false, true]));
    fireEvent.keyDown(window, { key: 'F11' });
    await waitFor(() => expect(port.writes).toEqual([true, false, true, false]));
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });

  it('projects the active provider identity without hard-coding the acceptance marker', () => {
    const view = renderApp(fakeMusicProvider);
    expect(view.container.querySelector('.app-shell')).toHaveAttribute('data-provider-id', 'fake');

    const qqmusic = Object.assign(Object.create(fakeMusicProvider) as MusicProvider, {
      id: 'qqmusic',
    });
    view.rerender(
      <ProviderContext.Provider value={qqmusic}>
        <App />
      </ProviderContext.Provider>,
    );
    expect(view.container.querySelector('.app-shell')).toHaveAttribute(
      'data-provider-id',
      'qqmusic',
    );
  });

  it('loads an account playlist through the private detail path only', async () => {
    const account = accountProvider();
    useAccountStore.setState({ snapshot: authenticatedSnapshot() });
    renderApp(account.value);

    fireEvent.click(screen.getByRole('button', { name: 'Navigate to account playlist' }));

    await waitFor(() =>
      expect(account.getAccountPlaylistTracks).toHaveBeenCalledWith(
        accountPlaylistDetail().summary,
        undefined,
        100,
        undefined,
      ),
    );
    expect(account.getPlaylist).not.toHaveBeenCalled();
    expect(
      await screen.findByRole('heading', { name: 'Private synthetic playlist' }),
    ).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Navigate to search' }));
    await waitFor(() => expect(screen.getByTestId('active-route')).toHaveTextContent('search'));
    fireEvent.click(screen.getByTitle('Go back'));
    await waitFor(() =>
      expect(screen.getByTestId('active-playlist-reference')).toHaveTextContent(
        'owned:account-playlist-a',
      ),
    );
    expect(account.getAccountPlaylistTracks).toHaveBeenCalledTimes(2);
    expect(account.getAccountPlaylistTracks).toHaveBeenLastCalledWith(
      accountPlaylistDetail().summary,
      undefined,
      100,
      undefined,
    );
  });

  it('integrates song and artist routes through the active provider', async () => {
    const getSong = vi.fn().mockResolvedValue(allSongs[0]!);
    const getArtist = vi
      .fn()
      .mockResolvedValue(await fakeMusicProvider.getArtist('artist-mira-vale'));
    const provider = Object.assign(Object.create(fakeMusicProvider) as MusicProvider, {
      getSong,
      getArtist,
    });
    appCatalog.value = { status: 'ready', home: homeFeed, library: librarySnapshot, message: null };
    renderApp(provider);

    fireEvent.click(screen.getByRole('button', { name: 'Navigate to song' }));
    expect(await screen.findByRole('heading', { name: 'Quiet Light' })).toBeVisible();
    expect(getSong).toHaveBeenCalledWith('quiet-light', expect.any(AbortSignal));

    fireEvent.click(screen.getByRole('button', { name: 'Navigate to artist' }));
    expect(await screen.findByRole('heading', { name: 'Mira Vale' })).toBeVisible();
    expect(getArtist).toHaveBeenCalledWith('artist-mira-vale', expect.any(AbortSignal));
  });

  it('keeps provider-scoped pages unavailable until their provider is restored', async () => {
    const activeProvider = Object.assign(Object.create(fakeMusicProvider) as MusicProvider, {
      id: 'qqmusic',
      displayName: 'QQ Music',
    });
    const getSong = vi.fn().mockResolvedValue(allSongs[0]!);
    const pluginProvider = Object.assign(Object.create(fakeMusicProvider) as MusicProvider, {
      id: 'plugin.example',
      displayName: 'Example Platform',
      getSong,
    });
    appCatalog.value = { status: 'ready', home: homeFeed, library: librarySnapshot, message: null };
    const tree = (available: boolean) => (
      <ProviderRegistryContext
        value={
          new MusicProviderRegistry(
            'qqmusic',
            available ? [activeProvider, pluginProvider] : [activeProvider],
          )
        }
      >
        <ProviderSelectionContext
          value={{
            activeId: 'qqmusic',
            providers: [
              { id: 'qqmusic', displayName: 'QQ Music', available: true },
              { id: 'plugin.example', displayName: 'Example Platform', available },
            ],
            selectProvider: vi.fn(),
          }}
        >
          <ProviderContext value={activeProvider}>
            <App />
          </ProviderContext>
        </ProviderSelectionContext>
      </ProviderRegistryContext>
    );
    const view = render(tree(false));

    fireEvent.click(screen.getByRole('button', { name: 'Navigate to plugin song' }));
    expect(await screen.findByRole('heading', { name: 'This item is unavailable' })).toBeVisible();
    expect(
      screen.getByText(
        'Example Platform is disabled or no longer installed. Re-enable it to restore this page.',
      ),
    ).toBeVisible();
    expect(getSong).not.toHaveBeenCalled();

    view.rerender(tree(true));
    expect(await screen.findByRole('heading', { name: 'Quiet Light' })).toBeVisible();
    expect(getSong).toHaveBeenCalledWith('plugin-song', expect.any(AbortSignal));
  });
});
