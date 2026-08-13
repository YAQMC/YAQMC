import { describe, expect, it } from 'vitest';
import type { Artwork } from '../domain/music';
import { resolveArtworkSource } from './artwork-resolver';

const albumArtwork: Artwork = {
  src: 'https://y.gtimg.cn/medium.jpg',
  alt: 'Album cover',
  dominantColor: '#123456',
  variants: [
    { src: 'https://y.gtimg.cn/150.jpg', width: 150, height: 150 },
    { src: 'https://y.gtimg.cn/300.jpg', width: 300, height: 300 },
    { src: 'https://y.gtimg.cn/500.jpg', width: 500, height: 500 },
    { src: 'https://y.gtimg.cn/800.jpg', width: 800, height: 800 },
  ],
};

describe('resolveArtworkSource', () => {
  it.each([
    ['small', 'https://y.gtimg.cn/150.jpg'],
    ['medium', 'https://y.gtimg.cn/300.jpg'],
    ['large', 'https://y.gtimg.cn/500.jpg'],
    ['fullscreen', 'https://y.gtimg.cn/800.jpg'],
  ] as const)('selects the bounded %s variant', (purpose, expected) => {
    expect(resolveArtworkSource(albumArtwork, purpose)).toBe(expected);
  });

  it('uses the smallest sufficient variant when an exact size is unavailable', () => {
    expect(
      resolveArtworkSource(
        {
          ...albumArtwork,
          variants: albumArtwork.variants?.filter((variant) => variant.width !== 500),
        },
        'large',
      ),
    ).toBe('https://y.gtimg.cn/800.jpg');
  });

  it('uses the largest known variant rather than inventing a URL', () => {
    expect(
      resolveArtworkSource(
        {
          ...albumArtwork,
          variants: albumArtwork.variants?.slice(0, 2),
        },
        'fullscreen',
      ),
    ).toBe('https://y.gtimg.cn/300.jpg');
  });

  it('preserves the provider source when no measured variants exist', () => {
    expect(resolveArtworkSource({ ...albumArtwork, variants: undefined }, 'fullscreen')).toBe(
      albumArtwork.src,
    );
  });

  it('ignores malformed variants', () => {
    expect(
      resolveArtworkSource(
        {
          ...albumArtwork,
          variants: [
            { src: '', width: 800, height: 800 },
            { src: 'https://y.gtimg.cn/invalid.jpg', width: Number.NaN, height: 800 },
          ],
        },
        'fullscreen',
      ),
    ).toBe(albumArtwork.src);
  });
});
