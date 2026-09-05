import { describe, expect, it } from 'vitest';
import { androidBackAction } from './android-back-navigation';

describe('androidBackAction', () => {
  it('dismisses transient UI before navigating or exiting', () => {
    expect(
      androidBackAction({
        accountDialogOpen: true,
        playerSurfaceOpen: true,
        canNavigateBack: true,
      }),
    ).toBe('close-account-dialog');
    expect(
      androidBackAction({
        accountDialogOpen: false,
        playerSurfaceOpen: true,
        canNavigateBack: true,
      }),
    ).toBe('close-player-surface');
  });

  it('navigates through application history before finishing the Activity', () => {
    expect(
      androidBackAction({
        accountDialogOpen: false,
        playerSurfaceOpen: false,
        canNavigateBack: true,
      }),
    ).toBe('navigate-back');
    expect(
      androidBackAction({
        accountDialogOpen: false,
        playerSurfaceOpen: false,
        canNavigateBack: false,
      }),
    ).toBe('exit-app');
  });
});
