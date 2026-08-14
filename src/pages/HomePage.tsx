import { ArrowRight, Play, Plus } from 'lucide-react';
import type { CSSProperties } from 'react';
import { usePlayerStore } from '../application/player-store';
import type { AppRoute } from '../application/navigation';
import type { HomeFeed, MediaCollection } from '../domain/music';
import { MediaCard } from '../components/MediaCard';
import { Artwork } from '../components/ui/Artwork';
import { useTranslation } from 'react-i18next';

interface HomePageProps {
  feed: HomeFeed;
  onNavigate: (route: AppRoute) => void;
}

function collectionRoute(collection: MediaCollection): AppRoute {
  return collection.type === 'album'
    ? { page: 'album', id: collection.item.id }
    : { page: 'playlist', id: collection.item.id };
}

export function HomePage({ feed, onNavigate }: HomePageProps) {
  const { t } = useTranslation('pages', { keyPrefix: 'home' });
  const { t: common } = useTranslation('common');
  const playTracks = usePlayerStore((state) => state.playTracks);
  const featured = feed.featured.album;

  return (
    <div className="page home-page">
      <section
        className="featured-release"
        style={{ '--feature-color': featured.artwork.dominantColor } as CSSProperties}
      >
        <div className="featured-release__copy">
          <p className="eyebrow">{feed.featured.eyebrow}</p>
          <button
            type="button"
            className="featured-release__title"
            onClick={() => onNavigate({ page: 'album', id: featured.id })}
          >
            {featured.title}
          </button>
          <p className="featured-release__artist">{featured.artist.name}</p>
          <p className="featured-release__description">{featured.description}</p>
          <div className="featured-release__actions">
            <button
              type="button"
              className="button button--primary"
              onClick={() => playTracks(featured.tracks)}
            >
              <Play size={16} fill="currentColor" />
              {t('playAlbum')}
            </button>
            <button type="button" className="button button--quiet" aria-label={t('addAlbum')}>
              <Plus size={17} />
              {common('add')}
            </button>
          </div>
        </div>
        <button
          type="button"
          className="featured-release__art"
          onClick={() => onNavigate({ page: 'album', id: featured.id })}
          aria-label={t('openItem', { title: featured.title })}
        >
          <Artwork artwork={featured.artwork} loading="eager" purpose="large" />
        </button>
      </section>

      <section className="content-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">{t('recentEyebrow')}</p>
            <h2>{t('recent')}</h2>
          </div>
          <button type="button" onClick={() => onNavigate({ page: 'account-recent' })}>
            {t('viewAll')} <ArrowRight size={14} />
          </button>
        </div>
        <div className="media-grid media-grid--five">
          {feed.recentlyPlayed.map((collection) => (
            <MediaCard
              key={`${collection.type}-${collection.item.id}`}
              item={collection.item}
              type={collection.type}
              onOpen={() => onNavigate(collectionRoute(collection))}
              onPlay={() => playTracks(collection.item.tracks)}
            />
          ))}
        </div>
      </section>

      <section className="content-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">{t('curatedEyebrow')}</p>
            <h2>{t('madeForYou')}</h2>
          </div>
        </div>
        <div className="editorial-grid">
          {feed.madeForYou.map((playlist) => (
            <article className="editorial-card" key={playlist.id}>
              <button
                type="button"
                className="editorial-card__art"
                onClick={() => onNavigate({ page: 'playlist', id: playlist.id })}
              >
                <Artwork artwork={playlist.artwork} />
              </button>
              <div className="editorial-card__copy">
                <p>{playlist.owner.displayName}</p>
                <button
                  type="button"
                  onClick={() => onNavigate({ page: 'playlist', id: playlist.id })}
                >
                  {playlist.title}
                </button>
                <span>{playlist.description}</span>
              </div>
              <button
                type="button"
                className="editorial-card__play"
                onClick={() => playTracks(playlist.tracks)}
                aria-label={t('playItem', { title: playlist.title })}
              >
                <Play size={16} fill="currentColor" />
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className="content-section content-section--last">
        <div className="section-heading">
          <div>
            <p className="eyebrow">{t('freshEyebrow')}</p>
            <h2>{t('newReleases')}</h2>
          </div>
          <button type="button" onClick={() => onNavigate({ page: 'explore' })}>
            {t('explore')} <ArrowRight size={14} />
          </button>
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
    </div>
  );
}
