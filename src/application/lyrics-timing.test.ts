import { describe, expect, it } from 'vitest';
import type { LyricDocument, LyricLine } from '../domain/music';
import { lyricScrollBehavior, selectLyricCursor, wordProgress } from './lyrics-timing';

const line = (partial: Partial<LyricLine> & Pick<LyricLine, 'id' | 'text'>): LyricLine => ({
  startMs: null,
  endMs: null,
  words: [],
  ...partial,
});

const document = (
  lines: LyricLine[],
  syncMode: LyricDocument['syncMode'] = 'line',
): LyricDocument => ({
  songId: 'song',
  syncMode,
  metadata: { sourceLabel: 'test', offsetMs: 0 },
  vocalists: [],
  lines,
});

describe('lyrics timing', () => {
  it('selects lines at inclusive start and exclusive end boundaries', () => {
    const lyrics = document([
      line({ id: 'one', text: 'One', startMs: 1_000, endMs: 2_000 }),
      line({ id: 'two', text: 'Two', startMs: 2_000, endMs: 3_000 }),
    ]);

    expect(selectLyricCursor(lyrics, 999).lineIndex).toBe(-1);
    expect(selectLyricCursor(lyrics, 1_000).lineIndex).toBe(0);
    expect(selectLyricCursor(lyrics, 2_000).lineIndex).toBe(1);
    expect(selectLyricCursor(lyrics, 3_000).lineIndex).toBe(-1);
  });

  it('selects word timing independently inside the active line', () => {
    const lyrics = document(
      [
        line({
          id: 'one',
          text: 'Soft light',
          startMs: 1_000,
          endMs: 3_000,
          words: [
            { startMs: 1_000, endMs: 1_900, text: 'Soft ' },
            { startMs: 2_100, endMs: 3_000, text: 'light' },
          ],
        }),
      ],
      'word',
    );

    expect(selectLyricCursor(lyrics, 1_450).wordIndex).toBe(0);
    expect(selectLyricCursor(lyrics, 2_000).wordIndex).toBe(-1);
    expect(selectLyricCursor(lyrics, 2_500).wordIndex).toBe(1);
  });

  it('returns no active line during an explicitly timed instrumental gap', () => {
    const lyrics = document([
      line({ id: 'one', text: 'One', startMs: 1_000, endMs: 2_000 }),
      line({ id: 'two', text: 'Two', startMs: 5_000, endMs: 6_000 }),
    ]);

    expect(selectLyricCursor(lyrics, 3_500)).toEqual(
      expect.objectContaining({ lineIndex: -1, line: null }),
    );
  });

  it('keeps translated text associated with its normalized line', () => {
    const lyrics = document([
      line({
        id: 'one',
        text: '晨光',
        translation: 'Morning light',
        startMs: 1_000,
        endMs: 2_000,
      }),
    ]);

    expect(selectLyricCursor(lyrics, 1_500).line?.translation).toBe('Morning light');
  });

  it('handles missing and unsynchronized lyrics without inventing timing', () => {
    expect(selectLyricCursor(null, 1_000).lineIndex).toBe(-1);
    expect(
      selectLyricCursor(document([line({ id: 'plain', text: 'Plain' })], 'unsynchronized'), 1_000)
        .lineIndex,
    ).toBe(-1);
  });

  it('clamps word progression', () => {
    const word = { startMs: 1_000, endMs: 2_000, text: 'light' };
    expect(wordProgress(word, 500)).toBe(0);
    expect(wordProgress(word, 1_500)).toBe(0.5);
    expect(wordProgress(word, 2_500)).toBe(1);
  });

  it('disables animated lyric scrolling for reduced motion', () => {
    expect(lyricScrollBehavior(true)).toBe('auto');
    expect(lyricScrollBehavior(false)).toBe('smooth');
  });
});
