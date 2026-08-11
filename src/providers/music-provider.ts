import type {
  AccountLoginMethod,
  AccountPlaylistDetail,
  AccountPlaylistSummary,
  AccountSnapshot,
  Album,
  CreatePlaylistRequest,
  DeletePlaylistRequest,
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
  Song,
} from '../domain/music';

export interface MusicProvider {
  readonly id: string;
  readonly displayName: string;

  getHome(signal?: AbortSignal): Promise<HomeFeed>;
  getAlbum(id: EntityId, signal?: AbortSignal): Promise<Album>;
  getPlaylist(id: EntityId, signal?: AbortSignal): Promise<Playlist>;
  getLibrary(signal?: AbortSignal): Promise<LibrarySnapshot>;
  getLyrics(songId: EntityId, signal?: AbortSignal): Promise<LyricDocument | null>;
  search(query: string, signal?: AbortSignal, page?: number, limit?: number): Promise<SearchResult>;
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
    id: EntityId,
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
  ].every((method) => typeof candidate[method as keyof AccountMusicProvider] === 'function');
}
