import { invoke } from '@tauri-apps/api/core';
import { useEffect } from 'react';
import { useMusicProvider } from './provider-context';
import { useLyricsStore } from './lyrics-store';
import { isNativeRuntime } from './native-player-runtime';
import { usePlayerStore } from './player-store';
import { useTranslation } from 'react-i18next';

export function useLyricsCoordinator(): void {
  const { t } = useTranslation('errors');
  const provider = useMusicProvider();
  const currentSongId = usePlayerStore((state) => state.queue[state.currentIndex]?.id ?? null);
  const sessionId = usePlayerStore((state) => state.sessionId);
  const currentQueueEntryId = usePlayerStore((state) => state.currentQueueEntryId);

  useEffect(() => {
    if (!currentSongId) return;
    const controller = new AbortController();
    const generation = sessionId;
    const store = useLyricsStore.getState();
    store.startLoading(currentSongId, generation);

    void provider
      .getLyrics(currentSongId, controller.signal)
      .then((document) => {
        if (controller.signal.aborted) return;
        useLyricsStore.getState().setDocument(currentSongId, document, generation);
        if (isNativeRuntime) {
          void invoke('player_set_lyrics', { document }).catch((error: unknown) => {
            console.error('Native lyric synchronization failed', error);
          });
        }
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        useLyricsStore.getState().setError(currentSongId, t('lyricsFailed'), generation);
      });

    return () => controller.abort();
  }, [currentSongId, currentQueueEntryId, sessionId, provider, t]);
}
