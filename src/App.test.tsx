import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PreferencesModule from './application/preferences';
import i18n from './i18n';
import { defaultPreferences, usePreferencesStore } from './application/preferences';
import { resetAccountRuntimeForTest, useAccountStore } from './application/account-runtime';
import { initialPlayerState, usePlayerStore } from './application/player-store';
import { resetLyricsStageForTests } from './application/lyrics-stage-machine';
import type { AppRoute } from './application/navigation';
import { ProviderContext } from './application/provider-context';
import {
  setFullscreenPortForTests,
  useLyricsPresentationStore,
  type FullscreenPort,
} from './application/lyrics-presentation';
import type { AccountPlaylistDetail, AccountSnapshot } from './domain/music';
import type { AccountMusicProvider, MusicProvider } from './providers/music-provider';
import { fakeMusicProvider } from './providers/fake/fake-music-provider';
import { allSongs, playlists } from './providers/fake/fixtures';
import App from './App';

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
  useCatalog: () => ({ status: 'loading', home: null, library: null, message: null }),
}));
vi.mock('./application/preferences', async (importOriginal) => {
  const actual = await importOriginal<typeof PreferencesModule>();
  return { ...actual, usePreferencesRuntime: vi.fn() };
});

vi.mock('./components/AppBackground', () => ({ AppBackground: () => null }));
vi.mock('./components/PlayerBar', () => ({ PlayerBar: () => null }));
vi.mock('./components/QueuePanel', () => ({ QueuePanel: () => null }));
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
  });

  afterEach(() => {
    cleanup();
    resetLyricsStageForTests();
    resetAccountRuntimeForTest();
    restorePort();
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
});
