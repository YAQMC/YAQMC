import { describe, expect, it } from 'vitest';
import type { LyricDocument } from '../domain/music';
import { buildLyricsRenderModel } from './lyrics-render-model';

function document(overrides: Partial<LyricDocument> = {}): LyricDocument {
  return {
    songId: 'song-1',
    syncMode: 'word',
    metadata: {
      sourceLabel: 'test',
      offsetMs: 0,
    },
    vocalists: [],
    lines: [],
    ...overrides,
  };
}

describe('buildLyricsRenderModel', () => {
  it('preserves the existing word-synced AMLL presentation semantics', () => {
    const model = buildLyricsRenderModel(
      document({
        lines: [
          {
            id: 'line-1',
            startMs: 1000.4,
            endMs: 2200.6,
            text: 'hello world',
            translation: '你好世界',
            romanization: 'hello roman',
            vocalistId: 'response',
            words: [
              { startMs: 1000.4, endMs: 1499.6, text: 'hello ' },
              { startMs: 1500.2, endMs: 2200.6, text: 'world' },
            ],
          },
        ],
      }),
      'show',
      'show',
    );

    expect(model.lines).toEqual([
      {
        sourceLineIndex: 0,
        words: [
          { startTimeMs: 1000, endTimeMs: 1500, text: 'hello ' },
          { startTimeMs: 1500, endTimeMs: 2201, text: 'world' },
        ],
        translatedLyric: '你好世界',
        romanLyric: 'hello roman',
        startTimeMs: 1000,
        endTimeMs: 2201,
        isBackground: false,
        isDuet: true,
      },
    ]);
  });

  it('filters invalid timed words and falls back to the whole line when none remain', () => {
    const model = buildLyricsRenderModel(
      document({
        lines: [
          {
            id: 'line-1',
            startMs: 500,
            endMs: null,
            text: 'fallback',
            words: [
              { startMs: 500, endMs: 400, text: 'invalid' },
              { startMs: Number.NaN, endMs: 900, text: 'also invalid' },
              { startMs: 500, endMs: 1250, text: 'valid end source' },
            ],
          },
        ],
      }),
      'hide',
      'hide',
    );

    expect(model.lines[0]).toMatchObject({
      sourceLineIndex: 0,
      startTimeMs: 500,
      endTimeMs: 1250,
      words: [{ startTimeMs: 500, endTimeMs: 1250, text: 'valid end source' }],
    });
  });

  it('uses a whole-line timing atom for line-synchronized documents', () => {
    const model = buildLyricsRenderModel(
      document({
        syncMode: 'line',
        lines: [
          {
            id: 'line-1',
            startMs: 2000,
            endMs: 2600,
            text: 'whole line',
            words: [{ startMs: 2000, endMs: 2200, text: 'ignored word timing' }],
          },
        ],
      }),
      'hide',
      'hide',
    );

    expect(model.lines[0]?.words).toEqual([
      { startTimeMs: 2000, endTimeMs: 2600, text: 'whole line' },
    ]);
  });

  it('keeps source indexes stable when invalid source lines are skipped', () => {
    const model = buildLyricsRenderModel(
      document({
        lines: [
          {
            id: 'invalid',
            startMs: null,
            endMs: null,
            text: 'skip me',
            words: [],
          },
          {
            id: 'valid',
            startMs: 3000,
            endMs: 3500,
            text: 'keep me',
            words: [],
          },
        ],
      }),
      'hide',
      'hide',
    );

    expect(model.lines).toHaveLength(1);
    expect(model.lines[0]?.sourceLineIndex).toBe(1);
  });
});
