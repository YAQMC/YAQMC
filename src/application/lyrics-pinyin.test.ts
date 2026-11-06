import { describe, expect, it } from 'vitest';
import type { LyricDocument } from '../domain/music';
import { needsGeneratedPinyin, withGeneratedPinyin } from './lyrics-pinyin';

function lyrics(language: string | undefined, romanization?: string): LyricDocument {
  return {
    songId: 'song',
    syncMode: 'word',
    metadata: { sourceLabel: 'test', offsetMs: 0, language },
    vocalists: [],
    lines: [
      {
        id: 'l1',
        startMs: 0,
        endMs: 1000,
        text: '十年之前 baby',
        romanization,
        words: [{ startMs: 0, endMs: 500, text: '十年' }],
      },
      { id: 'l2', startMs: 1000, endMs: 2000, text: 'Oh yeah', words: [] },
    ],
  };
}

describe('generated pinyin', () => {
  it('only applies to Mandarin without provider romanization', () => {
    expect(needsGeneratedPinyin(lyrics('cmn'))).toBe(true);
    expect(needsGeneratedPinyin(lyrics('yue'))).toBe(false);
    expect(needsGeneratedPinyin(lyrics(undefined))).toBe(false);
    expect(needsGeneratedPinyin(lyrics('zh-Hans'))).toBe(false);
    expect(needsGeneratedPinyin(lyrics('cmn', 'shi nian'))).toBe(false);
  });

  it('adds line-level pinyin to Han lines and leaves word timing alone', async () => {
    const source = lyrics('cmn');
    const generated = await withGeneratedPinyin(source);
    expect(generated.lines[0]?.romanization).toBe('shí nián zhī qián baby');
    expect(generated.lines[0]?.words).toBe(source.lines[0]?.words);
    expect(generated.lines[1]).toBe(source.lines[1]);
  });
});
