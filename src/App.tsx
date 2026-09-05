import {
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AccountPlaylistDetail,
  Album,
  AreaFeed,
  HomeFeed,
  MediaCollection,
  Playlist,
  Song,
} from './domain/music';
import { useCatalog } from './application/use-catalog';
import { useTheme } from './application/use-theme';
import {
  isProviderCatalogRoute,
  scopeCatalogRoute,
  type AppRoute,
  type ProviderCatalogRoute,
} from './application/navigation';
import { NavigationProvider } from './application/navigation-context';
import { useEntityDetail } from './application/use-entity-detail';
import { usePlayerStore } from './application/player-store';
import { isNativeRuntime, useNativePlayerRuntime } from './application/native-player-runtime';
import { useLyricsCoordinator } from './application/use-lyrics-coordinator';
import {
  ProviderContext,
  ProviderRegistryContext,
  useMusicProvider,
  useMusicProviderSelection,
} from './application/provider-context';
import {
  accountPlaylistDetailToPlaylist,
  type AccountListResource,
  type LibraryResource,
  useAccountStore,
} from './application/account-runtime';
import { isAccountMusicProvider, type MusicProvider } from './providers/music-provider';
import { AndroidBottomNav, Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { PlayerBar } from './components/PlayerBar';
import { QueuePanel } from './components/QueuePanel';
import { ApplicationContextMenu } from './components/ApplicationContextMenu';
import { LyricsPanel } from './components/LyricsPanel';
import { LoadingState } from './components/ui/LoadingState';
import { RouteErrorBoundary } from './components/ui/RouteErrorBoundary';
import { HomePage } from './pages/HomePage';
import { AlbumPage } from './pages/AlbumPage';
import { SongPage } from './pages/SongPage';
import { ArtistPage } from './pages/ArtistPage';
import { AreaPage } from './pages/AreaPage';
import { PlaylistPage } from './pages/PlaylistPage';
import { ExplorePage } from './pages/ExplorePage';
import { LibraryPage } from './pages/LibraryPage';
import { MediaLibraryPage } from './pages/MediaLibraryPage';
import { SearchPage } from './pages/SearchPage';
import { AppBackground } from './components/AppBackground';
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
import { CHANNEL_APP_OPEN_CATALOG_SONG } from '@yaqmc/client';
import { catalogSongRouteFromDeepLink } from './application/deep-link-navigation';
import { usePluginHost } from './application/plugin-runtime';
import './styles/index.css';
import { getHostBridge } from './application/yaqmc-runtime';
import { hasHostCapability, isAndroidRuntime } from './application/host-capabilities';
import { App as CapacitorApp } from '@capacitor/app';
import { androidBackAction } from './application/android-back-navigation';

const ApplicationPlaybackDiagnostics = __YAQMC_QA_BUILD__
  ? lazy(async () => {
      const module = await import('./development/PlaybackDiagnostics');
      return { default: module.ApplicationPlaybackDiagnostics };
    })
  : null;

const SettingsPage = lazy(async () => {
  const module = await import('./pages/SettingsPage');
  return { default: module.SettingsPage };
});

const StatisticsPage = lazy(async () => {
  const module = await import('./pages/StatisticsPage');
  return { default: module.StatisticsPage };
});

interface NavigationHistory {
  entries: AppRoute[];
  index: number;
}

const initialRoute: AppRoute = { page: 'home' };

function routesEqual(first: AppRoute, second: AppRoute): boolean {
  if (first.page !== second.page) return false;
  if (isProviderCatalogRoute(first) && isProviderCatalogRoute(second)) {
    if (first.providerId !== second.providerId) return false;
    if (first.page === 'area' && second.page === 'area') {
      return first.encArea === second.encArea && first.title === second.title;
    }
    return 'id' in first && 'id' in second && first.id === second.id;
  }
  if (first.page === 'search' && second.page === 'search') return first.query === second.query;
  if (first.page === 'account-playlist' && second.page === 'account-playlist') {
    return first.playlist.id === second.playlist.id;
  }
  return true;
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
  const { t: common } = useTranslation('common');
  const provider = useMusicProvider();
  const providerRegistry = useContext(ProviderRegistryContext);
  const providerSelection = useMusicProviderSelection();
  const accountProvider = isAccountMusicProvider(provider) ? provider : null;
  useNativePlayerRuntime();
  useLyricsCoordinator();
  usePreferencesRuntime(true);
  usePlatformDiagnosticsRuntime();
  usePluginHost();
  const catalog = useCatalog();
  const { theme, toggleTheme } = useTheme();
  const hydrateQueue = usePlayerStore((state) => state.hydrateQueue);
  const lyricsOpen = usePlayerStore((state) => state.lyricsOpen);
  const lyricsStage = useLyricsStageStore((state) => state.stage);
  const lyricsSurfaceVisible = lyricsOpen || lyricsStage !== 'closed';
  const focusSidebarCollapsed = usePreferencesStore((state) => state.lyrics.focusSidebarCollapsed);
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
  const historyRef = useRef(history);
  const route = history.entries[history.index] ?? initialRoute;

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  const navigate = useCallback(
    (nextRoute: AppRoute) => {
      const scopedRoute = scopeCatalogRoute(nextRoute, provider.id);
      void runAfterLyricsClose(() => {
        setHistory((current) => {
          const active = current.entries[current.index] ?? initialRoute;
          if (routesEqual(active, scopedRoute)) return current;
          return {
            entries: [...current.entries.slice(0, current.index + 1), scopedRoute],
            index: current.index + 1,
          };
        });
      });
    },
    [provider.id],
  );

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

  useEffect(() => {
    if (!isNativeRuntime || !hasHostCapability('deepLinks')) return;
    const client = getYaqmcClient();
    const openSong = (payload: { providerId: string; entityId: string }) => {
      const available = providerSelection.providers.some(
        (candidate) => candidate.id === payload.providerId && candidate.available,
      );
      if (!available) return;
      const nextRoute = catalogSongRouteFromDeepLink(payload.providerId, payload);
      if (nextRoute) {
        providerSelection.selectProvider(payload.providerId);
        navigate(nextRoute);
      }
    };
    const unsubscribe = client.on(CHANNEL_APP_OPEN_CATALOG_SONG, openSong);
    void client
      .invoke('deep_link_take_pending')
      .then((pending) => {
        if (pending) openSong(pending);
      })
      .catch(() => undefined);
    return unsubscribe;
  }, [navigate, providerSelection]);

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
    if (!isAndroidRuntime()) return;

    let disposed = false;
    let removeListener: (() => Promise<void>) | null = null;
    void CapacitorApp.addListener('backButton', () => {
      const player = usePlayerStore.getState();
      const presentation = useLyricsPresentationStore.getState();
      const stage = useLyricsStageStore.getState().stage;
      const account = useAccountStore.getState();
      const action = androidBackAction({
        accountDialogOpen: account.dialogOpen && accountProvider !== null,
        playerSurfaceOpen:
          player.queueOpen ||
          player.lyricsOpen ||
          presentation.fullscreen ||
          presentation.pending ||
          stage !== 'closed',
        canNavigateBack: historyRef.current.index > 0,
      });

      if (action === 'close-account-dialog') {
        void account.closeDialog(accountProvider!);
      } else if (action === 'close-player-surface') {
        if (
          player.lyricsOpen ||
          presentation.fullscreen ||
          presentation.pending ||
          stage !== 'closed'
        ) {
          void closeLyricsPresentation();
        } else {
          player.closePanels();
        }
      } else if (action === 'navigate-back') {
        goBack();
      } else {
        void CapacitorApp.exitApp();
      }
    }).then((listener) => {
      if (disposed) void listener.remove();
      else removeListener = listener.remove;
    });

    return () => {
      disposed = true;
      if (removeListener) void removeListener();
    };
  }, [accountProvider, goBack]);

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
    const playlists = [...homePlaylists(catalog.home), ...catalog.library.savedPlaylists];
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

  const catalogRoute = isProviderCatalogRoute(route) ? route : null;
  const catalogRouteProviderId = catalogRoute?.providerId ?? provider.id;
  const catalogRouteProvider = catalogRoute
    ? catalogRouteProviderId === provider.id
      ? provider
      : (providerRegistry?.get(catalogRouteProviderId)?.legacyProvider ?? null)
    : null;
  const catalogRouteNavigate = useCallback(
    (nextRoute: AppRoute) => navigate(scopeCatalogRoute(nextRoute, catalogRouteProviderId)),
    [catalogRouteProviderId, navigate],
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
  } else if (route.page === 'statistics') {
    pageContent = (
      <RouteErrorBoundary
        fallback={
          <p className="settings-error" role="alert">
            {t('pageLoadFailed')}
          </p>
        }
      >
        <Suspense fallback={<LoadingState label={t('statistics.loading')} />}>
          <StatisticsPage />
        </Suspense>
      </RouteErrorBoundary>
    );
  } else if (route.page === 'library') {
    pageContent = <MediaLibraryPage onNavigate={navigate} />;
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
        providerLabel={provider.displayName}
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
  } else if (catalogRoute && !catalogRouteProvider) {
    const providerLabel =
      providerSelection.providers.find((candidate) => candidate.id === catalogRouteProviderId)
        ?.displayName ?? catalogRouteProviderId;
    pageContent = <MissingEntity message={t('providerUnavailable', { provider: providerLabel })} />;
  } else if (
    catalogRoute &&
    catalogRouteProvider?.id === provider.id &&
    catalog.status === 'loading'
  ) {
    pageContent = <LoadingState />;
  } else if (
    catalogRoute &&
    catalogRouteProvider?.id === provider.id &&
    catalog.status === 'error'
  ) {
    pageContent = (
      <div className="empty-state empty-state--error">
        <h1>{t('musicUnavailable')}</h1>
        <p>{catalog.message}</p>
        <button type="button" className="button button--primary" onClick={catalog.retry}>
          {common('retry')}
        </button>
      </div>
    );
  } else if (catalogRoute && catalogRouteProvider) {
    const activeCatalog = catalogRouteProvider.id === provider.id && catalog.status === 'ready';
    pageContent = (
      <ProviderCatalogPage
        key={`${catalogRouteProvider.id}:${catalogRoute.page}:${
          'id' in catalogRoute ? catalogRoute.id : catalogRoute.encArea
        }`}
        route={catalogRoute}
        provider={catalogRouteProvider}
        initialAlbum={
          activeCatalog && catalogRoute.page === 'album'
            ? entities.albums.find((candidate) => candidate.id === catalogRoute.id)
            : undefined
        }
        initialSong={
          activeCatalog && catalogRoute.page === 'song'
            ? catalog.home.radarSongs.find((candidate) => candidate.id === catalogRoute.id)
            : undefined
        }
        initialPlaylist={
          activeCatalog && catalogRoute.page === 'playlist'
            ? entities.playlists.find((candidate) => candidate.id === catalogRoute.id)
            : undefined
        }
        onNavigate={catalogRouteNavigate}
      />
    );
  } else if (catalog.status === 'loading') {
    pageContent = <LoadingState />;
  } else if (catalog.status === 'error') {
    pageContent = (
      <div className="empty-state empty-state--error">
        <h1>{t('musicUnavailable')}</h1>
        <p>{catalog.message}</p>
        <button type="button" className="button button--primary" onClick={catalog.retry}>
          {common('retry')}
        </button>
      </div>
    );
  } else {
    switch (route.page) {
      case 'home':
        pageContent = <HomePage feed={catalog.home} onNavigate={navigate} />;
        break;
      case 'search':
        pageContent = (
          <SearchPage
            key={`search:${route.query ?? ''}`}
            initialQuery={route.query}
            feed={catalog.home}
            onNavigate={navigate}
          />
        );
        break;
      case 'explore':
        pageContent = <ExplorePage onNavigate={navigate} />;
        break;
      case 'album':
      case 'song':
      case 'artist':
      case 'playlist':
      case 'area':
        break;
    }
  }

  return (
    <div className="application-frame">
      <AppBackground />
      <ApplicationContextMenu />
      {ApplicationPlaybackDiagnostics && (
        <Suspense fallback={null}>
          <ApplicationPlaybackDiagnostics />
        </Suspense>
      )}
      <NavigationProvider onNavigate={navigate}>
        <div
          className="app-shell"
          data-provider-id={provider.id}
          data-host-kind={getHostBridge().kind}
          data-lyrics-open={lyricsSurfaceVisible || undefined}
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
              onAccount={() => navigate({ page: 'settings' })}
            />
            <main
              className="main-content"
              key={
                route.page +
                ('id' in route ? route.id : 'playlist' in route ? route.playlist.id : '')
              }
            >
              {pageContent}
            </main>
          </div>
          <PlayerBar onToggleQueue={toggleQueue} />
          <AndroidBottomNav route={route} onNavigate={navigate} />
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
      </NavigationProvider>
    </div>
  );
}

function ProviderCatalogPage({
  route,
  provider,
  initialAlbum,
  initialSong,
  initialPlaylist,
  onNavigate,
}: {
  route: ProviderCatalogRoute;
  provider: MusicProvider;
  initialAlbum?: Album;
  initialSong?: Song;
  initialPlaylist?: Playlist;
  onNavigate: (route: AppRoute) => void;
}) {
  let content;
  switch (route.page) {
    case 'album':
      content = <ProviderAlbumPage id={route.id} initial={initialAlbum} />;
      break;
    case 'song':
      content = <ProviderSongPage id={route.id} initial={initialSong} />;
      break;
    case 'artist':
      content = <ProviderArtistPage id={route.id} />;
      break;
    case 'playlist':
      content = <ProviderPlaylistPage id={route.id} initial={initialPlaylist} />;
      break;
    case 'area':
      content = (
        <ProviderAreaPage encArea={route.encArea} title={route.title} onNavigate={onNavigate} />
      );
      break;
  }

  return (
    <ProviderContext value={provider}>
      <NavigationProvider onNavigate={onNavigate}>{content}</NavigationProvider>
    </ProviderContext>
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
  providerLabel,
  resource,
  onRetry,
  onLoadMore,
  onDeleted,
}: {
  id: string;
  providerLabel: string;
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
          playlist={accountPlaylistDetailToPlaylist(detail, providerLabel)}
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

function ProviderSongPage({ id, initial }: { id: string; initial?: Song }) {
  const { t } = useTranslation('pages');
  const provider = useMusicProvider();
  const load = useCallback(
    (entityId: string, signal: AbortSignal) => provider.getSong(entityId, signal),
    [provider],
  );
  const resource = useEntityDetail(id, load, initial);

  if (resource.status === 'error' && !resource.data) {
    return <MissingEntity message={t('songLoadFailed')} />;
  }
  return resource.data ? (
    <SongPage song={resource.data} />
  ) : (
    <LoadingState label={t('loadingSong')} />
  );
}

function ProviderArtistPage({ id }: { id: string }) {
  const { t } = useTranslation('pages');
  const provider = useMusicProvider();
  const load = useCallback(
    (entityId: string, signal: AbortSignal) => provider.getArtist(entityId, signal),
    [provider],
  );
  const resource = useEntityDetail(id, load);

  if (resource.status === 'error' && !resource.data) {
    return <MissingEntity message={t('artistLoadFailed')} />;
  }
  return resource.data ? (
    <ArtistPage artist={resource.data} />
  ) : (
    <LoadingState label={t('loadingArtist')} />
  );
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
