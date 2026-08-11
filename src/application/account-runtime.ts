import { useEffect } from 'react';
import { create } from 'zustand';
import type {
  AccountPlaylistDetail,
  AccountPlaylistSummary,
  AccountSnapshot,
  EntityId,
  Page,
  Playlist,
  RemotePlayHistoryItem,
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

export type LibraryResourceError = 'network' | 'protocol' | 'unsupported' | 'unknown';

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
  mutationMessage: string | null;
  openDialog: () => void;
  closeDialog: (provider: AccountMusicProvider) => Promise<void>;
  refreshSnapshot: (provider: AccountMusicProvider) => Promise<void>;
  startLogin: (provider: AccountMusicProvider) => Promise<void>;
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
    id: EntityId,
    reset?: boolean,
  ) => Promise<void>;
  loadNextAccountPlaylist: (provider: AccountMusicProvider, id: EntityId) => Promise<void>;
  setFavorite: (provider: AccountMusicProvider, track: Song, favorite: boolean) => Promise<void>;
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
  return {
    favorites: resourceForSnapshot<Song[]>(snapshot),
    playlists: resourceForSnapshot<AccountPlaylistSummary[]>(snapshot),
    recent: resourceForSnapshot<RemotePlayHistoryItem[]>(snapshot),
    accountPlaylistDetails: {} as Record<EntityId, LibraryResource<AccountPlaylistDetail>>,
    favoriteByTrackId: {} as Record<EntityId, boolean>,
    favoritePendingByTrackId: {} as Record<EntityId, string>,
    mutationMessage: null,
  };
}

function favoriteOperationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `favorite-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
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

function projectFavoritePage(songs: Song[], replace: boolean): void {
  useAccountStore.setState((state) => {
    const favoriteByTrackId = replace
      ? Object.fromEntries(Object.keys(state.favoriteByTrackId).map((id) => [id, false]))
      : { ...state.favoriteByTrackId };
    for (const song of songs) favoriteByTrackId[song.id] = true;
    return { favoriteByTrackId };
  });
}

function confirmedFavoritesResource(
  resource: LibraryResource<Song[]>,
  track: Song,
  favorite: boolean,
): LibraryResource<Song[]> {
  const data = loadedData(resource);
  if (!data) return resource;
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
  if (code === 'schema-changed' || code === 'malformed-response') return 'protocol';
  if (code === 'unsupported-operation') return 'unsupported';
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
  const previousData = reset ? [] : (loadedData(previous) ?? []);
  const requestedCursor = reset ? null : nextCursor(previous);
  if (!reset && requestedCursor === null) return;
  const revision = snapshot.revision;
  const generation = ++libraryGenerations[resource];
  publishListResource(resource, {
    status: 'loading',
    data: previousData.length > 0 ? previousData : null,
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
    const data = mergeFirstSeen(previousData, page.items, keyOf);
    if (data.length === 0) {
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
      projectFavoritePage(data as Song[], page.nextCursor === null);
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
        data: previousData.length > 0 ? previousData : null,
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
  id: EntityId,
  reset: boolean,
): Promise<void> {
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
  const previousDetail = reset ? null : loadedData(previous);
  const requestedCursor = reset ? null : nextCursor(previous);
  if (!reset && requestedCursor === null) return;
  const revision = snapshot.revision;
  const generation = (accountPlaylistGenerations.get(id) ?? 0) + 1;
  accountPlaylistGenerations.set(id, generation);
  setAccountPlaylistResource(id, {
    status: 'loading',
    data: previousDetail,
    nextCursor: requestedCursor,
    requestedCursor,
  });

  try {
    const detail = await provider.getAccountPlaylistTracks(
      id,
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
    const tracks = mergeFirstSeen(
      previousDetail?.tracks.items ?? [],
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
        data: previousDetail,
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
      detail.summary.updatedAtMs === null
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
  startLogin: async (provider) => {
    set({ dialogOpen: true, displayedQrImageDataUri: null });
    await runSnapshotRequest(
      provider,
      (signal) => provider.startQrLogin(signal),
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
  loadAccountPlaylist: (provider, id, reset = true) =>
    loadAccountPlaylistResource(provider, id, reset),
  loadNextAccountPlaylist: (provider, id) => loadAccountPlaylistResource(provider, id, false),
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
    const operationId = favoriteOperationId();
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
      set({
        favoriteByTrackId: { ...current.favoriteByTrackId, [track.id]: previous },
        favoritePendingByTrackId: pending,
        mutationMessage: 'QQ Music rejected the Favorites change.',
      });
      return;
    }
    if (result.status === 'outcome-unknown') {
      set({
        favoritePendingByTrackId: pending,
        mutationMessage: FAVORITE_OUTCOME_UNKNOWN_MESSAGE,
      });
      void get().loadFavorites(provider, true);
      return;
    }
    set({
      favoriteByTrackId: { ...current.favoriteByTrackId, [track.id]: result.favorite },
      favoritePendingByTrackId: pending,
      favorites: confirmedFavoritesResource(current.favorites, track, result.favorite),
      mutationMessage: result.status === 'reconciled' ? FAVORITE_RECONCILED_MESSAGE : null,
    });
  },
}));

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

export function useAccountRuntime(provider: MusicProvider): void {
  useEffect(() => {
    if (!isAccountMusicProvider(provider)) return;
    const controller = new AbortController();
    runtimeProvider = provider;
    runtimeAbortController = controller;
    const unsubscribe = useAccountStore.subscribe(() => reconcileOwnershipTimers(provider));
    const release = () => disposeOwnership(provider);
    window.addEventListener('pagehide', release);
    void useAccountStore.getState().refreshSnapshot(provider);
    reconcileOwnershipTimers(provider);

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
    mutationMessage: null,
  });
}
