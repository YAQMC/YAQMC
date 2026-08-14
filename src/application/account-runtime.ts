import { useEffect } from 'react';
import { create } from 'zustand';
import type {
  AccountLoginMethod,
  AccountPlaylistDetail,
  AccountPlaylistSummary,
  AccountSnapshot,
  CollectPlaylistRequest,
  CreatePlaylistRequest,
  DeletePlaylistRequest,
  EntityId,
  Page,
  Playlist,
  PlaylistMutationResult,
  PlaylistTrackMutationRequest,
  RemotePlayHistoryItem,
  RenamePlaylistRequest,
  Song,
} from '../domain/music';
import { ProviderError } from '../domain/music';
import {
  isAccountMusicProvider,
  type AccountMusicProvider,
  type MusicProvider,
} from '../providers/music-provider';

export type AccountRuntimeError =
  'network' | 'authorization' | 'secure-store' | 'protocol' | 'unknown';

export type LibraryResourceError =
  | 'network'
  | 'protocol'
  | 'unsupported'
  | 'unavailable'
  | 'unknown';

interface LoadedLibraryResource<T> {
  data: T;
  nextCursor: string | null;
  total: number | null;
  fetchedAtMs: number;
  authRevision: number;
}

export type LibraryResource<T> =
  | { status: 'idle' }
  | {
      status: 'loading';
      data: T | null;
      nextCursor: string | null;
      requestedCursor: string | null;
    }
  | ({ status: 'ready' } & LoadedLibraryResource<T>)
  | { status: 'empty' }
  | ({ status: 'stale' } & Omit<LoadedLibraryResource<T>, 'nextCursor'>)
  | { status: 'account-required' }
  | { status: 'reauthentication-required' }
  | {
      status: 'error';
      error: LibraryResourceError;
      data: T | null;
      nextCursor: string | null;
    };

export type AccountListResource = 'favorites' | 'playlists' | 'recent';

export const FAVORITE_RECONCILED_MESSAGE =
  'The server result was checked before the library was updated.';
export const FAVORITE_OUTCOME_UNKNOWN_MESSAGE =
  'The server could not confirm the library change. Refreshing Favorites.';

export type PlaylistMutationOperation =
  'create' | 'rename' | 'add' | 'remove' | 'delete' | 'collect' | 'uncollect';
export type PlaylistMutationOutcome = 'rejected' | 'outcome-unknown' | 'failed' | 'reconciled';

export interface PlaylistMutationNotice {
  operation: PlaylistMutationOperation;
  outcome: PlaylistMutationOutcome;
}

type OwnedSnapshot = Extract<
  AccountSnapshot,
  { state: 'starting-login' | 'waiting-for-scan' | 'waiting-for-confirmation' }
>;

interface AccountStoreState {
  snapshot: AccountSnapshot;
  displayedQrImageDataUri: string | null;
  dialogOpen: boolean;
  busy: boolean;
  error: AccountRuntimeError | null;
  favorites: LibraryResource<Song[]>;
  playlists: LibraryResource<AccountPlaylistSummary[]>;
  recent: LibraryResource<RemotePlayHistoryItem[]>;
  accountPlaylistDetails: Record<EntityId, LibraryResource<AccountPlaylistDetail>>;
  favoriteByTrackId: Record<EntityId, boolean>;
  favoritePendingByTrackId: Record<EntityId, string>;
  playlistPendingById: Record<EntityId, string>;
  playlistMutationNoticeById: Record<EntityId, PlaylistMutationNotice>;
  mutationMessage: string | null;
  openDialog: () => void;
  closeDialog: (provider: AccountMusicProvider) => Promise<void>;
  refreshSnapshot: (provider: AccountMusicProvider) => Promise<void>;
  startLogin: (provider: AccountMusicProvider, method: AccountLoginMethod) => Promise<void>;
  heartbeatLogin: (provider: AccountMusicProvider) => Promise<void>;
  refreshQr: (provider: AccountMusicProvider) => Promise<void>;
  cancelLogin: (provider: AccountMusicProvider) => Promise<void>;
  signOut: (provider: AccountMusicProvider) => Promise<void>;
  loadFavorites: (provider: AccountMusicProvider, reset?: boolean) => Promise<void>;
  loadPlaylists: (provider: AccountMusicProvider, reset?: boolean) => Promise<void>;
  loadRecent: (provider: AccountMusicProvider, reset?: boolean) => Promise<void>;
  loadNext: (provider: AccountMusicProvider, resource: AccountListResource) => Promise<void>;
  loadAccountPlaylist: (
    provider: AccountMusicProvider,
    playlist: AccountPlaylistSummary,
    reset?: boolean,
  ) => Promise<void>;
  loadNextAccountPlaylist: (
    provider: AccountMusicProvider,
    playlist: AccountPlaylistSummary,
  ) => Promise<void>;
  setFavorite: (provider: AccountMusicProvider, track: Song, favorite: boolean) => Promise<void>;
  createPlaylist: (
    provider: AccountMusicProvider,
    title: string,
  ) => Promise<PlaylistMutationResult | null>;
  renamePlaylist: (
    provider: AccountMusicProvider,
    playlist: AccountPlaylistSummary,
    title: string,
  ) => Promise<PlaylistMutationResult | null>;
  addPlaylistTrack: (
    provider: AccountMusicProvider,
    playlist: AccountPlaylistSummary,
    track: Song,
  ) => Promise<PlaylistMutationResult | null>;
  removePlaylistTrack: (
    provider: AccountMusicProvider,
    playlist: AccountPlaylistSummary,
    track: Song,
  ) => Promise<PlaylistMutationResult | null>;
  deletePlaylist: (
    provider: AccountMusicProvider,
    playlist: AccountPlaylistSummary,
  ) => Promise<PlaylistMutationResult | null>;
  setPlaylistCollected: (
    provider: AccountMusicProvider,
    playlist: Playlist,
    collected: boolean,
  ) => Promise<PlaylistMutationResult | null>;
}

const initialSnapshot: AccountSnapshot = {
  state: 'guest',
  profile: null,
  entitlement: null,
  revision: 0,
  capabilities: {
    qrLogin: false,
    favoriteRead: false,
    favoriteWrite: false,
    playlistRead: false,
    playlistWrite: false,
    recentHistoryRead: false,
  },
};

let requestGeneration = 0;
let snapshotTimer: number | null = null;
let heartbeatTimer: number | null = null;
let timerOwnerKey: string | null = null;
let timerPollAfterMs: number | null = null;
const RESTORE_POLL_AFTER_MS = 500;
let runtimeProvider: AccountMusicProvider | null = null;
let runtimeAbortController: AbortController | null = null;
const blockedAttempts = new Set<string>();
const cancellationRequests = new Map<string, Promise<AccountSnapshot>>();
const libraryGenerations: Record<AccountListResource, number> = {
  favorites: 0,
  playlists: 0,
  recent: 0,
};
const accountPlaylistGenerations = new Map<EntityId, number>();
let favoriteMutationVersion = 0;
const favoriteMutationVersionByTrackId = new Map<EntityId, number>();
const favoriteConfirmedGuardByTrackId = new Map<
  EntityId,
  { version: number; desired: boolean; track: Song }
>();

const idleResource = <T>(): LibraryResource<T> => ({ status: 'idle' });

function invalidateLibraryRequests(): void {
  libraryGenerations.favorites += 1;
  libraryGenerations.playlists += 1;
  libraryGenerations.recent += 1;
  for (const [id, generation] of accountPlaylistGenerations) {
    accountPlaylistGenerations.set(id, generation + 1);
  }
}

function resourceForSnapshot<T>(snapshot: AccountSnapshot): LibraryResource<T> {
  switch (snapshot.state) {
    case 'authenticated':
      return idleResource();
    case 'restoring-session':
    case 'starting-login':
    case 'waiting-for-scan':
    case 'waiting-for-confirmation':
      return { status: 'loading', data: null, nextCursor: null, requestedCursor: null };
    case 'session-expired':
    case 'reauthentication-required':
      return { status: 'reauthentication-required' };
    case 'secure-store-unavailable':
      return { status: 'error', error: 'unknown', data: null, nextCursor: null };
    case 'network-error':
      return { status: 'error', error: 'network', data: null, nextCursor: null };
    case 'protocol-error':
      return { status: 'error', error: 'protocol', data: null, nextCursor: null };
    case 'guest':
    case 'cancelled':
    case 'expired':
    case 'rejected':
      return { status: 'account-required' };
  }
}

function libraryResetForSnapshot(snapshot: AccountSnapshot) {
  invalidateLibraryRequests();
  accountPlaylistGenerations.clear();
  favoriteMutationVersion = 0;
  favoriteMutationVersionByTrackId.clear();
  favoriteConfirmedGuardByTrackId.clear();
  return {
    favorites: resourceForSnapshot<Song[]>(snapshot),
    playlists: resourceForSnapshot<AccountPlaylistSummary[]>(snapshot),
    recent: resourceForSnapshot<RemotePlayHistoryItem[]>(snapshot),
    accountPlaylistDetails: {} as Record<EntityId, LibraryResource<AccountPlaylistDetail>>,
    favoriteByTrackId: {} as Record<EntityId, boolean>,
    favoritePendingByTrackId: {} as Record<EntityId, string>,
    playlistPendingById: {} as Record<EntityId, string>,
    playlistMutationNoticeById: {} as Record<EntityId, PlaylistMutationNotice>,
    mutationMessage: null,
  };
}

function mutationOperationId(prefix = 'mutation'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function withoutKey<T>(record: Record<EntityId, T>, key: EntityId): Record<EntityId, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

function ownedSnapshot(snapshot: AccountSnapshot): OwnedSnapshot | null {
  return snapshot.state === 'starting-login' ||
    snapshot.state === 'waiting-for-scan' ||
    snapshot.state === 'waiting-for-confirmation'
    ? snapshot
    : null;
}

function safeQrImage(value: string): string | null {
  return value.length <= 350_000 &&
    /^data:image\/(?:png|jpeg);base64,[a-z0-9+/]+={0,2}$/i.test(value)
    ? value
    : null;
}

function runtimeSignal(provider: AccountMusicProvider): AbortSignal | undefined {
  return runtimeProvider === provider ? runtimeAbortController?.signal : undefined;
}

function clearOwnershipTimers(): void {
  if (snapshotTimer !== null) window.clearInterval(snapshotTimer);
  if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer);
  snapshotTimer = null;
  heartbeatTimer = null;
  timerOwnerKey = null;
  timerPollAfterMs = null;
}

function classifyError(error: unknown): AccountRuntimeError {
  const code =
    error instanceof ProviderError
      ? error.code
      : error && typeof error === 'object' && 'code' in error
        ? String((error as { code: unknown }).code)
        : null;
  if (code === 'offline' || code === 'timeout' || code === 'rate-limited') return 'network';
  if (code === 'authentication-expired' || code === 'authorization-rejected') {
    return 'authorization';
  }
  if (code === 'storage-failure') return 'secure-store';
  if (code === 'schema-changed' || code === 'malformed-response') return 'protocol';
  return 'unknown';
}

function commitSnapshot(snapshot: AccountSnapshot): void {
  const owner = ownedSnapshot(snapshot);
  if (owner) blockedAttempts.delete(owner.attemptId);
  if (!owner && 'attemptId' in snapshot && snapshot.attemptId) {
    blockedAttempts.delete(snapshot.attemptId);
    cancellationRequests.delete(snapshot.attemptId);
  }
  const currentStore = useAccountStore.getState();
  const dialogOpen = currentStore.dialogOpen;
  const displayedQrImageDataUri =
    dialogOpen && snapshot.state === 'waiting-for-scan'
      ? safeQrImage(snapshot.qrImageDataUri)
      : null;
  useAccountStore.setState({
    snapshot,
    displayedQrImageDataUri,
    busy: false,
    error:
      snapshot.state === 'waiting-for-scan' && displayedQrImageDataUri === null ? 'protocol' : null,
    ...(currentStore.snapshot.revision !== snapshot.revision ||
    currentStore.snapshot.state !== snapshot.state
      ? libraryResetForSnapshot(snapshot)
      : {}),
  });
}

function cancellationRequest(
  provider: AccountMusicProvider,
  id: string,
  signal: AbortSignal | undefined,
): Promise<AccountSnapshot> {
  const existing = cancellationRequests.get(id);
  if (existing) return existing;
  const request = provider.cancelQrLogin(id, signal);
  cancellationRequests.set(id, request);
  return request;
}

async function releaseUncommittedOwnership(
  provider: AccountMusicProvider,
  snapshot: AccountSnapshot,
): Promise<void> {
  const owner = ownedSnapshot(snapshot);
  if (!owner) return;
  const currentOwner = ownedSnapshot(useAccountStore.getState().snapshot);
  if (
    currentOwner?.attemptId === owner.attemptId &&
    currentOwner.ownerLeaseId === owner.ownerLeaseId
  ) {
    return;
  }
  blockedAttempts.add(owner.attemptId);
  try {
    await cancellationRequest(provider, owner.attemptId, undefined);
  } catch {
    // Native owner expiry remains the final cleanup boundary if cancellation fails.
  }
}

function reconcileOwnershipTimers(provider: AccountMusicProvider): void {
  const { dialogOpen, snapshot } = useAccountStore.getState();
  if (snapshot.state === 'restoring-session') {
    if (
      snapshotTimer !== null &&
      heartbeatTimer === null &&
      timerOwnerKey === 'restoring-session' &&
      timerPollAfterMs === RESTORE_POLL_AFTER_MS
    ) {
      return;
    }
    clearOwnershipTimers();
    timerOwnerKey = 'restoring-session';
    timerPollAfterMs = RESTORE_POLL_AFTER_MS;
    snapshotTimer = window.setInterval(() => {
      void useAccountStore.getState().refreshSnapshot(provider);
    }, RESTORE_POLL_AFTER_MS);
    return;
  }
  const owner = ownedSnapshot(snapshot);
  if (!dialogOpen || !owner || blockedAttempts.has(owner.attemptId)) {
    clearOwnershipTimers();
    return;
  }

  const pollAfterMs = Math.min(2_000, Math.max(1_500, owner.pollAfterMs));
  const ownerKey = `${owner.attemptId}\u0000${owner.ownerLeaseId}`;
  if (
    snapshotTimer !== null &&
    heartbeatTimer !== null &&
    timerOwnerKey === ownerKey &&
    timerPollAfterMs === pollAfterMs
  ) {
    return;
  }
  clearOwnershipTimers();
  timerOwnerKey = ownerKey;
  timerPollAfterMs = pollAfterMs;
  snapshotTimer = window.setInterval(() => {
    void useAccountStore.getState().refreshSnapshot(provider);
  }, pollAfterMs);
  heartbeatTimer = window.setInterval(() => {
    void useAccountStore.getState().heartbeatLogin(provider);
  }, 2_000);
}

function hydrateAuthenticatedFavoriteAuthority(provider: AccountMusicProvider): void {
  const state = useAccountStore.getState();
  if (
    state.snapshot.state === 'authenticated' &&
    state.snapshot.capabilities.favoriteRead &&
    state.favorites.status === 'idle'
  ) {
    void state.loadFavorites(provider, true);
  }
}

async function runSnapshotRequest(
  provider: AccountMusicProvider,
  request: (signal?: AbortSignal) => Promise<AccountSnapshot>,
  busy: boolean,
  onStale?: (snapshot: AccountSnapshot) => Promise<void> | void,
): Promise<void> {
  const generation = ++requestGeneration;
  if (busy) useAccountStore.setState({ busy: true, error: null });
  try {
    const next = await request(runtimeSignal(provider));
    if (generation !== requestGeneration) {
      await onStale?.(next);
      return;
    }
    commitSnapshot(next);
  } catch (error) {
    if (generation !== requestGeneration) return;
    if (error instanceof DOMException && error.name === 'AbortError') return;
    useAccountStore.setState({ busy: false, error: classifyError(error) });
  }
}

async function cancelOwnedAttempt(
  provider: AccountMusicProvider,
  closeDialog: boolean,
): Promise<void> {
  const current = useAccountStore.getState().snapshot;
  const id = ownedSnapshot(current)?.attemptId ?? null;
  const generation = ++requestGeneration;
  clearOwnershipTimers();
  if (id) blockedAttempts.add(id);
  useAccountStore.setState({
    displayedQrImageDataUri: null,
    dialogOpen: closeDialog ? false : useAccountStore.getState().dialogOpen,
    busy: Boolean(id) && !closeDialog,
    error: null,
  });
  if (!id) return;
  try {
    const next = await cancellationRequest(provider, id, runtimeSignal(provider));
    if (generation !== requestGeneration) return;
    commitSnapshot(next);
  } catch (error) {
    if (generation !== requestGeneration) return;
    if (error instanceof DOMException && error.name === 'AbortError') return;
    useAccountStore.setState({ busy: false, error: classifyError(error) });
  }
}

function disposeOwnership(provider: AccountMusicProvider): void {
  const snapshot = useAccountStore.getState().snapshot;
  const id = ownedSnapshot(snapshot)?.attemptId ?? null;
  ++requestGeneration;
  clearOwnershipTimers();
  if (id) {
    blockedAttempts.add(id);
    void cancellationRequest(provider, id, undefined).catch(() => undefined);
  }
  useAccountStore.setState({
    displayedQrImageDataUri: null,
    dialogOpen: false,
    busy: false,
  });
}

function listResource<T>(resource: AccountListResource): LibraryResource<T[]> {
  return useAccountStore.getState()[resource] as LibraryResource<T[]>;
}

function publishListResource<T>(resource: AccountListResource, value: LibraryResource<T[]>): void {
  if (resource === 'favorites') {
    useAccountStore.setState({ favorites: value as LibraryResource<Song[]> });
  } else if (resource === 'playlists') {
    useAccountStore.setState({
      playlists: value as LibraryResource<AccountPlaylistSummary[]>,
    });
  } else {
    useAccountStore.setState({
      recent: value as LibraryResource<RemotePlayHistoryItem[]>,
    });
  }
}

function loadedData<T>(resource: LibraryResource<T>): T | null {
  if (resource.status === 'ready' || resource.status === 'stale') return resource.data;
  if (resource.status === 'loading' || resource.status === 'error') return resource.data;
  return null;
}

function nextCursor<T>(resource: LibraryResource<T>): string | null {
  if (resource.status === 'ready') return resource.nextCursor;
  if (resource.status === 'error' && resource.data !== null) return resource.nextCursor;
  return null;
}

function mergeFirstSeen<T>(base: T[], incoming: T[], keyOf: (item: T) => EntityId): T[] {
  const seen = new Set(base.map(keyOf));
  const merged = [...base];
  for (const item of incoming) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function projectFavoritePage(songs: Song[], replace: boolean, requestVersion: number): void {
  const returned = new Set(songs.map((song) => song.id));
  useAccountStore.setState((state) => {
    const favoriteByTrackId = { ...state.favoriteByTrackId };
    const ids = new Set([...Object.keys(favoriteByTrackId), ...returned]);
    for (const id of ids) {
      const guard = favoriteConfirmedGuardByTrackId.get(id);
      const observed = returned.has(id);
      if (guard) {
        favoriteByTrackId[id] = guard.desired;
        continue;
      }
      if ((favoriteMutationVersionByTrackId.get(id) ?? 0) > requestVersion) continue;
      if (observed) favoriteByTrackId[id] = true;
      else if (replace) favoriteByTrackId[id] = false;
    }
    return { favoriteByTrackId };
  });
}

function reconcileConfirmedFavoriteSongs(songs: Song[]): Song[] {
  let reconciled = [...songs];
  for (const [id, guard] of favoriteConfirmedGuardByTrackId) {
    const observed = reconciled.some((song) => song.id === id);
    if (observed === guard.desired) {
      favoriteConfirmedGuardByTrackId.delete(id);
    } else if (guard.desired) {
      reconciled = mergeFirstSeen(reconciled, [guard.track], (song) => song.id);
    } else {
      reconciled = reconciled.filter((song) => song.id !== id);
    }
  }
  return reconciled;
}

function confirmedFavoritesResource(
  resource: LibraryResource<Song[]>,
  track: Song,
  favorite: boolean,
  authRevision: number,
): LibraryResource<Song[]> {
  const data = loadedData(resource);
  if (!data) {
    if (!favorite) return resource.status === 'empty' ? resource : { status: 'empty' };
    return {
      status: 'ready',
      data: [track],
      nextCursor: null,
      total: 1,
      fetchedAtMs: Date.now(),
      authRevision,
    };
  }
  const nextData = favorite
    ? mergeFirstSeen(data, [track], (song) => song.id)
    : data.filter((song) => song.id !== track.id);
  if (resource.status === 'ready' || resource.status === 'stale') {
    return { ...resource, data: nextData };
  }
  if (resource.status === 'loading' || resource.status === 'error') {
    return { ...resource, data: nextData };
  }
  return resource;
}

function classifyLibraryFailure(
  error: unknown,
): LibraryResourceError | 'cancelled' | 'reauthentication-required' {
  if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
  const code =
    error instanceof ProviderError
      ? error.code
      : error && typeof error === 'object' && 'code' in error
        ? String((error as { code: unknown }).code)
        : null;
  if (code === 'cancelled') return 'cancelled';
  if (code === 'authentication-expired' || code === 'authorization-rejected') {
    return 'reauthentication-required';
  }
  if (code === 'offline' || code === 'timeout' || code === 'rate-limited') return 'network';
  if (code === 'unavailable') return 'unavailable';
  if (
    code === 'schema-changed' ||
    code === 'malformed-response' ||
    code === 'invalid-playlist-identifier'
  ) {
    return 'protocol';
  }
  if (code === 'unsupported-operation' || code === 'unsupported-account-collection') {
    return 'unsupported';
  }
  return 'unknown';
}

function canCommitListResult(
  resource: AccountListResource,
  generation: number,
  revision: number,
  requestedCursor: string | null,
): boolean {
  const snapshot = useAccountStore.getState().snapshot;
  const current = listResource(resource);
  return (
    libraryGenerations[resource] === generation &&
    snapshot.state === 'authenticated' &&
    snapshot.revision === revision &&
    current.status === 'loading' &&
    current.requestedCursor === requestedCursor
  );
}

async function loadPagedList<T>(options: {
  provider: AccountMusicProvider;
  resource: AccountListResource;
  reset: boolean;
  capability: 'favoriteRead' | 'playlistRead' | 'recentHistoryRead';
  request: (cursor: string | undefined, signal?: AbortSignal) => Promise<Page<T>>;
  keyOf: (item: T) => EntityId;
}): Promise<void> {
  const { provider, resource, reset, capability, request, keyOf } = options;
  const snapshot = useAccountStore.getState().snapshot;
  if (snapshot.state !== 'authenticated') {
    publishListResource(resource, resourceForSnapshot<T[]>(snapshot));
    return;
  }
  if (!snapshot.capabilities[capability]) {
    publishListResource(resource, {
      status: 'error',
      error: 'unsupported',
      data: null,
      nextCursor: null,
    });
    return;
  }

  const previous = listResource<T>(resource);
  if (previous.status === 'loading') return;
  const visibleData = loadedData(previous) ?? [];
  const previousData = reset ? [] : visibleData;
  const requestedCursor = reset ? null : nextCursor(previous);
  if (!reset && requestedCursor === null) return;
  const revision = snapshot.revision;
  const generation = ++libraryGenerations[resource];
  const favoriteVersionAtRequest = favoriteMutationVersion;
  publishListResource(resource, {
    status: 'loading',
    data: visibleData.length > 0 ? visibleData : null,
    nextCursor: requestedCursor,
    requestedCursor,
  });

  try {
    const page = await request(requestedCursor ?? undefined, runtimeSignal(provider));
    if (
      !canCommitListResult(resource, generation, revision, requestedCursor) ||
      page.authRevision !== revision
    ) {
      return;
    }
    let data = mergeFirstSeen(previousData, page.items, keyOf);
    if (resource === 'favorites') {
      data = reconcileConfirmedFavoriteSongs(data as Song[]) as T[];
    }
    if (data.length === 0 && page.nextCursor === null) {
      publishListResource(resource, { status: 'empty' });
    } else if (page.stale) {
      publishListResource(resource, {
        status: 'stale',
        data,
        total: page.total,
        fetchedAtMs: page.fetchedAtMs,
        authRevision: page.authRevision,
      });
    } else {
      publishListResource(resource, {
        status: 'ready',
        data,
        nextCursor: page.nextCursor,
        total: page.total,
        fetchedAtMs: page.fetchedAtMs,
        authRevision: page.authRevision,
      });
    }
    if (resource === 'favorites') {
      projectFavoritePage(data as Song[], page.nextCursor === null, favoriteVersionAtRequest);
    }
  } catch (error) {
    if (!canCommitListResult(resource, generation, revision, requestedCursor)) return;
    const failure = classifyLibraryFailure(error);
    if (failure === 'cancelled') {
      publishListResource(resource, previous);
    } else if (failure === 'reauthentication-required') {
      publishListResource(resource, { status: 'reauthentication-required' });
    } else {
      publishListResource(resource, {
        status: 'error',
        error: failure,
        data: visibleData.length > 0 ? visibleData : null,
        nextCursor: requestedCursor,
      });
    }
  }
}

function setAccountPlaylistResource(
  id: EntityId,
  resource: LibraryResource<AccountPlaylistDetail>,
): void {
  useAccountStore.setState((state) => ({
    accountPlaylistDetails: { ...state.accountPlaylistDetails, [id]: resource },
  }));
}

function canCommitAccountPlaylist(
  id: EntityId,
  generation: number,
  revision: number,
  requestedCursor: string | null,
): boolean {
  const state = useAccountStore.getState();
  const current = state.accountPlaylistDetails[id];
  return (
    accountPlaylistGenerations.get(id) === generation &&
    state.snapshot.state === 'authenticated' &&
    state.snapshot.revision === revision &&
    current?.status === 'loading' &&
    current.requestedCursor === requestedCursor
  );
}

async function loadAccountPlaylistResource(
  provider: AccountMusicProvider,
  playlist: AccountPlaylistSummary,
  reset: boolean,
): Promise<void> {
  const id = playlist.id;
  const snapshot = useAccountStore.getState().snapshot;
  if (snapshot.state !== 'authenticated') {
    setAccountPlaylistResource(id, resourceForSnapshot(snapshot));
    return;
  }
  if (!snapshot.capabilities.playlistRead) {
    setAccountPlaylistResource(id, {
      status: 'error',
      error: 'unsupported',
      data: null,
      nextCursor: null,
    });
    return;
  }
  const previous = useAccountStore.getState().accountPlaylistDetails[id] ?? idleResource();
  if (previous.status === 'loading') return;
  const visibleDetail = loadedData(previous);
  const mergeBase = reset ? null : visibleDetail;
  const requestedCursor = reset ? null : nextCursor(previous);
  if (!reset && requestedCursor === null) return;
  const revision = snapshot.revision;
  const favoriteRequestVersion = favoriteMutationVersion;
  const generation = (accountPlaylistGenerations.get(id) ?? 0) + 1;
  accountPlaylistGenerations.set(id, generation);
  setAccountPlaylistResource(id, {
    status: 'loading',
    data: visibleDetail,
    nextCursor: requestedCursor,
    requestedCursor,
  });

  try {
    const detail = await provider.getAccountPlaylistTracks(
      playlist,
      requestedCursor ?? undefined,
      100,
      runtimeSignal(provider),
    );
    if (
      !canCommitAccountPlaylist(id, generation, revision, requestedCursor) ||
      detail.tracks.authRevision !== revision
    ) {
      return;
    }
    if (detail.summary.ownership === 'favorite') {
      projectFavoritePage(detail.tracks.items, false, favoriteRequestVersion);
    }
    const tracks = mergeFirstSeen(
      mergeBase?.tracks.items ?? [],
      detail.tracks.items,
      (song) => song.id,
    );
    const merged: AccountPlaylistDetail = {
      summary: detail.summary,
      tracks: { ...detail.tracks, items: tracks },
    };
    const loaded: LoadedLibraryResource<AccountPlaylistDetail> = {
      data: merged,
      nextCursor: detail.tracks.nextCursor,
      total: detail.tracks.total,
      fetchedAtMs: detail.tracks.fetchedAtMs,
      authRevision: detail.tracks.authRevision,
    };
    if (detail.tracks.stale) {
      setAccountPlaylistResource(id, {
        status: 'stale',
        data: loaded.data,
        total: loaded.total,
        fetchedAtMs: loaded.fetchedAtMs,
        authRevision: loaded.authRevision,
      });
    } else {
      setAccountPlaylistResource(id, { status: 'ready', ...loaded });
    }
  } catch (error) {
    if (!canCommitAccountPlaylist(id, generation, revision, requestedCursor)) return;
    const failure = classifyLibraryFailure(error);
    if (failure === 'cancelled') {
      setAccountPlaylistResource(id, previous);
    } else if (failure === 'reauthentication-required') {
      setAccountPlaylistResource(id, { status: 'reauthentication-required' });
    } else {
      setAccountPlaylistResource(id, {
        status: 'error',
        error: failure,
        data: visibleDetail,
        nextCursor: requestedCursor,
      });
    }
  }
}

export function accountPlaylistDetailToPlaylist(detail: AccountPlaylistDetail): Playlist {
  return {
    id: detail.summary.id,
    title: detail.summary.title,
    description: detail.summary.description,
    owner: detail.summary.owner,
    artwork: detail.summary.artwork,
    updatedLabel:
      detail.summary.updatedAtMs === null || detail.summary.updatedAtMs === 0
        ? 'QQ Music'
        : String(new Date(detail.summary.updatedAtMs).getUTCFullYear()),
    tracks: detail.tracks.items,
  };
}

export const useAccountStore = create<AccountStoreState>((set, get) => ({
  snapshot: initialSnapshot,
  displayedQrImageDataUri: null,
  dialogOpen: false,
  busy: false,
  error: null,
  favorites: idleResource(),
  playlists: idleResource(),
  recent: idleResource(),
  accountPlaylistDetails: {},
  favoriteByTrackId: {},
  favoritePendingByTrackId: {},
  playlistPendingById: {},
  playlistMutationNoticeById: {},
  mutationMessage: null,
  openDialog: () => {
    const snapshot = get().snapshot;
    const owner = ownedSnapshot(snapshot);
    set({
      dialogOpen: true,
      error: null,
      displayedQrImageDataUri:
        owner?.state === 'waiting-for-scan' && !blockedAttempts.has(owner.attemptId)
          ? safeQrImage(owner.qrImageDataUri)
          : null,
    });
  },
  closeDialog: (provider) => cancelOwnedAttempt(provider, true),
  refreshSnapshot: (provider) =>
    runSnapshotRequest(provider, (signal) => provider.getAccountSnapshot(signal), false),
  startLogin: async (provider, method) => {
    set({ dialogOpen: true, displayedQrImageDataUri: null });
    await runSnapshotRequest(
      provider,
      (signal) => provider.startWebLogin(method, signal),
      true,
      (snapshot) => releaseUncommittedOwnership(provider, snapshot),
    );
  },
  heartbeatLogin: async (provider) => {
    const owner = ownedSnapshot(get().snapshot);
    if (!owner || blockedAttempts.has(owner.attemptId)) return;
    const generation = ++requestGeneration;
    try {
      const next = await provider.heartbeatQrLogin(
        owner.attemptId,
        owner.ownerLeaseId,
        runtimeSignal(provider),
      );
      if (generation !== requestGeneration) return;
      commitSnapshot(next);
    } catch (error) {
      if (generation !== requestGeneration) return;
      clearOwnershipTimers();
      blockedAttempts.add(owner.attemptId);
      set({ displayedQrImageDataUri: null, busy: false });
      try {
        const reconciled = await provider.getAccountSnapshot(runtimeSignal(provider));
        if (generation !== requestGeneration) return;
        const reconciledOwner = ownedSnapshot(reconciled);
        if (
          !reconciledOwner ||
          reconciledOwner.attemptId !== owner.attemptId ||
          reconciledOwner.ownerLeaseId !== owner.ownerLeaseId
        ) {
          commitSnapshot(reconciled);
          return;
        }
      } catch {
        if (generation !== requestGeneration) return;
      }
      set({ error: classifyError(error) });
      try {
        const next = await cancellationRequest(provider, owner.attemptId, runtimeSignal(provider));
        if (generation === requestGeneration) commitSnapshot(next);
      } catch {
        // The stable local error above is sufficient; cancellation is best effort.
      }
    }
  },
  refreshQr: async (provider) => {
    const snapshot = get().snapshot;
    if (snapshot.state !== 'expired') return;
    const previousAttemptId = snapshot.attemptId;
    if (previousAttemptId) blockedAttempts.add(previousAttemptId);
    clearOwnershipTimers();
    set({ dialogOpen: true, displayedQrImageDataUri: null });
    await runSnapshotRequest(
      provider,
      (signal) => provider.refreshQrLogin(previousAttemptId, signal),
      true,
      (next) => releaseUncommittedOwnership(provider, next),
    );
  },
  cancelLogin: (provider) => cancelOwnedAttempt(provider, false),
  signOut: async (provider) => {
    clearOwnershipTimers();
    set({ dialogOpen: false, displayedQrImageDataUri: null });
    await runSnapshotRequest(provider, (signal) => provider.signOut(signal), true);
  },
  loadFavorites: (provider, reset = true) =>
    loadPagedList({
      provider,
      resource: 'favorites',
      reset,
      capability: 'favoriteRead',
      request: (cursor, signal) => provider.getFavoriteSongs(cursor, 100, signal),
      keyOf: (song) => song.id,
    }),
  loadPlaylists: (provider, reset = true) =>
    loadPagedList({
      provider,
      resource: 'playlists',
      reset,
      capability: 'playlistRead',
      request: (cursor, signal) => provider.getAccountPlaylists(cursor, 100, signal),
      keyOf: (playlist) => playlist.id,
    }),
  loadRecent: (provider, reset = true) =>
    loadPagedList({
      provider,
      resource: 'recent',
      reset,
      capability: 'recentHistoryRead',
      request: (cursor, signal) => provider.getAccountRecentlyPlayed(cursor, 100, signal),
      keyOf: (item) => item.song.id,
    }),
  loadNext: (provider, resource) => {
    if (resource === 'favorites') return get().loadFavorites(provider, false);
    if (resource === 'playlists') return get().loadPlaylists(provider, false);
    return get().loadRecent(provider, false);
  },
  loadAccountPlaylist: (provider, playlist, reset = true) =>
    loadAccountPlaylistResource(provider, playlist, reset),
  loadNextAccountPlaylist: (provider, playlist) =>
    loadAccountPlaylistResource(provider, playlist, false),
  setFavorite: async (provider, track, favorite) => {
    const initial = get();
    if (initial.snapshot.state !== 'authenticated') {
      initial.openDialog();
      return;
    }
    if (!initial.snapshot.capabilities.favoriteWrite) {
      set({ mutationMessage: 'This account cannot change Favorites.' });
      return;
    }
    if (initial.favoritePendingByTrackId[track.id]) return;

    const revision = initial.snapshot.revision;
    const previous = initial.favoriteByTrackId[track.id] ?? track.isFavorite;
    const operationId = mutationOperationId('favorite');
    const mutationVersion = ++favoriteMutationVersion;
    favoriteMutationVersionByTrackId.set(track.id, mutationVersion);
    favoriteConfirmedGuardByTrackId.set(track.id, {
      version: mutationVersion,
      desired: favorite,
      track,
    });
    set((state) => ({
      favoriteByTrackId: { ...state.favoriteByTrackId, [track.id]: favorite },
      favoritePendingByTrackId: {
        ...state.favoritePendingByTrackId,
        [track.id]: operationId,
      },
      mutationMessage: null,
    }));

    let result;
    try {
      result = await provider.setFavorite(
        {
          trackId: track.id,
          favorite,
          clientOperationId: operationId,
        },
        runtimeSignal(provider),
      );
    } catch (error) {
      const current = get();
      if (current.favoritePendingByTrackId[track.id] !== operationId) return;
      const pending = withoutKey(current.favoritePendingByTrackId, track.id);
      if (current.snapshot.revision !== revision) {
        set({ favoritePendingByTrackId: pending });
        return;
      }
      const failure = classifyLibraryFailure(error);
      if (favoriteMutationVersionByTrackId.get(track.id) === mutationVersion) {
        favoriteConfirmedGuardByTrackId.delete(track.id);
      }
      set({
        favoriteByTrackId: { ...current.favoriteByTrackId, [track.id]: previous },
        favoritePendingByTrackId: pending,
        favorites:
          failure === 'reauthentication-required'
            ? { status: 'reauthentication-required' }
            : current.favorites,
        mutationMessage:
          failure === 'reauthentication-required'
            ? 'Your QQ Music session expired before Favorites could be updated.'
            : 'Favorites could not be updated.',
      });
      if (failure === 'reauthentication-required') {
        void get().refreshSnapshot(provider);
      }
      return;
    }

    const current = get();
    if (current.favoritePendingByTrackId[track.id] !== operationId) return;
    const pending = withoutKey(current.favoritePendingByTrackId, track.id);
    if (
      current.snapshot.revision !== revision ||
      result.authRevision !== revision ||
      result.clientOperationId !== operationId ||
      result.trackId !== track.id
    ) {
      set({ favoritePendingByTrackId: pending });
      return;
    }

    if (result.status === 'rejected') {
      if (favoriteMutationVersionByTrackId.get(track.id) === mutationVersion) {
        favoriteConfirmedGuardByTrackId.delete(track.id);
      }
      set({
        favoriteByTrackId: { ...current.favoriteByTrackId, [track.id]: previous },
        favoritePendingByTrackId: pending,
        mutationMessage: 'QQ Music rejected the Favorites change.',
      });
      return;
    }
    if (result.status === 'outcome-unknown') {
      if (favoriteMutationVersionByTrackId.get(track.id) === mutationVersion) {
        favoriteConfirmedGuardByTrackId.delete(track.id);
      }
      set({
        favoritePendingByTrackId: pending,
        mutationMessage: FAVORITE_OUTCOME_UNKNOWN_MESSAGE,
      });
      void get().loadFavorites(provider, true);
      return;
    }
    if (favoriteMutationVersionByTrackId.get(track.id) === mutationVersion) {
      favoriteConfirmedGuardByTrackId.set(track.id, {
        version: mutationVersion,
        desired: result.favorite,
        track,
      });
    }
    set({
      favoriteByTrackId: { ...current.favoriteByTrackId, [track.id]: result.favorite },
      favoritePendingByTrackId: pending,
      favorites: confirmedFavoritesResource(
        current.favorites,
        track,
        result.favorite,
        result.authRevision,
      ),
      mutationMessage: result.status === 'reconciled' ? FAVORITE_RECONCILED_MESSAGE : null,
    });
  },
  createPlaylist: (provider, title) => runCreatePlaylistMutation(provider, title),
  renamePlaylist: (provider, playlist, title) =>
    runEntityPlaylistMutation({ provider, playlist, operation: 'rename', title }),
  addPlaylistTrack: (provider, playlist, track) =>
    runEntityPlaylistMutation({ provider, playlist, operation: 'add', track }),
  removePlaylistTrack: (provider, playlist, track) =>
    runEntityPlaylistMutation({ provider, playlist, operation: 'remove', track }),
  deletePlaylist: (provider, playlist) =>
    runEntityPlaylistMutation({ provider, playlist, operation: 'delete' }),
  setPlaylistCollected: (provider, playlist, collected) =>
    runPlaylistCollectionMutation(provider, playlist, collected),
}));

function resourceWithData<T>(resource: LibraryResource<T>, data: T): LibraryResource<T> {
  if (
    resource.status === 'ready' ||
    resource.status === 'stale' ||
    resource.status === 'loading' ||
    resource.status === 'error'
  ) {
    return { ...resource, data };
  }
  return resource;
}

function replacePlaylistSummary(
  resource: LibraryResource<AccountPlaylistSummary[]>,
  playlistId: EntityId,
  summary: AccountPlaylistSummary | null,
): LibraryResource<AccountPlaylistSummary[]> {
  const data = loadedData(resource);
  if (!data) return resource;
  const index = data.findIndex((playlist) => playlist.id === playlistId);
  const next = summary
    ? index < 0
      ? [...data, summary]
      : data.map((playlist, candidate) => (candidate === index ? summary : playlist))
    : data.filter((playlist) => playlist.id !== playlistId);
  return resourceWithData(resource, next);
}

function updateDetailSummary(
  resource: LibraryResource<AccountPlaylistDetail> | undefined,
  summary: AccountPlaylistSummary,
): LibraryResource<AccountPlaylistDetail> | undefined {
  if (!resource) return resource;
  const detail = loadedData(resource);
  return detail ? resourceWithData(resource, { ...detail, summary }) : resource;
}

function projectPlaylistSummary(
  state: AccountStoreState,
  summary: AccountPlaylistSummary,
): Pick<AccountStoreState, 'playlists' | 'accountPlaylistDetails'> {
  const detail = updateDetailSummary(state.accountPlaylistDetails[summary.id], summary);
  return {
    playlists: replacePlaylistSummary(state.playlists, summary.id, summary),
    accountPlaylistDetails: detail
      ? { ...state.accountPlaylistDetails, [summary.id]: detail }
      : state.accountPlaylistDetails,
  };
}

function projectPlaylistTracks(
  state: AccountStoreState,
  playlist: AccountPlaylistSummary,
  track: Song,
  add: boolean,
): Pick<AccountStoreState, 'playlists' | 'accountPlaylistDetails'> {
  const resource = state.accountPlaylistDetails[playlist.id];
  const detail = resource ? loadedData(resource) : null;
  const previouslyContained = detail?.tracks.items.some((item) => item.id === track.id) ?? false;
  const changed = add ? !previouslyContained : previouslyContained;
  const summary = changed
    ? {
        ...playlist,
        trackCount: Math.max(0, playlist.trackCount + (add ? 1 : -1)),
      }
    : playlist;
  if (!resource || !detail) return projectPlaylistSummary(state, summary);
  const tracks = add
    ? mergeFirstSeen(detail.tracks.items, [track], (item) => item.id)
    : detail.tracks.items.filter((item) => item.id !== track.id);
  return {
    playlists: replacePlaylistSummary(state.playlists, playlist.id, summary),
    accountPlaylistDetails: {
      ...state.accountPlaylistDetails,
      [playlist.id]: resourceWithData(resource, {
        ...detail,
        summary,
        tracks: { ...detail.tracks, items: tracks, total: summary.trackCount },
      }),
    },
  };
}

function restorePlaylistEntity(
  state: AccountStoreState,
  playlistId: EntityId,
  previousSummary: AccountPlaylistSummary | null,
  previousDetail: LibraryResource<AccountPlaylistDetail> | undefined,
): Pick<AccountStoreState, 'playlists' | 'accountPlaylistDetails'> {
  const accountPlaylistDetails = { ...state.accountPlaylistDetails };
  if (previousDetail) accountPlaylistDetails[playlistId] = previousDetail;
  else delete accountPlaylistDetails[playlistId];
  return {
    playlists: replacePlaylistSummary(state.playlists, playlistId, previousSummary),
    accountPlaylistDetails,
  };
}

function collectedSummaryFromPlaylist(playlist: Playlist): AccountPlaylistSummary {
  return {
    id: playlist.id,
    reference: {
      kind: 'collected',
      tid: playlist.id.replace(/^qqmusic:playlist:/, ''),
    },
    title: playlist.title,
    description: playlist.description,
    owner: playlist.owner,
    artwork: playlist.artwork,
    ownership: 'collected',
    capabilities: {
      canAddTracks: false,
      canRemoveTracks: false,
      canRename: false,
      canDelete: false,
      canReorder: false,
    },
    trackCount: playlist.tracks.length,
    updatedAtMs: null,
  };
}

async function runPlaylistCollectionMutation(
  provider: AccountMusicProvider,
  playlist: Playlist,
  collected: boolean,
): Promise<PlaylistMutationResult | null> {
  const initial = useAccountStore.getState();
  if (initial.snapshot.state !== 'authenticated') {
    initial.openDialog();
    return null;
  }
  if (!initial.snapshot.capabilities.playlistWrite || initial.playlistPendingById[playlist.id]) {
    return null;
  }
  const operation: PlaylistMutationOperation = collected ? 'collect' : 'uncollect';
  const revision = initial.snapshot.revision;
  const operationId = mutationOperationId(`playlist-${operation}`);
  const previousSummary =
    loadedData(initial.playlists)?.find((item) => item.id === playlist.id) ?? null;
  const optimisticSummary = collected ? collectedSummaryFromPlaylist(playlist) : null;
  useAccountStore.setState((state) => ({
    playlists: replacePlaylistSummary(state.playlists, playlist.id, optimisticSummary),
    playlistPendingById: { ...state.playlistPendingById, [playlist.id]: operationId },
    playlistMutationNoticeById: withoutKey(state.playlistMutationNoticeById, playlist.id),
  }));

  const request: CollectPlaylistRequest = {
    playlistId: playlist.id,
    collected,
    clientOperationId: operationId,
  };
  let result: PlaylistMutationResult;
  try {
    result = await provider.setPlaylistCollected(request, runtimeSignal(provider));
  } catch (error) {
    const current = useAccountStore.getState();
    if (current.playlistPendingById[playlist.id] !== operationId) return null;
    const pending = withoutKey(current.playlistPendingById, playlist.id);
    useAccountStore.setState({
      playlists: replacePlaylistSummary(current.playlists, playlist.id, previousSummary),
      playlistPendingById: pending,
      playlistMutationNoticeById: {
        ...current.playlistMutationNoticeById,
        [playlist.id]: { operation, outcome: 'failed' },
      },
    });
    if (classifyLibraryFailure(error) === 'reauthentication-required') {
      void current.refreshSnapshot(provider);
    }
    return null;
  }

  const current = useAccountStore.getState();
  if (current.playlistPendingById[playlist.id] !== operationId) return null;
  const pending = withoutKey(current.playlistPendingById, playlist.id);
  const resultPlaylistValid =
    result.playlist === null ||
    (result.playlist.id === playlist.id && result.playlist.ownership === 'collected');
  const confirmed = result.status === 'applied' || result.status === 'reconciled';
  const confirmationMatchesRequestedState =
    !confirmed || (collected ? result.playlist !== null : result.playlist === null);
  if (
    current.snapshot.revision !== revision ||
    result.authRevision !== revision ||
    result.clientOperationId !== operationId ||
    !resultPlaylistValid ||
    !confirmationMatchesRequestedState
  ) {
    useAccountStore.setState({
      playlists: replacePlaylistSummary(current.playlists, playlist.id, previousSummary),
      playlistPendingById: pending,
    });
    return null;
  }
  if (result.status === 'applied' || result.status === 'reconciled') {
    useAccountStore.setState((state) => ({
      playlists: replacePlaylistSummary(state.playlists, playlist.id, result.playlist),
      playlistPendingById: pending,
      playlistMutationNoticeById:
        result.status === 'reconciled'
          ? {
              ...state.playlistMutationNoticeById,
              [playlist.id]: { operation, outcome: 'reconciled' },
            }
          : withoutKey(state.playlistMutationNoticeById, playlist.id),
    }));
    return result;
  }
  if (result.status === 'outcome-unknown') {
    useAccountStore.setState({
      playlistPendingById: pending,
      playlistMutationNoticeById: {
        ...current.playlistMutationNoticeById,
        [playlist.id]: { operation, outcome: 'outcome-unknown' },
      },
    });
    void current.loadPlaylists(provider, true);
    return result;
  }
  useAccountStore.setState({
    playlists: replacePlaylistSummary(current.playlists, playlist.id, previousSummary),
    playlistPendingById: pending,
    playlistMutationNoticeById: {
      ...current.playlistMutationNoticeById,
      [playlist.id]: { operation, outcome: 'rejected' },
    },
  });
  return result;
}

interface EntityPlaylistMutationOptions {
  provider: AccountMusicProvider;
  playlist: AccountPlaylistSummary;
  operation: Exclude<PlaylistMutationOperation, 'create'>;
  title?: string;
  track?: Song;
}

async function runEntityPlaylistMutation({
  provider,
  playlist,
  operation,
  title,
  track,
}: EntityPlaylistMutationOptions): Promise<PlaylistMutationResult | null> {
  const initial = useAccountStore.getState();
  if (initial.snapshot.state !== 'authenticated') {
    initial.openDialog();
    return null;
  }
  const capability =
    operation === 'rename'
      ? playlist.capabilities.canRename
      : operation === 'add'
        ? playlist.capabilities.canAddTracks
        : operation === 'remove'
          ? playlist.capabilities.canRemoveTracks
          : playlist.capabilities.canDelete;
  if (!initial.snapshot.capabilities.playlistWrite || !capability) {
    useAccountStore.setState((state) => ({
      playlistMutationNoticeById: {
        ...state.playlistMutationNoticeById,
        [playlist.id]: { operation, outcome: 'failed' },
      },
    }));
    return null;
  }
  if (initial.playlistPendingById[playlist.id]) return null;
  if (
    (operation === 'rename' && title === undefined) ||
    ((operation === 'add' || operation === 'remove') && !track)
  ) {
    return null;
  }

  const revision = initial.snapshot.revision;
  const operationId = mutationOperationId(`playlist-${operation}`);
  const previousSummary =
    loadedData(initial.playlists)?.find((item) => item.id === playlist.id) ?? null;
  const previousDetail = initial.accountPlaylistDetails[playlist.id];
  accountPlaylistGenerations.set(
    playlist.id,
    (accountPlaylistGenerations.get(playlist.id) ?? 0) + 1,
  );
  useAccountStore.setState((state) => {
    const projected =
      operation === 'rename'
        ? projectPlaylistSummary(state, { ...playlist, title: title!.trim() })
        : operation === 'add' || operation === 'remove'
          ? projectPlaylistTracks(state, playlist, track!, operation === 'add')
          : { playlists: state.playlists, accountPlaylistDetails: state.accountPlaylistDetails };
    return {
      ...projected,
      playlistPendingById: { ...state.playlistPendingById, [playlist.id]: operationId },
      playlistMutationNoticeById: withoutKey(state.playlistMutationNoticeById, playlist.id),
    };
  });

  let result: PlaylistMutationResult;
  try {
    const signal = runtimeSignal(provider);
    if (operation === 'rename') {
      const request: RenamePlaylistRequest = {
        playlistId: playlist.id,
        title: title!,
        clientOperationId: operationId,
      };
      result = await provider.renamePlaylist(request, signal);
    } else if (operation === 'add' || operation === 'remove') {
      const request: PlaylistTrackMutationRequest = {
        playlistId: playlist.id,
        trackId: track!.id,
        clientOperationId: operationId,
      };
      result =
        operation === 'add'
          ? await provider.addPlaylistTrack(request, signal)
          : await provider.removePlaylistTrack(request, signal);
    } else {
      const request: DeletePlaylistRequest = {
        playlistId: playlist.id,
        clientOperationId: operationId,
      };
      result = await provider.deletePlaylist(request, signal);
    }
  } catch (error) {
    const current = useAccountStore.getState();
    if (current.playlistPendingById[playlist.id] !== operationId) return null;
    const pending = withoutKey(current.playlistPendingById, playlist.id);
    if (current.snapshot.revision !== revision) {
      useAccountStore.setState({ playlistPendingById: pending });
      return null;
    }
    const failure = classifyLibraryFailure(error);
    useAccountStore.setState({
      ...restorePlaylistEntity(current, playlist.id, previousSummary, previousDetail),
      playlistPendingById: pending,
      playlistMutationNoticeById: {
        ...current.playlistMutationNoticeById,
        [playlist.id]: { operation, outcome: 'failed' },
      },
    });
    if (failure === 'reauthentication-required') {
      void current.refreshSnapshot(provider);
    }
    return null;
  }

  const current = useAccountStore.getState();
  if (current.playlistPendingById[playlist.id] !== operationId) return null;
  const pending = withoutKey(current.playlistPendingById, playlist.id);
  if (
    current.snapshot.revision !== revision ||
    result.authRevision !== revision ||
    result.clientOperationId !== operationId ||
    (result.playlist !== null &&
      (result.playlist.id !== playlist.id || result.playlist.ownership !== 'owned'))
  ) {
    useAccountStore.setState({ playlistPendingById: pending });
    return null;
  }
  const confirmed = result.status === 'applied' || result.status === 'reconciled';
  const invalidConfirmedShape =
    confirmed && (operation === 'delete' ? result.playlist !== null : result.playlist === null);
  if (invalidConfirmedShape) {
    useAccountStore.setState({
      ...restorePlaylistEntity(current, playlist.id, previousSummary, previousDetail),
      playlistPendingById: pending,
      playlistMutationNoticeById: {
        ...current.playlistMutationNoticeById,
        [playlist.id]: { operation, outcome: 'failed' },
      },
    });
    return null;
  }
  if (result.status === 'rejected') {
    useAccountStore.setState({
      ...restorePlaylistEntity(current, playlist.id, previousSummary, previousDetail),
      playlistPendingById: pending,
      playlistMutationNoticeById: {
        ...current.playlistMutationNoticeById,
        [playlist.id]: { operation, outcome: 'rejected' },
      },
    });
    return result;
  }
  if (result.status === 'outcome-unknown') {
    useAccountStore.setState({
      playlistPendingById: pending,
      playlistMutationNoticeById: {
        ...current.playlistMutationNoticeById,
        [playlist.id]: { operation, outcome: 'outcome-unknown' },
      },
    });
    if (operation === 'delete') void current.loadPlaylists(provider, true);
    else void current.loadAccountPlaylist(provider, playlist, true);
    return result;
  }
  useAccountStore.setState((state) => {
    if (operation === 'delete') {
      const accountPlaylistDetails = { ...state.accountPlaylistDetails };
      delete accountPlaylistDetails[playlist.id];
      return {
        playlists: replacePlaylistSummary(state.playlists, playlist.id, null),
        accountPlaylistDetails,
        playlistPendingById: pending,
        playlistMutationNoticeById:
          result.status === 'reconciled'
            ? {
                ...state.playlistMutationNoticeById,
                [playlist.id]: { operation, outcome: 'reconciled' },
              }
            : withoutKey(state.playlistMutationNoticeById, playlist.id),
      };
    }
    const projected = result.playlist
      ? projectPlaylistSummary(state, result.playlist)
      : { playlists: state.playlists, accountPlaylistDetails: state.accountPlaylistDetails };
    return {
      ...projected,
      playlistPendingById: pending,
      playlistMutationNoticeById:
        result.status === 'reconciled'
          ? {
              ...state.playlistMutationNoticeById,
              [playlist.id]: { operation, outcome: 'reconciled' },
            }
          : withoutKey(state.playlistMutationNoticeById, playlist.id),
    };
  });
  return result;
}

const CREATE_PLAYLIST_KEY = 'playlist-create';

async function runCreatePlaylistMutation(
  provider: AccountMusicProvider,
  title: string,
): Promise<PlaylistMutationResult | null> {
  const initial = useAccountStore.getState();
  if (initial.snapshot.state !== 'authenticated') {
    initial.openDialog();
    return null;
  }
  if (
    !initial.snapshot.capabilities.playlistWrite ||
    initial.playlistPendingById[CREATE_PLAYLIST_KEY]
  ) {
    return null;
  }
  const revision = initial.snapshot.revision;
  const operationId = mutationOperationId('playlist-create');
  useAccountStore.setState((state) => ({
    playlistPendingById: { ...state.playlistPendingById, [CREATE_PLAYLIST_KEY]: operationId },
    playlistMutationNoticeById: withoutKey(state.playlistMutationNoticeById, CREATE_PLAYLIST_KEY),
  }));
  const request: CreatePlaylistRequest = { title, clientOperationId: operationId };
  let result: PlaylistMutationResult;
  try {
    result = await provider.createPlaylist(request, runtimeSignal(provider));
  } catch (error) {
    const current = useAccountStore.getState();
    if (current.playlistPendingById[CREATE_PLAYLIST_KEY] !== operationId) return null;
    const pending = withoutKey(current.playlistPendingById, CREATE_PLAYLIST_KEY);
    if (current.snapshot.revision !== revision) {
      useAccountStore.setState({ playlistPendingById: pending });
      return null;
    }
    const failure = classifyLibraryFailure(error);
    useAccountStore.setState({
      playlistPendingById: pending,
      playlistMutationNoticeById: {
        ...current.playlistMutationNoticeById,
        [CREATE_PLAYLIST_KEY]: { operation: 'create', outcome: 'failed' },
      },
    });
    if (failure === 'reauthentication-required') {
      void current.refreshSnapshot(provider);
    }
    return null;
  }
  const current = useAccountStore.getState();
  if (current.playlistPendingById[CREATE_PLAYLIST_KEY] !== operationId) return null;
  const pending = withoutKey(current.playlistPendingById, CREATE_PLAYLIST_KEY);
  if (
    current.snapshot.revision !== revision ||
    result.authRevision !== revision ||
    result.clientOperationId !== operationId
  ) {
    useAccountStore.setState({ playlistPendingById: pending });
    return null;
  }
  if (result.status === 'applied' || result.status === 'reconciled') {
    if (!result.playlist || result.playlist.ownership !== 'owned') {
      useAccountStore.setState({
        playlistPendingById: pending,
        playlistMutationNoticeById: {
          ...current.playlistMutationNoticeById,
          [CREATE_PLAYLIST_KEY]: { operation: 'create', outcome: 'failed' },
        },
      });
      return null;
    }
    useAccountStore.setState((state) => ({
      ...projectPlaylistSummary(state, result.playlist!),
      playlistPendingById: pending,
      playlistMutationNoticeById:
        result.status === 'reconciled'
          ? {
              ...state.playlistMutationNoticeById,
              [CREATE_PLAYLIST_KEY]: { operation: 'create', outcome: 'reconciled' },
            }
          : withoutKey(state.playlistMutationNoticeById, CREATE_PLAYLIST_KEY),
    }));
  } else {
    useAccountStore.setState({
      playlistPendingById: pending,
      playlistMutationNoticeById: {
        ...current.playlistMutationNoticeById,
        [CREATE_PLAYLIST_KEY]: {
          operation: 'create',
          outcome: result.status === 'rejected' ? 'rejected' : 'outcome-unknown',
        },
      },
    });
    if (result.status === 'outcome-unknown') void current.loadPlaylists(provider, true);
  }
  return result;
}

export function useFavoriteState(
  trackId: EntityId | null | undefined,
  fallbackFavorite = false,
): { favorite: boolean; pending: boolean } {
  const favorite = useAccountStore((state) =>
    trackId ? (state.favoriteByTrackId[trackId] ?? fallbackFavorite) : fallbackFavorite,
  );
  const pending = useAccountStore((state) =>
    trackId ? Boolean(state.favoritePendingByTrackId[trackId]) : false,
  );
  return { favorite, pending };
}

export function usePlaylistMutationState(playlistId: EntityId | null | undefined): {
  pending: boolean;
  notice: PlaylistMutationNotice | null;
} {
  const pending = useAccountStore((state) =>
    playlistId ? Boolean(state.playlistPendingById[playlistId]) : false,
  );
  const notice = useAccountStore((state) =>
    playlistId ? (state.playlistMutationNoticeById[playlistId] ?? null) : null,
  );
  return { pending, notice };
}

function requireAcceptedPlaylistMutation(
  result: PlaylistMutationResult,
  operation: PlaylistMutationOperation,
): AccountPlaylistSummary | null {
  if (result.status !== 'applied' && result.status !== 'reconciled') {
    throw new Error(`Temporary playlist ${operation} was not confirmed`);
  }
  return result.playlist;
}

function requireConfirmedPlaylistDeletion(result: PlaylistMutationResult): void {
  if (requireAcceptedPlaylistMutation(result, 'delete') !== null) {
    throw new Error('Temporary playlist deletion returned an invalid confirmation');
  }
}

function isTemporaryPlaylist(playlist: AccountPlaylistSummary, createdId: EntityId): boolean {
  return (
    playlist.id === createdId &&
    playlist.ownership === 'owned' &&
    playlist.title.startsWith('YAQMC Integration Test (')
  );
}

/**
 * Deterministic fake/live-gate helper. It never targets a playlist unless the
 * provider identified it as the owned, uniquely created playlist for this run.
 */
export async function runTemporaryPlaylistAcceptance(
  provider: AccountMusicProvider,
  knownTrack: Song,
): Promise<AccountPlaylistSummary> {
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const title = `YAQMC Integration Test (${timestamp})`;
  const create = await provider.createPlaylist({
    title,
    clientOperationId: mutationOperationId('playlist-create-acceptance'),
  });
  const created = requireAcceptedPlaylistMutation(create, 'create');
  if (!created || created.title !== title || !isTemporaryPlaylist(created, created.id)) {
    throw new Error('Temporary playlist creation returned an unsafe cleanup target');
  }

  let cleanupTarget = created;
  let deleteAttempted = false;
  let primaryError: unknown;
  try {
    const add = await provider.addPlaylistTrack({
      playlistId: created.id,
      trackId: knownTrack.id,
      clientOperationId: mutationOperationId('playlist-add-acceptance'),
    });
    requireAcceptedPlaylistMutation(add, 'add');

    const detail = await provider.getAccountPlaylistTracks(created, undefined, 100);
    if (
      !isTemporaryPlaylist(detail.summary, created.id) ||
      !detail.tracks.items.some((track) => track.id === knownTrack.id)
    ) {
      throw new Error('Temporary playlist add could not be verified safely');
    }
    cleanupTarget = detail.summary;

    const remove = await provider.removePlaylistTrack({
      playlistId: created.id,
      trackId: knownTrack.id,
      clientOperationId: mutationOperationId('playlist-remove-acceptance'),
    });
    requireAcceptedPlaylistMutation(remove, 'remove');

    const renamedTitle = `${title} Verified`;
    const rename = await provider.renamePlaylist({
      playlistId: created.id,
      title: renamedTitle,
      clientOperationId: mutationOperationId('playlist-rename-acceptance'),
    });
    const renamed = requireAcceptedPlaylistMutation(rename, 'rename');
    if (!renamed || renamed.title !== renamedTitle || !isTemporaryPlaylist(renamed, created.id)) {
      throw new Error('Temporary playlist rename could not be verified safely');
    }
    cleanupTarget = renamed;

    deleteAttempted = true;
    const deleted = await provider.deletePlaylist({
      playlistId: created.id,
      clientOperationId: mutationOperationId('playlist-delete-acceptance'),
    });
    requireConfirmedPlaylistDeletion(deleted);
    return created;
  } catch (error) {
    primaryError = error;
  }

  if (!deleteAttempted && isTemporaryPlaylist(cleanupTarget, created.id)) {
    try {
      const cleanup = await provider.deletePlaylist({
        playlistId: created.id,
        clientOperationId: mutationOperationId('playlist-cleanup-acceptance'),
      });
      requireConfirmedPlaylistDeletion(cleanup);
    } catch (cleanupError) {
      throw new AggregateError(
        [primaryError, cleanupError],
        'Temporary playlist operation and cleanup both failed',
        { cause: cleanupError },
      );
    }
  }
  throw primaryError;
}

export function useAccountRuntime(provider: MusicProvider): void {
  useEffect(() => {
    if (!isAccountMusicProvider(provider)) return;
    const controller = new AbortController();
    runtimeProvider = provider;
    runtimeAbortController = controller;
    const unsubscribe = useAccountStore.subscribe(() => {
      reconcileOwnershipTimers(provider);
      hydrateAuthenticatedFavoriteAuthority(provider);
    });
    const release = () => disposeOwnership(provider);
    window.addEventListener('pagehide', release);
    void useAccountStore.getState().refreshSnapshot(provider);
    reconcileOwnershipTimers(provider);
    hydrateAuthenticatedFavoriteAuthority(provider);

    return () => {
      window.removeEventListener('pagehide', release);
      unsubscribe();
      disposeOwnership(provider);
      controller.abort();
      if (runtimeProvider === provider) {
        runtimeProvider = null;
        runtimeAbortController = null;
      }
    };
  }, [provider]);
}

export function releaseAccountDialogOwnership(provider: AccountMusicProvider): void {
  disposeOwnership(provider);
}

export function resetAccountRuntimeForTest(): void {
  ++requestGeneration;
  invalidateLibraryRequests();
  accountPlaylistGenerations.clear();
  clearOwnershipTimers();
  runtimeAbortController?.abort();
  runtimeAbortController = null;
  runtimeProvider = null;
  blockedAttempts.clear();
  cancellationRequests.clear();
  favoriteMutationVersion = 0;
  favoriteMutationVersionByTrackId.clear();
  favoriteConfirmedGuardByTrackId.clear();
  useAccountStore.setState({
    snapshot: initialSnapshot,
    displayedQrImageDataUri: null,
    dialogOpen: false,
    busy: false,
    error: null,
    favorites: idleResource(),
    playlists: idleResource(),
    recent: idleResource(),
    accountPlaylistDetails: {},
    favoriteByTrackId: {},
    favoritePendingByTrackId: {},
    playlistPendingById: {},
    playlistMutationNoticeById: {},
    mutationMessage: null,
  });
}
