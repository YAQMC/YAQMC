import { useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { ProviderContext } from './provider-context';
import { pushPluginNotice } from './plugin-notifications';
import { getHostBridge } from './yaqmc-runtime';
import { hostCapabilities } from './host-capabilities';
import {
  copyTextToClipboard,
  resolveSongShareValue,
  SongShareUnavailableError,
  type SongShareKind,
} from './song-sharing';
import type { Song } from '../domain/music';
import { isShareMusicProvider } from '../providers/music-provider';

const SHARE_NOTICE_SOURCE = 'app.share';

export function useSongShareActions(song: Song): {
  available: boolean;
  copy: (kind: SongShareKind) => Promise<void>;
} {
  const { t } = useTranslation('player');
  const provider = useContext(ProviderContext);
  const shareProvider = provider && isShareMusicProvider(provider) ? provider : null;
  const referencedProviderId = song.provider?.providerId.trim();
  const nativeShare = getHostBridge().share;
  const available =
    shareProvider !== null && (!referencedProviderId || referencedProviderId === shareProvider.id);

  const copy = async (kind: SongShareKind) => {
    if (!shareProvider || !available) {
      notify('warning', t('shareUnavailable'), kind);
      return;
    }
    try {
      const value = await resolveSongShareValue(shareProvider, shareProvider.id, song, kind);
      if (hostCapabilities().nativeShare && nativeShare) {
        await nativeShare?.share({
          text: kind === 'public-link' ? song.title : value,
          title: song.title,
          ...(kind === 'public-link' ? { url: value } : {}),
        });
      } else {
        await copyTextToClipboard(value, getHostBridge().clipboard?.writeText);
      }
      notify('success', t('shareCopied'), kind);
    } catch (error) {
      const message =
        error instanceof SongShareUnavailableError && error.reason === 'public-link'
          ? t('sharePublicUnavailable')
          : t('shareFailed');
      notify(error instanceof SongShareUnavailableError ? 'warning' : 'error', message, kind);
    }
  };

  return { available, copy };
}

function notify(
  level: 'success' | 'warning' | 'error',
  message: string,
  kind: SongShareKind,
): void {
  pushPluginNotice({
    pluginId: `${SHARE_NOTICE_SOURCE}.${kind}`,
    pluginName: 'YAQMC',
    level,
    message,
  });
}
