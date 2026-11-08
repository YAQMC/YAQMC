import { lazy, Suspense, useCallback, useEffect, useRef } from 'react';
import { useCatalog } from './application/use-catalog';
import { useTheme } from './application/use-theme';
import { NavigationProvider } from './application/navigation-context';
import { useNavigationHistory } from './application/use-navigation-history';
import { useGlobalShortcuts } from './application/use-global-shortcuts';
import { useAndroidBackButton } from './application/use-android-back-button';
import { usePlayerStore } from './application/player-store';
import { isNativeRuntime, useNativePlayerRuntime } from './application/native-player-runtime';
import { useLyricsCoordinator } from './application/use-lyrics-coordinator';
import { useMusicProvider, useMusicProviderSelection } from './application/provider-context';
import { isAccountMusicProvider } from './providers/music-provider';
import { BottomNav, Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { PlayerBar } from './components/PlayerBar';
import { CommentsPanel } from './components/CommentsPanel';
import { QueuePanel } from './components/QueuePanel';
import { ApplicationContextMenu } from './components/ApplicationContextMenu';
import { LyricsPanel } from './components/LyricsPanel';
import { AppBackground } from './components/AppBackground';
import { PluginNoticeHost } from './components/PluginNoticeHost';
import { CoreStatusBanner } from './components/CoreStatusBanner';
import { RouteContent } from './pages/RouteContent';
import { usePreferencesRuntime, usePreferencesStore } from './application/preferences';
import {
  startLyricsPresentationRuntime,
  useLyricsPresentationStore,
} from './application/lyrics-presentation';
import {
  closeLyricsPresentation,
  toggleQueueAfterLyricsClose,
} from './application/lyrics-presentation-actions';
import { useLyricsStageStore } from './application/lyrics-stage-machine';
import { usePlatformDiagnosticsRuntime } from './application/platform-integration';
import { getHostBridge, getYaqmcClient } from './application/yaqmc-runtime';
import { CHANNEL_APP_OPEN_CATALOG_SONG } from '@yaqmc/client';
import { catalogSongRouteFromDeepLink } from './application/deep-link-navigation';
import { usePluginHost } from './application/plugin-runtime';
import { hasHostCapability } from './application/host-capabilities';
import './styles/index.css';

const ApplicationPlaybackDiagnostics = __YAQMC_QA_BUILD__
  ? lazy(async () => {
      const module = await import('./development/PlaybackDiagnostics');
      return { default: module.ApplicationPlaybackDiagnostics };
    })
  : null;

export default function App() {
  const provider = useMusicProvider();
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
  const fullscreen = useLyricsPresentationStore((state) => state.fullscreen);
  const fullscreenError = useLyricsPresentationStore((state) => state.error);
  const syncFullscreen = useLyricsPresentationStore((state) => state.sync);
  const previousLyricsOpen = useRef(lyricsOpen);
  const { route, canGoBack, canGoForward, historyRef, navigate, goBack, goForward } =
    useNavigationHistory(provider.id);

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

  useGlobalShortcuts({ navigate, closeLyrics, toggleLyricsFullscreen });
  useAndroidBackButton(accountProvider, historyRef, goBack);

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
      const nextRoute = catalogSongRouteFromDeepLink(provider.id, provider.profileId, payload);
      if (nextRoute) {
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
  }, [navigate, provider, providerSelection]);

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
          data-lyrics-stage={lyricsStage === 'closed' && lyricsOpen ? 'entering' : lyricsStage}
          data-lyrics-focus={(lyricsSurfaceVisible && focusSidebarCollapsed) || undefined}
          data-lyrics-fullscreen={(lyricsSurfaceVisible && fullscreen) || undefined}
        >
          <Sidebar route={route} onNavigate={navigate} inert={lyricsSurfaceVisible} />
          <div className="content-shell" inert={lyricsSurfaceVisible}>
            <TopBar
              canGoBack={canGoBack}
              canGoForward={canGoForward}
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
                ('id' in route
                  ? route.id
                  : 'playlist' in route
                    ? route.playlist.id
                    : route.page === 'plugin-page'
                      ? `${route.pluginId}/${route.pageId}`
                      : '')
              }
            >
              <RouteContent
                route={route}
                catalog={catalog}
                accountProvider={accountProvider}
                onNavigate={navigate}
              />
            </main>
          </div>
          <PlayerBar onToggleQueue={toggleQueue} inert={lyricsSurfaceVisible} />
          <BottomNav route={route} onNavigate={navigate} inert={lyricsSurfaceVisible} />
          <PluginNoticeHost />
          <CoreStatusBanner />
          <QueuePanel />
          <CommentsPanel />
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
