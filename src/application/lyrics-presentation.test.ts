import { describe, expect, it } from 'vitest';
import { shouldShowLyricSecondary } from './lyrics-presentation';

describe('lyric language presentation', () => {
  it('keeps UI language independent from original lyric content', () => {
    expect(shouldShowLyricSecondary('auto', 'Morning light', '晨光', 'translation')).toBe(true);
    expect(shouldShowLyricSecondary('auto', 'chen guang', '晨光', 'romanization')).toBe(true);
    expect(shouldShowLyricSecondary('auto', 'Hello', 'Hello', 'translation')).toBe(false);
  });

  it('honors explicit show and hide preferences', () => {
    expect(shouldShowLyricSecondary('hide', '译文', 'Original', 'translation')).toBe(false);
    expect(shouldShowLyricSecondary('show', 'romanized', 'Original', 'romanization')).toBe(true);
  });
});
