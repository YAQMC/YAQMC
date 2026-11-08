import { useEffect } from 'react';
import type { AppRoute } from './navigation';
import { usePlayerStore } from './player-store';
import { usePreferencesStore } from './preferences';
import { lyricsEscapeAction, useLyricsPresentationStore } from './lyrics-presentation';
import { exitLyricsFullscreen } from './lyrics-presentation-actions';

interface GlobalShortcutActions {
  navigate: (route: AppRoute) => void;
  closeLyrics: () => void;
  toggleLyricsFullscreen: () => void;
}

/** Window-level keys: Ctrl/Cmd+K search, Escape unwinding, F11 lyrics fullscreen, Space play/pause. */
export function useGlobalShortcuts({
  navigate,
  closeLyrics,
  toggleLyricsFullscreen,
}: GlobalShortcutActions): void {
  const lyricsOpen = usePlayerStore((state) => state.lyricsOpen);
  const fullscreen = useLyricsPresentationStore((state) => state.fullscreen);
  const focusSidebarCollapsed = usePreferencesStore((state) => state.lyrics.focusSidebarCollapsed);
  const updateLyrics = usePreferencesStore((state) => state.updateLyrics);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const editing =
        target instanceof Element &&
        target.matches('input, textarea, select, [contenteditable="true"]');

      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault();
        navigate({ page: 'search' });
        return;
      }
      if (event.key === 'Escape') {
        const action = lyricsEscapeAction({
          lyricsOpen,
          fullscreen,
          focus: focusSidebarCollapsed,
        });
        if (action === 'exit-fullscreen') void exitLyricsFullscreen();
        else if (action === 'exit-focus') updateLyrics({ focusSidebarCollapsed: false });
        else if (action === 'close-lyrics') closeLyrics();
        else usePlayerStore.getState().closePanels();
        return;
      }
      if (event.key === 'F11' && lyricsOpen) {
        event.preventDefault();
        if (!event.repeat) toggleLyricsFullscreen();
        return;
      }
      if (!editing && event.code === 'Space') {
        event.preventDefault();
        usePlayerStore.getState().togglePlayback();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    closeLyrics,
    focusSidebarCollapsed,
    fullscreen,
    lyricsOpen,
    navigate,
    toggleLyricsFullscreen,
    updateLyrics,
  ]);
}
