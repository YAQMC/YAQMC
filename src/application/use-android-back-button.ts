import { useEffect, type RefObject } from 'react';
import type { AccountMusicProvider } from '../providers/music-provider';
import { useAccountStore } from './account-runtime';
import { androidApp as CapacitorApp } from './android-app';
import { androidBackAction, ANDROID_MODAL_BACK_EVENT } from './android-back-navigation';
import { useCommentsPanelStore } from './comments-panel-store';
import { isAndroidRuntime } from './host-capabilities';
import { useLyricsPresentationStore } from './lyrics-presentation';
import { closeLyricsPresentation } from './lyrics-presentation-actions';
import { useLyricsStageStore } from './lyrics-stage-machine';
import type { NavigationHistory } from './use-navigation-history';
import { usePlayerStore } from './player-store';
import { logger } from './logger';

/** Hardware back unwinds overlays first, then in-app history, then exits the app. */
export function useAndroidBackButton(
  accountProvider: AccountMusicProvider | null,
  historyRef: RefObject<NavigationHistory>,
  goBack: () => void,
): void {
  useEffect(() => {
    if (!isAndroidRuntime()) return;

    let disposed = false;
    let removeListener: (() => Promise<void>) | null = null;
    void CapacitorApp.addListener('backButton', () => {
      if (!window.dispatchEvent(new Event(ANDROID_MODAL_BACK_EVENT, { cancelable: true }))) return;
      if (useCommentsPanelStore.getState().song) {
        useCommentsPanelStore.getState().close();
        return;
      }
      const player = usePlayerStore.getState();
      const presentation = useLyricsPresentationStore.getState();
      const stage = useLyricsStageStore.getState().stage;
      const account = useAccountStore.getState();
      const lyricsVisible =
        player.lyricsOpen || presentation.fullscreen || presentation.pending || stage !== 'closed';
      const action = androidBackAction({
        accountDialogOpen: account.dialogOpen && accountProvider !== null,
        playerSurfaceOpen: player.queueOpen || lyricsVisible,
        canNavigateBack: historyRef.current.index > 0,
      });

      if (action === 'close-account-dialog') {
        void account.closeDialog(accountProvider!);
      } else if (action === 'close-player-surface') {
        if (lyricsVisible) void closeLyricsPresentation();
        else player.closePanels();
      } else if (action === 'navigate-back') {
        goBack();
      } else {
        void CapacitorApp.exitApp();
      }
    })
      .then((listener) => {
        if (disposed) void listener.remove();
        else removeListener = () => listener.remove();
      })
      .catch((error: unknown) => logger.error('android.back-button', String(error)));

    return () => {
      disposed = true;
      if (removeListener) void removeListener();
    };
  }, [accountProvider, goBack, historyRef]);
}
