import { describe, expect, it } from 'vitest';
import { pointerInsideSurface, showsEditingChrome, visibleSurfaceInteractionState } from './lyrics-surface-interaction';

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

  it('keeps hover when expansion geometry still contains the pointer', () => {
    const root = document.createElement('div');
    root.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 200, bottom: 140, width: 200, height: 140, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    expect(pointerInsideSurface(root, 40, 80)).toBe(true);
    expect(pointerInsideSurface(root, 400, 80)).toBe(false);
    expect(pointerInsideSurface(null, 40, 80)).toBe(false);
  });
});
