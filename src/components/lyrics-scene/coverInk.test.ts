import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../../application/theme-tokens';
import { coverInk } from './coverInk';

describe('coverInk', () => {
  it('chooses a WCAG AA foreground for both light and dark lyric backdrops', () => {
    for (const background of ['#F4DFC5', '#1B2538', '#75856F', '#D13F75']) {
      const { ink } = coverInk(background);
      expect(contrastRatio(background, ink)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps a safe light fallback for malformed artwork metadata', () => {
    expect(coverInk('not-a-color')).toEqual({ ink: '#ffffff', contrast: '#10140c' });
  });

  it('selects against the scene treatment for a pale cover', () => {
    const { ink } = coverInk('#F4DFC5', { dimmed: true });
    expect(ink).toBe('#FFFFFF');
    expect(contrastRatio('#49433B', ink)).toBeGreaterThanOrEqual(4.5);
  });
});
