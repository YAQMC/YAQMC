import { afterEach, describe, expect, it } from 'vitest';
import {
  applySceneBackdrop,
  resolveLyricsAppearance,
  type LyricsAppearanceBackground,
} from './lyrics-appearance';

const managedImage = 'data:image/png;base64,AA==';
const safeArtwork = 'data:image/webp;base64,AQ==';

function background(
  mode: LyricsAppearanceBackground['mode'],
  overrides: Partial<LyricsAppearanceBackground> = {},
): LyricsAppearanceBackground {
  return {
    mode,
    imageSource: null,
    imageFit: 'cover',
    color: '#20231C',
    ...overrides,
  };
}

describe('immersive lyrics appearance projection', () => {
  afterEach(() => document.documentElement.removeAttribute('data-theme'));

  for (const theme of ['light', 'dark'] as const) {
    it.each([
      {
        label: 'default',
        input: background('default'),
        expected: {
          mode: 'default',
          imageSource: safeArtwork,
          imageFit: 'cover',
          baseColor: null,
        },
      },
      {
        label: 'color',
        input: background('color', { color: '#abc' }),
        expected: {
          mode: 'color',
          imageSource: null,
          imageFit: 'cover',
          baseColor: '#AABBCC',
        },
      },
      {
        label: 'managed cover image',
        input: background('image', { imageSource: managedImage }),
        expected: {
          mode: 'image',
          imageSource: managedImage,
          imageFit: 'cover',
          baseColor: '#20231C',
        },
      },
      {
        label: 'managed contain image',
        input: background('image', { imageSource: managedImage, imageFit: 'contain' }),
        expected: {
          mode: 'image',
          imageSource: managedImage,
          imageFit: 'contain',
          baseColor: '#20231C',
        },
      },
      {
        label: 'resolved artwork',
        input: background('artwork', { imageFit: 'contain' }),
        expected: {
          mode: 'artwork',
          imageSource: safeArtwork,
          imageFit: 'cover',
          baseColor: null,
        },
      },
    ])(`returns only truthful primitives for $label in ${theme} theme`, ({ input, expected }) => {
      document.documentElement.dataset.theme = theme;
      expect(resolveLyricsAppearance(input, safeArtwork)).toStrictEqual(expected);
    });
  }

  it.each([
    { mode: 'image' as const, imageSource: null },
    { mode: 'image' as const, imageSource: 'https://example.com/raw.jpg' },
    { mode: 'image' as const, imageSource: 'data:text/plain;base64,QQ==' },
    { mode: 'artwork' as const, imageSource: null },
  ])('keeps missing or unsafe $mode sources out of the projection', ({ mode, imageSource }) => {
    const input = background(mode, { imageSource });
    expect(
      resolveLyricsAppearance(input, mode === 'artwork' ? null : safeArtwork).imageSource,
    ).toBeNull();
  });

  it.each([
    { value: 'not-a-color', expected: '#20231C' },
    { value: '#123456', expected: '#123456' },
    { value: ' 789 ', expected: '#778899' },
  ])('normalizes color background $value', ({ value, expected }) => {
    expect(resolveLyricsAppearance(background('color', { color: value }), null).baseColor).toBe(
      expected,
    );
  });

  it('keeps the raw cover when blur is still rendering', () => {
    expect(
      applySceneBackdrop(resolveLyricsAppearance(background('default'), safeArtwork), 22, null),
    ).toEqual({
      mode: 'default',
      imageSource: safeArtwork,
      imageFit: 'cover',
      baseColor: null,
    });
    expect(
      applySceneBackdrop(
        resolveLyricsAppearance(background('default'), safeArtwork),
        22,
        managedImage,
      ),
    ).toMatchObject({ imageSource: managedImage });
    expect(
      applySceneBackdrop(
        resolveLyricsAppearance(background('default'), safeArtwork),
        0,
        managedImage,
      ),
    ).toMatchObject({ imageSource: safeArtwork });
  });

  it('uses the scene fallback color for Contain letterboxing', () => {
    expect(
      resolveLyricsAppearance(
        background('image', { imageSource: managedImage, imageFit: 'contain', color: '#31415a' }),
        safeArtwork,
      ),
    ).toMatchObject({
      imageFit: 'contain',
      baseColor: '#31415A',
    });
  });
});
