import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  generateThemeTokens,
  isValidHexColor,
  normalizeHexColor,
  readableForeground,
} from './theme-tokens';

describe('theme token generation', () => {
  it('normalizes valid colors and rejects malformed input', () => {
    expect(normalizeHexColor('#abc')).toBe('#AABBCC');
    expect(normalizeHexColor('16324f')).toBe('#16324F');
    expect(normalizeHexColor('not-a-color', '#123456')).toBe('#123456');
    expect(isValidHexColor('#12ff8a')).toBe(true);
    expect(isValidHexColor('#12xz8a')).toBe(false);
  });

  it('derives hover, active, secondary, and readable foreground tokens', () => {
    const tokens = generateThemeTokens({
      mode: 'dark',
      primary: '#F7F7F7',
      secondary: '#426B80',
      surfaceOpacity: 90,
      material: 'translucent',
    });
    expect(tokens['--accent-primary']).toBe('#F7F7F7');
    expect(tokens['--accent-primary-hover']).not.toBe(tokens['--accent-primary']);
    expect(tokens['--accent-secondary-muted']).toMatch(/^rgba/);
    expect(tokens['--accent-ink']).toBe('#11130F');
    expect(Number(tokens['--surface-base-alpha'])).toBeGreaterThanOrEqual(0.78);
  });

  it('selects a foreground with WCAG AA contrast for representative accents', () => {
    for (const color of ['#E85D68', '#4C9FE8', '#A8C95E', '#111111', '#F8F8F8']) {
      expect(contrastRatio(color, readableForeground(color))).toBeGreaterThanOrEqual(4.5);
    }
  });
});
