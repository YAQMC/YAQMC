import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { create } from 'zustand';
import type { SecondaryLyricVisibility } from './preferences';

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
  read: () => getCurrentWindow().isFullscreen(),
  write: (value) => getCurrentWindow().setFullscreen(value),
  subscribe: async (listener) => getCurrentWindow().onResized(() => listener()),
};

let fullscreenPort: FullscreenPort = isTauri() ? nativePort : browserPort;
let generation = 0;

export const useLyricsPresentationStore = create<LyricsPresentationState>((set, get) => ({
  fullscreen: false,
  pending: false,
  error: null,
  request: async (value) => {
    const requestGeneration = ++generation;
    set({ pending: true, error: null });
    try {
      await fullscreenPort.write(value);
      const confirmed = await fullscreenPort.read();
      if (requestGeneration !== generation) return get().fullscreen;
      set({ fullscreen: confirmed, pending: false, error: null });
      return confirmed;
    } catch (error) {
      if (requestGeneration !== generation) return get().fullscreen;
      set({ pending: false, error: errorMessage(error) });
      return false;
    }
  },
  sync: async () => {
    const syncGeneration = generation;
    try {
      const fullscreen = await fullscreenPort.read();
      if (syncGeneration === generation) set({ fullscreen });
    } catch (error) {
      if (syncGeneration === generation) set({ error: errorMessage(error) });
    }
  },
  clearError: () => set({ error: null }),
}));

export function setFullscreenPortForTests(port: FullscreenPort): void {
  fullscreenPort = port;
  generation += 1;
  useLyricsPresentationStore.setState({ fullscreen: false, pending: false, error: null });
}

export async function startLyricsPresentationRuntime(): Promise<() => Promise<void>> {
  let active = true;
  let syncQueued = false;
  const unsubscribe = await fullscreenPort.subscribe(() => {
    if (!active || syncQueued) return;
    syncQueued = true;
    queueMicrotask(() => {
      syncQueued = false;
      if (active) void useLyricsPresentationStore.getState().sync();
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
