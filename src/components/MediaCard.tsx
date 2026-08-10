import { Play } from 'lucide-react';
import type { Album, Playlist } from '../domain/music';
import { Artwork } from './ui/Artwork';
import { useTranslation } from 'react-i18next';

interface MediaCardProps {
  item: Album | Playlist;
  type: 'album' | 'playlist';
  onOpen: () => void;
  onPlay: () => void;
  size?: 'regular' | 'wide';
}

function getSubtitle(item: Album | Playlist, type: 'album' | 'playlist'): string {
  if (type === 'playlist') {
    return (item as Playlist).owner.displayName;
  }

  const album = item as Album;
  return album.releaseYear > 0 ? `${album.releaseYear} · ${album.artist.name}` : album.artist.name;
}

export function MediaCard({ item, type, onOpen, onPlay, size = 'regular' }: MediaCardProps) {
  const { t } = useTranslation('pages', { keyPrefix: 'home' });
  return (
    <article className={`media-card media-card--${size}`}>
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
        <span className="media-card__title">{item.title}</span>
        <span className="media-card__subtitle">{getSubtitle(item, type)}</span>
      </button>
    </article>
  );
}
