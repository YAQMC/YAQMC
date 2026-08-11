import { useEffect } from 'react';
import { create } from 'zustand';
import type { AccountSnapshot } from '../domain/music';
import { ProviderError } from '../domain/music';
import {
  isAccountMusicProvider,
  type AccountMusicProvider,
  type MusicProvider,
} from '../providers/music-provider';

export type AccountRuntimeError =
  'network' | 'authorization' | 'secure-store' | 'protocol' | 'unknown';

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
  openDialog: () => void;
  closeDialog: (provider: AccountMusicProvider) => Promise<void>;
  refreshSnapshot: (provider: AccountMusicProvider) => Promise<void>;
  startLogin: (provider: AccountMusicProvider) => Promise<void>;
  heartbeatLogin: (provider: AccountMusicProvider) => Promise<void>;
  refreshQr: (provider: AccountMusicProvider) => Promise<void>;
  cancelLogin: (provider: AccountMusicProvider) => Promise<void>;
  signOut: (provider: AccountMusicProvider) => Promise<void>;
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
  const dialogOpen = useAccountStore.getState().dialogOpen;
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

export const useAccountStore = create<AccountStoreState>((set, get) => ({
  snapshot: initialSnapshot,
  displayedQrImageDataUri: null,
  dialogOpen: false,
  busy: false,
  error: null,
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
}));

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
  });
}
