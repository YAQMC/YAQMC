import {
  type AccountLoginMethod,
  type AccountLoginMethodDescriptor,
  type AccountPlaylistDetail,
  type AccountPlaylistSummary,
  type AccountSnapshot,
  type Album,
  type AreaFeed,
  type Artist,
  type ArtistCatalogKind,
  type ArtistCatalogPage,
  type CatalogSearchKind,
  type CollectPlaylistRequest,
  type CreatePlaylistRequest,
  type DeletePlaylistRequest,
  type DiscoverFeed,
  type EntityId,
  type FavoriteMutationRequest,
  type FavoriteMutationResult,
  type HomeFeed,
  type LibrarySnapshot,
  type LyricDocument,
  type Page,
  type Playlist,
  type PlaylistMutationResult,
  type PlaylistTrackMutationRequest,
  type RemotePlayHistoryItem,
  type RenamePlaylistRequest,
  type SearchResult,
  type ShareTarget,
  type Song,
} from '../../domain/music';
import type { AccountMusicProvider, MusicProvider } from '../music-provider';
import { nativeProviderRequest as nativeRequest } from '../native/native-request';

export class QQMusicProvider implements MusicProvider, AccountMusicProvider {
  readonly id = 'qqmusic';
  readonly displayName = 'QQ Music';

  getHome(signal?: AbortSignal, refresh = false): Promise<HomeFeed> {
    return nativeRequest('qqmusic_home', { refresh }, signal);
  }

  getDiscover(signal?: AbortSignal, refresh = false): Promise<DiscoverFeed> {
    return nativeRequest('qqmusic_discover', { refresh }, signal);
  }

  getArea(encArea: string, signal?: AbortSignal): Promise<AreaFeed> {
    return nativeRequest('qqmusic_area', { encArea }, signal);
  }

  getSong(id: EntityId, signal?: AbortSignal): Promise<Song> {
    return nativeRequest('qqmusic_song', { id }, signal);
  }

  getAlbum(id: EntityId, signal?: AbortSignal): Promise<Album> {
    return nativeRequest('qqmusic_album', { id }, signal);
  }

  getArtist(id: EntityId, signal?: AbortSignal): Promise<Artist> {
    return nativeRequest('qqmusic_artist', { id }, signal);
  }

  getArtistCatalog(
    id: EntityId,
    kind: ArtistCatalogKind,
    signal?: AbortSignal,
    page = 1,
    limit = 20,
  ): Promise<ArtistCatalogPage> {
    return nativeRequest('qqmusic_artist_catalog', { id, kind, page, limit }, signal);
  }

  getPlaylist(id: EntityId, signal?: AbortSignal): Promise<Playlist> {
    return nativeRequest('qqmusic_playlist', { id }, signal);
  }

  getSongShareTarget(id: EntityId, signal?: AbortSignal): Promise<ShareTarget> {
    return nativeRequest('catalog_share_song', { providerId: this.id, id }, signal);
  }

  getLibrary(signal?: AbortSignal): Promise<LibrarySnapshot> {
    return nativeRequest('qqmusic_library', undefined, signal);
  }

  getLyrics(songId: EntityId, signal?: AbortSignal): Promise<LyricDocument | null> {
    return nativeRequest('qqmusic_lyrics', { songId }, signal);
  }

  search(
    query: string,
    kind: CatalogSearchKind,
    signal?: AbortSignal,
    page = 1,
    limit = 20,
  ): Promise<SearchResult> {
    return nativeRequest('qqmusic_search', { query, kind, page, limit }, signal);
  }

  getAccountSnapshot(signal?: AbortSignal): Promise<AccountSnapshot> {
    return nativeRequest('qqmusic_account_snapshot', undefined, signal);
  }

  getLoginMethods(): Promise<AccountLoginMethodDescriptor[]> {
    return Promise.resolve([
      { id: 'qq', label: 'QQ', flow: 'oauth' },
      { id: 'wechat', label: 'WeChat', flow: 'oauth' },
    ]);
  }

  startWebLogin(method: AccountLoginMethod, signal?: AbortSignal): Promise<AccountSnapshot> {
    return nativeRequest('qqmusic_auth_oauth_start', { loginProvider: method }, signal);
  }

  startQrLogin(signal?: AbortSignal): Promise<AccountSnapshot> {
    return nativeRequest('qqmusic_auth_start', undefined, signal);
  }

  heartbeatQrLogin(
    attemptId: string,
    ownerLeaseId: string,
    signal?: AbortSignal,
  ): Promise<AccountSnapshot> {
    return nativeRequest('qqmusic_auth_heartbeat', { attemptId, ownerLeaseId }, signal);
  }

  cancelQrLogin(attemptId: string, signal?: AbortSignal): Promise<AccountSnapshot> {
    return nativeRequest('qqmusic_auth_cancel', { attemptId }, signal);
  }

  refreshQrLogin(attemptId: string | null, signal?: AbortSignal): Promise<AccountSnapshot> {
    return nativeRequest('qqmusic_auth_refresh', { attemptId }, signal);
  }

  signOut(signal?: AbortSignal): Promise<AccountSnapshot> {
    return nativeRequest('qqmusic_sign_out', undefined, signal);
  }

  getFavoriteSongs(cursor?: string, limit?: number, signal?: AbortSignal): Promise<Page<Song>> {
    return nativeRequest('qqmusic_favorite_songs', { cursor, limit }, signal);
  }

  getAccountPlaylists(
    cursor?: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<Page<AccountPlaylistSummary>> {
    return nativeRequest('qqmusic_account_playlists', { cursor, limit }, signal);
  }

  getAccountPlaylistTracks(
    playlist: AccountPlaylistSummary,
    cursor?: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<AccountPlaylistDetail> {
    return nativeRequest('qqmusic_account_playlist_tracks', { playlist, cursor, limit }, signal);
  }

  getAccountRecentlyPlayed(
    cursor?: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<Page<RemotePlayHistoryItem>> {
    return nativeRequest('qqmusic_account_recently_played', { cursor, limit }, signal);
  }

  setFavorite(
    request: FavoriteMutationRequest,
    signal?: AbortSignal,
  ): Promise<FavoriteMutationResult> {
    return nativeRequest('qqmusic_set_favorite', { request }, signal);
  }

  createPlaylist(
    request: CreatePlaylistRequest,
    signal?: AbortSignal,
  ): Promise<PlaylistMutationResult> {
    return nativeRequest('qqmusic_create_playlist', { request }, signal);
  }

  renamePlaylist(
    request: RenamePlaylistRequest,
    signal?: AbortSignal,
  ): Promise<PlaylistMutationResult> {
    return nativeRequest('qqmusic_rename_playlist', { request }, signal);
  }

  addPlaylistTrack(
    request: PlaylistTrackMutationRequest,
    signal?: AbortSignal,
  ): Promise<PlaylistMutationResult> {
    return nativeRequest('qqmusic_add_playlist_track', { request }, signal);
  }

  removePlaylistTrack(
    request: PlaylistTrackMutationRequest,
    signal?: AbortSignal,
  ): Promise<PlaylistMutationResult> {
    return nativeRequest('qqmusic_remove_playlist_track', { request }, signal);
  }

  deletePlaylist(
    request: DeletePlaylistRequest,
    signal?: AbortSignal,
  ): Promise<PlaylistMutationResult> {
    return nativeRequest('qqmusic_delete_playlist', { request }, signal);
  }

  setPlaylistCollected(
    request: CollectPlaylistRequest,
    signal?: AbortSignal,
  ): Promise<PlaylistMutationResult> {
    return nativeRequest('qqmusic_set_playlist_collected', { request }, signal);
  }
}

export const qqMusicProvider = new QQMusicProvider();
