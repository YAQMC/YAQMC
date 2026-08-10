export type EntityId = string;

export interface Artwork {
  src: string;
  alt: string;
  dominantColor: string;
}

export interface ArtistSummary {
  id: EntityId;
  name: string;
}

export interface AlbumSummary {
  id: EntityId;
  title: string;
}

export type AudioQuality = 'standard' | 'high' | 'lossless';

export type AudioCodec = 'mp3' | 'aac' | 'flac' | 'alac' | 'unknown';

export interface AudioFormatInfo {
  quality: AudioQuality;
  codec: AudioCodec;
  bitrateKbps?: number;
  sampleRateHz?: number;
  bitDepth?: number;
  lossless: boolean;
}

export interface ProviderTrackReference {
  providerId: string;
  trackId: string;
  numericId?: number;
  albumId?: string;
  mediaId?: string;
}

export type PlaybackCapability =
  | { status: 'full' }
  | { status: 'preview'; startMs: number; endMs: number }
  | { status: 'unavailable'; reason: string };

export type SongAvailability =
  | { status: 'available' }
  | { status: 'unavailable'; reason: string }
  | { status: 'entitlement-required'; requiredTier: string };

export interface Song {
  id: EntityId;
  title: string;
  artists: ArtistSummary[];
  album: AlbumSummary;
  artwork: Artwork;
  durationMs: number;
  trackNumber: number;
  isFavorite: boolean;
  quality: AudioQuality;
  availability: SongAvailability;
  audioFormats?: AudioFormatInfo[];
  playbackCapability?: PlaybackCapability;
  provider?: ProviderTrackReference;
}

export interface Album {
  id: EntityId;
  title: string;
  artist: ArtistSummary;
  artwork: Artwork;
  releaseYear: number;
  genre: string;
  description: string;
  tracks: Song[];
}

export interface PlaylistOwner {
  id: EntityId;
  displayName: string;
}

export interface Playlist {
  id: EntityId;
  title: string;
  description: string;
  owner: PlaylistOwner;
  artwork: Artwork;
  updatedLabel: string;
  tracks: Song[];
}

export type MediaCollection = { type: 'album'; item: Album } | { type: 'playlist'; item: Playlist };

export interface FeaturedRelease {
  eyebrow: string;
  album: Album;
}

export interface HomeFeed {
  featured: FeaturedRelease;
  recentlyPlayed: MediaCollection[];
  madeForYou: Playlist[];
  newReleases: Album[];
}

export interface LibrarySnapshot {
  favoriteSongs: Song[];
  savedAlbums: Album[];
  savedPlaylists: Playlist[];
}

export interface SearchResult {
  query: string;
  songs: Song[];
  albums: Album[];
  playlists: Playlist[];
  page?: number;
  hasMore?: boolean;
}

export type LyricSyncMode = 'unsynchronized' | 'line' | 'word';

export interface LyricVocalist {
  id: EntityId;
  displayName: string;
}

export interface LyricWord {
  startMs: number;
  endMs: number;
  text: string;
}

export interface LyricLine {
  id: EntityId;
  startMs: number | null;
  endMs: number | null;
  text: string;
  translation?: string;
  romanization?: string;
  vocalistId?: EntityId;
  words: LyricWord[];
}

export interface LyricMetadata {
  sourceLabel: string;
  language?: string;
  translatedLanguage?: string;
  offsetMs: number;
}

export interface LyricDocument {
  songId: EntityId;
  syncMode: LyricSyncMode;
  metadata: LyricMetadata;
  vocalists: LyricVocalist[];
  lines: LyricLine[];
}

export interface PlaybackSource {
  songId: EntityId;
  quality: AudioQuality;
  url: string;
  expiresAt?: string;
}

export type ProviderErrorCode =
  | 'offline'
  | 'timeout'
  | 'authentication-expired'
  | 'unauthorized'
  | 'entitlement-unavailable'
  | 'rate-limited'
  | 'schema-changed'
  | 'song-unavailable'
  | 'malformed-response'
  | 'provider-failure';

export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProviderError';
  }
}
