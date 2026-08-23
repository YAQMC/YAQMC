import { Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePlayerStore } from '../application/player-store';
import { useMusicProvider } from '../application/provider-context';
import type { AppRoute } from '../application/navigation';
import { useCatalogSearch } from '../application/use-catalog-search';
import { EntityLink } from '../components/EntityLink';
import { MediaCard } from '../components/MediaCard';
import { TrackList } from '../components/TrackList';
import { Artwork } from '../components/ui/Artwork';
import { IconButton } from '../components/ui/IconButton';
import type {
  AlbumPreview,
  ArtistPreview,
  CatalogSearchKind,
  HomeFeed,
  Song,
} from '../domain/music';

interface SearchPageProps {
  initialQuery?: string;
  feed: HomeFeed;
  onNavigate: (route: AppRoute) => void;
}

const tabOrder: CatalogSearchKind[] = ['song', 'artist', 'album'];

export function SearchPage({ initialQuery = '', feed, onNavigate }: SearchPageProps) {
  const { t } = useTranslation('pages', { keyPrefix: 'search' });
  const { t: errors } = useTranslation('errors');
  const provider = useMusicProvider();
  const playTracks = usePlayerStore((state) => state.playTracks);
  const [inputValue, setInputValue] = useState(initialQuery);
  const inputRef = useRef<HTMLInputElement>(null);
  const normalizedInput = inputValue.trim();
  const search = useCatalogSearch({ provider, query: normalizedInput });
  const category = search.categories[search.activeKind];
  const categoryLabel = t(search.activeKind === 'song' ? 'songs' : `${search.activeKind}s`);
  const searching = Boolean(
    normalizedInput &&
    (category.status === 'loading' || category.status === 'idle' || category.loadingMore),
  );

  useEffect(() => inputRef.current?.focus(), []);

  const moveTabFocus = (kind: CatalogSearchKind) => {
    search.setActiveKind(kind);
    document.getElementById(`search-tab-${kind}`)?.focus();
  };

  return (
    <div className="page standard-page search-page">
      <div className="search-page__field" data-searching={searching || undefined}>
        <Search size={20} />
        <input
          ref={inputRef}
          value={inputValue}
          onChange={(event) => setInputValue(event.target.value)}
          placeholder={t('placeholder')}
          aria-label={t('label')}
        />
        {inputValue && (
          <IconButton label={t('clear')} size="small" onClick={() => setInputValue('')}>
            <X size={16} />
          </IconButton>
        )}
      </div>

      {!normalizedInput ? (
        <>
          <header className="search-page__intro">
            <p className="eyebrow">{t('introEyebrow')}</p>
            <h1>{t('introTitle')}</h1>
            <p>{provider.id === 'qqmusic' ? t('introQq') : t('introOffline')}</p>
          </header>
          <section className="content-section content-section--last">
            <div className="section-heading">
              <div>
                <h2>{t('browsePlaylists')}</h2>
              </div>
            </div>
            {feed.madeForYou.length > 0 ? (
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
            ) : (
              <p className="search-page__placeholder">{t('noPlaylists')}</p>
            )}
          </section>
        </>
      ) : (
        <div className="search-results">
          <header className="search-results__heading">
            <p className="eyebrow">{t('resultsFor')}</p>
            <h1>“{normalizedInput}”</h1>
          </header>
          <div className="search-tabs" role="tablist" aria-label={t('tabsLabel')}>
            {tabOrder.map((kind) => {
              const label = t(kind === 'song' ? 'songs' : `${kind}s`);
              return (
                <button
                  key={kind}
                  id={`search-tab-${kind}`}
                  type="button"
                  role="tab"
                  aria-selected={search.activeKind === kind}
                  aria-controls="search-tabpanel"
                  tabIndex={search.activeKind === kind ? 0 : -1}
                  onClick={() => search.setActiveKind(kind)}
                  onKeyDown={(event) => {
                    const index = tabOrder.indexOf(kind);
                    let nextIndex = index;
                    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabOrder.length;
                    if (event.key === 'ArrowLeft')
                      nextIndex = (index - 1 + tabOrder.length) % tabOrder.length;
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
                  {label}
                </button>
              );
            })}
          </div>
          <section
            id="search-tabpanel"
            role="tabpanel"
            aria-labelledby={`search-tab-${search.activeKind}`}
            aria-busy={
              category.status === 'loading' || category.status === 'idle' || category.loadingMore
            }
            tabIndex={0}
          >
            {category.status === 'loading' || category.status === 'idle' ? (
              <div className="empty-state" role="status" aria-live="polite">
                <span>
                  <Search size={24} />
                </span>
                <h2>{t('loadingCategory', { category: categoryLabel })}</h2>
              </div>
            ) : category.status === 'error' ? (
              <div className="empty-state empty-state--error" role="alert">
                <span>
                  <Search size={24} />
                </span>
                <h2>{t('unavailable')}</h2>
                <p>{searchErrorMessage(category.error, errors)}</p>
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={() => void search.retry()}
                >
                  {t('retry')}
                </button>
              </div>
            ) : category.items.length === 0 ? (
              <div className="empty-state">
                <span>
                  <Search size={24} />
                </span>
                <h2>{t('noMatches', { query: normalizedInput })}</h2>
                <p>{t('emptyCategory', { category: categoryLabel.toLowerCase() })}</p>
              </div>
            ) : (
              <>
                {search.activeKind === 'song' && (
                  <section className="content-section">
                    <h2 className="search-results__category-heading">{categoryLabel}</h2>
                    <TrackList tracks={category.items as Song[]} showAlbum compact />
                  </section>
                )}
                {search.activeKind === 'artist' && (
                  <PreviewGrid kind="artist" items={category.items as ArtistPreview[]} />
                )}
                {search.activeKind === 'album' && (
                  <PreviewGrid kind="album" items={category.items as AlbumPreview[]} />
                )}
                {category.paginationError && (
                  <div className="search-results__error" role="alert">
                    <span>{t('paginationFailed', { category: categoryLabel.toLowerCase() })}</span>{' '}
                    <button type="button" onClick={() => void search.retryLoadMore()}>
                      {t('retry')}
                    </button>
                  </div>
                )}
                {category.hasMore && !category.paginationError && (
                  <button
                    type="button"
                    className="button button--secondary search-results__more"
                    disabled={category.loadingMore}
                    onClick={() => void search.loadMore()}
                  >
                    {category.loadingMore
                      ? t('loading')
                      : t('loadMore', { category: categoryLabel.toLowerCase() })}
                  </button>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function PreviewGrid({
  kind,
  items,
}: {
  kind: 'artist' | 'album';
  items: ArtistPreview[] | AlbumPreview[];
}) {
  return (
    <div className="catalog-preview-grid">
      {items.map((item, index) =>
        kind === 'artist' ? (
          <article className="catalog-preview-card" key={`${kind}-${item.id.trim() || index}`}>
            <EntityLink
              entity="artist"
              id={item.id}
              className="catalog-preview-card__link"
              ariaLabel={(item as ArtistPreview).name}
            >
              <Artwork artwork={(item as ArtistPreview).artwork} />
              <strong>{(item as ArtistPreview).name}</strong>
            </EntityLink>
          </article>
        ) : (
          <article className="catalog-preview-card" key={`${kind}-${item.id.trim() || index}`}>
            <EntityLink
              entity="album"
              id={item.id}
              className="catalog-preview-card__link"
              ariaLabel={(item as AlbumPreview).title}
            >
              <Artwork artwork={(item as AlbumPreview).artwork} />
              <strong>{(item as AlbumPreview).title}</strong>
            </EntityLink>
            <EntityLink
              entity="artist"
              id={(item as AlbumPreview).artist.id}
              className="catalog-preview-card__artist"
              ariaLabel={(item as AlbumPreview).artist.name}
            >
              {(item as AlbumPreview).artist.name}
            </EntityLink>
            {(item as AlbumPreview).releaseYear > 0 && (
              <span className="catalog-preview-card__year">
                {(item as AlbumPreview).releaseYear}
              </span>
            )}
          </article>
        ),
      )}
    </div>
  );
}

function searchErrorMessage(
  error: unknown,
  translate: (key: 'offline' | 'timeout' | 'rateLimited' | 'searchFailed') => string,
): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code: unknown }).code);
    if (code === 'offline') return translate('offline');
    if (code === 'timeout') return translate('timeout');
    if (code === 'rate-limited') return translate('rateLimited');
  }
  return translate('searchFailed');
}
