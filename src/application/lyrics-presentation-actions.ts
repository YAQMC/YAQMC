import { usePlayerStore } from './player-store';
import { useLyricsPresentationStore } from './lyrics-presentation';

export async function enterLyricsFullscreen(): Promise<boolean> {
  const presentation = useLyricsPresentationStore.getState();
  if (presentation.pending) return presentation.fullscreen;

  usePlayerStore.getState().openLyrics();
  return useLyricsPresentationStore.getState().request(true);
}

export async function closeLyricsPresentation(): Promise<boolean> {
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
