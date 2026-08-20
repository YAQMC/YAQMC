import { useTranslation } from 'react-i18next';
import { Play } from 'lucide-react';
import { usePlayerStore } from '../application/player-store';
import { useDiscover } from '../application/use-discover';
import type { AppRoute } from '../application/navigation';
import { MediaCard } from '../components/MediaCard';
import { Artwork } from '../components/ui/Artwork';

function CoverCard({
  title,
  subtitle,
  cover,
  eyebrow,
  onClick,
}: {
  title: string;
  subtitle: string;
  cover: string;
  eyebrow: string;
  onClick?: () => void;
}) {
  return (
    <article className="media-card" tabIndex={0}>
      <div className="media-card__art">
        <button type="button" className="media-card__open" onClick={onClick} aria-label={title}>
          <Artwork artwork={{ src: cover, alt: title, dominantColor: '#181818' }} />
        </button>
      </div>
      <button type="button" className="media-card__meta" onClick={onClick}>
        <span className="media-card__title">{title}</span>
        <span className="media-card__subtitle">{subtitle || eyebrow}</span>
      </button>
    </article>
  );
}

interface ExplorePageProps {
  onNavigate: (route: AppRoute) => void;
}

export function ExplorePage({ onNavigate }: ExplorePageProps) {
  const { t } = useTranslation('pages', { keyPrefix: 'explore' });
  const playTracks = usePlayerStore((state) => state.playTracks);
  const state = useDiscover();

  return (
    <div className="page standard-page">
      <header className="page-heading">
        <p className="eyebrow">{t('eyebrow')}</p>
        <h1>{t('title')}</h1>
        <p>{t('subtitle')}</p>
      </header>

      {state.status === 'loading' && <p className="discover-status">{t('loading')}</p>}
      {state.status === 'error' && (
        <p className="discover-status discover-status--error">{state.message}</p>
      )}

      {state.status === 'ready' && (
        <>
          {state.discover.charts.length > 0 && (
            <section className="content-section">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">{t('chartsEyebrow')}</p>
                  <h2>{t('charts')}</h2>
                </div>
              </div>
              <div className="media-grid media-grid--four">
                {state.discover.charts.map((chart) => (
                  <MediaCard
                    key={chart.id}
                    item={chart}
                    type="playlist"
                    onOpen={() => onNavigate({ page: 'playlist', id: chart.id })}
                    onPlay={() => playTracks(chart.tracks)}
                  />
                ))}
              </div>
            </section>
          )}

          {state.discover.newSongs && (
            <section className="content-section">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">{t('newSongsEyebrow')}</p>
                  <h2>{t('newSongs')}</h2>
                </div>
                {state.discover.newSongs.tracks.length > 0 && (
                  <button type="button" onClick={() => playTracks(state.discover.newSongs!.tracks)}>
                    <Play size={15} fill="currentColor" /> {t('playAll')}
                  </button>
                )}
              </div>
              <div className="media-grid media-grid--four">
                {state.discover.newSongs.tracks.map((song) => (
                  <MediaCard
                    key={song.id}
                    item={song}
                    type="song"
                    onOpen={() => playTracks([song])}
                    onPlay={() => playTracks([song])}
                  />
                ))}
              </div>
            </section>
          )}

          {state.discover.newAlbums.length > 0 && (
            <section className="content-section">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">{t('newAlbumsEyebrow')}</p>
                  <h2>{t('newAlbums')}</h2>
                </div>
              </div>
              <div className="media-grid media-grid--four">
                {state.discover.newAlbums.map((album) => (
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
          )}

          {state.discover.categories.length > 0 && (
            <section className="content-section">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">{t('categoriesEyebrow')}</p>
                  <h2>{t('categories')}</h2>
                </div>
              </div>
              <div className="media-grid media-grid--five">
                {state.discover.categories.map((category) => (
                  <CoverCard
                    key={category.encArea}
                    title={category.title}
                    subtitle=""
                    cover={category.cover}
                    eyebrow={t('categoryLabel')}
                    onClick={() =>
                      onNavigate({
                        page: 'area',
                        encArea: category.encArea,
                        title: category.title,
                      })
                    }
                  />
                ))}
              </div>
            </section>
          )}

          {state.discover.newMvs.length > 0 && (
            <section className="content-section">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">{t('newMvsEyebrow')}</p>
                  <h2>{t('newMvs')}</h2>
                </div>
              </div>
              <div className="media-grid media-grid--four">
                {state.discover.newMvs.map((mv) => (
                  <CoverCard
                    key={mv.id}
                    title={mv.title}
                    subtitle={mv.artist}
                    cover={mv.cover}
                    eyebrow={t('mvLabel')}
                  />
                ))}
              </div>
            </section>
          )}

          {state.discover.podcasts.length > 0 && (
            <section className="content-section">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">{t('podcastsEyebrow')}</p>
                  <h2>{t('podcasts')}</h2>
                </div>
              </div>
              <div className="media-grid media-grid--five">
                {state.discover.podcasts.map((podcast) => (
                  <CoverCard
                    key={podcast.id}
                    title={podcast.title}
                    subtitle={podcast.subtitle}
                    cover={podcast.cover}
                    eyebrow={t('podcastLabel')}
                  />
                ))}
              </div>
            </section>
          )}

          {state.discover.featured.length > 0 && (
            <section className="content-section">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">{t('featuredEyebrow')}</p>
                  <h2>{t('featured')}</h2>
                </div>
              </div>
              <div className="media-grid media-grid--four">
                {state.discover.featured.map((card) => (
                  <CoverCard
                    key={card.id}
                    title={card.title}
                    subtitle={card.subtitle}
                    cover={card.cover}
                    eyebrow={t('featuredLabel')}
                  />
                ))}
              </div>
            </section>
          )}

          {state.discover.popularSonglists.length > 0 && (
            <section className="content-section content-section--last">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">{t('popularSonglistsEyebrow')}</p>
                  <h2>{t('popularSonglists')}</h2>
                </div>
              </div>
              <div className="media-grid media-grid--four">
                {state.discover.popularSonglists.map((playlist) => (
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
        </>
      )}
    </div>
  );
}
