import type { SurfaceInteraction } from './preferences';

export type VisibleSurfaceInteractionState =
  'visible-interactive-idle' | 'visible-interactive-hover' | 'visible-passive-locked';

export function visibleSurfaceInteractionState(
  interaction: SurfaceInteraction,
  hovered: boolean,
): VisibleSurfaceInteractionState {
  if (interaction === 'passive-locked') return 'visible-passive-locked';
  return hovered ? 'visible-interactive-hover' : 'visible-interactive-idle';
}

export function showsEditingChrome(state: VisibleSurfaceInteractionState): boolean {
  return state === 'visible-interactive-hover';
}

export function pointerInsideSurface(
  root: Element | null,
  clientX: number,
  clientY: number,
): boolean {
  if (!root) return false;
  const hit =
    typeof document !== 'undefined' && typeof document.elementFromPoint === 'function'
      ? document.elementFromPoint(clientX, clientY)
      : null;
  if (hit && (root === hit || root.contains(hit))) return true;
  const rect = root.getBoundingClientRect();
  return (
    clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
  );
}
