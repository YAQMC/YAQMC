export type EntityId = string;

export interface ArtworkVariant {
  src: string;
  width: number;
  height: number;
}

export interface Artwork {
  src: string;
  alt: string;
  dominantColor: string;
  variants?: ArtworkVariant[];
}

export interface ArtistSummary {
  id: EntityId;
  name: string;
}

export interface AlbumSummary {
  id: EntityId;
  title: string;
}

export type AudioQuality = 'standard' | 'high' | 'lossless' | 'master';

export type AudioQualityPreference = 'automatic' | AudioQuality;

export type PlaybackFallbackReason =
  | 'source-unavailable'
  | 'account-rights'
  | 'entitlement-unknown'
  | 'client-unsupported'
  | 'preview-only';

export type EntitlementCapabilityState = 'allowed' | 'denied' | 'unknown';
export type ResourceCapabilityState = 'available' | 'unavailable' | 'unknown';
export type ClientCapabilityState = 'supported' | 'unsupported' | 'unknown';

export interface QualityCapabilityState {
  quality: AudioQuality;
  entitlement: EntitlementCapabilityState;
  resource: ResourceCapabilityState;
  client: ClientCapabilityState;
  playable: boolean;
}

export interface PlaybackSourceSelection {
  requestedQuality: AudioQualityPreference;
  resolvedQuality: AudioQuality;
  fallbackReason?: PlaybackFallbackReason;
  preview: boolean;
  qualityCapabilities?: QualityCapabilityState[];
}

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
  guessSonglist: Playlist | null;
  recommendedSonglists: Playlist[];
  dailySonglist: Playlist | null;
  radarSongs: Song[];
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

export const PROVIDER_ERROR_CODES = [
  'offline',
  'timeout',
  'authentication-expired',
  'authorization-rejected',
  'entitlement-unavailable',
  'entitlement-unknown',
  'client-unsupported',
  'rate-limited',
  'schema-changed',
  'song-unavailable',
  'malformed-response',
  'unavailable',
  'provider-failure',
  'cancelled',
  'not-found',
  'invalid-request',
  'unsupported-operation',
  'mutation-in-progress',
  'storage-failure',
  'invalid-playlist-identifier',
  'unsupported-account-collection',
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total: number | null;
  fetchedAtMs: number;
  stale: boolean;
  authRevision: number;
}

export interface PlaylistCapabilities {
  canAddTracks: boolean;
  canRemoveTracks: boolean;
  canRename: boolean;
  canDelete: boolean;
  canReorder: boolean;
}

export type PlaylistOwnership = 'owned' | 'collected' | 'favorite' | 'system';

export type AccountPlaylistReference =
  | { kind: 'owned'; tid: string; dirId?: number }
  | { kind: 'collected'; tid: string }
  | { kind: 'favorite-songs'; dirId: number }
  | { kind: 'system-collection'; dirId: number; tid?: string; collectionType?: string };

export interface AccountPlaylistSummary {
  id: EntityId;
  reference: AccountPlaylistReference;
  title: string;
  description: string;
  owner: PlaylistOwner;
  artwork: Artwork;
  ownership: PlaylistOwnership;
  capabilities: PlaylistCapabilities;
  trackCount: number;
  updatedAtMs: number | null;
}

export interface AccountPlaylistDetail {
  summary: AccountPlaylistSummary;
  tracks: Page<Song>;
}

export interface RemotePlayHistoryItem {
  song: Song;
  playedAtMs: number | null;
  source: 'qqmusic-account' | 'local-playback';
}

export type EntitlementTier = 'free' | 'green-diamond' | 'super-vip' | 'unknown';
export type MembershipState = 'active' | 'expired' | 'inactive' | 'unknown';

export type SecondaryEntitlement =
  | 'luxury-green-diamond'
  | 'annual-green-diamond'
  | 'annual-luxury-green-diamond'
  | 'star'
  | 'annual-star'
  | 'eight-platform'
  | 'twelve-platform'
  | 'family'
  | 'child'
  | 'trial'
  | 'couple'
  | 'ad-free';

export interface EntitlementRestriction {
  feature: 'playback' | 'favorite-write' | 'playlist-write' | 'quality';
  quality?: AudioQuality;
  reason: 'membership-required' | 'region-restricted' | 'upstream-restricted' | 'unknown';
}

export interface AccountEntitlement {
  tier: EntitlementTier;
  membership: MembershipState;
  expiresAtMs: number | null;
  secondaryEntitlements?: SecondaryEntitlement[];
  permittedQualities: AudioQuality[];
  observedMaximumQuality: AudioQuality | null;
  restrictions: EntitlementRestriction[];
}

export interface AccountProfile {
  avatarUrl: string | null;
  nickname: string;
  maskedIdentity: string;
}

export interface CatalogProviderCapabilities {
  search: boolean;
  album: boolean;
  artist: boolean;
  playlist: boolean;
  lyrics: boolean;
  wordTimedLyrics: boolean;
  streaming: boolean;
  qualitySelection: boolean;
}

export interface AccountCapabilities {
  qrLogin: boolean;
  favoriteRead: boolean;
  favoriteWrite: boolean;
  playlistRead: boolean;
  playlistWrite: boolean;
  recentHistoryRead: boolean;
}

export type AccountLoginMethod = 'qq' | 'wechat';

export type AccountState =
  | { state: 'guest'; profile: null; entitlement: null }
  | { state: 'restoring-session'; profile: null; entitlement: null }
  | {
      state: 'starting-login';
      attemptId: string;
      ownerLeaseId: string;
      pollAfterMs: number;
      profile: null;
      entitlement: null;
    }
  | {
      state: 'waiting-for-scan';
      attemptId: string;
      ownerLeaseId: string;
      qrImageDataUri: string;
      expiresAtMs: number;
      pollAfterMs: number;
      profile: null;
      entitlement: null;
    }
  | {
      state: 'waiting-for-confirmation';
      attemptId: string;
      ownerLeaseId: string;
      expiresAtMs: number;
      pollAfterMs: number;
      profile: null;
      entitlement: null;
    }
  | { state: 'authenticated'; profile: AccountProfile; entitlement: AccountEntitlement }
  | {
      state: 'session-expired' | 'reauthentication-required' | 'secure-store-unavailable';
      profile: AccountProfile | null;
      entitlement: AccountEntitlement | null;
    }
  | {
      state: 'cancelled' | 'expired' | 'rejected' | 'network-error' | 'protocol-error';
      attemptId: string | null;
      profile: null;
      entitlement: null;
    };

export type AccountSnapshot = AccountState & {
  revision: number;
  capabilities: AccountCapabilities;
};

export type MutationStatus = 'applied' | 'rejected' | 'reconciled' | 'outcome-unknown';

export interface FavoriteMutationRequest {
  trackId: EntityId;
  favorite: boolean;
  clientOperationId: string;
}

export interface FavoriteMutationResult {
  clientOperationId: string;
  status: MutationStatus;
  trackId: EntityId;
  favorite: boolean;
  errorCode: ProviderErrorCode | null;
  authRevision: number;
}

export interface CreatePlaylistRequest {
  title: string;
  clientOperationId: string;
}

export interface RenamePlaylistRequest {
  playlistId: EntityId;
  title: string;
  clientOperationId: string;
}

export interface PlaylistTrackMutationRequest {
  playlistId: EntityId;
  trackId: EntityId;
  clientOperationId: string;
}

export interface DeletePlaylistRequest {
  playlistId: EntityId;
  clientOperationId: string;
}

export interface CollectPlaylistRequest {
  playlistId: EntityId;
  collected: boolean;
  clientOperationId: string;
}

export interface PlaylistMutationResult {
  clientOperationId: string;
  status: MutationStatus;
  playlist: AccountPlaylistSummary | null;
  errorCode: ProviderErrorCode | null;
  authRevision: number;
}

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
