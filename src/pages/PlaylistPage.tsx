import { Check, MoreHorizontal, Play, Shuffle } from 'lucide-react';
import type { CSSProperties } from 'react';
import { usePlayerStore } from '../application/player-store';
import type { Playlist } from '../domain/music';
import { formatTotalDuration } from '../utils/format';
import { TrackList } from '../components/TrackList';
import { Artwork } from '../components/ui/Artwork';
import { IconButton } from '../components/ui/IconButton';
import { useTranslation } from 'react-i18next';

interface PlaylistPageProps {
  playlist: Playlist;
}

export function PlaylistPage({ playlist }: PlaylistPageProps) {
  const { t, i18n } = useTranslation('pages', { keyPrefix: 'playlist' });
  const { t: common } = useTranslation('common');
  const playTracks = usePlayerStore((state) => state.playTracks);
  const totalDuration = playlist.tracks.reduce((sum, track) => sum + track.durationMs, 0);

  return (
    <div className="page detail-page">
      <section
        className="detail-hero"
        style={{ '--detail-color': playlist.artwork.dominantColor } as CSSProperties}
      >
        <Artwork artwork={playlist.artwork} className="detail-hero__art" loading="eager" />
        <div className="detail-hero__copy">
          <p className="eyebrow">{t('eyebrow')}</p>
          <h1>{playlist.title}</h1>
          <p className="detail-hero__description">{playlist.description}</p>
          <p className="detail-hero__owner">
            <span className="detail-hero__owner-mark">P</span>
            <strong>{playlist.owner.displayName}</strong>
            <Check size={13} />
          </p>
          <p className="detail-hero__meta">
            {playlist.updatedLabel} <span>·</span>{' '}
            {common('songCount', { count: playlist.tracks.length })},{' '}
            {formatTotalDuration(totalDuration, i18n.resolvedLanguage ?? i18n.language)}
          </p>
          <div className="detail-hero__actions">
            <button
              type="button"
              className="button button--primary"
              onClick={() => playTracks(playlist.tracks)}
            >
              <Play size={16} fill="currentColor" />
              {t('play')}
            </button>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => playTracks(playlist.tracks.slice().reverse())}
            >
              <Shuffle size={16} />
              {t('shuffle')}
            </button>
            <IconButton label={t('more')} className="detail-hero__icon-action">
              <MoreHorizontal size={19} />
            </IconButton>
          </div>
        </div>
      </section>

      <section className="detail-track-section" aria-label={t('tracks', { title: playlist.title })}>
        <TrackList tracks={playlist.tracks} showAlbum />
      </section>
    </div>
  );
}
