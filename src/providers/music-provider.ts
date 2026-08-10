import type {
  Album,
  EntityId,
  HomeFeed,
  LibrarySnapshot,
  LyricDocument,
  Playlist,
  SearchResult,
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
