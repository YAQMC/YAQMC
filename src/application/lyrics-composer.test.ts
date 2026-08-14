import { describe, expect, it } from 'vitest';
import { factoryScene } from './lyrics-preset';
import { nudgeWidget, snapWidgetPosition, widgetEdges } from './lyrics-scene-geometry';
import { clonePresetDraft, pushComposerHistory } from './lyrics-composer';
import { builtinPresetCatalog } from './lyrics-preset';
import {
  composerStageFit,
  constrainVisualSquare,
  fitUniformScene,
  inscribedVisualSquare,
  logicalSceneSize,
  normalizedToScreen,
  overlayBoundsForWidget,
  screenDeltaToNormalized,
} from './lyrics-composer-view';

describe('lyrics composer geometry', () => {
  it('snaps a moving widget to the scene center and sibling edges', () => {
    const scene = factoryScene('split');
    const moving = { ...scene.artwork, x: 0.5, y: 0.5 };
    const snapped = snapWidgetPosition(moving, [scene.lyrics], false);
    expect(snapped.guides.length).toBeGreaterThan(0);
    const bypassed = snapWidgetPosition(moving, [scene.lyrics], true);
    expect(bypassed.x).toBe(0.5);
    expect(bypassed.guides).toEqual([]);
  });

  it('nudges using normalized scene coordinates', () => {
    const box = factoryScene('split').lyrics;
    const next = nudgeWidget(box, 0.01, -0.02);
    expect(next.x).toBeCloseTo(box.x + 0.01);
    expect(next.y).toBeCloseTo(box.y - 0.02);
    expect(widgetEdges(box).width).toBeCloseTo(box.width);
  });

  it('records one undo snapshot per committed gesture', () => {
    const original = builtinPresetCatalog[0]!;
    const moved = clonePresetDraft(original);
    moved.scene.artwork.x = 0.4;
    const history = pushComposerHistory([], original);
    expect(history).toHaveLength(1);
    expect(history[0]?.scene.artwork.x).toBe(original.scene.artwork.x);
    expect(moved.scene.artwork.x).toBe(0.4);
  });
});

describe('lyrics composer view transform', () => {
  it('fits a 1920×1080 scene with one uniform scale', () => {
    const fit = fitUniformScene({ width: 1200, height: 700 }, { width: 1920, height: 1080 });
    expect(fit.scale).toBeCloseTo(Math.min(1200 / 1920, 700 / 1080), 6);
    expect(fit.width / fit.height).toBeCloseTo(1920 / 1080, 6);
    expect(fit.width).toBeLessThanOrEqual(1200);
    expect(fit.height).toBeLessThanOrEqual(700);
  });

  it('maps logical points to screen and back through the same scale', () => {
    const logical = { width: 1920, height: 1080 };
    const fit = fitUniformScene({ width: 1200, height: 700 }, logical);
    const screen = normalizedToScreen(0.25, 0.4, fit.scale, logical);
    const back = screenDeltaToNormalized(screen.x, screen.y, fit.scale, logical);
    expect(back.x).toBeCloseTo(0.25, 6);
    expect(back.y).toBeCloseTo(0.4, 6);
    const delta = screenDeltaToNormalized(40, 20, fit.scale, logical);
    expect(delta.x * logical.width * fit.scale).toBeCloseTo(40, 6);
    expect(delta.y * logical.height * fit.scale).toBeCloseTo(20, 6);
  });

  it('keeps vinyl overlay visually square in 16:9 and other editor sizes', () => {
    const vinyl = factoryScene('vinyl').artwork;
    for (const aspect of [16 / 9, 4 / 3, 21 / 9]) {
      const square = inscribedVisualSquare(vinyl, aspect);
      const visualWidth = square.width * aspect;
      const visualHeight = square.height;
      expect(visualWidth / visualHeight).toBeCloseTo(1, 5);
    }
    const constrained = constrainVisualSquare(0.4, 0.2, 16 / 9);
    expect((constrained.width * 16) / 9 / constrained.height).toBeCloseTo(1, 5);
    expect(overlayBoundsForWidget(vinyl, 'vinyl', 16 / 9).width).toBeLessThan(vinyl.width);
    expect(overlayBoundsForWidget(vinyl, 'box', 16 / 9).width).toBe(vinyl.width);
  });

  it('does not serialize zoom into the fitted logical size', () => {
    const logical = logicalSceneSize('desktop');
    const fit = composerStageFit({ width: 1600, height: 900 }, logical, 'fit');
    const zoomed = composerStageFit({ width: 1600, height: 900 }, logical, 0.5);
    expect(logical.width).toBe(1920);
    expect(zoomed.scale).toBeCloseTo(Math.min(fit.scale, 0.5), 6);
    expect(zoomed.width / zoomed.height).toBeCloseTo(fit.width / fit.height, 6);
  });
});
