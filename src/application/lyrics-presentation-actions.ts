import { usePlayerStore } from './player-store';
import { useLyricsPresentationStore } from './lyrics-presentation';

export async function enterLyricsFullscreen(): Promise<boolean> {
  const presentation = useLyricsPresentationStore.getState();
  if (presentation.pending) return presentation.fullscreen;

  usePlayerStore.getState().openLyrics();
  return useLyricsPresentationStore.getState().request(true);
}

export function exitLyricsFullscreen(): Promise<boolean> {
  return useLyricsPresentationStore.getState().request(false);
}

let closeInFlight: Promise<boolean> | null = null;

async function closeLyricsPresentationOnce(): Promise<boolean> {
  const presentation = useLyricsPresentationStore.getState();
  if (!presentation.fullscreen && !presentation.pending) {
    presentation.clearError();
    usePlayerStore.getState().closePanels();
    return true;
  }

  await useLyricsPresentationStore.getState().request(false);
  const confirmed = useLyricsPresentationStore.getState();
  if (confirmed.fullscreen || confirmed.pending || confirmed.error !== null) return false;

  usePlayerStore.getState().closePanels();
  return true;
}

export function closeLyricsPresentation(): Promise<boolean> {
  if (closeInFlight) return closeInFlight;

  const operation = closeLyricsPresentationOnce();
  const shared = operation.finally(() => {
    if (closeInFlight === shared) closeInFlight = null;
  });
  closeInFlight = shared;
  return shared;
}

export async function runAfterLyricsClose(action: () => void): Promise<boolean> {
  if (!(await closeLyricsPresentation())) return false;
  action();
  return true;
}

export function toggleQueueAfterLyricsClose(): Promise<boolean> {
  const player = usePlayerStore.getState();
  if (player.queueOpen) {
    player.toggleQueue();
    return Promise.resolve(true);
  }

  return runAfterLyricsClose(() => usePlayerStore.getState().toggleQueue());
}
