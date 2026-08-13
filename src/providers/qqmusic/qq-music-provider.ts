import { invoke } from '@tauri-apps/api/core';
import {
  PROVIDER_ERROR_CODES,
  ProviderError,
  type AccountLoginMethod,
  type AccountPlaylistDetail,
  type AccountPlaylistSummary,
  type AccountSnapshot,
  type Album,
  type CollectPlaylistRequest,
  type CreatePlaylistRequest,
  type DeletePlaylistRequest,
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
  type ProviderErrorCode,
  type RemotePlayHistoryItem,
  type RenamePlaylistRequest,
  type SearchResult,
  type Song,
} from '../../domain/music';
import type { AccountMusicProvider, MusicProvider } from '../music-provider';

interface NativeProviderError {
  code?: string;
  message?: string;
  retryable?: boolean;
}

const providerErrorCodes = new Set<ProviderErrorCode>(PROVIDER_ERROR_CODES);

function isProviderErrorCode(value: unknown): value is ProviderErrorCode {
  return typeof value === 'string' && providerErrorCodes.has(value as ProviderErrorCode);
}

function abortError(): DOMException {
  return new DOMException('The provider request was cancelled.', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function providerError(error: unknown): ProviderError {
  const value = error as NativeProviderError | null;
  if (value && typeof value === 'object' && isProviderErrorCode(value.code)) {
    return new ProviderError(
      value.code,
      typeof value.message === 'string' ? value.message : 'QQ Music request failed.',
      Boolean(value.retryable),
    );
  }
  return new ProviderError('provider-failure', 'QQ Music request failed.', false);
}

async function nativeRequest<T>(
  command: string,
  args: Record<string, unknown> | undefined,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  try {
    const result = await invoke<T>(command, args);
    throwIfAborted(signal);
    return result;
  } catch (error) {
    throwIfAborted(signal);
    throw providerError(error);
  }
}

export class QQMusicProvider implements MusicProvider, AccountMusicProvider {
  readonly id = 'qqmusic';
  readonly displayName = 'QQ Music';

  getHome(signal?: AbortSignal): Promise<HomeFeed> {
    return nativeRequest('qqmusic_home', undefined, signal);
  }

  getAlbum(id: EntityId, signal?: AbortSignal): Promise<Album> {
    return nativeRequest('qqmusic_album', { id }, signal);
  }

  getPlaylist(id: EntityId, signal?: AbortSignal): Promise<Playlist> {
    return nativeRequest('qqmusic_playlist', { id }, signal);
  }

  getLibrary(signal?: AbortSignal): Promise<LibrarySnapshot> {
    return nativeRequest('qqmusic_library', undefined, signal);
  }

  getLyrics(songId: EntityId, signal?: AbortSignal): Promise<LyricDocument | null> {
    return nativeRequest('qqmusic_lyrics', { songId }, signal);
  }

  search(query: string, signal?: AbortSignal, page = 1, limit = 20): Promise<SearchResult> {
    return nativeRequest('qqmusic_search', { query, page, limit }, signal);
  }

  getAccountSnapshot(signal?: AbortSignal): Promise<AccountSnapshot> {
    return nativeRequest('qqmusic_account_snapshot', undefined, signal);
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
