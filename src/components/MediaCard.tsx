import { Play } from 'lucide-react';
import type { Album, Playlist, Song } from '../domain/music';
import { Artwork } from './ui/Artwork';
import { useTranslation } from 'react-i18next';
import type { ContextMenuItem } from './ui/ContextMenu';
import { useContextMenu } from './ui/use-context-menu';
import { joinArtistNames } from '../utils/format';

interface MediaCardProps {
  item: Album | Playlist | Song;
  type: 'album' | 'playlist' | 'song';
  onOpen: () => void;
  onPlay: () => void;
  size?: 'regular' | 'wide' | 'hero';
  title?: string;
  subtitle?: string;
}

function getSubtitle(item: Album | Playlist | Song, type: 'album' | 'playlist' | 'song'): string {
  if (type === 'song') {
    return joinArtistNames((item as Song).artists);
  }

  if (type === 'playlist') {
    return (item as Playlist).owner.displayName;
  }

  const album = item as Album;
  return album.releaseYear > 0 ? `${album.releaseYear} · ${album.artist.name}` : album.artist.name;
}

export function MediaCard({
  item,
  type,
  onOpen,
  onPlay,
  size = 'regular',
  title,
  subtitle,
}: MediaCardProps) {
  const { t } = useTranslation('pages', { keyPrefix: 'home' });
  const items: readonly ContextMenuItem[] = [
    { id: 'open', label: t('openItem', { title: item.title }), action: onOpen },
    { id: 'play', label: t('playItem', { title: item.title }), action: onPlay },
  ];
  const contextMenu = useContextMenu(t('itemActions', { title: item.title }), items);
  return (
    <article
      className={`media-card media-card--${size}`}
      tabIndex={0}
      {...contextMenu.triggerProps}
    >
      <div className="media-card__art">
        <button
          type="button"
          className="media-card__open"
          onClick={onOpen}
          aria-label={t('openItem', { title: item.title })}
        >
          <Artwork artwork={item.artwork} />
        </button>
        <button
          type="button"
          className="media-card__play"
          onClick={onPlay}
          aria-label={t('playItem', { title: item.title })}
        >
          <Play size={17} fill="currentColor" />
        </button>
      </div>
      <button type="button" className="media-card__meta" onClick={onOpen}>
        <span className="media-card__title">{title ?? item.title}</span>
        <span className="media-card__subtitle">{subtitle ?? getSubtitle(item, type)}</span>
      </button>
      {contextMenu.menu}
    </article>
  );
}
