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
      <section className="content-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">{t('forYouEyebrow')}</p>
            <h2>{t('forYou')}</h2>
          </div>
        </div>
        <div className="media-grid media-grid--hero">
          {feed.guessSonglist && (
            <MediaCard
              item={feed.guessSonglist}
              type="playlist"
              size="hero"
              title={t('guessYouLike')}
              subtitle={t('playImmediately')}
              onOpen={() => {
                playTracks(feed.guessSonglist!.tracks);
                startGuessSession();
              }}
              onPlay={() => {
                playTracks(feed.guessSonglist!.tracks);
                startGuessSession();
              }}
            />
          )}

          {feed.dailySonglist && (
            <MediaCard
              item={feed.dailySonglist}
              type="playlist"
              title={t('newSongs')}
              subtitle={t('trackCount', { count: feed.dailySonglist.tracks.length })}
              onOpen={() => onNavigate({ page: 'playlist', id: feed.dailySonglist!.id })}
              onPlay={() => playTracks(feed.dailySonglist!.tracks)}
            />
          )}

          {feed.newSongSonglist && (
            <MediaCard
              item={feed.newSongSonglist}
              type="playlist"
              title={t('newSongRecommend')}
              subtitle={t('trackCount', { count: feed.newSongSonglist.tracks.length })}
              onOpen={() => onNavigate({ page: 'playlist', id: feed.newSongSonglist!.id })}
              onPlay={() => playTracks(feed.newSongSonglist!.tracks)}
            />
          )}
        </div>
      </section>

      {feed.radarSongs.length > 0 && (
        <section className="content-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">{t('radarEyebrow')}</p>
              <h2>
                {feed.radarBasedOnSong
                  ? t('radarSongsWithSong', { title: feed.radarBasedOnSong })
                  : t('radarSongs')}
              </h2>
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
