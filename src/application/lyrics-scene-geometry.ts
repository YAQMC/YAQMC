import type { CSSProperties } from 'react';
import type { WidgetAnchor, WidgetTransform } from './lyrics-preset';

export const ANCHOR_FRACTIONS: Record<WidgetAnchor, readonly [number, number]> = {
  'top-left': [0, 0],
  'top-center': [0.5, 0],
  'top-right': [1, 0],
  'center-left': [0, 0.5],
  center: [0.5, 0.5],
  'center-right': [1, 0.5],
  'bottom-left': [0, 1],
  'bottom-center': [0.5, 1],
  'bottom-right': [1, 1],
};

export interface WidgetEdges {
  left: number;
  top: number;
  right: number;
  bottom: number;
  centerX: number;
  centerY: number;
  width: number;
  height: number;
}

export function widgetEdges(
  box: Pick<WidgetTransform, 'x' | 'y' | 'width' | 'height' | 'anchor'>,
): WidgetEdges {
  const [ax, ay] = ANCHOR_FRACTIONS[box.anchor];
  const left = box.x - ax * box.width;
  const top = box.y - ay * box.height;
  return {
    left,
    top,
    right: left + box.width,
    bottom: top + box.height,
    centerX: left + box.width / 2,
    centerY: top + box.height / 2,
    width: box.width,
    height: box.height,
  };
}

export function placeWidget(
  edges: Pick<WidgetEdges, 'left' | 'top' | 'width' | 'height'>,
  anchor: WidgetAnchor,
): { x: number; y: number } {
  const [ax, ay] = ANCHOR_FRACTIONS[anchor];
  return {
    x: edges.left + ax * edges.width,
    y: edges.top + ay * edges.height,
  };
}

export function widgetBoxStyle(box: WidgetTransform): CSSProperties {
  const [ax, ay] = ANCHOR_FRACTIONS[box.anchor];
  return {
    position: 'absolute',
    left: `${box.x * 100}%`,
    top: `${box.y * 100}%`,
    width: `${box.width * 100}%`,
    height: `${box.height * 100}%`,
    transform: `translate(${-ax * 100}%, ${-ay * 100}%)`,
    zIndex: box.zIndex,
    visibility: box.visible ? 'visible' : 'hidden',
    pointerEvents: box.visible ? 'auto' : 'none',
  };
}

export const SNAP_THRESHOLD = 0.012;
export const MARGIN_GUIDES = [0.04, 0.5, 0.96];

export interface SnapGuide {
  axis: 'x' | 'y';
  position: number;
}

export function snapNumber(
  value: number,
  targets: number[],
  threshold = SNAP_THRESHOLD,
): number | null {
  let best: number | null = null;
  let bestDistance = threshold;
  for (const target of targets) {
    const distance = Math.abs(value - target);
    if (distance <= bestDistance) {
      best = target;
      bestDistance = distance;
    }
  }
  return best;
}

export function snapWidgetPosition(
  box: WidgetTransform,
  siblings: WidgetTransform[],
  bypass: boolean,
): { x: number; y: number; guides: SnapGuide[] } {
  if (bypass) return { x: box.x, y: box.y, guides: [] };
  const moving = widgetEdges(box);
  const targetsX = [...MARGIN_GUIDES];
  const targetsY = [...MARGIN_GUIDES];
  for (const sibling of siblings.filter((item) => item.visible)) {
    const edges = widgetEdges(sibling);
    targetsX.push(edges.left, edges.centerX, edges.right);
    targetsY.push(edges.top, edges.centerY, edges.bottom);
  }
  const guides: SnapGuide[] = [];
  let left = moving.left;
  let top = moving.top;
  const snappedLeft = snapNumber(moving.left, targetsX) ?? snapNumber(moving.centerX, targetsX);
  const snappedTop = snapNumber(moving.top, targetsY) ?? snapNumber(moving.centerY, targetsY);
  if (snappedLeft !== null) {
    if (Math.abs(moving.left - snappedLeft) <= SNAP_THRESHOLD) left = snappedLeft;
    else left = snappedLeft - moving.width / 2;
    guides.push({ axis: 'x', position: snappedLeft });
  }
  if (snappedTop !== null) {
    if (Math.abs(moving.top - snappedTop) <= SNAP_THRESHOLD) top = snappedTop;
    else top = snappedTop - moving.height / 2;
    guides.push({ axis: 'y', position: snappedTop });
  }
  const placed = placeWidget({ left, top, width: moving.width, height: moving.height }, box.anchor);
  return { x: placed.x, y: placed.y, guides };
}

export function nudgeWidget(
  box: WidgetTransform,
  dx: number,
  dy: number,
): { x: number; y: number } {
  return { x: box.x + dx, y: box.y + dy };
}
