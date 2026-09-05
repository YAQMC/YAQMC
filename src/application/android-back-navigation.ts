export type AndroidBackAction =
  'close-account-dialog' | 'close-player-surface' | 'navigate-back' | 'exit-app';

export interface AndroidBackState {
  accountDialogOpen: boolean;
  playerSurfaceOpen: boolean;
  canNavigateBack: boolean;
}

/**
 * Keep Android's Back behavior deterministic: dismiss transient UI before
 * changing the application route, and only finish the Activity at the root.
 */
export function androidBackAction(state: AndroidBackState): AndroidBackAction {
  if (state.accountDialogOpen) return 'close-account-dialog';
  if (state.playerSurfaceOpen) return 'close-player-surface';
  if (state.canNavigateBack) return 'navigate-back';
  return 'exit-app';
}
