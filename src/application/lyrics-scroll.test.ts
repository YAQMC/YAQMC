import { describe, expect, it } from 'vitest';
import { lyricScrollSpringStepSeconds, lyricScrollWaveIntensity } from './lyrics-scroll';

describe('lyric scroll spring timing', () => {
  it('uses the browser frame duration while clamping stalled frames', () => {
    expect(lyricScrollSpringStepSeconds(null, 100)).toBeCloseTo(1 / 60);
    expect(lyricScrollSpringStepSeconds(100, 116)).toBeCloseTo(0.016);
    expect(lyricScrollSpringStepSeconds(100, 500)).toBeCloseTo(1 / 20);
  });

  it('falls back to one safe frame for invalid or non-advancing timestamps', () => {
    expect(lyricScrollSpringStepSeconds(100, 100)).toBeCloseTo(1 / 60);
    expect(lyricScrollSpringStepSeconds(100, Number.NaN)).toBeCloseTo(1 / 60);
  });
});

describe('lyric scroll wave intensity', () => {
  it('keeps micro-adjustments still and scales the wave with meaningful travel', () => {
    expect(lyricScrollWaveIntensity(0)).toBe(0);
    expect(lyricScrollWaveIntensity(15)).toBe(0);
    expect(lyricScrollWaveIntensity(68)).toBeCloseTo(0.5);
    expect(lyricScrollWaveIntensity(120)).toBe(1);
    expect(lyricScrollWaveIntensity(800)).toBe(1);
  });
});
