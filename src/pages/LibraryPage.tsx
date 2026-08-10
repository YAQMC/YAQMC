import { Disc3, Heart, ListMusic } from 'lucide-react';
import { usePlayerStore } from '../application/player-store';
import type { AppRoute } from '../application/navigation';
import type { LibrarySnapshot } from '../domain/music';
import { MediaCard } from '../components/MediaCard';
import { TrackList } from '../components/TrackList';
import { useTranslation } from 'react-i18next';

interface LibraryPageProps {
  library: LibrarySnapshot;
  onNavigate: (route: AppRoute) => void;
}

export function LibraryPage({ library, onNavigate }: LibraryPageProps) {
  const { t } = useTranslation('pages', { keyPrefix: 'library' });
  const { t: common } = useTranslation('common');
  const playTracks = usePlayerStore((state) => state.playTracks);

  return (
    <div className="page standard-page library-page">
      <header className="page-heading">
        <p className="eyebrow">{t('eyebrow')}</p>
        <h1>{t('title')}</h1>
        <div className="library-summary" aria-label={t('summary')}>
          <span>
            <Heart size={15} /> {common('favoriteCount', { count: library.favoriteSongs.length })}
          </span>
          <span>
            <Disc3 size={15} /> {common('albumCount', { count: library.savedAlbums.length })}
          </span>
          <span>
            <ListMusic size={15} />{' '}
            {common('playlistCount', { count: library.savedPlaylists.length })}
          </span>
        </div>
      </header>

      <section className="content-section">
        <div className="section-heading">
          <div>
            <h2>{t('favoriteSongs')}</h2>
          </div>
          <button type="button" onClick={() => playTracks(library.favoriteSongs)}>
            {t('playAll')}
          </button>
        </div>
        <TrackList tracks={library.favoriteSongs} showAlbum compact />
      </section>

      <section className="content-section">
        <div className="section-heading">
          <div>
            <h2>{t('savedAlbums')}</h2>
          </div>
        </div>
        <div className="media-grid media-grid--four">
          {library.savedAlbums.map((album) => (
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
            <h2>{t('savedPlaylists')}</h2>
          </div>
        </div>
        <div className="media-grid media-grid--four">
          {library.savedPlaylists.map((playlist) => (
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
