import { Disc3, ListMusic } from 'lucide-react';
import { useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { useMusicProvider } from '../application/provider-context';
import {
  useArtistCatalog,
  type ArtistCatalogCategoryState,
} from '../application/use-artist-catalog';
import { EntityLink } from '../components/EntityLink';
import { TrackList } from '../components/TrackList';
import { Artwork } from '../components/ui/Artwork';
import type { AlbumPreview, Artist, ArtistCatalogKind, Song } from '../domain/music';

type ArtistSection = 'top' | ArtistCatalogKind;

const tabOrder: ArtistSection[] = ['top', 'song', 'album'];

export function ArtistPage({ artist }: { artist: Artist }) {
  const { t } = useTranslation('pages', { keyPrefix: 'artist' });
  const { t: errors } = useTranslation('errors');
  const provider = useMusicProvider();
  const [selection, setSelection] = useState<{ artistId: string; section: ArtistSection }>({
    artistId: artist.id,
    section: 'top',
  });
  const activeSection = selection.artistId === artist.id ? selection.section : 'top';
  const activeKind = activeSection === 'top' ? null : activeSection;
  const catalog = useArtistCatalog({ provider, artistId: artist.id, activeKind });
  const description = artist.description.trim();

  const selectSection = (section: ArtistSection) => {
    setSelection({ artistId: artist.id, section });
  };
  const moveTabFocus = (section: ArtistSection) => {
    selectSection(section);
    document.getElementById(`artist-tab-${section}`)?.focus();
  };

  return (
    <div className="page detail-page artist-page">
      <section
        className="detail-hero artist-page__hero"
        style={{ '--detail-color': artist.artwork.dominantColor } as CSSProperties}
      >
        <Artwork
          artwork={artist.artwork}
          className="detail-hero__art artist-page__avatar"
          loading="eager"
          purpose="large"
        />
        <div className="detail-hero__copy">
          <p className="eyebrow">{t('eyebrow')}</p>
          <h1>{artist.name}</h1>
        </div>
      </section>

      {description && (
        <section className="artist-page__bio" aria-labelledby="artist-biography-heading">
          <h2 id="artist-biography-heading">{t('description', { name: artist.name })}</h2>
          <p>{description}</p>
        </section>
      )}

      <div className="search-tabs artist-page__tabs" role="tablist" aria-label={t('tabsLabel')}>
        {tabOrder.map((section) => (
          <button
            key={section}
            id={`artist-tab-${section}`}
            type="button"
            role="tab"
            aria-selected={activeSection === section}
            aria-controls={`artist-tabpanel-${section}`}
            tabIndex={activeSection === section ? 0 : -1}
            onClick={() => selectSection(section)}
            onKeyDown={(event) => {
              const index = tabOrder.indexOf(section);
              let nextIndex = index;
              if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabOrder.length;
              if (event.key === 'ArrowLeft') {
                nextIndex = (index - 1 + tabOrder.length) % tabOrder.length;
              }
              if (event.key === 'Home') nextIndex = 0;
              if (event.key === 'End') nextIndex = tabOrder.length - 1;
              if (nextIndex !== index) {
                event.preventDefault();
                moveTabFocus(tabOrder[nextIndex]!);
              } else if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault();
              }
            }}
          >
            {sectionLabel(section, t)}
          </button>
        ))}
      </div>

      <section
        id="artist-tabpanel-top"
        className="detail-track-section artist-page__tabpanel"
        role="tabpanel"
        aria-labelledby="artist-tab-top"
        hidden={activeSection !== 'top'}
        tabIndex={0}
      >
        <h2>{t('topSongs')}</h2>
        {artist.topSongs.length > 0 ? (
          <TrackList tracks={artist.topSongs} showAlbum titleTarget="album-first" />
        ) : (
          <ArtistEmptyState label={t('emptySongs')} icon="song" />
        )}
      </section>

      <section
        id="artist-tabpanel-song"
        className="artist-page__tabpanel"
        role="tabpanel"
        aria-labelledby="artist-tab-song"
        aria-busy={isBusy(catalog.categories.song)}
        hidden={activeSection !== 'song'}
        tabIndex={0}
      >
        <h2>{t('allSongs')}</h2>
        <ArtistCatalogContent
          kind="song"
          category={catalog.categories.song}
          errorMessage={(error) => artistCatalogErrorMessage(error, errors)}
          onRetry={catalog.retry}
          onRetryLoadMore={catalog.retryLoadMore}
          onLoadMore={catalog.loadMore}
        />
      </section>

      <section
        id="artist-tabpanel-album"
        className="artist-page__tabpanel artist-page__albums"
        role="tabpanel"
        aria-labelledby="artist-tab-album"
        aria-busy={isBusy(catalog.categories.album)}
        hidden={activeSection !== 'album'}
        tabIndex={0}
      >
        <h2>{t('allAlbums')}</h2>
        <ArtistCatalogContent
          kind="album"
          category={catalog.categories.album}
          errorMessage={(error) => artistCatalogErrorMessage(error, errors)}
          onRetry={catalog.retry}
          onRetryLoadMore={catalog.retryLoadMore}
          onLoadMore={catalog.loadMore}
        />
      </section>
    </div>
  );
}

function ArtistCatalogContent({
  kind,
  category,
  errorMessage,
  onRetry,
  onRetryLoadMore,
  onLoadMore,
}: {
  kind: ArtistCatalogKind;
  category: ArtistCatalogCategoryState;
  errorMessage: (error: unknown) => string;
  onRetry: () => Promise<void>;
  onRetryLoadMore: () => Promise<void>;
  onLoadMore: () => Promise<void>;
}) {
  const { t } = useTranslation('pages', { keyPrefix: 'artist' });
  const label = kind === 'song' ? t('allSongs') : t('allAlbums');

  if (category.status === 'idle' || category.status === 'loading') {
    return <ArtistEmptyState label={t('loading', { category: label })} icon={kind} status />;
  }
  if (category.status === 'error') {
    return (
      <div className="empty-state empty-state--error artist-page__empty" role="alert">
        <span>{kind === 'song' ? <ListMusic size={24} /> : <Disc3 size={24} />}</span>
        <h3>{t('unavailable', { category: label })}</h3>
        <p>{errorMessage(category.error)}</p>
        <button type="button" className="button button--secondary" onClick={() => void onRetry()}>
          {t('retry')}
        </button>
      </div>
    );
  }
  if (category.items.length === 0 && !category.hasMore) {
    return (
      <ArtistEmptyState label={kind === 'song' ? t('emptySongs') : t('emptyAlbums')} icon={kind} />
    );
  }

  return (
    <>
      {category.items.length === 0 ? (
        <ArtistEmptyState
          label={kind === 'song' ? t('emptySongs') : t('emptyAlbums')}
          icon={kind}
        />
      ) : kind === 'song' ? (
        <TrackList tracks={category.items as Song[]} showAlbum compact titleTarget="album-first" />
      ) : (
        <ArtistAlbumGrid albums={category.items as AlbumPreview[]} />
      )}
      {category.paginationError && (
        <div className="search-results__error" role="alert">
          <span>{t('paginationFailed', { category: label.toLowerCase() })}</span>{' '}
          <button type="button" onClick={() => void onRetryLoadMore()}>
            {t('retry')}
          </button>
        </div>
      )}
      {category.hasMore && !category.paginationError && (
        <button
          type="button"
          className="button button--secondary search-results__more"
          disabled={category.loadingMore}
          onClick={() => void onLoadMore()}
        >
          {category.loadingMore
            ? t('loadingMore', { category: label.toLowerCase() })
            : t('loadMore', { category: label.toLowerCase() })}
        </button>
      )}
    </>
  );
}

function ArtistAlbumGrid({ albums }: { albums: AlbumPreview[] }) {
  const { t } = useTranslation('pages', { keyPrefix: 'artist' });
  return (
    <div className="artist-page__album-grid">
      {albums.map((album, index) => (
        <EntityLink
          key={album.id.trim() || `missing-album:${index}`}
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
  );
}

function ArtistEmptyState({
  label,
  icon,
  status = false,
}: {
  label: string;
  icon: ArtistCatalogKind;
  status?: boolean;
}) {
  return (
    <div
      className="empty-state artist-page__empty"
      {...(status ? { role: 'status', 'aria-live': 'polite' as const } : {})}
    >
      <span>{icon === 'song' ? <ListMusic size={24} /> : <Disc3 size={24} />}</span>
      <h3>{label}</h3>
    </div>
  );
}

function isBusy(category: ArtistCatalogCategoryState): boolean {
  return category.status === 'idle' || category.status === 'loading' || category.loadingMore;
}

function sectionLabel(
  section: ArtistSection,
  translate: (key: 'topSongs' | 'allSongs' | 'allAlbums') => string,
): string {
  if (section === 'top') return translate('topSongs');
  return translate(section === 'song' ? 'allSongs' : 'allAlbums');
}

function artistCatalogErrorMessage(
  error: unknown,
  translate: (key: 'offline' | 'timeout' | 'rateLimited' | 'catalogFailed') => string,
): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code: unknown }).code);
    if (code === 'offline') return translate('offline');
    if (code === 'timeout') return translate('timeout');
    if (code === 'rate-limited') return translate('rateLimited');
  }
  return translate('catalogFailed');
}
