/** DTO mirror seeded from `src/domain/music.ts` and command-facing frontend types. */

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

export interface ArtistPreview {
  id: EntityId;
  name: string;
  artwork: Artwork;
}

export interface AlbumSummary {
  id: EntityId;
  title: string;
}

export interface AlbumPreview {
  id: EntityId;
  title: string;
  artist: ArtistPreview;
  artwork: Artwork;
  releaseYear: number;
}

export interface PlaylistPreview {
  id: EntityId;
  title: string;
  creator: string;
  artwork: Artwork;
  trackCount: number;
}

export type AudioQuality = 'standard' | 'high' | 'lossless' | 'hi-res' | 'master';
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

export interface ShareTarget {
  providerId: string;
  entityKind: 'song';
  entityId: EntityId;
  title: string;
  artists: string[];
  album?: string;
  canonicalHttpsUrl?: string;
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

export interface Artist {
  id: EntityId;
  name: string;
  artwork: Artwork;
  description: string;
  topSongs: Song[];
  albums: AlbumPreview[];
}

export type ArtistCatalogKind = 'song' | 'album';

export type ArtistCatalogPage =
  | {
      kind: 'song';
      artistId: EntityId;
      page: number;
      hasMore: boolean;
      items: Song[];
    }
  | {
      kind: 'album';
      artistId: EntityId;
      page: number;
      hasMore: boolean;
      items: AlbumPreview[];
    };

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
  newSongSonglist: Playlist | null;
  radarBasedOnSong: string | null;
  radarSongs: Song[];
}

export interface DiscoverFeed {
  charts: Playlist[];
  newSongs: Playlist | null;
  newAlbums: Album[];
  popularSonglists: Playlist[];
  categories: Category[];
  podcasts: Podcast[];
  newMvs: NewMv[];
  featured: FeaturedCard[];
}

export interface Category {
  encArea: string;
  title: string;
  cover: string;
}

export interface Podcast {
  id: string;
  title: string;
  subtitle: string;
  cover: string;
}

export interface NewMv {
  id: string;
  title: string;
  cover: string;
  durationMs: number;
  artist: string;
}

export interface FeaturedCard {
  id: string;
  title: string;
  subtitle: string;
  cover: string;
}

export interface AreaFeed {
  title: string;
  songlists: Playlist[];
  playlists: Playlist[];
  artists: AreaArtist[];
}

export interface AreaArtist {
  id: string;
  name: string;
  cover: string;
}

export interface LibrarySnapshot {
  favoriteSongs: Song[];
  savedAlbums: Album[];
  savedPlaylists: Playlist[];
}

export type CatalogSearchKind = 'song' | 'artist' | 'album' | 'playlist';

export type SearchResult =
  | { kind: 'song'; query: string; page: number; hasMore: boolean; items: Song[] }
  | {
      kind: 'artist';
      query: string;
      page: number;
      hasMore: boolean;
      items: ArtistPreview[];
    }
  | {
      kind: 'album';
      query: string;
      page: number;
      hasMore: boolean;
      items: AlbumPreview[];
    }
  | {
      kind: 'playlist';
      query: string;
      page: number;
      hasMore: boolean;
      items: PlaylistPreview[];
    };

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

export interface PlayTracksRequest {
  tracks: Song[];
  startAtId?: EntityId | null;
  shuffle?: boolean | null;
}

export type RepeatMode = 'off' | 'all' | 'one';
export type PlaybackOrder = 'sequential' | 'shuffle';
export type PrimaryPlaybackMode = 'sequential' | 'shuffle' | 'repeat-one';

export interface QueueEntry {
  id: string;
  track: Song;
}

export type PlaybackState =
  | 'idle'
  | 'loading'
  | 'buffering'
  | 'playing'
  | 'paused'
  | 'stopped'
  | 'ended'
  | 'recoverable-error'
  | 'fatal-error';

export interface PlaybackFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export interface PlayerSnapshot {
  queue: Song[];
  queueEntries: QueueEntry[];
  currentIndex: number | null;
  currentQueueEntryId: string | null;
  positionMs: number;
  isPlaying: boolean;
  volume: number;
  isMuted: boolean;
  repeat: RepeatMode;
  playbackOrder: PlaybackOrder;
  shuffle: boolean;
  primaryPlaybackMode?: PrimaryPlaybackMode;
  shuffleTraversal: string[];
  shuffleCursor: number;
  playbackHistory: string[];
  historyCursor: number;
  upcomingQueueEntryIds: string[];
  playbackState: PlaybackState;
  playbackDurationMs: number | null;
  playbackError?: PlaybackFailure | null;
  sourceSelection?: PlaybackSourceSelection | null;
  sessionId?: number;
  snapshotRevision?: number;
  sourceGeneration?: number;
  lastSeekRevision?: number;
  sampledAtMs?: number;
}

export interface ProviderStatus {
  providerId: string;
  displayName: string;
  connection: 'online' | 'cached' | 'offline';
  message: string;
  preferredQuality: AudioQualityPreference;
  capabilities: CatalogProviderCapabilities;
}

export interface CacheStats {
  totalBytes: number;
  mediaBytes: number;
  artworkBytes: number;
  mediaEntries: number;
  artworkEntries: number;
  metadataEntries: number;
  lyricEntries: number;
  mediaLimitBytes: number;
  artworkLimitBytes: number;
}

export interface AudioOutputDevice {
  id: string;
  label: string;
  isDefault: boolean;
  isSelected: boolean;
  selectionKind: 'system-default' | 'specific-device';
  resolvedOutput: {
    name: string;
    driver: string;
    host: string;
    sampleRate: number;
    channels: number;
    sampleFormat: string;
  } | null;
}

export interface PlatformCapabilities {
  reliableAlwaysOnTop: boolean;
  clickThrough: boolean;
  transparentWindow: boolean;
  globalPositioning: boolean;
  absoluteWindowPlacement: boolean;
  fullscreenDetection: boolean;
  globalShortcuts: boolean;
  notes: string[];
}

export interface DesktopIntegrationStatus {
  trayAvailable: boolean;
  trayError: string | null;
  globalShortcutsSupported: boolean;
  globalShortcutsEnabled: boolean;
  globalShortcuts: string[];
  shortcutError: string | null;
}

export interface PlatformDiagnostics {
  generatedAtUnixMs: number;
  appName: string;
  appVersion: string;
  os: string;
  architecture: string;
  linux: Record<string, unknown> | null;
  capabilities?: PlatformCapabilities;
}

export interface LyricSurfaceProjection {
  timestampMs: number;
  sessionId?: number;
  currentTrack: Song | null;
  positionMs: number;
  isPlaying: boolean;
  playbackState: string;
  playbackDurationMs: number | null;
  syncMode: LyricSyncMode | null;
  lineIndex: number | null;
  wordIndex: number | null;
  currentLine: LyricLine | null;
  nextLine: LyricLine | null;
}

export type SurfaceKind = 'desktop' | 'island';
export type SurfaceInteraction = 'interactive' | 'passive-locked';
export type SurfaceWidth = 'compact' | 'regular' | 'wide';

export interface SurfaceRuntimeConfig {
  enabled: boolean;
  alwaysOnTop: boolean;
  interaction: SurfaceInteraction;
  hideInFullscreen: boolean;
  horizontalPosition: number;
  verticalOffset: number;
  width: SurfaceWidth;
}

export interface SurfaceRuntimeMap {
  desktop: SurfaceRuntimeConfig;
  island: SurfaceRuntimeConfig;
}

export interface SurfaceCapabilities {
  desktop: boolean;
  island: boolean;
  platform: string;
  backend: string;
  reliableAlwaysOnTop: boolean;
  reliableClickThrough: boolean;
  reliableGlobalPositioning: boolean;
  limitations: string[];
}

export interface ManagedBackgroundImage {
  reference: string;
  dataUri: string;
}

export type LocalApiRunState = 'disabled' | 'starting' | 'running' | 'error';

export interface LocalApiStatus {
  enabled: boolean;
  state: LocalApiRunState;
  host: '127.0.0.1';
  configuredPort: number;
  boundPort: number | null;
  tokenConfigured: boolean;
  lastError: string | null;
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface DebugPerfSample {
  fps: number;
  averageMs: number;
  p95Ms: number;
  maxMs: number;
  longTasks: number;
}

export interface LyricsPresetDiagnostics {
  id: string;
  kind: 'built-in' | 'custom' | 'plugin';
  schemaVersion: number;
  rendererVersion?: number;
}

export interface DiagnosticsRequest {
  accountState?: string;
  membershipTier?: string;
  membershipStatus?: string;
  lyricsPreset?: LyricsPresetDiagnostics;
}

export interface DiagnosticsHostWindowState {
  id: number;
  role: string;
  visible: boolean;
  focused?: boolean;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  alwaysOnTop?: boolean;
}

export interface DiagnosticsHostCapabilities {
  alwaysOnTop: boolean;
  clickThrough: boolean;
  globalShortcuts: boolean;
  transparency: boolean;
}

export interface DiagnosticsHostDisplay {
  backend: string;
  capabilities: DiagnosticsHostCapabilities;
}

export interface DiagnosticsHostUpdater {
  state: string;
  canInstall?: boolean;
  allowPrerelease?: boolean;
  channel?: string;
  version?: string;
  releaseUrl?: string;
  error?: string;
}

/** Optional §29.2 graphics facts nested in `host.json`. */
export interface DiagnosticsHostLinuxGraphics {
  platform: string;
  mode: string;
  canonicalMode: string;
  switches: string[];
  deprecatedEnv: boolean;
}

/** Host-collected blob for `host.json` (+ optional `host.log` via `log`). */
export interface DiagnosticsHostPayload {
  schemaVersion: number;
  electron: string;
  chrome: string;
  node: string;
  windows: DiagnosticsHostWindowState[];
  display: DiagnosticsHostDisplay;
  updater: DiagnosticsHostUpdater;
  restartCounter: number;
  log?: string;
  linuxGraphics?: DiagnosticsHostLinuxGraphics;
}

export interface DiagnosticsBundleRequest extends DiagnosticsRequest {
  includeLogs?: boolean;
  overrideUnresolved?: boolean;
  description?: string;
  issueCategory?: string;
  hostPayload?: DiagnosticsHostPayload;
}

export interface AppSection {
  name: string;
  version: string;
  commit: string | null;
  channel: string;
  buildType: string;
}

export interface ProviderSection {
  id: string;
  connection: string;
  accountState: string;
}

export interface PlaybackSection {
  state: string;
}

export interface ErrorRecord {
  code: string;
  domain: string;
  message: string;
  opId: string | null;
  capturedAtUnixMs: number;
}

export interface PluginDiagnostic {
  id: string;
  version: string;
  enabled: boolean;
  status: string;
  entrypointKinds: string[];
  apiVersion: number;
  packageSha256: string;
  permissions: string[];
  riskRating: string;
}

export interface DiagnosticsSnapshot {
  schemaVersion: number;
  sessionId: string;
  generatedAtUnixMs: number;
  app: AppSection;
  platform: PlatformDiagnostics;
  provider: ProviderSection | null;
  playback: PlaybackSection;
  logLevel: LogLevel;
  recentErrors: ErrorRecord[];
  lyricsPreset?: LyricsPresetDiagnostics | null;
  plugins?: PluginDiagnostic[];
}

export interface RedactionReport {
  scannerVersion: number;
  filesScanned: number;
  valuesRedacted: number;
  unresolvedPatterns: string[];
}

export interface BundleManifest {
  schemaVersion: number;
  scannerVersion: number;
  appName: string;
  appVersion: string;
  platform: string;
  architecture: string;
  generatedAtUnixMs: number;
  sessionId: string;
  logFiles: string[];
  includeSnapshot: boolean;
  includeLogs: boolean;
}

export interface BundleExportResult {
  path: string;
  bytes: number;
  sha256: string;
  redaction: RedactionReport;
  warnings: string[];
  manifest: BundleManifest;
}

export interface RecordErrorRequest {
  code: string;
  domain: string;
  message: string;
  opId?: string | null;
}

export interface FrontendLogEntry {
  level: LogLevel;
  target: string;
  message: string;
  opId?: string | null;
  fields?: unknown;
}

export type IssueCategory = 'bug' | 'linux' | 'playback' | 'provider' | 'lyrics' | 'ui' | 'other';

export interface IssueDraft {
  category: IssueCategory;
  summary: string;
  description: string;
  bundleFileName?: string;
  linkedErrorCode?: string;
  linkedOpId?: string;
}

export interface IssuePreview {
  title: string;
  body: string;
  url: string;
  tooLongForBrowser: boolean;
  includedFields: string[];
  template: string;
}

export type PluginStatus =
  'installed' | 'disabled' | 'enabling' | 'active' | 'disabling' | 'failed' | 'incompatible';

export interface PluginScanReport {
  severity: 'low' | 'medium' | 'high' | null;
  findings: Array<{ severity: string; kind: string; count: number; detail: string }>;
}

export interface PluginRecord {
  id: string;
  name: string;
  version: string;
  description?: string | null;
  authors: string[];
  enabled: boolean;
  status: PluginStatus;
  statusReason?: string | null;
  apiVersion: number;
  packageSha256: string;
  source: string;
  unsigned: boolean;
  entrypoints: { styles: number; scenes: number; script: boolean };
  permissions: string[];
  grantedPermissions: string[];
  riskRating: string;
  styleScan: PluginScanReport;
  scriptScan: PluginScanReport;
  compatible: boolean;
  platforms: string[];
  settingsSchema?: unknown;
  networkOrigins?: string[];
  unpackedPath?: string | null;
  lastError?: string | null;
}

export interface ActiveStyleSheet {
  pluginId: string;
  css: string;
}

export interface ActiveSceneResource {
  pluginId: string;
  pluginName: string;
  sceneId: string;
  css?: string | null;
  definition: unknown;
}

export interface ActiveScriptResource {
  pluginId: string;
  pluginName?: string;
  source: string;
}

export interface ActivePluginResources {
  safeMode: boolean;
  developerMode: boolean;
  styleOrder: string[];
  styles: ActiveStyleSheet[];
  scenes: ActiveSceneResource[];
  scripts: ActiveScriptResource[];
}

export interface PluginInspectResult {
  sha256: string;
  compressedBytes: number;
  expandedBytes: number;
  fileCount: number;
  manifest: {
    id: string;
    name: string;
    version: string;
    authors?: string[];
    apiVersion?: number;
    manifestVersion?: number;
    description?: string;
  };
  permissions: string[];
  styleScan: PluginScanReport;
  scriptScan: PluginScanReport;
  files: string[];
}

export interface PluginInstallRequest {
  path: string;
  enable?: boolean;
  grant?: string[];
}

export interface PluginEnableRequest {
  id: string;
  enabled: boolean;
  grant?: string[];
}

export interface PluginUninstallRequest {
  id: string;
  removeData?: boolean;
}

export interface PluginBridgeRequest {
  token: string;
  method: string;
  payload?: unknown;
}

export interface PluginSettingsWrite {
  id: string;
  values: Record<string, unknown>;
}

export interface PluginAsset {
  mime: string;
  dataBase64: string;
}

export interface PingResult {
  ok: true;
}

export interface OAuthPrepareResult {
  attemptId: string;
  url: string;
  navigationAllowlist: string[];
  callbackMatcher: { urlPrefix: string };
}

export type NamedRequest<T> = { request: T };
