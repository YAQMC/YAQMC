import {
  ProviderError,
  type Album,
  type AlbumPreview,
  type Artist,
  type ArtistCatalogKind,
  type ArtistCatalogPage,
  type CatalogSearchKind,
  type EntityId,
  type Playlist,
  type Song,
  type SearchResult,
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

function normalizePageLimit(page: number, limit: number): { page: number; limit: number } {
  return {
    page: Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1,
    limit: Number.isFinite(limit) ? Math.min(30, Math.max(1, Math.floor(limit))) : 20,
  };
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
    const summary =
      artistAlbums[0]?.artist ?? topSongs[0]?.artists.find((artist) => artist.id === id);
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

  async getArtistCatalog(
    id: EntityId,
    kind: ArtistCatalogKind,
    signal?: AbortSignal,
    page = 1,
    limit = 20,
  ): Promise<ArtistCatalogPage> {
    throwIfAborted(signal);
    const artistAlbums = albums.filter((album) => album.artist.id === id);
    const artistSongs = allSongs.filter((song) => song.artists.some((artist) => artist.id === id));
    if (artistAlbums.length === 0 && artistSongs.length === 0) {
      throw new ProviderError('not-found', `Unknown fixture artist: ${id}`, false);
    }

    const normalized = normalizePageLimit(page, limit);
    const start = (normalized.page - 1) * normalized.limit;
    if (kind === 'song') {
      const items = artistSongs.slice(start, start + normalized.limit);
      return clone({
        kind,
        artistId: id,
        page: normalized.page,
        hasMore: start + items.length < artistSongs.length,
        items,
      });
    }
    if (kind === 'album') {
      const summary =
        artistAlbums[0]?.artist ?? artistSongs[0]?.artists.find((artist) => artist.id === id);
      if (!summary) {
        throw new ProviderError('not-found', `Unknown fixture artist: ${id}`, false);
      }
      const previews = artistAlbums.map<AlbumPreview>((album) => ({
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
      const items = previews.slice(start, start + normalized.limit);
      return clone({
        kind,
        artistId: id,
        page: normalized.page,
        hasMore: start + items.length < previews.length,
        items,
      });
    }
    throw new ProviderError('invalid-request', `Unsupported artist catalog kind: ${kind}`, false);
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

  async search(
    query: string,
    kind: CatalogSearchKind,
    signal?: AbortSignal,
    page = 1,
    limit = 20,
  ): Promise<SearchResult> {
    throwIfAborted(signal);
    const normalized = normalizeQuery(query);
    if (!normalized) {
      return {
        kind,
        query: '',
        page: 1,
        hasMore: false,
        items: [],
      } as SearchResult;
    }

    const includesQuery = (...values: string[]) =>
      values.some((value) => value.toLocaleLowerCase().includes(normalized));

    const matches =
      kind === 'song'
        ? allSongs.filter((song) =>
            includesQuery(
              song.title,
              song.album.title,
              ...song.artists.map((artist) => artist.name),
            ),
          )
        : kind === 'album'
          ? albums
              .filter((album) => includesQuery(album.title, album.artist.name, album.genre))
              .map<AlbumPreview>((album) => ({
                id: album.id,
                title: album.title,
                artist: {
                  id: album.artist.id,
                  name: album.artist.name,
                  artwork: clone(album.artwork),
                },
                artwork: clone(album.artwork),
                releaseYear: album.releaseYear,
              }))
          : allSongs
              .flatMap((song) => song.artists)
              .filter(
                (artist, index, all) => all.findIndex((item) => item.id === artist.id) === index,
              )
              .filter((artist) => includesQuery(artist.name))
              .map((artist) => ({
                id: artist.id,
                name: artist.name,
                artwork: clone(
                  albums.find((album) => album.artist.id === artist.id)?.artwork ??
                    allSongs.find((song) => song.artists.some((item) => item.id === artist.id))!
                      .artwork,
                ),
              }));
    const start = Math.max(0, (Math.max(1, page) - 1) * Math.max(1, limit));
    const items = matches.slice(start, start + Math.max(1, limit));
    return clone({
      kind,
      query: query.trim(),
      page: Math.max(1, page),
      hasMore: start + items.length < matches.length,
      items,
    }) as SearchResult;
  }

  async getGuessNext(limit = 5, signal?: AbortSignal) {
    throwIfAborted(signal);
    return clone(allSongs.slice(0, limit));
  }
}

export const fakeMusicProvider = new FakeMusicProvider();
