import { useTranslation } from 'react-i18next';
import { usePlayerStore } from '../application/player-store';
import type { AreaFeed } from '../domain/music';
import type { AppRoute } from '../application/navigation';
import { MediaCard } from '../components/MediaCard';
import { Artwork } from '../components/ui/Artwork';

interface AreaPageProps {
  feed: AreaFeed;
  onNavigate: (route: AppRoute) => void;
}

export function AreaPage({ feed, onNavigate }: AreaPageProps) {
  const { t } = useTranslation('pages', { keyPrefix: 'area' });
  const playTracks = usePlayerStore((state) => state.playTracks);

  return (
    <div className="page standard-page">
      <header className="page-heading">
        <p className="eyebrow">{t('eyebrow')}</p>
        <h1>{feed.title}</h1>
        <p>{t('subtitle')}</p>
      </header>

      {feed.songlists.length > 0 && (
        <section className="content-section">
          <div className="section-heading">
            <div>
              <h2>{t('songlists')}</h2>
            </div>
          </div>
          <div className="media-grid media-grid--four">
            {feed.songlists.map((playlist) => (
              <MediaCard
                key={playlist.id}
                item={playlist}
                type="playlist"
                onOpen={() => onNavigate({ page: 'playlist', id: playlist.id })}
                onPlay={() => playTracks(playlist.tracks)}
              />
            ))}
          </div>
        </section>
      )}

      {feed.playlists.length > 0 && (
        <section className="content-section">
          <div className="section-heading">
            <div>
              <h2>{t('playlists')}</h2>
            </div>
          </div>
          <div className="media-grid media-grid--four">
            {feed.playlists.map((playlist) => (
              <MediaCard
                key={playlist.id}
                item={playlist}
                type="playlist"
                onOpen={() => onNavigate({ page: 'playlist', id: playlist.id })}
                onPlay={() => playTracks(playlist.tracks)}
              />
            ))}
          </div>
        </section>
      )}

      {feed.artists.length > 0 && (
        <section className="content-section content-section--last">
          <div className="section-heading">
            <div>
              <h2>{t('artists')}</h2>
            </div>
          </div>
          <div className="media-grid media-grid--four">
            {feed.artists.map((artist) => (
              <article key={artist.id} className="media-card">
                <div className="media-card__art">
                  <Artwork artwork={{ src: artist.cover, alt: artist.name, dominantColor: '#181818' }} />
                </div>
                <button type="button" className="media-card__meta">
                  <span className="media-card__title">{artist.name}</span>
                  <span className="media-card__subtitle">{t('artistLabel')}</span>
                </button>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
