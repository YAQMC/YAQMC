import type {
  AccountLoginMethod,
  AccountPlaylistDetail,
  AccountPlaylistSummary,
  AccountSnapshot,
  Album,
  Artist,
  ArtistCatalogKind,
  ArtistCatalogPage,
  CollectPlaylistRequest,
  CreatePlaylistRequest,
  DeletePlaylistRequest,
  AreaFeed,
  DiscoverFeed,
  EntityId,
  FavoriteMutationRequest,
  FavoriteMutationResult,
  HomeFeed,
  LibrarySnapshot,
  LyricDocument,
  Page,
  Playlist,
  PlaylistMutationResult,
  PlaylistTrackMutationRequest,
  RemotePlayHistoryItem,
  RenamePlaylistRequest,
  SearchResult,
  ShareTarget,
  CatalogSearchKind,
  Song,
} from '../domain/music';

export interface CatalogMusicProvider {
  getHome(signal?: AbortSignal, refresh?: boolean): Promise<HomeFeed>;
  getDiscover(signal?: AbortSignal, refresh?: boolean): Promise<DiscoverFeed>;
  getArea(encArea: string, signal?: AbortSignal): Promise<AreaFeed>;
  getSong(id: EntityId, signal?: AbortSignal): Promise<Song>;
  getAlbum(id: EntityId, signal?: AbortSignal): Promise<Album>;
  getArtist(id: EntityId, signal?: AbortSignal): Promise<Artist>;
  getArtistCatalog(
    id: EntityId,
    kind: ArtistCatalogKind,
    signal?: AbortSignal,
    page?: number,
    limit?: number,
  ): Promise<ArtistCatalogPage>;
  getPlaylist(id: EntityId, signal?: AbortSignal): Promise<Playlist>;
  getLibrary(signal?: AbortSignal): Promise<LibrarySnapshot>;
  getLyrics(songId: EntityId, signal?: AbortSignal): Promise<LyricDocument | null>;
  search(
    query: string,
    kind: CatalogSearchKind,
    signal?: AbortSignal,
    page?: number,
    limit?: number,
  ): Promise<SearchResult>;
}

export interface LyricsMusicProvider {
  getLyrics(songId: EntityId, signal?: AbortSignal): Promise<LyricDocument | null>;
}

export interface ShareMusicProvider {
  getSongShareTarget(id: EntityId, signal?: AbortSignal): Promise<ShareTarget>;
}

export interface MusicProvider extends CatalogMusicProvider, LyricsMusicProvider {
  readonly id: string;
  readonly displayName: string;
}

export interface AccountMusicProvider {
  getAccountSnapshot(signal?: AbortSignal): Promise<AccountSnapshot>;
  startWebLogin(method: AccountLoginMethod, signal?: AbortSignal): Promise<AccountSnapshot>;
  startQrLogin(signal?: AbortSignal): Promise<AccountSnapshot>;
  heartbeatQrLogin(
    attemptId: string,
    ownerLeaseId: string,
    signal?: AbortSignal,
  ): Promise<AccountSnapshot>;
  cancelQrLogin(attemptId: string, signal?: AbortSignal): Promise<AccountSnapshot>;
  refreshQrLogin(attemptId: string | null, signal?: AbortSignal): Promise<AccountSnapshot>;
  signOut(signal?: AbortSignal): Promise<AccountSnapshot>;
  getFavoriteSongs(cursor?: string, limit?: number, signal?: AbortSignal): Promise<Page<Song>>;
  getAccountPlaylists(
    cursor?: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<Page<AccountPlaylistSummary>>;
  getAccountPlaylistTracks(
    playlist: AccountPlaylistSummary,
    cursor?: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<AccountPlaylistDetail>;
  getAccountRecentlyPlayed(
    cursor?: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<Page<RemotePlayHistoryItem>>;
  setFavorite(
    request: FavoriteMutationRequest,
    signal?: AbortSignal,
  ): Promise<FavoriteMutationResult>;
  createPlaylist(
    request: CreatePlaylistRequest,
    signal?: AbortSignal,
  ): Promise<PlaylistMutationResult>;
  renamePlaylist(
    request: RenamePlaylistRequest,
    signal?: AbortSignal,
  ): Promise<PlaylistMutationResult>;
  addPlaylistTrack(
    request: PlaylistTrackMutationRequest,
    signal?: AbortSignal,
  ): Promise<PlaylistMutationResult>;
  removePlaylistTrack(
    request: PlaylistTrackMutationRequest,
    signal?: AbortSignal,
  ): Promise<PlaylistMutationResult>;
  deletePlaylist(
    request: DeletePlaylistRequest,
    signal?: AbortSignal,
  ): Promise<PlaylistMutationResult>;
  setPlaylistCollected(
    request: CollectPlaylistRequest,
    signal?: AbortSignal,
  ): Promise<PlaylistMutationResult>;
}

export function isAccountMusicProvider(
  provider: MusicProvider,
): provider is MusicProvider & AccountMusicProvider {
  const candidate = provider as Partial<AccountMusicProvider>;
  return [
    'getAccountSnapshot',
    'startWebLogin',
    'startQrLogin',
    'heartbeatQrLogin',
    'cancelQrLogin',
    'refreshQrLogin',
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
  ].every((method) => typeof candidate[method as keyof AccountMusicProvider] === 'function');
}

export function isShareMusicProvider(
  provider: MusicProvider,
): provider is MusicProvider & ShareMusicProvider {
  return typeof (provider as Partial<ShareMusicProvider>).getSongShareTarget === 'function';
}

export interface MusicProviderCapabilityFacade {
  readonly id: string;
  readonly catalog: CatalogMusicProvider;
  readonly lyrics: LyricsMusicProvider;
  /** Recommendation fetching is Core-owned; this is capability metadata only. */
  readonly recommendations: boolean;
  readonly share: ShareMusicProvider | null;
  readonly account: AccountMusicProvider | null;
  readonly legacyProvider: MusicProvider;
}

export function createMusicProviderCapabilityFacade(
  provider: MusicProvider,
): MusicProviderCapabilityFacade {
  return Object.freeze({
    id: provider.id,
    catalog: provider,
    lyrics: provider,
    recommendations: true,
    share: isShareMusicProvider(provider) ? provider : null,
    account: isAccountMusicProvider(provider) ? provider : null,
    legacyProvider: provider,
  });
}
