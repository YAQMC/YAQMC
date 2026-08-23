import {
  ProviderError,
  type Album,
  type Artist,
  type EntityId,
  type Playlist,
  type Song,
} from '../../domain/music';
import type { MusicProvider } from '../music-provider';
import {
  albums,
  allSongs,
  areaFeeds,
  discoverFeed,
  homeFeed,
  librarySnapshot,
  lyricsBySong,
  playlists,
} from './fixtures';

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

  async getHome(signal?: AbortSignal, refresh = false) {
    throwIfAborted(signal);
    void refresh;
    return clone(homeFeed);
  }

  async getDiscover(signal?: AbortSignal, refresh = false) {
    throwIfAborted(signal);
    void refresh;
    return clone(discoverFeed);
  }

  async getArea(encArea: string, signal?: AbortSignal) {
    throwIfAborted(signal);
    const area = areaFeeds[encArea];
    if (!area) {
      throw new ProviderError('malformed-response', `Unknown fixture area: ${encArea}`, false);
    }
    return clone(area);
  }

  async getSong(id: EntityId, signal?: AbortSignal): Promise<Song> {
    throwIfAborted(signal);
    const song = allSongs.find((candidate) => candidate.id === id);
    if (!song) {
      throw new ProviderError('not-found', `Unknown fixture song: ${id}`, false);
    }
    return clone(song);
  }

  async getAlbum(id: EntityId, signal?: AbortSignal): Promise<Album> {
    throwIfAborted(signal);
    const album = albums.find((candidate) => candidate.id === id);
    if (!album) {
      throw new ProviderError('malformed-response', `Unknown fixture album: ${id}`, false);
    }
    return clone(album);
  }

  async getArtist(id: EntityId, signal?: AbortSignal): Promise<Artist> {
    throwIfAborted(signal);
    const artistAlbums = albums.filter((album) => album.artist.id === id);
    const topSongs = allSongs.filter((song) => song.artists.some((artist) => artist.id === id));
    if (artistAlbums.length === 0 && topSongs.length === 0) {
      throw new ProviderError('not-found', `Unknown fixture artist: ${id}`, false);
    }
    const summary = artistAlbums[0]?.artist ?? topSongs[0]?.artists.find((artist) => artist.id === id);
    if (!summary) {
      throw new ProviderError('not-found', `Unknown fixture artist: ${id}`, false);
    }
    const albumPreviews = artistAlbums.map((album) => ({
      id: album.id,
      title: album.title,
      artist: {
        id: summary.id,
        name: summary.name,
        artwork: clone(album.artwork),
      },
      artwork: clone(album.artwork),
      releaseYear: album.releaseYear,
    }));
    return {
      id: summary.id,
      name: summary.name,
      artwork: clone(artistAlbums[0]?.artwork ?? topSongs[0]!.artwork),
      description: `Offline fixture profile for ${summary.name}.`,
      topSongs: clone(topSongs.slice(0, 20)),
      albums: albumPreviews,
    };
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

  async getGuessNext(limit = 5, signal?: AbortSignal) {
    throwIfAborted(signal);
    return clone(allSongs.slice(0, limit));
  }
}

export const fakeMusicProvider = new FakeMusicProvider();
