import { usePlayerStore } from '../application/player-store';
import { ProviderContext } from '../application/provider-context';
import { Play } from 'lucide-react';
import { useContext } from 'react';
import type { AppRoute } from '../application/navigation';
import type { HomeFeed } from '../domain/music';
import { resolveArtworkSource } from '../application/artwork-resolver';
import { MediaCard } from '../components/MediaCard';
import { TrackList } from '../components/TrackList';
import { useTranslation } from 'react-i18next';

interface HomePageProps {
  feed: HomeFeed;
  onNavigate: (route: AppRoute) => void;
}

export function HomePage({ feed, onNavigate }: HomePageProps) {
  const { t } = useTranslation('pages', { keyPrefix: 'home' });
  const { t: common } = useTranslation('common');
  const provider = useContext(ProviderContext);
  const playTracks = usePlayerStore((state) => state.playTracks);
  const startContinuation = usePlayerStore((state) => state.startContinuation);
  const daily = feed.dailySonglist;
  const dailyTrackArtwork = daily?.tracks.find((track) =>
    Boolean(resolveArtworkSource(track.artwork, 'medium').trim()),
  )?.artwork;
  const dailyArtwork =
    daily && !dailyTrackArtwork
      ? { ...daily.artwork, src: '', variants: [], alt: `${daily.title} daily mix` }
      : dailyTrackArtwork;

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
                if (provider) {
                  startContinuation(provider.id, 'guess', feed.guessSonglist!.tracks);
                }
              }}
              onPlay={() => {
                if (provider) {
                  startContinuation(provider.id, 'guess', feed.guessSonglist!.tracks);
                }
              }}
            />
          )}

          {daily && (
            <MediaCard
              item={daily}
              type="playlist"
              artwork={dailyArtwork}
              artworkFallback={<DailyMixArtwork />}
              subtitle={t('trackCount', { count: daily.tracks.length })}
              onOpen={() => onNavigate({ page: 'playlist', id: daily.id })}
              onPlay={() => playTracks(daily.tracks)}
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
            <button
              type="button"
              disabled={!provider}
              onClick={() => {
                const first = feed.radarSongs[0];
                if (provider && first) {
                  startContinuation(provider.id, 'radar', feed.radarSongs, first.id, [first.id]);
                }
              }}
            >
              <Play size={14} aria-hidden="true" />
              {common('play')}
            </button>
          </div>
          <TrackList
            tracks={feed.radarSongs}
            showAlbum
            compact
            continuation={provider ? { providerId: provider.id, kind: 'radar' } : undefined}
          />
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

const ENGLISH_MONTHS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
] as const;

function DailyMixArtwork({ date = new Date() }: { date?: Date }) {
  const month = ENGLISH_MONTHS[date.getMonth()] ?? 'DAY';
  const day = String(date.getDate()).padStart(2, '0');
  return (
    <span className="daily-mix-artwork" aria-hidden="true">
      <span className="daily-mix-artwork__month">{month}</span>
      <span className="daily-mix-artwork__day">{day}</span>
      <span className="daily-mix-artwork__label">DAILY MIX</span>
    </span>
  );
}
