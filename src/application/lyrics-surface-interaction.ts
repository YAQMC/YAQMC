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
