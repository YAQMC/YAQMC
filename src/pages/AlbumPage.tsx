import { Heart, MoreHorizontal, Play, Shuffle } from 'lucide-react';
import type { CSSProperties } from 'react';
import { usePlayerStore } from '../application/player-store';
import type { Album } from '../domain/music';
import { formatTotalDuration } from '../utils/format';
import { TrackList } from '../components/TrackList';
import { Artwork } from '../components/ui/Artwork';
import { IconButton } from '../components/ui/IconButton';
import { useTranslation } from 'react-i18next';

interface AlbumPageProps {
  album: Album;
}

export function AlbumPage({ album }: AlbumPageProps) {
  const { t, i18n } = useTranslation('pages', { keyPrefix: 'album' });
  const { t: common } = useTranslation('common');
  const playTracks = usePlayerStore((state) => state.playTracks);
  const totalDuration = album.tracks.reduce((sum, track) => sum + track.durationMs, 0);
  const releaseLabel =
    album.releaseYear > 0
      ? new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language, {
          useGrouping: false,
        }).format(album.releaseYear)
      : t('releaseUnavailable');
  const sourceLabel = album.id.startsWith('qqmusic:') ? t('qqCatalog') : t('offlineCatalog');

  return (
    <div className="page detail-page">
      <section
        className="detail-hero"
        style={{ '--detail-color': album.artwork.dominantColor } as CSSProperties}
      >
        <Artwork artwork={album.artwork} className="detail-hero__art" loading="eager" />
        <div className="detail-hero__copy">
          <p className="eyebrow">{t('eyebrow')}</p>
          <h1>{album.title}</h1>
          <button type="button" className="detail-hero__artist">
            {album.artist.name}
          </button>
          <p className="detail-hero__description">{album.description}</p>
          <p className="detail-hero__meta">
            {releaseLabel} <span>·</span> {album.genre} <span>·</span>{' '}
            {common('songCount', { count: album.tracks.length })},{' '}
            {formatTotalDuration(totalDuration, i18n.resolvedLanguage ?? i18n.language)}
          </p>
          <div className="detail-hero__actions">
            <button
              type="button"
              className="button button--primary"
              onClick={() => playTracks(album.tracks)}
            >
              <Play size={16} fill="currentColor" />
              {t('play')}
            </button>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => playTracks(album.tracks.slice().reverse())}
            >
              <Shuffle size={16} />
              {t('shuffle')}
            </button>
            <IconButton label={t('favorite')} className="detail-hero__icon-action">
              <Heart size={18} />
            </IconButton>
            <IconButton label={t('more')} className="detail-hero__icon-action">
              <MoreHorizontal size={19} />
            </IconButton>
          </div>
        </div>
      </section>

      <section className="detail-track-section" aria-label={t('tracks', { title: album.title })}>
        <TrackList tracks={album.tracks} />
      </section>

      <footer className="detail-footer">
        <p>
          {releaseLabel} · {sourceLabel}
        </p>
        <span>{t('playbackNote')}</span>
      </footer>
    </div>
  );
}
