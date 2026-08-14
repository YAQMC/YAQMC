import { useEffect, useRef } from 'react';
import type { MusicProvider } from '../providers/music-provider';
import { usePlayerStore } from './player-store';

const GUESS_BATCH_SIZE = 5;

export function useGuessContinuation(provider: MusicProvider): void {
  const inFlight = useRef(false);

  useEffect(() => {
    const unsubscribe = usePlayerStore.subscribe((state, previous) => {
      if (
        state.guessSessionActive &&
        state.playbackState === 'ended' &&
        previous.playbackState !== 'ended' &&
        !inFlight.current
      ) {
        inFlight.current = true;
        void (async () => {
          try {
            const next = await provider.getGuessNext(GUESS_BATCH_SIZE);
            const store = usePlayerStore.getState();
            if (!store.guessSessionActive || next.length === 0) {
              if (next.length === 0) store.endGuessSession();
              return;
            }
            const previousLength = store.queue.length;
            store.addTracksToQueue(next);
            store.playFromQueue(previousLength);
          } catch {
            usePlayerStore.getState().endGuessSession();
          } finally {
            inFlight.current = false;
          }
        })();
      }
    });
    return unsubscribe;
  }, [provider]);
}
