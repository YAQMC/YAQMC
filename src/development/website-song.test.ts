import { describe, expect, it } from 'vitest';
import { websiteLyrics, websiteNotes, websiteSong } from './website-song';

describe('website demo song', () => {
  it('sings one Han character per melody note', () => {
    const melody = websiteNotes.filter((note) => !note.bass);
    const words = websiteLyrics.lines.flatMap((line) => line.words);
    expect(websiteLyrics.lines).toHaveLength(12);
    expect(words.map((word) => word.text.length)).toEqual(words.map(() => 1));
    expect(words.map((word) => word.startMs)).toEqual(melody.map((note) => note.startMs));
  });

  it('keeps every line in order and inside the song', () => {
    const starts = websiteLyrics.lines.map((line) => line.startMs ?? -1);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(websiteLyrics.lines.at(-1)?.endMs).toBeLessThan(websiteSong.durationMs);
  });
});
