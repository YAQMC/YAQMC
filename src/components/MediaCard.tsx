import { Fragment } from 'react';
import { Play } from 'lucide-react';
import type { Album, Playlist, Song } from '../domain/music';
import { Artwork } from './ui/Artwork';
import { useTranslation } from 'react-i18next';
import type { ContextMenuItem } from './ui/ContextMenu';
import { useContextMenu } from './ui/use-context-menu';
import { EntityLink } from './EntityLink';

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
    return (item as Song).artists.map((artist) => artist.name).join(', ');
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
  const displayTitle = title ?? item.title;
  const metadata =
    type === 'playlist' ? (
      <>
        <span className="media-card__title">{displayTitle}</span>
        <span className="media-card__subtitle">{subtitle ?? getSubtitle(item, type)}</span>
      </>
    ) : (
      <>
        <EntityLink entity={type} id={item.id} className="media-card__title">
          {displayTitle}
        </EntityLink>
        <span className="media-card__subtitle">
          {subtitle ??
            (type === 'song' ? (
              (item as Song).artists.map((artist, index) => (
                <Fragment key={`${artist.id || artist.name}-${index}`}>
                  <EntityLink entity="artist" id={artist.id}>
                    {artist.name}
                  </EntityLink>
                  {index < (item as Song).artists.length - 1 ? ', ' : null}
                </Fragment>
              ))
            ) : (
              <>
                {(item as Album).releaseYear > 0 ? (
                  <>
                    <span>{(item as Album).releaseYear}</span>
                    <span aria-hidden="true"> · </span>
                  </>
                ) : null}
                <EntityLink entity="artist" id={(item as Album).artist.id}>
                  {(item as Album).artist.name}
                </EntityLink>
              </>
            ))}
        </span>
      </>
    );
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
      {type === 'playlist' ? (
        <button type="button" className="media-card__meta" onClick={onOpen}>
          {metadata}
        </button>
      ) : (
        <div className="media-card__meta">{metadata}</div>
      )}
      {contextMenu.menu}
    </article>
  );
}
