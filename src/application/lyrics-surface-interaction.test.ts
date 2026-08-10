import { describe, expect, it } from 'vitest';
import { showsEditingChrome, visibleSurfaceInteractionState } from './lyrics-surface-interaction';

describe('lyric-surface interaction state', () => {
  it('reveals editing chrome only while an interactive surface is hovered', () => {
    expect(showsEditingChrome(visibleSurfaceInteractionState('interactive', false))).toBe(false);
    expect(showsEditingChrome(visibleSurfaceInteractionState('interactive', true))).toBe(true);
  });

  it('never activates hover chrome for a passive locked surface', () => {
    const locked = visibleSurfaceInteractionState('passive-locked', true);
    expect(locked).toBe('visible-passive-locked');
    expect(showsEditingChrome(locked)).toBe(false);
  });
});
