import { useTranslation } from 'react-i18next';
import { useSongShareActions } from '../application/use-song-share-actions';
import type { Song } from '../domain/music';
import { ActionMenuItem } from './ui/ActionMenu';

export function SongShareMenuItems({ song, onSelect }: { song: Song; onSelect?: () => void }) {
  const { t } = useTranslation('player');
  const share = useSongShareActions(song);
  return (
    <>
      <ActionMenuItem
        disabled={!share.available}
        onClick={() => share.copy('public-link')}
        onSelect={onSelect}
      >
        {t('copyPublicSongLink')}
      </ActionMenuItem>
      <ActionMenuItem
        disabled={!share.available}
        onClick={() => share.copy('yaqmc-link')}
        onSelect={onSelect}
      >
        {t('copyYaqmcSongLink')}
      </ActionMenuItem>
      <ActionMenuItem
        disabled={!share.available}
        onClick={() => share.copy('text')}
        onSelect={onSelect}
      >
        {t('copySongText')}
      </ActionMenuItem>
    </>
  );
}
