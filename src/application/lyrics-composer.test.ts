import { describe, expect, it } from 'vitest';
import { factoryScene } from './lyrics-preset';
import { nudgeWidget, snapWidgetPosition, widgetEdges } from './lyrics-scene-geometry';
import { clonePresetDraft, pushComposerHistory } from './lyrics-composer';
import { builtinPresetCatalog } from './lyrics-preset';

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
