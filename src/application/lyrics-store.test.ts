import { describe, expect, it } from 'vitest';
import { useLyricsStore } from './lyrics-store';

describe('lyrics store', () => {
  it('ignores a document from a previous song after the current song started loading', () => {
    useLyricsStore.setState({
      songId: null,
      generation: 0,
      status: 'idle',
      document: null,
      error: null,
    });
    useLyricsStore.getState().startLoading('song-b', 2);
    useLyricsStore.getState().setDocument('song-a', {
      songId: 'song-a',
      syncMode: 'line',
      metadata: { sourceLabel: 'stale', offsetMs: 0 },
      vocalists: [],
      lines: [],
    }, 1);
    expect(useLyricsStore.getState().songId).toBe('song-b');
    expect(useLyricsStore.getState().document).toBeNull();
    expect(useLyricsStore.getState().status).toBe('loading');
  });
});
