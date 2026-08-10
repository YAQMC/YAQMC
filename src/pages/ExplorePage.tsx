import { usePlayerStore } from '../application/player-store';
import type { AppRoute } from '../application/navigation';
import type { HomeFeed } from '../domain/music';
import { MediaCard } from '../components/MediaCard';
import { useTranslation } from 'react-i18next';

interface ExplorePageProps {
  feed: HomeFeed;
  onNavigate: (route: AppRoute) => void;
}

export function ExplorePage({ feed, onNavigate }: ExplorePageProps) {
  const { t } = useTranslation('pages', { keyPrefix: 'explore' });
  const playTracks = usePlayerStore((state) => state.playTracks);

  return (
    <div className="page standard-page">
      <header className="page-heading">
        <p className="eyebrow">{t('eyebrow')}</p>
        <h1>{t('title')}</h1>
        <p>{t('subtitle')}</p>
      </header>

      <section className="content-section">
        <div className="section-heading">
          <div>
            <h2>{t('newAndNoteworthy')}</h2>
          </div>
        </div>
        <div className="media-grid media-grid--four">
          {feed.newReleases.map((album) => (
            <MediaCard
              key={album.id}
              item={album}
              type="album"
              onOpen={() => onNavigate({ page: 'album', id: album.id })}
              onPlay={() => playTracks(album.tracks)}
            />
          ))}
        </div>
      </section>

      <section className="content-section content-section--last">
        <div className="section-heading">
          <div>
            <h2>{t('selectedPlaylists')}</h2>
          </div>
        </div>
        <div className="media-grid media-grid--four">
          {feed.madeForYou.map((playlist) => (
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
    </div>
  );
}
