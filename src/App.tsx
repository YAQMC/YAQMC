import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AccountPlaylistDetail, Album, AreaFeed, HomeFeed, MediaCollection, Playlist } from './domain/music';
import { useCatalog } from './application/use-catalog';
import { useGuessContinuation } from './application/use-guess-continuation';
import { useTheme } from './application/use-theme';
import type { AppRoute } from './application/navigation';
import { usePlayerStore } from './application/player-store';
import { isNativeRuntime, useNativePlayerRuntime } from './application/native-player-runtime';
import { useLyricsCoordinator } from './application/use-lyrics-coordinator';
import { useMusicProvider } from './application/provider-context';
import {
  accountPlaylistDetailToPlaylist,
  type AccountListResource,
  type LibraryResource,
  useAccountStore,
} from './application/account-runtime';
import { isAccountMusicProvider } from './providers/music-provider';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { PlayerBar } from './components/PlayerBar';
import { QueuePanel } from './components/QueuePanel';
import { ApplicationContextMenu } from './components/ApplicationContextMenu';
import { LyricsPanel } from './components/LyricsPanel';
import { LoadingState } from './components/ui/LoadingState';
import { RouteErrorBoundary } from './components/ui/RouteErrorBoundary';
import { HomePage } from './pages/HomePage';
import { AlbumPage } from './pages/AlbumPage';
import { AreaPage } from './pages/AreaPage';
import { PlaylistPage } from './pages/PlaylistPage';
import { ExplorePage } from './pages/ExplorePage';
import { LibraryPage } from './pages/LibraryPage';
import { SearchPage } from './pages/SearchPage';
import { AppBackground } from './components/AppBackground';
import { FpsOverlay } from './components/FpsOverlay';
import { PluginNoticeHost } from './components/PluginNoticeHost';
import { CoreStatusBanner } from './components/CoreStatusBanner';
import { usePreferencesRuntime, usePreferencesStore } from './application/preferences';
import {
  lyricsEscapeAction,
  startLyricsPresentationRuntime,
  useLyricsPresentationStore,
} from './application/lyrics-presentation';
import {
  closeLyricsPresentation,
  exitLyricsFullscreen,
  runAfterLyricsClose,
  toggleQueueAfterLyricsClose,
} from './application/lyrics-presentation-actions';
import { useLyricsStageStore } from './application/lyrics-stage-machine';
import { usePlatformDiagnosticsRuntime } from './application/platform-integration';
import { getYaqmcClient } from './application/yaqmc-runtime';
import { usePluginHost } from './application/plugin-runtime';
import { installPlaybackUiProbe } from './application/playback-ui-probe';
import './styles/index.css';

const SettingsPage = lazy(async () => {
  const module = await import('./pages/SettingsPage');
  return { default: module.SettingsPage };
});

interface NavigationHistory {
  entries: AppRoute[];
  index: number;
}

const initialRoute: AppRoute = { page: 'home' };

function routesEqual(first: AppRoute, second: AppRoute): boolean {
  return (
    first.page === second.page &&
    ('id' in first ? first.id === ('id' in second ? second.id : '') : true)
  );
}

function collectEntities(collections: MediaCollection[]) {
  const albums: Album[] = [];
  const playlists: Playlist[] = [];
  for (const collection of collections) {
    if (collection.type === 'album') albums.push(collection.item);
    else playlists.push(collection.item);
  }
  return { albums, playlists };
}

function homePlaylists(home: HomeFeed): Playlist[] {
  return [
    ...home.madeForYou,
    ...collectEntities(home.recentlyPlayed).playlists,
    ...[home.guessSonglist, home.dailySonglist, home.newSongSonglist].filter(
      (playlist): playlist is Playlist => playlist !== null,
    ),
    ...home.recommendedSonglists,
  ];
}

export default function App() {
  const { t } = useTranslation('pages');
  const provider = useMusicProvider();
  const accountProvider = isAccountMusicProvider(provider) ? provider : null;
  useNativePlayerRuntime();
  useLyricsCoordinator();
  usePreferencesRuntime(true);
  usePlatformDiagnosticsRuntime();
  useGuessContinuation(provider);
  usePluginHost();
  useEffect(() => installPlaybackUiProbe(), []);
  const catalog = useCatalog();
  const { theme, toggleTheme } = useTheme();
  const hydrateQueue = usePlayerStore((state) => state.hydrateQueue);
  const lyricsOpen = usePlayerStore((state) => state.lyricsOpen);
  const lyricsStage = useLyricsStageStore((state) => state.stage);
  const lyricsSurfaceVisible = lyricsOpen || lyricsStage !== 'closed';
  const focusSidebarCollapsed = usePreferencesStore((state) => state.lyrics.focusSidebarCollapsed);
  const showFpsCounter = usePreferencesStore((state) => state.debug.showFpsCounter);
  const updateLyrics = usePreferencesStore((state) => state.updateLyrics);
  const fullscreen = useLyricsPresentationStore((state) => state.fullscreen);
  const fullscreenPending = useLyricsPresentationStore((state) => state.pending);
  const fullscreenError = useLyricsPresentationStore((state) => state.error);
  const syncFullscreen = useLyricsPresentationStore((state) => state.sync);
  const accountSnapshot = useAccountStore((state) => state.snapshot);
  const favorites = useAccountStore((state) => state.favorites);
  const accountPlaylists = useAccountStore((state) => state.playlists);
  const accountRecent = useAccountStore((state) => state.recent);
  const accountPlaylistDetails = useAccountStore((state) => state.accountPlaylistDetails);
  const openAccountDialog = useAccountStore((state) => state.openDialog);
  const loadFavorites = useAccountStore((state) => state.loadFavorites);
  const loadPlaylists = useAccountStore((state) => state.loadPlaylists);
  const loadRecent = useAccountStore((state) => state.loadRecent);
  const loadNext = useAccountStore((state) => state.loadNext);
  const loadAccountPlaylist = useAccountStore((state) => state.loadAccountPlaylist);
  const loadNextAccountPlaylist = useAccountStore((state) => state.loadNextAccountPlaylist);
  const previousLyricsOpen = useRef(lyricsOpen);
  const [history, setHistory] = useState<NavigationHistory>({ entries: [initialRoute], index: 0 });
  const route = history.entries[history.index] ?? initialRoute;

  const navigate = useCallback((nextRoute: AppRoute) => {
    void runAfterLyricsClose(() => {
      setHistory((current) => {
        const active = current.entries[current.index] ?? initialRoute;
        if (routesEqual(active, nextRoute)) return current;
        return {
          entries: [...current.entries.slice(0, current.index + 1), nextRoute],
          index: current.index + 1,
        };
      });
    });
  }, []);

  const toggleLyricsFullscreen = useCallback(() => {
    const presentation = useLyricsPresentationStore.getState();
    if (presentation.pending) return;
    void presentation.request(!presentation.fullscreen);
  }, []);

  const closeLyrics = useCallback(() => {
    void closeLyricsPresentation();
  }, []);

  const toggleQueue = useCallback(() => {
    void toggleQueueAfterLyricsClose();
  }, []);

  useEffect(() => {
    if (!isNativeRuntime) return;
    return getYaqmcClient().on('app://open-settings', () => navigate({ page: 'settings' }));
  }, [navigate]);

  const goBack = useCallback(() => {
    void runAfterLyricsClose(() => {
      setHistory((current) => ({ ...current, index: Math.max(0, current.index - 1) }));
    });
  }, []);

  const goForward = useCallback(() => {
    void runAfterLyricsClose(() => {
      setHistory((current) => ({
        ...current,
        index: Math.min(current.entries.length - 1, current.index + 1),
      }));
    });
  }, []);

  useEffect(() => {
    if (isNativeRuntime) return;
    const timer = window.setInterval(() => usePlayerStore.getState().tick(1_000), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (catalog.status === 'ready') hydrateQueue(catalog.home.featured.album.tracks);
  }, [catalog, hydrateQueue]);

  useEffect(() => {
    if (!accountProvider) return;
    if (route.page === 'account-playlists') {
      void loadPlaylists(accountProvider, true);
    } else if (route.page === 'favorites') {
      void loadFavorites(accountProvider, true);
    } else if (route.page === 'account-recent') {
      void loadRecent(accountProvider, true);
    } else if (route.page === 'account-playlist') {
      void loadAccountPlaylist(accountProvider, route.playlist, true);
    }
  }, [
    accountProvider,
    accountSnapshot.revision,
    loadAccountPlaylist,
    loadFavorites,
    loadPlaylists,
    loadRecent,
    route,
  ]);

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => Promise<void>) | null = null;

    void startLyricsPresentationRuntime()
      .then((stop) => {
        if (disposed) {
          void stop().catch(() => undefined);
          return;
        }
        cleanup = stop;
        void syncFullscreen().catch(() => undefined);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      if (cleanup) void cleanup().catch(() => undefined);
    };
  }, [syncFullscreen]);

  useEffect(() => {
    const wasOpen = previousLyricsOpen.current;
    previousLyricsOpen.current = lyricsOpen;
    if (!wasOpen || lyricsOpen) return;

    const presentation = useLyricsPresentationStore.getState();
    if (presentation.fullscreen || presentation.pending) {
      void presentation.request(false).catch(() => undefined);
    }
  }, [lyricsOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const editing =
        target instanceof Element &&
        target.matches('input, textarea, select, [contenteditable="true"]');

      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault();
        navigate({ page: 'search' });
        return;
      }
      if (event.key === 'Escape') {
        const action = lyricsEscapeAction({
          lyricsOpen,
          fullscreen,
          focus: focusSidebarCollapsed,
        });
        if (action === 'exit-fullscreen') void exitLyricsFullscreen();
        else if (action === 'exit-focus') updateLyrics({ focusSidebarCollapsed: false });
        else if (action === 'close-lyrics') closeLyrics();
        else usePlayerStore.getState().closePanels();
        return;
      }
      if (event.key === 'F11' && lyricsOpen) {
        event.preventDefault();
        if (!event.repeat) toggleLyricsFullscreen();
        return;
      }
      if (!editing && event.code === 'Space') {
        event.preventDefault();
        usePlayerStore.getState().togglePlayback();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    focusSidebarCollapsed,
    fullscreen,
    fullscreenPending,
    lyricsOpen,
    navigate,
    closeLyrics,
    toggleLyricsFullscreen,
    updateLyrics,
  ]);

  const entities = useMemo(() => {
    if (catalog.status !== 'ready') return { albums: [] as Album[], playlists: [] as Playlist[] };
    const recent = collectEntities(catalog.home.recentlyPlayed);
    const albums = [
      catalog.home.featured.album,
      ...catalog.home.newReleases,
      ...recent.albums,
      ...catalog.library.savedAlbums,
    ];
    const playlists = [
      ...homePlaylists(catalog.home),
      ...catalog.library.savedPlaylists,
    ];
    return {
      albums: [...new Map(albums.map((album) => [album.id, album])).values()],
      playlists: [...new Map(playlists.map((playlist) => [playlist.id, playlist])).values()],
    };
  }, [catalog]);

  const retryAccountResource = useCallback(
    (resource: AccountListResource) => {
      if (!accountProvider) return;
      if (resource === 'favorites') void loadFavorites(accountProvider, true);
      else if (resource === 'playlists') void loadPlaylists(accountProvider, true);
      else void loadRecent(accountProvider, true);
    },
    [accountProvider, loadFavorites, loadPlaylists, loadRecent],
  );

  const loadMoreAccountResource = useCallback(
    (resource: AccountListResource) => {
      if (accountProvider) void loadNext(accountProvider, resource);
    },
    [accountProvider, loadNext],
  );

  let pageContent;
  if (route.page === 'settings') {
    pageContent = (
      <RouteErrorBoundary
        fallback={
          <p className="settings-error" role="alert">
            {t('pageLoadFailed')}
          </p>
        }
      >
        <Suspense fallback={<LoadingState label={t('loadingSettings')} />}>
          <SettingsPage />
        </Suspense>
      </RouteErrorBoundary>
    );
  } else if (
    route.page === 'favorites' ||
    route.page === 'account-playlists' ||
    route.page === 'account-recent'
  ) {
    pageContent = (
      <LibraryPage
        view={
          route.page === 'account-playlists'
            ? 'playlists'
            : route.page === 'account-recent'
              ? 'recent'
              : 'favorites'
        }
        snapshot={accountSnapshot}
        favorites={favorites}
        playlists={accountPlaylists}
        recent={accountRecent}
        onNavigate={navigate}
        onSignIn={openAccountDialog}
        onRetry={retryAccountResource}
        onLoadMore={loadMoreAccountResource}
      />
    );
  } else if (route.page === 'account-playlist') {
    pageContent = (
      <AccountPlaylistRoute
        id={route.playlist.id}
        resource={accountPlaylistDetails[route.playlist.id] ?? { status: 'idle' }}
        onRetry={() => {
          if (accountProvider) void loadAccountPlaylist(accountProvider, route.playlist, true);
        }}
        onLoadMore={() => {
          if (accountProvider) void loadNextAccountPlaylist(accountProvider, route.playlist);
        }}
        onDeleted={() => navigate({ page: 'account-playlists' })}
      />
    );
  } else if (catalog.status === 'loading') {
    pageContent = <LoadingState />;
  } else if (catalog.status === 'error') {
    pageContent = (
      <div className="empty-state empty-state--error">
        <h1>{t('musicUnavailable')}</h1>
        <p>{catalog.message}</p>
      </div>
    );
  } else {
    switch (route.page) {
      case 'home':
        pageContent = <HomePage feed={catalog.home} onNavigate={navigate} />;
        break;
      case 'search':
        pageContent = (
          <SearchPage initialQuery={route.query} feed={catalog.home} onNavigate={navigate} />
        );
        break;
      case 'explore':
        pageContent = <ExplorePage onNavigate={navigate} />;
        break;
      case 'album': {
        const album = entities.albums.find((candidate) => candidate.id === route.id);
        pageContent = <ProviderAlbumPage key={route.id} id={route.id} initial={album} />;
        break;
      }
      case 'playlist': {
        const playlist = entities.playlists.find((candidate) => candidate.id === route.id);
        pageContent = <ProviderPlaylistPage key={route.id} id={route.id} initial={playlist} />;
        break;
      }
      case 'area':
        pageContent = <ProviderAreaPage encArea={route.encArea} title={route.title} onNavigate={navigate} />;
        break;
    }
  }

  return (
    <div className="application-frame">
      <AppBackground />
      <ApplicationContextMenu />
      {showFpsCounter && <FpsOverlay />}
      <div
        className="app-shell"
        data-provider-id={provider.id}
        data-lyrics-focus={(lyricsSurfaceVisible && focusSidebarCollapsed) || undefined}
        data-lyrics-fullscreen={(lyricsSurfaceVisible && fullscreen) || undefined}
      >
        <Sidebar route={route} onNavigate={navigate} />
        <div className="content-shell">
          <TopBar
            canGoBack={history.index > 0}
            canGoForward={history.index < history.entries.length - 1}
            theme={theme}
            onBack={goBack}
            onForward={goForward}
            onSearch={() => navigate({ page: 'search' })}
            onToggleTheme={toggleTheme}
          />
          <main
            className="main-content"
            key={
              route.page + ('id' in route ? route.id : 'playlist' in route ? route.playlist.id : '')
            }
          >
            {pageContent}
          </main>
        </div>
        <PlayerBar onCloseLyrics={closeLyrics} onToggleQueue={toggleQueue} />
        <PluginNoticeHost />
        <CoreStatusBanner />
        <QueuePanel />
        <LyricsPanel
          focus={focusSidebarCollapsed}
          fullscreen={fullscreen}
          fullscreenError={fullscreenError}
          onClose={closeLyrics}
        />
      </div>
    </div>
  );
}

function MissingEntity({ message }: { message: string }) {
  const { t } = useTranslation('pages');
  return (
    <div className="empty-state">
      <h1>{t('itemUnavailable')}</h1>
      <p>{message}</p>
    </div>
  );
}

function AccountPlaylistRoute({
  id,
  resource,
  onRetry,
  onLoadMore,
  onDeleted,
}: {
  id: string;
  resource: LibraryResource<AccountPlaylistDetail>;
  onRetry: () => void;
  onLoadMore: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation('pages');
  const { t: common } = useTranslation('common');
  const detail =
    resource.status === 'ready' || resource.status === 'stale'
      ? resource.data
      : resource.status === 'loading' || resource.status === 'error'
        ? resource.data
        : null;

  if (detail) {
    return (
      <>
        {(resource.status === 'stale' || resource.status === 'error') && (
          <div className="account-library-notice" role="status">
            <span>
              {resource.status === 'stale'
                ? t('library.stale')
                : t(`library.errors.${resource.error}`)}
            </span>
            <button type="button" onClick={onRetry}>
              {common('retry')}
            </button>
          </div>
        )}
        <PlaylistPage
          key={id}
          playlist={accountPlaylistDetailToPlaylist(detail)}
          accountSummary={detail.summary}
          hasMore={resource.status === 'ready' && resource.nextCursor !== null}
          loadingMore={resource.status === 'loading'}
          onLoadMore={onLoadMore}
          onDeleted={onDeleted}
        />
      </>
    );
  }
  if (resource.status === 'idle' || resource.status === 'loading') {
    return <LoadingState label={t('loadingPlaylist')} />;
  }
  if (resource.status === 'account-required' || resource.status === 'reauthentication-required') {
    return <MissingEntity message={t('library.signInBody')} />;
  }
  return (
    <div className="empty-state empty-state--error">
      <h1>{t('itemUnavailable')}</h1>
      <p>
        {resource.status === 'error'
          ? t(`library.errors.${resource.error}`)
          : t('playlistLoadFailed')}
      </p>
      <button type="button" onClick={onRetry}>
        {common('retry')}
      </button>
    </div>
  );
}

function ProviderAlbumPage({ id, initial }: { id: string; initial?: Album }) {
  const { t } = useTranslation('pages');
  const provider = useMusicProvider();
  const [album, setAlbum] = useState<Album | null>(initial ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void provider
      .getAlbum(id, controller.signal)
      .then(setAlbum)
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setFailed(true);
      });
    return () => controller.abort();
  }, [id, provider]);

  if (failed && !album) {
    return <MissingEntity message={t('albumLoadFailed')} />;
  }
  return album ? <AlbumPage album={album} /> : <LoadingState label={t('loadingAlbum')} />;
}

function ProviderPlaylistPage({ id, initial }: { id: string; initial?: Playlist }) {
  const { t } = useTranslation('pages');
  const provider = useMusicProvider();
  const [playlist, setPlaylist] = useState<Playlist | null>(initial ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void provider
      .getPlaylist(id, controller.signal)
      .then(setPlaylist)
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setFailed(true);
      });
    return () => controller.abort();
  }, [id, provider]);

  if (failed && !playlist) {
    return <MissingEntity message={t('playlistLoadFailed')} />;
  }
  return playlist ? (
    <PlaylistPage playlist={playlist} />
  ) : (
    <LoadingState label={t('loadingPlaylist')} />
  );
}

function ProviderAreaPage({
  encArea,
  title,
  onNavigate,
}: {
  encArea: string;
  title: string;
  onNavigate: (route: AppRoute) => void;
}) {
  const { t } = useTranslation('pages');
  const provider = useMusicProvider();
  const [feed, setFeed] = useState<AreaFeed | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void provider
      .getArea(encArea, controller.signal)
      .then(setFeed)
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setFailed(true);
      });
    return () => controller.abort();
  }, [encArea, provider]);

  if (failed && !feed) {
    return <MissingEntity message={t('areaLoadFailed')} />;
  }
  if (!feed) {
    return <LoadingState label={t('loadingArea', { title })} />;
  }
  return <AreaPage feed={feed} onNavigate={onNavigate} />;
}
