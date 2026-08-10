import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Album, MediaCollection, Playlist } from './domain/music';
import { useCatalog } from './application/use-catalog';
import { useTheme } from './application/use-theme';
import type { AppRoute } from './application/navigation';
import { usePlayerStore } from './application/player-store';
import { isNativeRuntime, useNativePlayerRuntime } from './application/native-player-runtime';
import { useLyricsCoordinator } from './application/use-lyrics-coordinator';
import { useMusicProvider } from './application/provider-context';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { PlayerBar } from './components/PlayerBar';
import { QueuePanel } from './components/QueuePanel';
import { LyricsPanel } from './components/LyricsPanel';
import { LoadingState } from './components/ui/LoadingState';
import { HomePage } from './pages/HomePage';
import { AlbumPage } from './pages/AlbumPage';
import { PlaylistPage } from './pages/PlaylistPage';
import { ExplorePage } from './pages/ExplorePage';
import { LibraryPage } from './pages/LibraryPage';
import { SearchPage } from './pages/SearchPage';
import { SettingsPage } from './pages/SettingsPage';
import { AppBackground } from './components/AppBackground';
import { usePreferencesRuntime, usePreferencesStore } from './application/preferences';
import {
  lyricsEscapeAction,
  startLyricsPresentationRuntime,
  useLyricsPresentationStore,
} from './application/lyrics-presentation';
import {
  closeLyricsPresentation,
  enterLyricsFullscreen,
  exitLyricsFullscreen,
  runAfterLyricsClose,
  toggleQueueAfterLyricsClose,
} from './application/lyrics-presentation-actions';
import { listen } from '@tauri-apps/api/event';
import { usePlatformDiagnosticsRuntime } from './application/platform-integration';
import './styles/index.css';

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

export default function App() {
  const { t } = useTranslation('pages');
  useNativePlayerRuntime();
  useLyricsCoordinator();
  usePreferencesRuntime(true);
  usePlatformDiagnosticsRuntime();
  const catalog = useCatalog();
  const { theme, toggleTheme } = useTheme();
  const hydrateQueue = usePlayerStore((state) => state.hydrateQueue);
  const lyricsOpen = usePlayerStore((state) => state.lyricsOpen);
  const focusSidebarCollapsed = usePreferencesStore((state) => state.lyrics.focusSidebarCollapsed);
  const updateLyrics = usePreferencesStore((state) => state.updateLyrics);
  const fullscreen = useLyricsPresentationStore((state) => state.fullscreen);
  const fullscreenPending = useLyricsPresentationStore((state) => state.pending);
  const fullscreenError = useLyricsPresentationStore((state) => state.error);
  const syncFullscreen = useLyricsPresentationStore((state) => state.sync);
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

  const toggleLyricsFocus = useCallback(() => {
    const preferences = usePreferencesStore.getState();
    preferences.updateLyrics({
      focusSidebarCollapsed: !preferences.lyrics.focusSidebarCollapsed,
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

  const enterFullscreenLyrics = useCallback(() => {
    void enterLyricsFullscreen();
  }, []);

  const toggleQueue = useCallback(() => {
    void toggleQueueAfterLyricsClose();
  }, []);

  useEffect(() => {
    if (!isNativeRuntime) return;
    let active = true;
    let unlisten: (() => void) | null = null;
    void listen('app://open-settings', () => navigate({ page: 'settings' })).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [navigate]);

  const goBack = () =>
    setHistory((current) => ({ ...current, index: Math.max(0, current.index - 1) }));
  const goForward = () =>
    setHistory((current) => ({
      ...current,
      index: Math.min(current.entries.length - 1, current.index + 1),
    }));

  useEffect(() => {
    if (isNativeRuntime) return;
    const timer = window.setInterval(() => usePlayerStore.getState().tick(1_000), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (catalog.status === 'ready') hydrateQueue(catalog.home.featured.album.tracks);
  }, [catalog, hydrateQueue]);

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
      const target = event.target as HTMLElement | null;
      const editing = target?.matches('input, textarea, select, [contenteditable="true"]') ?? false;

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
      ...catalog.home.madeForYou,
      ...recent.playlists,
      ...catalog.library.savedPlaylists,
    ];
    return {
      albums: [...new Map(albums.map((album) => [album.id, album])).values()],
      playlists: [...new Map(playlists.map((playlist) => [playlist.id, playlist])).values()],
    };
  }, [catalog]);

  let pageContent;
  if (route.page === 'settings') {
    pageContent = <SettingsPage />;
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
        pageContent = <ExplorePage feed={catalog.home} onNavigate={navigate} />;
        break;
      case 'library':
        pageContent = <LibraryPage library={catalog.library} onNavigate={navigate} />;
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
    }
  }

  return (
    <div className="application-frame">
      <AppBackground />
      <div
        className="app-shell"
        data-lyrics-focus={(lyricsOpen && focusSidebarCollapsed) || undefined}
        data-lyrics-fullscreen={(lyricsOpen && fullscreen) || undefined}
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
          <main className="main-content" key={route.page + ('id' in route ? route.id : '')}>
            {pageContent}
          </main>
        </div>
        <PlayerBar
          onEnterLyricsFullscreen={enterFullscreenLyrics}
          onCloseLyrics={closeLyrics}
          onToggleQueue={toggleQueue}
          lyricsFullscreenPending={fullscreenPending}
        />
        <QueuePanel />
        <LyricsPanel
          focus={focusSidebarCollapsed}
          fullscreen={fullscreen}
          fullscreenPending={fullscreenPending}
          fullscreenError={fullscreenError}
          onToggleFocus={toggleLyricsFocus}
          onToggleFullscreen={toggleLyricsFullscreen}
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
