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

  it('produces genuinely hue-free, readable tokens for the neutral palette', () => {
    for (const mode of ['dark', 'light'] as const) {
      const tokens = generateThemeTokens({
        mode,
        primary: '#A8C95E',
        secondary: '#7FA3A0',
        surfaceOpacity: 96,
        material: 'opaque',
        neutral: true,
      });
      for (const [name, value] of Object.entries(tokens)) {
        const hex = /#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})/i.exec(value);
        const rgb = /rgba\((\d+), (\d+), (\d+)/.exec(value);
        const [r, g, b] =
          (hex
            ? hex.slice(1).map((part) => Number.parseInt(part, 16))
            : rgb?.slice(1).map(Number)) ?? [];
        if (r !== undefined) expect([name, r, g], `${name}=${value}`).toEqual([name, g, b]);
      }
      const base = mode === 'dark' ? '#0F0F0F' : '#F5F5F5';
      expect(contrastRatio(tokens['--accent-primary']!, base)).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(tokens['--accent-primary']!, tokens['--accent-ink']!),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the tinted default when the neutral flag is absent', () => {
    const tokens = generateThemeTokens({
      mode: 'dark',
      primary: '#A8C95E',
      secondary: '#7FA3A0',
      surfaceOpacity: 96,
      material: 'opaque',
    });
    expect(tokens['--accent-primary']).toBe('#A8C95E');
    expect(tokens['--bg-opaque']).toBe('#11120F');
  });
});
