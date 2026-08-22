// @ts-expect-error Vitest runs in Node; the renderer tsconfig does not include Node types.
import { readFileSync } from 'node:fs';
// @ts-expect-error Vitest runs in Node; the renderer tsconfig does not include Node types.
import { dirname, join } from 'node:path';
// @ts-expect-error Vitest runs in Node; the renderer tsconfig does not include Node types.
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  drivePercentageClock,
  freezePercentageClock,
  surfaceVisualActive,
  syncSurfaceVisualDataset,
} from './lyrics-surface-visual';

afterEach(() => {
  delete document.documentElement.dataset.compositorProbe;
  delete document.documentElement.dataset.surfaceVisual;
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'visible',
  });
});

describe('lyrics surface visual clock', () => {
  it('is idle when the overlay document is hidden, host-idle, or animation is probed off', () => {
    expect(surfaceVisualActive()).toBe(true);
    document.documentElement.dataset.surfaceVisual = 'idle';
    expect(surfaceVisualActive()).toBe(false);
    delete document.documentElement.dataset.surfaceVisual;
    document.documentElement.dataset.compositorProbe = 'no-surface-anim';
    expect(surfaceVisualActive()).toBe(false);
    delete document.documentElement.dataset.compositorProbe;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    expect(surfaceVisualActive()).toBe(false);
  });

  it('mirrors document hidden into data-surface-visual without forcing active', () => {
    syncSurfaceVisualDataset();
    expect(document.documentElement.dataset.surfaceVisual).not.toBe('idle');
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    syncSurfaceVisualDataset();
    expect(document.documentElement.dataset.surfaceVisual).toBe('idle');
  });

  it('does not start a minutes-long CSS transition for Island-length remaining time', () => {
    const node = document.createElement('span');
    document.body.append(node);
    drivePercentageClock(node, '--island-progress', 0.25, 180_000);
    expect(node.style.transition).toBe('none');
    expect(node.style.getPropertyValue('--island-progress')).toBe('25%');
    drivePercentageClock(node, '--word-progress', 0.2, 400);
    expect(node.style.transition).toBe('--word-progress 400ms linear');
    expect(node.style.getPropertyValue('--word-progress')).toBe('100%');
    freezePercentageClock(node, '--island-progress', 0.5);
    expect(node.style.getPropertyValue('--island-progress')).toBe('50%');
    node.remove();
  });

  it('is not imported by the main-window Fullscreen Lyrics renderer', () => {
    const srcDir = dirname(fileURLToPath(import.meta.url));
    const repoSrc = join(srcDir, '..');
    for (const relative of [
      'App.tsx',
      'components/LyricsPanel.tsx',
      'components/lyrics-scene/LyricsViewport.tsx',
    ]) {
      const source = readFileSync(join(repoSrc, relative), 'utf8');
      expect(source, relative).not.toContain('lyrics-surface-visual');
      expect(source, relative).not.toContain('surfaceVisualActive');
    }
  });
});
