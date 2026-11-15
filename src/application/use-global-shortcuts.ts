import { useEffect } from 'react';
import type { AppRoute } from './navigation';
import { usePlayerStore } from './player-store';
import { usePreferencesStore } from './preferences';
import { lyricsEscapeAction, useLyricsPresentationStore } from './lyrics-presentation';
import { exitLyricsFullscreen } from './lyrics-presentation-actions';
import { matchesAccelerator, type ShortcutAction } from '@yaqmc/client';
import { matchingPluginShortcut } from './plugin-shortcuts';
import { dispatchPluginShortcut } from './plugin-runtime';

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
      if (event.defaultPrevented || event.isComposing || event.getModifierState?.('AltGraph'))
        return;
      const target = event.target;
      const editing =
        target instanceof Element &&
        Boolean(
          target.closest(
            'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
          ),
        );

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
      const bindings = usePreferencesStore.getState().system.shortcutBindings;
      const action = (Object.keys(bindings) as ShortcutAction[]).find(
        (key) => bindings[key] && matchesAccelerator(event, bindings[key]!),
      );
      if (editing && action !== 'search') return;
      const interactive = target instanceof Element && target.closest('button, a, [role="button"]');
      if (interactive && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey)
        return;
      if (action) {
        if (action === 'fullscreen' && !lyricsOpen) return;
        event.preventDefault();
        if (event.repeat && action !== 'volumeUp' && action !== 'volumeDown') return;
        const player = usePlayerStore.getState();
        if (action === 'search') navigate({ page: 'search' });
        else if (action === 'toggle') player.togglePlayback();
        else if (action === 'previous') player.previous();
        else if (action === 'next') player.next();
        else if (action === 'fullscreen') toggleLyricsFullscreen();
        else
          player.setVolume(
            Math.max(0, Math.min(1, player.volume + (action === 'volumeUp' ? 0.05 : -0.05))),
          );
        return;
      }
      const plugin = matchingPluginShortcut(event);
      if (plugin) {
        event.preventDefault();
        if (!event.repeat) dispatchPluginShortcut(plugin.pluginId, plugin.id);
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
