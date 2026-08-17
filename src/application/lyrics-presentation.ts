import { create } from 'zustand';
import type { SecondaryLyricVisibility } from './preferences';
import { getYaqmcClient } from './yaqmc-runtime';

export interface FullscreenPort {
  read(): Promise<boolean>;
  write(value: boolean): Promise<void>;
  subscribe(listener: () => void): Promise<() => void>;
}

export type LyricsEscapeAction = 'exit-fullscreen' | 'exit-focus' | 'close-lyrics' | 'none';

export function lyricsEscapeAction(input: {
  lyricsOpen: boolean;
  fullscreen: boolean;
  focus: boolean;
}): LyricsEscapeAction {
  if (input.fullscreen) return 'exit-fullscreen';
  if (!input.lyricsOpen) return 'none';
  if (input.focus) return 'exit-focus';
  return 'close-lyrics';
}

interface LyricsPresentationState {
  fullscreen: boolean;
  pending: boolean;
  error: string | null;
  request: (value: boolean) => Promise<boolean>;
  sync: () => Promise<void>;
  clearError: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let browserFullscreen = false;
let nativeFullscreen = false;

const browserPort: FullscreenPort = {
  async read() {
    return browserFullscreen;
  },
  async write(value) {
    browserFullscreen = value;
  },
  async subscribe(listener) {
    if (typeof window === 'undefined') return () => undefined;
    window.addEventListener('resize', listener);
    return () => window.removeEventListener('resize', listener);
  },
};

const nativePort: FullscreenPort = {
  read: async () => nativeFullscreen,
  write: async (value) => {
    await getYaqmcClient().host.window.setFullscreen(value);
    nativeFullscreen = value;
  },
  subscribe: async (listener) => {
    if (typeof window === 'undefined') return () => undefined;
    window.addEventListener('resize', listener);
    return () => window.removeEventListener('resize', listener);
  },
};

let fullscreenPort: FullscreenPort =
  getYaqmcClient().bridge.kind === 'fake' ? browserPort : nativePort;
let generation = 0;
let nextSynchronizationSequence = 0;
let lastCommittedSynchronizationSequence = 0;
const writeQueues = new WeakMap<FullscreenPort, Promise<void>>();

function enqueueWrite(port: FullscreenPort, value: boolean): Promise<void> {
  const write = (writeQueues.get(port) ?? Promise.resolve()).then(() => port.write(value));
  writeQueues.set(
    port,
    write.catch(() => undefined),
  );
  return write;
}

async function synchronizeFullscreen(
  commitAllowed: () => boolean = () => true,
  syncPort: FullscreenPort = fullscreenPort,
): Promise<void> {
  if (useLyricsPresentationStore.getState().pending) return;
  const syncGeneration = generation;
  const syncSequence = ++nextSynchronizationSequence;
  try {
    const fullscreen = await syncPort.read();
    if (
      syncGeneration === generation &&
      syncSequence > lastCommittedSynchronizationSequence &&
      commitAllowed() &&
      !useLyricsPresentationStore.getState().pending
    ) {
      lastCommittedSynchronizationSequence = syncSequence;
      useLyricsPresentationStore.setState({ fullscreen, error: null });
    }
  } catch (error) {
    if (
      syncGeneration === generation &&
      syncSequence > lastCommittedSynchronizationSequence &&
      commitAllowed() &&
      !useLyricsPresentationStore.getState().pending
    ) {
      lastCommittedSynchronizationSequence = syncSequence;
      useLyricsPresentationStore.setState({ error: errorMessage(error) });
    }
  }
}

export const useLyricsPresentationStore = create<LyricsPresentationState>((set, get) => ({
  fullscreen: false,
  pending: false,
  error: null,
  request: async (value) => {
    const requestGeneration = ++generation;
    const requestPort = fullscreenPort;
    set({ pending: true, error: null });
    try {
      await enqueueWrite(requestPort, value);
      const confirmed = await requestPort.read();
      if (requestGeneration !== generation) return get().fullscreen;
      set({ fullscreen: confirmed, pending: false, error: null });
      return confirmed;
    } catch (error) {
      if (requestGeneration !== generation) return get().fullscreen;
      const message = errorMessage(error);
      try {
        const confirmed = await requestPort.read();
        if (requestGeneration !== generation) return get().fullscreen;
        set({ fullscreen: confirmed, pending: false, error: message });
        return confirmed;
      } catch {
        if (requestGeneration !== generation) return get().fullscreen;
        const confirmed = get().fullscreen;
        set({ pending: false, error: message });
        return confirmed;
      }
    }
  },
  sync: () => synchronizeFullscreen(),
  clearError: () => set({ error: null }),
}));

export function setFullscreenPortForTests(port: FullscreenPort): () => void {
  const previousPort = fullscreenPort;
  fullscreenPort = port;
  generation += 1;
  useLyricsPresentationStore.setState({ fullscreen: false, pending: false, error: null });
  return () => {
    fullscreenPort = previousPort;
    generation += 1;
    useLyricsPresentationStore.setState({ fullscreen: false, pending: false, error: null });
  };
}

export async function startLyricsPresentationRuntime(): Promise<() => Promise<void>> {
  let active = true;
  let syncQueued = false;
  const runtimePort = fullscreenPort;
  const unsubscribe = await runtimePort.subscribe(() => {
    if (!active || syncQueued) return;
    syncQueued = true;
    queueMicrotask(() => {
      syncQueued = false;
      if (active) void synchronizeFullscreen(() => active, runtimePort);
    });
  });
  return async () => {
    active = false;
    unsubscribe();
  };
}

export function shouldShowLyricSecondary(
  mode: SecondaryLyricVisibility,
  value: string | undefined,
  primary: string,
  kind: 'translation' | 'romanization',
): boolean {
  if (!value || mode === 'hide') return false;
  if (mode === 'show') return true;
  if (value.trim().toLocaleLowerCase() === primary.trim().toLocaleLowerCase()) return false;
  const hasNonLatinText = Array.from(primary).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint > 0x024f;
  });
  return kind === 'translation' || hasNonLatinText;
}
