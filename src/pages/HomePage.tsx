import { usePlayerStore } from '../application/player-store';
import type { AppRoute } from '../application/navigation';
import type { HomeFeed } from '../domain/music';
import { MediaCard } from '../components/MediaCard';
import { TrackList } from '../components/TrackList';
import { useTranslation } from 'react-i18next';

interface HomePageProps {
  feed: HomeFeed;
  onNavigate: (route: AppRoute) => void;
}

export function HomePage({ feed, onNavigate }: HomePageProps) {
  const { t } = useTranslation('pages', { keyPrefix: 'home' });
  const playTracks = usePlayerStore((state) => state.playTracks);
  const startGuessSession = usePlayerStore((state) => state.startGuessSession);

  return (
    <div className="page home-page">
      {feed.dailySonglist && (
        <section className="content-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">{t('newSongsEyebrow')}</p>
              <h2>{t('newSongs')}</h2>
            </div>
          </div>
          <div className="media-grid media-grid--daily">
            <MediaCard
              item={feed.dailySonglist}
              type="playlist"
              size="wide"
              onOpen={() => onNavigate({ page: 'playlist', id: feed.dailySonglist!.id })}
              onPlay={() => playTracks(feed.dailySonglist!.tracks)}
            />
          </div>
        </section>
      )}

      {feed.guessSonglist && (
        <section className="content-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">{t('guessEyebrow')}</p>
              <h2>{t('guessYouLike')}</h2>
            </div>
          </div>
          <div className="media-grid media-grid--daily">
            <MediaCard
              item={feed.guessSonglist}
              type="playlist"
              size="wide"
              onOpen={() => playTracks(feed.guessSonglist!.tracks)}
              onPlay={() => {
                playTracks(feed.guessSonglist!.tracks);
                startGuessSession();
              }}
            />
          </div>
        </section>
      )}

      {feed.radarSongs.length > 0 && (
        <section className="content-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">{t('radarEyebrow')}</p>
              <h2>{t('radarSongs')}</h2>
            </div>
          </div>
          <TrackList tracks={feed.radarSongs} showAlbum compact />
        </section>
      )}

      {feed.recommendedSonglists.length > 0 && (
        <section className="content-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">{t('recommendedEyebrow')}</p>
              <h2>{t('recommendedSonglists')}</h2>
            </div>
          </div>
          <div className="media-grid media-grid--five">
            {feed.recommendedSonglists.map((playlist) => (
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
    </div>
  );
}
