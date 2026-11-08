export type PluginReleaseChannel = 'stable' | 'beta' | 'nightly';
export interface PluginReleaseInfo {
  channel: PluginReleaseChannel;
  buildId: string;
  releaseSequence: number;
}
export interface PluginUpdatePolicy {
  sourceId: string | null;
  channel: PluginReleaseChannel;
  automatic: boolean;
  bound: boolean;
  lastCheckMs: number;
  lastResult: string | null;
  failedSha256: string | null;
}
export interface PluginUpdateSource {
  id: string;
  pluginId: string;
  name: string;
  repository: string;
  feedUrl: string;
  keyId: string;
  publicKey: string;
  downloadOrigins: string[];
}
export interface PluginAvailableRelease extends PluginReleaseInfo {
  releaseId: string;
  sourceId: string;
  pluginId: string;
  version: string;
  sha256: string;
  size: number;
  url: string;
  expiresAtMs: number;
}
export interface PluginUpdateInfo {
  policy: PluginUpdatePolicy;
  sources: PluginUpdateSource[];
  available: PluginAvailableRelease[];
}
export interface PluginUpdatePolicyRequest {
  pluginId: string;
  sourceId: string | null;
  channel: PluginReleaseChannel;
  automatic: boolean;
  confirmSource?: boolean;
}
export interface PluginUpdatePrepareRequest {
  pluginId?: string;
  path?: string;
  releaseId?: string;
  unpacked?: boolean;
  /** Plugin store asset; the host resolves, downloads and reviews it as unverified. */
  github?: PluginStoreAssetRef;
}
export interface PluginUpdateApplyRequest {
  operationId: string;
  grant?: string[];
  confirm?: boolean;
  stopUsing?: boolean;
  automatic?: boolean;
}
export interface PluginUpdatePreview {
  pluginId: string;
  providerIds: string[];
  name: string;
  currentVersion: string | null;
  expectedGeneration: number | null;
  version: string;
  currentSha256: string | null;
  sha256: string;
  release: PluginReleaseInfo | null;
  permissions: string[];
  grantedPermissions: string[];
  addedPermissions: string[];
  removedPermissions: string[];
  sessionChanges: string[];
  confirmations: string[];
  trustedSource: string | null;
  /** Recorded source for unsigned installs, e.g. `github:owner/repo/releases/1`. */
  origin?: string | null;
  enabled: boolean;
  needsRenderer: boolean;
  hasScript: boolean;
}
export interface PluginUpdateOperation {
  operationId: string;
  pluginId: string | null;
  phase: string;
  preview: PluginUpdatePreview | null;
  downloadedBytes: number;
  totalBytes: number | null;
  error: string | null;
  runtimeChanged: boolean;
}
export interface PluginUpdateRuntimeReadyRequest {
  operationId: string;
  sha256: string;
  stage: 'quiescing' | 'validating';
  error?: string;
}

export type PluginStoreFilter = 'all' | 'name' | 'description' | 'author' | 'repository';
export type PluginStoreSort = 'best-match' | 'stars' | 'updated';
export interface PluginStoreSearchRequest {
  query?: string;
  filter?: PluginStoreFilter;
  sort?: PluginStoreSort;
  page?: number;
  refresh?: boolean;
}
export interface PluginStoreRepository {
  id: number;
  owner: string;
  repo: string;
  fullName: string;
  description: string | null;
  htmlUrl: string;
  ownerType: 'User' | 'Organization';
  ownerAvatarUrl: string | null;
  /** Owned by the YAQMC GitHub organization; not a signature. */
  organizationOwned: boolean;
  stars: number;
  license: string | null;
  topics: string[];
  archived: boolean;
  fork: boolean;
  updatedAt: string | null;
  pushedAt: string | null;
}
export interface PluginStoreSearchPage {
  query: string;
  page: number;
  totalCount: number;
  incompleteResults: boolean;
  hasMore: boolean;
  items: PluginStoreRepository[];
  stale: boolean;
  fetchedAtMs: number;
}
export interface PluginStoreReleasesRequest {
  owner: string;
  repo: string;
  includePrereleases?: boolean;
  page?: number;
  refresh?: boolean;
}
export interface PluginStoreAsset {
  id: number;
  name: string;
  size: number;
  downloadCount: number;
  updatedAt: string | null;
  sha256: string | null;
}
export interface PluginStoreRelease {
  id: number;
  tagName: string;
  name: string | null;
  body: string | null;
  publishedAt: string | null;
  prerelease: boolean;
  htmlUrl: string;
  assets: PluginStoreAsset[];
  otherAssetCount: number;
}
export interface PluginStoreReleasesPage {
  owner: string;
  repo: string;
  page: number;
  hasMore: boolean;
  releases: PluginStoreRelease[];
  hiddenPrereleases: number;
  stale: boolean;
  fetchedAtMs: number;
}
export interface PluginStoreAssetRef {
  owner: string;
  repo: string;
  releaseId: number;
  assetId: number;
}
