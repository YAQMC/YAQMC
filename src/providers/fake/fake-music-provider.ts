import {
  DEFAULT_PROFILE_ID,
  ProviderError,
  type Album,
  type AlbumPreview,
  type Artist,
  type ArtistCatalogKind,
  type ArtistCatalogPage,
  type CatalogSearchKind,
  type EntityId,
  type Playlist,
  type PlaylistPreview,
  type Song,
  type SearchResult,
  type ShareTarget,
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

function scopedSong(value: Song): Song {
  const song = clone(value);
  if (song.provider) song.provider.profileId = DEFAULT_PROFILE_ID;
  return song;
}

function scopedAlbum(value: Album): Album {
  const album = clone(value);
  album.tracks = album.tracks.map(scopedSong);
  return album;
}

function scopedPlaylist(value: Playlist): Playlist {
  const playlist = clone(value);
  playlist.tracks = playlist.tracks.map(scopedSong);
  return playlist;
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
  readonly profileId = DEFAULT_PROFILE_ID;
  readonly displayName = 'Offline fixtures';

  async getHome(signal?: AbortSignal, refresh = false) {
    throwIfAborted(signal);
    void refresh;
    const feed = clone(homeFeed);
    feed.featured.album = scopedAlbum(feed.featured.album);
    feed.recentlyPlayed = feed.recentlyPlayed.map((collection) =>
      collection.type === 'album'
        ? { type: 'album', item: scopedAlbum(collection.item) }
        : { type: 'playlist', item: scopedPlaylist(collection.item) },
    );
    feed.madeForYou = feed.madeForYou.map(scopedPlaylist);
    feed.newReleases = feed.newReleases.map(scopedAlbum);
    feed.guessSonglist = feed.guessSonglist ? scopedPlaylist(feed.guessSonglist) : null;
    feed.recommendedSonglists = feed.recommendedSonglists.map(scopedPlaylist);
    feed.dailySonglist = feed.dailySonglist ? scopedPlaylist(feed.dailySonglist) : null;
    feed.newSongSonglist = feed.newSongSonglist ? scopedPlaylist(feed.newSongSonglist) : null;
    feed.radarSongs = feed.radarSongs.map(scopedSong);
    return feed;
  }

  async getDiscover(signal?: AbortSignal, refresh = false) {
    throwIfAborted(signal);
    void refresh;
    const feed = clone(discoverFeed);
    feed.charts = feed.charts.map(scopedPlaylist);
    feed.newSongs = feed.newSongs ? scopedPlaylist(feed.newSongs) : null;
    feed.newAlbums = feed.newAlbums.map(scopedAlbum);
    feed.popularSonglists = feed.popularSonglists.map(scopedPlaylist);
    return feed;
  }

  async getArea(encArea: string, signal?: AbortSignal) {
    throwIfAborted(signal);
    const area = areaFeeds[encArea];
    if (!area) {
      throw new ProviderError('malformed-response', `Unknown fixture area: ${encArea}`, false);
    }
    const feed = clone(area);
    feed.songlists = feed.songlists.map(scopedPlaylist);
    feed.playlists = feed.playlists.map(scopedPlaylist);
    return feed;
  }

  async getSong(id: EntityId, signal?: AbortSignal): Promise<Song> {
    throwIfAborted(signal);
    const song = allSongs.find((candidate) => candidate.id === id);
    if (!song) {
      throw new ProviderError('not-found', `Unknown fixture song: ${id}`, false);
    }
    return scopedSong(song);
  }

  async getAlbum(id: EntityId, signal?: AbortSignal): Promise<Album> {
    throwIfAborted(signal);
    const album = albums.find((candidate) => candidate.id === id);
    if (!album) {
      throw new ProviderError('malformed-response', `Unknown fixture album: ${id}`, false);
    }
    return scopedAlbum(album);
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
      topSongs: topSongs.slice(0, 20).map(scopedSong),
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
      const items = artistSongs.slice(start, start + normalized.limit).map(scopedSong);
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
    return scopedPlaylist(playlist);
  }

  async getLibrary(signal?: AbortSignal) {
    throwIfAborted(signal);
    const library = clone(librarySnapshot);
    library.favoriteSongs = library.favoriteSongs.map(scopedSong);
    library.savedAlbums = library.savedAlbums.map(scopedAlbum);
    library.savedPlaylists = library.savedPlaylists.map(scopedPlaylist);
    return library;
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
          : kind === 'playlist'
            ? playlists
                .filter((playlist) =>
                  includesQuery(playlist.title, playlist.description, playlist.owner.displayName),
                )
                .map<PlaylistPreview>((playlist) => ({
                  id: playlist.id,
                  title: playlist.title,
                  creator: playlist.owner.displayName,
                  artwork: clone(playlist.artwork),
                  trackCount: playlist.tracks.length,
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
    const result = {
      kind,
      query: query.trim(),
      page: Math.max(1, page),
      hasMore: start + items.length < matches.length,
      items: kind === 'song' ? (items as Song[]).map(scopedSong) : items,
    } as SearchResult;
    return clone(result);
  }

  async getSongShareTarget(id: EntityId, signal?: AbortSignal): Promise<ShareTarget> {
    const song = await this.getSong(id, signal);
    return {
      providerId: this.id,
      profileId: this.profileId,
      entityKind: 'song',
      entityId: song.id,
      title: song.title,
      artists: song.artists.map((artist) => artist.name),
      album: song.album.title || undefined,
    };
  }
}

export const fakeMusicProvider = new FakeMusicProvider();
