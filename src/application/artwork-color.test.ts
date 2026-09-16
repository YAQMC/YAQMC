import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cachedArtworkPalette,
  clearArtworkPaletteCacheForTests,
  colorFieldEmitterColor,
  hexFromRgb,
  hslToRgb,
  rememberArtworkPalette,
  resolveArtworkPalette,
  rgbToHsl,
  sampleImage,
} from './artwork-color';

describe('artwork color cache and lifecycle', () => {
  beforeEach(() => {
    clearArtworkPaletteCacheForTests();
    vi.restoreAllMocks();
  });

  it('returns cached palette by identity and prefers bound artwork colors', () => {
    rememberArtworkPalette({
      identity: 'song-a',
      primary: '#112233',
      secondary: '#445566',
      revision: 1,
    });
    expect(cachedArtworkPalette('song-a')?.primary).toBe('#112233');
    expect(
      colorFieldEmitterColor(
        { color: '#FFFFFF', bind: 'artworkPrimary' },
        cachedArtworkPalette('song-a'),
      ),
    ).toBe('#112233');
    expect(
      colorFieldEmitterColor(
        { color: '#FFFFFF', bind: 'artworkSecondary' },
        cachedArtworkPalette('song-a'),
      ),
    ).toBe('#445566');
    expect(colorFieldEmitterColor({ color: '#ABCDEF' }, null)).toBe('#ABCDEF');
  });

  it('does NOT poison cache with fallback when source is null or empty', async () => {
    const fallback = '#6B4F46';
    const initial = await resolveArtworkPalette('track-pending', null, fallback, 1);

    expect(initial.primary).toBe(fallback);
    expect(initial.secondary).toBe(fallback);
    // Cache MUST remain null so subsequent data URI update triggers real extraction
    expect(cachedArtworkPalette('track-pending')).toBeNull();
  });

  it('evicts oldest entries when exceeding MAX_CACHE (24 entries)', () => {
    for (let i = 0; i < 26; i++) {
      rememberArtworkPalette({
        identity: `song-${i}`,
        primary: `#0000${i.toString(16).padStart(2, '0')}`,
        secondary: `#1111${i.toString(16).padStart(2, '0')}`,
        revision: i,
      });
    }

    // song-0 and song-1 should have been evicted
    expect(cachedArtworkPalette('song-0')).toBeNull();
    expect(cachedArtworkPalette('song-1')).toBeNull();
    expect(cachedArtworkPalette('song-2')).not.toBeNull();
    expect(cachedArtworkPalette('song-25')).not.toBeNull();
  });
});

describe('color space conversions', () => {
  it('converts RGB to HSL and back without loss', () => {
    const testCases: [number, number, number][] = [
      [255, 0, 0], // Red
      [0, 255, 0], // Green
      [0, 0, 255], // Blue
      [255, 165, 0], // Orange
      [255, 255, 255], // White
      [0, 0, 0], // Black
      [128, 128, 128], // Gray
    ];

    for (const [r, g, b] of testCases) {
      const [h, s, l] = rgbToHsl(r, g, b);
      const [recR, recG, recB] = hslToRgb(h, s, l);
      expect(recR).toBeCloseTo(r, -1);
      expect(recG).toBeCloseTo(g, -1);
      expect(recB).toBeCloseTo(b, -1);
    }
  });

  it('formats uppercase hex from rgb', () => {
    expect(hexFromRgb(255, 165, 0)).toBe('#FFA500');
    expect(hexFromRgb(0, 0, 0)).toBe('#000000');
    expect(hexFromRgb(255, 255, 255)).toBe('#FFFFFF');
  });
});

describe('sampleImage color extraction algorithm', () => {
  function createMockImageSource(
    pixels: { r: number; g: number; b: number; a?: number }[],
  ): CanvasImageSource {
    const totalPixels = 48 * 48; // 2304
    const data = new Uint8ClampedArray(totalPixels * 4);

    for (let i = 0; i < totalPixels; i++) {
      const spec = pixels[i % pixels.length]!;
      data[i * 4] = spec.r;
      data[i * 4 + 1] = spec.g;
      data[i * 4 + 2] = spec.b;
      data[i * 4 + 3] = spec.a ?? 255;
    }

    const mockCanvas = {
      width: 48,
      height: 48,
      getContext: () => ({
        drawImage: () => {},
        getImageData: () => ({ data }),
      }),
    };

    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      if (tagName === 'canvas') return mockCanvas as unknown as HTMLCanvasElement;
      return document.createElement(tagName);
    });

    return {} as CanvasImageSource;
  }

  it('extracts distinct dominant Primary and vibrant Secondary on blue/orange contrast artwork', () => {
    // 70% deep blue (#1E40AF -> r: 30, g: 64, b: 175), 20% bright orange (#F97316 -> r: 249, g: 115, b: 22), 10% black border
    const pixels = [
      ...Array(70).fill({ r: 30, g: 64, b: 175 }),
      ...Array(20).fill({ r: 249, g: 115, b: 22 }),
      ...Array(10).fill({ r: 5, g: 5, b: 5 }),
    ];

    const source = createMockImageSource(pixels);
    const result = sampleImage(source, '#111111');

    const [primH, primS] = rgbToHsl(
      parseInt(result.primary.slice(1, 3), 16),
      parseInt(result.primary.slice(3, 5), 16),
      parseInt(result.primary.slice(5, 7), 16),
    );

    const [secH, secS, secL] = rgbToHsl(
      parseInt(result.secondary.slice(1, 3), 16),
      parseInt(result.secondary.slice(3, 5), 16),
      parseInt(result.secondary.slice(5, 7), 16),
    );

    // Primary should be in the blue hue sector (~210 - 240 deg) with solid saturation
    expect(primH).toBeGreaterThan(190);
    expect(primH).toBeLessThan(250);
    expect(primS).toBeGreaterThan(0.4);

    // Secondary should be in the warm orange hue sector (~10 - 45 deg) with vibrant saturation
    expect(secH).toBeGreaterThanOrEqual(10);
    expect(secH).toBeLessThanOrEqual(45);
    expect(secS).toBeGreaterThan(0.4);
    // Secondary luminance should be lifted for glowing lyrics
    expect(secL).toBeGreaterThanOrEqual(0.4);
  });

  it('lifts dark accent luminance for dark mood artwork to prevent black text shadows', () => {
    // 80% very dark charcoal (#111318), 20% dark crimson (#660A1A)
    const pixels = [
      ...Array(80).fill({ r: 17, g: 19, b: 24 }),
      ...Array(20).fill({ r: 102, g: 10, b: 26 }),
    ];

    const source = createMockImageSource(pixels);
    const result = sampleImage(source, '#000000');

    const [, , secL] = rgbToHsl(
      parseInt(result.secondary.slice(1, 3), 16),
      parseInt(result.secondary.slice(3, 5), 16),
      parseInt(result.secondary.slice(5, 7), 16),
    );

    // Secondary should NOT be murky black (L < 0.2), it must be lifted >= 0.45
    expect(secL).toBeGreaterThanOrEqual(0.45);
  });

  it('produces clean contrast for monochrome grayscale artwork', () => {
    const pixels = Array(100).fill({ r: 35, g: 35, b: 35 });
    const source = createMockImageSource(pixels);
    const result = sampleImage(source, '#111111');

    expect(result.primary).toBe('#232323');
    // For dark monochrome, secondary should be high-contrast light tone
    const [, , secL] = rgbToHsl(
      parseInt(result.secondary.slice(1, 3), 16),
      parseInt(result.secondary.slice(3, 5), 16),
      parseInt(result.secondary.slice(5, 7), 16),
    );
    expect(secL).toBeGreaterThanOrEqual(0.7);
  });

  it('falls back to provided fallback when image is completely transparent', () => {
    const pixels = Array(10).fill({ r: 255, g: 0, b: 0, a: 0 });
    const source = createMockImageSource(pixels);
    const result = sampleImage(source, '#556677');

    expect(result.primary).toBe('#556677');
    expect(result.secondary).toBe('#556677');
  });
});
