import { lazy, Suspense, useCallback, useContext, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AccountPlaylistDetail,
  Album,
  HomeFeed,
  MediaCollection,
  Playlist,
  Song,
} from '../domain/music';
import type { useCatalog } from '../application/use-catalog';
import {
  isProviderCatalogRoute,
  scopeCatalogRoute,
  type AppRoute,
  type ProviderCatalogRoute,
} from '../application/navigation';
import { NavigationProvider } from '../application/navigation-context';
import { useEntityDetail } from '../application/use-entity-detail';
import {
  ProviderContext,
  ProviderRegistryContext,
  useMusicProvider,
  useMusicProviderSelection,
} from '../application/provider-context';
import {
  accountPlaylistDetailToPlaylist,
  type AccountListResource,
  type LibraryResource,
  useAccountStore,
} from '../application/account-runtime';
import type { AccountMusicProvider, MusicProvider } from '../providers/music-provider';
import { ErrorState } from '../components/ui/ErrorState';
import { LoadingState } from '../components/ui/LoadingState';
import { RouteErrorBoundary } from '../components/ui/RouteErrorBoundary';
import { AlbumPage } from './AlbumPage';
import { AreaPage } from './AreaPage';
import { ArtistPage } from './ArtistPage';
import { ExplorePage } from './ExplorePage';
import { HomePage } from './HomePage';
import { LibraryPage } from './LibraryPage';
import { MediaLibraryPage } from './MediaLibraryPage';
import { PlaylistPage } from './PlaylistPage';
import { PluginPage } from './PluginPage';
import { SearchPage } from './SearchPage';
import { SongPage } from './SongPage';

const SettingsPage = lazy(async () => {
  const module = await import('./SettingsPage');
  return { default: module.SettingsPage };
});

const StatisticsPage = lazy(async () => {
  const module = await import('./StatisticsPage');
  return { default: module.StatisticsPage };
});

type Catalog = ReturnType<typeof useCatalog>;

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

interface RouteContentProps {
  route: AppRoute;
  catalog: Catalog;
  accountProvider: AccountMusicProvider | null;
  onNavigate: (route: AppRoute) => void;
}

/** Resolves the active route to its page and owns the route-scoped data loading. */
export function RouteContent({ route, catalog, accountProvider, onNavigate }: RouteContentProps) {
  const { t } = useTranslation('pages');
  const provider = useMusicProvider();
  const providerRegistry = useContext(ProviderRegistryContext);
  const providerSelection = useMusicProviderSelection();
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
    (nextRoute: AppRoute) => onNavigate(scopeCatalogRoute(nextRoute, catalogRouteProviderId)),
    [catalogRouteProviderId, onNavigate],
  );

  if (route.page === 'settings' || route.page === 'statistics') {
    const settings = route.page === 'settings';
    return (
      <RouteErrorBoundary
        fallback={
          <p className="settings-error" role="alert">
            {t('pageLoadFailed')}
          </p>
        }
      >
        <Suspense
          fallback={
            <LoadingState label={settings ? t('loadingSettings') : t('statistics.loading')} />
          }
        >
          {settings ? <SettingsPage /> : <StatisticsPage />}
        </Suspense>
      </RouteErrorBoundary>
    );
  }
  if (route.page === 'library') return <MediaLibraryPage onNavigate={onNavigate} />;
  if (route.page === 'plugin-page') {
    return <PluginPage pluginId={route.pluginId} pageId={route.pageId} />;
  }
  if (
    route.page === 'favorites' ||
    route.page === 'account-playlists' ||
    route.page === 'account-recent'
  ) {
    return (
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
        onNavigate={onNavigate}
        onSignIn={openAccountDialog}
        onRetry={retryAccountResource}
        onLoadMore={loadMoreAccountResource}
      />
    );
  }
  if (route.page === 'account-playlist') {
    return (
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
        onDeleted={() => onNavigate({ page: 'account-playlists' })}
      />
    );
  }
  if (catalogRoute && !catalogRouteProvider) {
    const providerLabel =
      providerSelection.providers.find((candidate) => candidate.id === catalogRouteProviderId)
        ?.displayName ?? catalogRouteProviderId;
    return <MissingEntity message={t('providerUnavailable', { provider: providerLabel })} />;
  }
  if (catalogRoute && catalogRouteProvider) {
    const activeCatalog = catalogRouteProvider.id === provider.id && catalog.status === 'ready';
    return (
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
  }
  if (route.page === 'search') {
    return (
      <SearchPage
        key={`search:${route.query ?? ''}`}
        initialQuery={route.query}
        feed={catalog.status === 'ready' ? catalog.home : null}
        onNavigate={onNavigate}
      />
    );
  }
  if (route.page === 'explore') return <ExplorePage onNavigate={onNavigate} />;
  if (catalog.status === 'loading') return <LoadingState />;
  if (catalog.status === 'error') {
    return (
      <ErrorState title={t('musicUnavailable')} message={catalog.message} onRetry={catalog.retry} />
    );
  }
  return route.page === 'home' ? <HomePage feed={catalog.home} onNavigate={onNavigate} /> : null;
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

function MissingEntity({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useTranslation('pages');
  return <ErrorState title={t('itemUnavailable')} message={message} onRetry={onRetry} />;
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
    resource.status === 'ready' ||
    resource.status === 'stale' ||
    resource.status === 'loading' ||
    resource.status === 'error'
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
    <MissingEntity
      message={
        resource.status === 'error'
          ? t(`library.errors.${resource.error}`)
          : t('playlistLoadFailed')
      }
      onRetry={onRetry}
    />
  );
}

function ProviderAlbumPage({ id, initial }: { id: string; initial?: Album }) {
  const { t } = useTranslation('pages');
  const provider = useMusicProvider();
  const load = useCallback(
    (entityId: string, signal: AbortSignal) => provider.getAlbum(entityId, signal),
    [provider],
  );
  const resource = useEntityDetail(id, load, initial);

  if (resource.status === 'error' && !resource.data) {
    return <MissingEntity message={t('albumLoadFailed')} onRetry={resource.retry} />;
  }
  return resource.data ? (
    <AlbumPage album={resource.data} />
  ) : (
    <LoadingState label={t('loadingAlbum')} />
  );
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
    return <MissingEntity message={t('songLoadFailed')} onRetry={resource.retry} />;
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
    return <MissingEntity message={t('artistLoadFailed')} onRetry={resource.retry} />;
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
  const load = useCallback(
    (entityId: string, signal: AbortSignal) => provider.getPlaylist(entityId, signal),
    [provider],
  );
  const resource = useEntityDetail(id, load, initial);

  // Feed cards contain metadata only; their empty tracks are not a loaded playlist.
  if (resource.status === 'loading') return <LoadingState label={t('loadingPlaylist')} />;
  if (resource.status === 'error' || !resource.data) {
    return <MissingEntity message={t('playlistLoadFailed')} onRetry={resource.retry} />;
  }
  return <PlaylistPage playlist={resource.data} />;
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
  const load = useCallback(
    (area: string, signal: AbortSignal) => provider.getArea(area, signal),
    [provider],
  );
  const resource = useEntityDetail(encArea, load);

  if (resource.status === 'error' && !resource.data) {
    return <MissingEntity message={t('areaLoadFailed')} onRetry={resource.retry} />;
  }
  if (!resource.data) {
    return <LoadingState label={t('loadingArea', { title })} />;
  }
  return <AreaPage feed={resource.data} onNavigate={onNavigate} />;
}
