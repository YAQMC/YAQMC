import type { ProviderDescriptor } from '@yaqmc/client';
import { getHostBridge } from '../../application/yaqmc-runtime';
import { ProviderError } from '../../domain/music';
import type {
  AccountLoginMethodDescriptor,
  AccountPlaylistDetail,
  AccountPlaylistSummary,
  AccountSnapshot,
  Album,
  AreaFeed,
  Artist,
  ArtistCatalogKind,
  ArtistCatalogPage,
  CatalogSearchKind,
  CollectPlaylistRequest,
  CreatePlaylistRequest,
  DeletePlaylistRequest,
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
  Song,
} from '../../domain/music';
import type { AccountMusicProvider, MusicProvider, ShareMusicProvider } from '../music-provider';
import { nativeProviderRequest } from './native-request';

export class NativeMusicProvider implements MusicProvider {
  readonly id: string;
  readonly displayName: string;

  constructor(readonly descriptor: ProviderDescriptor) {
    this.id = descriptor.providerId;
    this.displayName = descriptor.displayName;
  }

  protected request<T>(
    method: Parameters<typeof nativeProviderRequest<T>>[0],
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    return nativeProviderRequest(
      method,
      { providerId: this.id, ...params },
      signal,
      this.displayName,
    );
  }

  getHome(signal?: AbortSignal, refresh = false): Promise<HomeFeed> {
    return this.request('provider_home', { refresh }, signal);
  }

  getDiscover(signal?: AbortSignal, refresh = false): Promise<DiscoverFeed> {
    return this.request('provider_discover', { refresh }, signal);
  }

  getArea(encArea: string, signal?: AbortSignal): Promise<AreaFeed> {
    return this.request('provider_area', { encArea }, signal);
  }

  getSong(id: EntityId, signal?: AbortSignal): Promise<Song> {
    return this.request('provider_song', { id }, signal);
  }

  getAlbum(id: EntityId, signal?: AbortSignal): Promise<Album> {
    return this.request('provider_album', { id }, signal);
  }

  getArtist(id: EntityId, signal?: AbortSignal): Promise<Artist> {
    return this.request('provider_artist', { id }, signal);
  }

  getArtistCatalog(
    id: EntityId,
    kind: ArtistCatalogKind,
    signal?: AbortSignal,
    page = 1,
    limit = 20,
  ): Promise<ArtistCatalogPage> {
    return this.request('provider_artist_catalog', { id, kind, page, limit }, signal);
  }

  getPlaylist(id: EntityId, signal?: AbortSignal): Promise<Playlist> {
    return this.request('provider_playlist', { id }, signal);
  }

  getLibrary(signal?: AbortSignal): Promise<LibrarySnapshot> {
    return this.request('provider_library', {}, signal);
  }

  getLyrics(songId: EntityId, signal?: AbortSignal): Promise<LyricDocument | null> {
    return this.request('provider_lyrics', { id: songId }, signal);
  }

  search(
    query: string,
    kind: CatalogSearchKind,
    signal?: AbortSignal,
    page = 1,
    limit = 20,
  ): Promise<SearchResult> {
    return this.request('provider_search', { query, kind, page, limit }, signal);
  }
}

class NativeShareMusicProvider extends NativeMusicProvider implements ShareMusicProvider {
  getSongShareTarget(id: EntityId, signal?: AbortSignal): Promise<ShareTarget> {
    return nativeProviderRequest(
      'catalog_share_song',
      { providerId: this.id, id },
      signal,
      this.displayName,
    );
  }
}

class NativeAccountMusicProvider extends NativeMusicProvider implements AccountMusicProvider {
  getAccountSnapshot(signal?: AbortSignal): Promise<AccountSnapshot> {
    return this.request('provider_account_snapshot', {}, signal);
  }

  refreshAccount(signal?: AbortSignal): Promise<AccountSnapshot> {
    return this.request('provider_account_refresh', {}, signal);
  }

  getLoginMethods(signal?: AbortSignal): Promise<AccountLoginMethodDescriptor[]> {
    return this.request('provider_account_login_methods', {}, signal);
  }

  startWebLogin(method: string, signal?: AbortSignal): Promise<AccountSnapshot> {
    return this.request('provider_auth_oauth_start', { methodId: method }, signal);
  }

  reopenLogin(attemptId: string, signal?: AbortSignal): Promise<AccountSnapshot> {
    if (getHostBridge().kind !== 'android' || this.id !== 'qqmusic') {
      return Promise.reject(
        new ProviderError(
          'unsupported-operation',
          'Reopening mobile authorization is unavailable on this host.',
          false,
        ),
      );
    }
    return this.request('provider_auth_oauth_start', { methodId: 'qq', attemptId }, signal);
  }

  startQrLogin(signal?: AbortSignal): Promise<AccountSnapshot> {
    return this.request('provider_auth_start', {}, signal);
  }

  heartbeatQrLogin(
    attemptId: string,
    ownerLeaseId: string,
    signal?: AbortSignal,
  ): Promise<AccountSnapshot> {
    return this.request('provider_auth_heartbeat', { attemptId, ownerLeaseId }, signal);
  }

  cancelQrLogin(attemptId: string, signal?: AbortSignal): Promise<AccountSnapshot> {
    return this.request('provider_auth_cancel', { attemptId }, signal);
  }

  refreshQrLogin(attemptId: string | null, signal?: AbortSignal): Promise<AccountSnapshot> {
    return this.request('provider_auth_refresh', { attemptId }, signal);
  }

  signOut(signal?: AbortSignal): Promise<AccountSnapshot> {
    return this.request('provider_sign_out', {}, signal);
  }

  getFavoriteSongs(cursor?: string, limit = 50, signal?: AbortSignal): Promise<Page<Song>> {
    return this.request('provider_favorite_songs', { cursor: cursor ?? null, limit }, signal);
  }

  getAccountPlaylists(
    cursor?: string,
    limit = 50,
    signal?: AbortSignal,
  ): Promise<Page<AccountPlaylistSummary>> {
    return this.request('provider_account_playlists', { cursor: cursor ?? null, limit }, signal);
  }

  getAccountPlaylistTracks(
    playlist: AccountPlaylistSummary,
    cursor?: string,
    limit = 50,
    signal?: AbortSignal,
  ): Promise<AccountPlaylistDetail> {
    return this.request(
      'provider_account_playlist_tracks',
      { playlist, cursor: cursor ?? null, limit },
      signal,
    );
  }

  getAccountRecentlyPlayed(
    cursor?: string,
    limit = 50,
    signal?: AbortSignal,
  ): Promise<Page<RemotePlayHistoryItem>> {
    return this.request(
      'provider_account_recently_played',
      { cursor: cursor ?? null, limit },
      signal,
    );
  }

  setFavorite(
    request: FavoriteMutationRequest,
    signal?: AbortSignal,
  ): Promise<FavoriteMutationResult> {
    return this.request('provider_set_favorite', { request }, signal);
  }

  createPlaylist(
    request: CreatePlaylistRequest,
    signal?: AbortSignal,
  ): Promise<PlaylistMutationResult> {
    return this.request('provider_create_playlist', { request }, signal);
  }

  renamePlaylist(
    request: RenamePlaylistRequest,
    signal?: AbortSignal,
  ): Promise<PlaylistMutationResult> {
    return this.request('provider_rename_playlist', { request }, signal);
  }

  addPlaylistTrack(
    request: PlaylistTrackMutationRequest,
    signal?: AbortSignal,
  ): Promise<PlaylistMutationResult> {
    return this.request('provider_add_playlist_track', { request }, signal);
  }

  removePlaylistTrack(
    request: PlaylistTrackMutationRequest,
    signal?: AbortSignal,
  ): Promise<PlaylistMutationResult> {
    return this.request('provider_remove_playlist_track', { request }, signal);
  }

  deletePlaylist(
    request: DeletePlaylistRequest,
    signal?: AbortSignal,
  ): Promise<PlaylistMutationResult> {
    return this.request('provider_delete_playlist', { request }, signal);
  }

  setPlaylistCollected(
    request: CollectPlaylistRequest,
    signal?: AbortSignal,
  ): Promise<PlaylistMutationResult> {
    return this.request('provider_set_playlist_collected', { request }, signal);
  }
}

class NativeAccountShareMusicProvider
  extends NativeAccountMusicProvider
  implements ShareMusicProvider
{
  getSongShareTarget(id: EntityId, signal?: AbortSignal): Promise<ShareTarget> {
    return nativeProviderRequest(
      'catalog_share_song',
      { providerId: this.id, id },
      signal,
      this.displayName,
    );
  }
}

export function createNativeMusicProvider(descriptor: ProviderDescriptor): MusicProvider {
  if (descriptor.capabilities.account && descriptor.capabilities.share) {
    return new NativeAccountShareMusicProvider(descriptor);
  }
  if (descriptor.capabilities.account) return new NativeAccountMusicProvider(descriptor);
  if (descriptor.capabilities.share) return new NativeShareMusicProvider(descriptor);
  return new NativeMusicProvider(descriptor);
}
