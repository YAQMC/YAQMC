import { describe, expect, it } from 'vitest';
import type { LyricDocument, LyricLine } from '../domain/music';
import {
  activeLyricInterlude,
  lastSungLineIndex,
  lyricInterludeRemainingMs,
  lyricScrollBehavior,
  lyricScrollTargetLineIndex,
  MIN_INTERLUDE_GAP_MS,
  nextLyricBoundaryMs,
  nextLyricPresentationBoundaryMs,
  selectLyricCursor,
  wordMotionIntensity,
  wordProgress,
} from './lyrics-timing';

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

  it('reports interludes only for gaps at least the minimum interlude length', () => {
    const lyrics = document([
      line({ id: 'one', text: 'One', startMs: 1_000, endMs: 2_000 }),
      line({ id: 'two', text: 'Two', startMs: 2_000 + MIN_INTERLUDE_GAP_MS - 1, endMs: 30_000 }),
    ]);

    expect(lyricInterludeRemainingMs(lyrics, 2_500)).toBeNull();
    expect(lyricInterludeRemainingMs(lyrics, 1_500)).toBeNull();
  });

  it('reports the remaining interlude during a long gap and a long intro', () => {
    const firstStartMs = MIN_INTERLUDE_GAP_MS + 2_000;
    const firstEndMs = firstStartMs + 1_000;
    const secondStartMs = firstEndMs + MIN_INTERLUDE_GAP_MS;
    const lyrics = document([
      line({ id: 'one', text: 'One', startMs: firstStartMs, endMs: firstEndMs }),
      line({ id: 'two', text: 'Two', startMs: secondStartMs, endMs: secondStartMs + 1_000 }),
    ]);

    expect(lyricInterludeRemainingMs(lyrics, 1_000)).toBe(MIN_INTERLUDE_GAP_MS + 1_000);
    expect(lyricInterludeRemainingMs(lyrics, firstEndMs + 2_000)).toBe(
      MIN_INTERLUDE_GAP_MS - 2_000,
    );
    expect(lyricInterludeRemainingMs(lyrics, secondStartMs - 1_000)).toBe(1_000);
    expect(lyricInterludeRemainingMs(lyrics, secondStartMs)).toBeNull();
  });

  it('uses the latest earlier lyric end when qualifying interludes', () => {
    const lyrics = document([
      line({ id: 'one', text: 'One', startMs: 1_000, endMs: 9_000 }),
      line({ id: 'overlap', text: 'Overlap', startMs: 3_000, endMs: 4_000 }),
      line({ id: 'two', text: 'Two', startMs: 12_000, endMs: 13_000 }),
      line({ id: 'three', text: 'Three', startMs: 17_000, endMs: 18_000 }),
    ]);

    expect(activeLyricInterlude(lyrics, 10_000)).toBeNull();
    expect(activeLyricInterlude(lyrics, 15_000)).toEqual({
      startMs: 13_000,
      endMs: 17_000,
      anchorLineIndex: 2,
    });
  });

  it('anchors an interlude after the overlapping line that ends last', () => {
    const lyrics = document([
      line({ id: 'lead', text: 'Lead', startMs: 1_000, endMs: 10_000 }),
      line({ id: 'response', text: 'Response', startMs: 3_000, endMs: 4_000 }),
      line({ id: 'next', text: 'Next', startMs: 15_000, endMs: 16_000 }),
    ]);

    expect(activeLyricInterlude(lyrics, 12_000)).toEqual({
      startMs: 10_000,
      endMs: 15_000,
      anchorLineIndex: 0,
    });
  });

  it('tracks the last sung line through timed gaps', () => {
    const lyrics = document([
      line({ id: 'one', text: 'One', startMs: 1_000, endMs: 2_000 }),
      line({ id: 'two', text: 'Two', startMs: 5_000, endMs: 6_000 }),
    ]);

    expect(lastSungLineIndex(lyrics, 999)).toBe(-1);
    expect(lastSungLineIndex(lyrics, 1_500)).toBe(0);
    expect(lastSungLineIndex(lyrics, 3_500)).toBe(0);
    expect(lastSungLineIndex(lyrics, 5_500)).toBe(1);
    expect(lastSungLineIndex(null, 3_500)).toBe(-1);
  });

  it('moves the view just before the next vocal without advancing the lyric cursor', () => {
    const lyrics = document([
      line({ id: 'one', text: 'One', startMs: 1_000, endMs: 4_000 }),
      line({ id: 'two', text: 'Two', startMs: 5_000, endMs: 6_000 }),
    ]);

    expect(lyricScrollTargetLineIndex(lyrics, 4_479)).toBe(0);
    expect(lyricScrollTargetLineIndex(lyrics, 4_480)).toBe(1);
    expect(selectLyricCursor(lyrics, 4_480).lineIndex).toBe(-1);
    expect(nextLyricPresentationBoundaryMs(lyrics, 4_000)).toBe(4_480);
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

  it('uses a symmetric eased envelope for word motion', () => {
    expect(wordMotionIntensity(-1)).toBe(0);
    expect(wordMotionIntensity(0)).toBe(0);
    expect(wordMotionIntensity(0.5)).toBeCloseTo(1);
    expect(wordMotionIntensity(1)).toBeCloseTo(0);
    expect(wordMotionIntensity(2)).toBeCloseTo(0);
  });

  it('disables animated lyric scrolling for reduced motion', () => {
    expect(lyricScrollBehavior(true)).toBe('auto');
    expect(lyricScrollBehavior(false)).toBe('smooth');
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
