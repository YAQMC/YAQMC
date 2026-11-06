import { useContext, useEffect } from 'react';
import { ProviderRegistryContext, useMusicProvider } from './provider-context';
import type { LyricDocument } from '../domain/music';
import { useLyricsStore } from './lyrics-store';
import { isNativeRuntime } from './native-player-runtime';
import { usePlayerStore } from './player-store';
import { useTranslation } from 'react-i18next';
import { getYaqmcClient } from './yaqmc-runtime';

export function useLyricsCoordinator(): void {
  const { t } = useTranslation('errors');
  const provider = useMusicProvider();
  const registry = useContext(ProviderRegistryContext);
  const reference = usePlayerStore((state) => state.queue[state.currentIndex]?.provider);
  const lyricsProvider = reference
    ? (registry?.get(reference.providerId, reference.profileId)?.lyrics ??
      (provider.id === reference.providerId && provider.profileId === reference.profileId
        ? provider
        : null))
    : provider;
  const lyricsSongId = reference?.trackId ?? null;
  const currentSongId = usePlayerStore((state) => state.queue[state.currentIndex]?.id ?? null);
  const sessionId = usePlayerStore((state) => state.sessionId);
  const currentQueueEntryId = usePlayerStore((state) => state.currentQueueEntryId);

  useEffect(() => {
    if (!currentSongId) return;
    const controller = new AbortController();
    const generation = sessionId;
    const store = useLyricsStore.getState();
    store.startLoading(currentSongId, generation);

    const request = lyricsProvider
      ? lyricsProvider.getLyrics(lyricsSongId ?? currentSongId, controller.signal)
      : Promise.reject(new Error('The track provider is unavailable.'));
    const publish = (document: LyricDocument | null) => {
      useLyricsStore.getState().setDocument(currentSongId, document, generation);
      if (isNativeRuntime) {
        void getYaqmcClient()
          .invoke('player_set_lyrics', { document })
          .catch((error: unknown) => {
            console.error('Native lyric synchronization failed', error);
          });
      }
    };
    void request
      .then((document) => {
        if (controller.signal.aborted) return;
        if (document && document.songId !== currentSongId)
          document = { ...document, songId: currentSongId };
        publish(document);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        useLyricsStore.getState().setError(currentSongId, t('lyricsFailed'), generation);
      });

    return () => controller.abort();
  }, [currentSongId, currentQueueEntryId, sessionId, lyricsProvider, lyricsSongId, t]);
}
