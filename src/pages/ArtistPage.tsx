import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { Artist } from '../domain/music';
import { EntityLink } from '../components/EntityLink';
import { Artwork } from '../components/ui/Artwork';
import { TrackList } from '../components/TrackList';

export function ArtistPage({ artist }: { artist: Artist }) {
  const { t } = useTranslation('pages', { keyPrefix: 'artist' });
  return (
    <div className="page detail-page artist-page">
      <section
        className="detail-hero"
        style={{ '--detail-color': artist.artwork.dominantColor } as CSSProperties}
      >
        <Artwork
          artwork={artist.artwork}
          className="detail-hero__art"
          loading="eager"
          purpose="large"
        />
        <div className="detail-hero__copy">
          <p className="eyebrow">{t('eyebrow')}</p>
          <h1>{artist.name}</h1>
          {artist.description.trim() && (
            <p className="detail-hero__description">{artist.description}</p>
          )}
        </div>
      </section>

      <section className="detail-track-section" aria-labelledby="artist-top-songs">
        <h2 id="artist-top-songs">{t('topSongs')}</h2>
        <TrackList tracks={artist.topSongs} showAlbum />
      </section>

      <section className="artist-page__albums" aria-labelledby="artist-albums">
        <h2 id="artist-albums">{t('albums')}</h2>
        <div className="artist-page__album-grid">
          {artist.albums.map((album) => (
            <EntityLink
              key={album.id}
              entity="album"
              id={album.id}
              className="artist-page__album-card"
              ariaLabel={t('openAlbum', { title: album.title })}
            >
              <Artwork artwork={album.artwork} loading="lazy" purpose="medium" />
              <span>{album.title}</span>
            </EntityLink>
          ))}
        </div>
      </section>
    </div>
  );
}
