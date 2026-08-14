import type { LyricsPreviewFrame, WidgetTransform } from './lyrics-preset';
import { placeWidget, widgetEdges } from './lyrics-scene-geometry';

export const DESKTOP_SCENE_WIDTH = 1920;
export const DESKTOP_SCENE_HEIGHT = 1080;
export const ULTRAWIDE_SCENE_WIDTH = 2560;
export const DRAG_THRESHOLD_PX = 4;

export interface SceneSize {
  width: number;
  height: number;
}

export interface UniformFit {
  scale: number;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
}

export type ComposerZoom = 'fit' | 1 | 0.75 | 0.5;

export function logicalSceneSize(
  frame: LyricsPreviewFrame,
  windowSize: SceneSize = { width: DESKTOP_SCENE_WIDTH, height: DESKTOP_SCENE_HEIGHT },
): SceneSize {
  if (frame === 'ultrawide') {
    return { width: ULTRAWIDE_SCENE_WIDTH, height: DESKTOP_SCENE_HEIGHT };
  }
  if (frame === 'window') {
    const height = Math.max(1, windowSize.height);
    const aspect = Math.max(0.5, Math.min(3, windowSize.width / height));
    return { width: Math.round(DESKTOP_SCENE_HEIGHT * aspect), height: DESKTOP_SCENE_HEIGHT };
  }
  return { width: DESKTOP_SCENE_WIDTH, height: DESKTOP_SCENE_HEIGHT };
}

export function sceneAspectRatio(size: SceneSize): number {
  return size.width / Math.max(size.height, 1);
}

export function fitUniformScene(available: SceneSize, logical: SceneSize): UniformFit {
  const availableWidth = Math.max(0, available.width);
  const availableHeight = Math.max(0, available.height);
  const logicalWidth = Math.max(1, logical.width);
  const logicalHeight = Math.max(1, logical.height);
  const scale =
    availableWidth === 0 || availableHeight === 0
      ? 0
      : Math.min(availableWidth / logicalWidth, availableHeight / logicalHeight);
  const width = logicalWidth * scale;
  const height = logicalHeight * scale;
  return {
    scale,
    width,
    height,
    offsetX: (availableWidth - width) / 2,
    offsetY: (availableHeight - height) / 2,
  };
}

export function composerStageFit(
  available: SceneSize,
  logical: SceneSize,
  zoom: ComposerZoom,
): UniformFit {
  const usable =
    available.width < 8 || available.height < 8
      ? { width: logical.width, height: logical.height }
      : available;
  const fitted = fitUniformScene(usable, logical);
  if (zoom === 'fit' || fitted.scale === 0) return fitted;
  const scale = Math.min(fitted.scale, zoom);
  const width = logical.width * scale;
  const height = logical.height * scale;
  return {
    scale,
    width,
    height,
    offsetX: (usable.width - width) / 2,
    offsetY: (usable.height - height) / 2,
  };
}

export function screenDeltaToNormalized(
  dx: number,
  dy: number,
  scale: number,
  logical: SceneSize,
): { x: number; y: number } {
  const safeScale = scale === 0 ? 1 : scale;
  return {
    x: dx / safeScale / Math.max(logical.width, 1),
    y: dy / safeScale / Math.max(logical.height, 1),
  };
}

export function normalizedToScreen(
  x: number,
  y: number,
  scale: number,
  logical: SceneSize,
): { x: number; y: number } {
  return {
    x: x * logical.width * scale,
    y: y * logical.height * scale,
  };
}

export function visualPixelSize(
  box: Pick<WidgetTransform, 'width' | 'height'>,
  aspect: number,
): { width: number; height: number } {
  return {
    width: box.width * aspect,
    height: box.height,
  };
}

export function inscribedVisualSquare(box: WidgetTransform, sceneAspect: number): WidgetTransform {
  const aspect = Math.max(sceneAspect, 0.0001);
  const edges = widgetEdges(box);
  const normWidth = Math.min(box.width, box.height / aspect);
  const normHeight = Math.min(box.height, box.width * aspect);
  const left = edges.left + (edges.width - normWidth) / 2;
  const top = edges.top + (edges.height - normHeight) / 2;
  const placed = placeWidget({ left, top, width: normWidth, height: normHeight }, box.anchor);
  return { ...box, ...placed, width: normWidth, height: normHeight };
}

export function constrainVisualSquare(
  width: number,
  height: number,
  sceneAspect: number,
  prefer: 'width' | 'height' | 'min' = 'min',
): { width: number; height: number } {
  const aspect = Math.max(sceneAspect, 0.0001);
  const minSize = 0.08;
  if (prefer === 'width') {
    const nextWidth = Math.max(minSize, width);
    return { width: nextWidth, height: Math.max(minSize, nextWidth * aspect) };
  }
  if (prefer === 'height') {
    const nextHeight = Math.max(minSize, height);
    return { width: Math.max(minSize, nextHeight / aspect), height: nextHeight };
  }
  const visual = visualPixelSize({ width, height }, aspect);
  const side = Math.max(minSize, Math.min(visual.width, visual.height));
  return { width: side / aspect, height: side };
}

export function overlayBoundsForWidget(
  box: WidgetTransform,
  kind: 'vinyl' | 'box',
  sceneAspect: number,
): WidgetTransform {
  return kind === 'vinyl' ? inscribedVisualSquare(box, sceneAspect) : box;
}

export function percentFromUnit(value: number): number {
  return Math.round(value * 1000) / 10;
}

export function unitFromPercent(value: number): number {
  return value / 100;
}
