import { invoke } from '@tauri-apps/api/core';
import {
  ProviderError,
  type Album,
  type EntityId,
  type HomeFeed,
  type LibrarySnapshot,
  type LyricDocument,
  type Playlist,
  type ProviderErrorCode,
  type SearchResult,
} from '../../domain/music';
import type { MusicProvider } from '../music-provider';

interface NativeProviderError {
  code?: string;
  message?: string;
  retryable?: boolean;
}

function abortError(): DOMException {
  return new DOMException('The provider request was cancelled.', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function providerError(error: unknown): ProviderError {
  const value = error as NativeProviderError | null;
  if (value && typeof value === 'object' && typeof value.code === 'string') {
    return new ProviderError(
      value.code as ProviderErrorCode,
      typeof value.message === 'string' ? value.message : 'QQ Music request failed.',
      Boolean(value.retryable),
    );
  }
  return new ProviderError(
    'provider-failure',
    error instanceof Error ? error.message : String(error),
    false,
  );
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

export class QQMusicProvider implements MusicProvider {
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
}

export const qqMusicProvider = new QQMusicProvider();
