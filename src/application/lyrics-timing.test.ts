import { describe, expect, it } from 'vitest';
import type { LyricDocument, LyricLine } from '../domain/music';
import { nextLyricBoundaryMs, selectLyricCursor, wordProgress } from './lyrics-timing';

const line = (partial: Partial<LyricLine> & Pick<LyricLine, 'id' | 'text'>): LyricLine => ({
  startMs: null,
  endMs: null,
  words: [],
  ...partial,
});

const document = (
  lines: LyricLine[],
  syncMode: LyricDocument['syncMode'] = 'line',
  offsetMs = 0,
): LyricDocument => ({
  songId: 'song',
  syncMode,
  metadata: { sourceLabel: 'test', offsetMs },
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

  it('selects the smallest finite line or word boundary strictly after lyric time', () => {
    const lyrics = document(
      [
        line({
          id: 'one',
          text: 'Soft light',
          startMs: 1_000,
          endMs: 4_000,
          words: [
            { startMs: 1_000, endMs: 1_800, text: 'Soft ' },
            { startMs: 2_200, endMs: 3_500, text: 'light' },
          ],
        }),
        line({ id: 'two', text: 'Next', startMs: 5_000, endMs: 6_000 }),
      ],
      'word',
    );

    expect(nextLyricBoundaryMs(lyrics, 999)).toBe(1_000);
    expect(nextLyricBoundaryMs(lyrics, 1_000)).toBe(1_800);
    expect(nextLyricBoundaryMs(lyrics, 1_800)).toBe(2_200);
    expect(nextLyricBoundaryMs(lyrics, 3_500)).toBe(4_000);
    expect(nextLyricBoundaryMs(lyrics, 4_000)).toBe(5_000);
    expect(nextLyricBoundaryMs(lyrics, 6_000)).toBeNull();
  });

  it('includes inferred finite ends across untimed lines but excludes a final infinite end', () => {
    const lyrics = document([
      line({ id: 'one', text: 'One', startMs: 1_000, endMs: null }),
      line({ id: 'untimed', text: 'Aside', startMs: null, endMs: null }),
      line({ id: 'two', text: 'Two', startMs: 5_000, endMs: null }),
    ]);

    expect(nextLyricBoundaryMs(lyrics, 1_000)).toBe(5_000);
    expect(nextLyricBoundaryMs(lyrics, 4_999)).toBe(5_000);
    expect(nextLyricBoundaryMs(lyrics, 5_000)).toBeNull();
  });

  it.each([
    { offsetMs: 300, rawPositionMs: 1_299, expected: 1_300 },
    { offsetMs: 300, rawPositionMs: 1_300, expected: 2_300 },
    { offsetMs: -250, rawPositionMs: 749, expected: 750 },
    { offsetMs: -250, rawPositionMs: 750, expected: 1_750 },
  ])(
    'converts lyric boundaries back to raw time with document offset $offsetMs',
    ({ offsetMs, rawPositionMs, expected }) => {
      const lyrics = document(
        [line({ id: 'one', text: 'One', startMs: 1_000, endMs: 2_000 })],
        'line',
        offsetMs,
      );

      expect(nextLyricBoundaryMs(lyrics, rawPositionMs)).toBe(expected);
    },
  );

  it('uses player plus presentation offset as raw time before applying document offset', () => {
    const lyrics = document(
      [line({ id: 'one', text: 'One', startMs: 1_000, endMs: 2_000 })],
      'line',
      300,
    );

    const playerPositionMs = 900;
    const presentationOffsetMs = 399;
    expect(nextLyricBoundaryMs(lyrics, playerPositionMs + presentationOffsetMs)).toBe(1_300);
    expect(nextLyricBoundaryMs(lyrics, playerPositionMs + presentationOffsetMs + 1)).toBe(2_300);
  });

  it('returns null for missing, unsynchronized, non-finite, and exhausted timelines', () => {
    const synchronized = document([line({ id: 'one', text: 'One', startMs: 1_000, endMs: 2_000 })]);
    const unsynchronized = document(
      [line({ id: 'plain', text: 'Plain', startMs: null, endMs: null })],
      'unsynchronized',
    );

    expect(nextLyricBoundaryMs(null, 0)).toBeNull();
    expect(nextLyricBoundaryMs(unsynchronized, 0)).toBeNull();
    expect(nextLyricBoundaryMs(synchronized, Number.NaN)).toBeNull();
    expect(nextLyricBoundaryMs(synchronized, Number.POSITIVE_INFINITY)).toBeNull();
    expect(nextLyricBoundaryMs(synchronized, 2_000)).toBeNull();
  });
});
