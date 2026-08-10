import { ProviderError, type Album, type EntityId, type Playlist } from '../../domain/music';
import type { MusicProvider } from '../music-provider';
import { albums, allSongs, homeFeed, librarySnapshot, lyricsBySong, playlists } from './fixtures';

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('The provider request was cancelled.', 'AbortError');
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function normalizeQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

export class FakeMusicProvider implements MusicProvider {
  readonly id = 'fake';
  readonly displayName = 'Offline fixtures';

  async getHome(signal?: AbortSignal) {
    throwIfAborted(signal);
    return clone(homeFeed);
  }

  async getAlbum(id: EntityId, signal?: AbortSignal): Promise<Album> {
    throwIfAborted(signal);
    const album = albums.find((candidate) => candidate.id === id);
    if (!album) {
      throw new ProviderError('malformed-response', `Unknown fixture album: ${id}`, false);
    }
    return clone(album);
  }

  async getPlaylist(id: EntityId, signal?: AbortSignal): Promise<Playlist> {
    throwIfAborted(signal);
    const playlist = playlists.find((candidate) => candidate.id === id);
    if (!playlist) {
      throw new ProviderError('malformed-response', `Unknown fixture playlist: ${id}`, false);
    }
    return clone(playlist);
  }

  async getLibrary(signal?: AbortSignal) {
    throwIfAborted(signal);
    return clone(librarySnapshot);
  }

  async getLyrics(songId: EntityId, signal?: AbortSignal) {
    throwIfAborted(signal);
    return clone(lyricsBySong[songId] ?? null);
  }

  async search(query: string, signal?: AbortSignal) {
    throwIfAborted(signal);
    const normalized = normalizeQuery(query);
    if (!normalized) {
      return { query: '', songs: [], albums: [], playlists: [] };
    }

    const includesQuery = (...values: string[]) =>
      values.some((value) => value.toLocaleLowerCase().includes(normalized));

    return clone({
      query: query.trim(),
      songs: allSongs.filter((song) =>
        includesQuery(song.title, song.album.title, ...song.artists.map((artist) => artist.name)),
      ),
      albums: albums.filter((album) => includesQuery(album.title, album.artist.name, album.genre)),
      playlists: playlists.filter((playlist) =>
        includesQuery(playlist.title, playlist.description, playlist.owner.displayName),
      ),
    });
  }
}

export const fakeMusicProvider = new FakeMusicProvider();
