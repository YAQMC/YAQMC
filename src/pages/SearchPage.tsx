import { LoaderCircle, Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePlayerStore } from '../application/player-store';
import { useMusicProvider } from '../application/provider-context';
import type { AppRoute } from '../application/navigation';
import { useCatalogSearch } from '../application/use-catalog-search';
import { isAndroidRuntime } from '../application/host-capabilities';
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
  PlaylistPreview,
  Song,
} from '../domain/music';

interface SearchPageProps {
  initialQuery?: string;
  feed: HomeFeed;
  onNavigate: (route: AppRoute) => void;
}

const tabOrder: CatalogSearchKind[] = ['song', 'artist', 'album', 'playlist'];
const ANDROID_SEARCH_DEBOUNCE_MS = 280;

export function SearchPage({ initialQuery = '', feed, onNavigate }: SearchPageProps) {
  const { t } = useTranslation('pages', { keyPrefix: 'search' });
  const { t: errors } = useTranslation('errors');
  const provider = useMusicProvider();
  const playTracks = usePlayerStore((state) => state.playTracks);
  const androidRuntime = isAndroidRuntime();
  const [inputValue, setInputValue] = useState(initialQuery);
  const [requestQuery, setRequestQuery] = useState(initialQuery.trim());
  const [isComposing, setIsComposing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const loadMoreTargetRef = useRef<HTMLDivElement>(null);
  const normalizedInput = inputValue.trim();
  const search = useCatalogSearch({
    provider,
    query: androidRuntime ? requestQuery : normalizedInput,
  });
  const category = search.categories[search.activeKind];
  const loadMore = search.loadMore;
  const categoryLabel = t(search.activeKind === 'song' ? 'songs' : `${search.activeKind}s`);
  const queryPending = normalizedInput !== search.query;
  const searching = Boolean(
    normalizedInput &&
    (queryPending ||
      category.status === 'loading' ||
      category.status === 'idle' ||
      category.loadingMore),
  );

  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    if (!androidRuntime) return;
    if (isComposing) return;
    const timer = window.setTimeout(
      () => setRequestQuery(normalizedInput),
      normalizedInput ? ANDROID_SEARCH_DEBOUNCE_MS : 0,
    );
    return () => window.clearTimeout(timer);
  }, [androidRuntime, isComposing, normalizedInput]);

  useEffect(() => {
    const target = loadMoreTargetRef.current;
    if (
      !target ||
      !normalizedInput ||
      queryPending ||
      category.status !== 'ready' ||
      !category.hasMore ||
      category.loadingMore ||
      category.paginationError !== null ||
      typeof IntersectionObserver === 'undefined'
    ) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      { rootMargin: '360px 0px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [
    category.hasMore,
    category.loadingMore,
    category.paginationError,
    category.status,
    normalizedInput,
    queryPending,
    loadMore,
  ]);

  const moveTabFocus = (kind: CatalogSearchKind) => {
    search.setActiveKind(kind);
    document.getElementById(`search-tab-${kind}`)?.focus();
  };

  return (
    <div className="page standard-page search-page">
      <form
        className="search-page__field"
        data-searching={searching || undefined}
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          setRequestQuery(normalizedInput);
          inputRef.current?.blur();
        }}
      >
        <Search size={20} />
        <input
          ref={inputRef}
          enterKeyHint="search"
          value={inputValue}
          onChange={(event) => setInputValue(event.target.value)}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={(event) => {
            setIsComposing(false);
            setInputValue(event.currentTarget.value);
          }}
          placeholder={t('placeholder')}
          aria-label={t('label')}
        />
        {inputValue && (
          <IconButton label={t('clear')} size="small" onClick={() => setInputValue('')}>
            <X size={16} />
          </IconButton>
        )}
      </form>

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
              queryPending ||
              category.status === 'loading' ||
              category.status === 'idle' ||
              category.loadingMore
            }
            tabIndex={0}
          >
            {queryPending || category.status === 'loading' || category.status === 'idle' ? (
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
                {search.activeKind === 'playlist' && (
                  <PreviewGrid kind="playlist" items={category.items as PlaylistPreview[]} />
                )}
              </>
            )}
            {category.status === 'ready' && category.paginationError !== null && (
              <div className="search-results__error" role="alert">
                <span>{t('paginationFailed', { category: categoryLabel.toLowerCase() })}</span>{' '}
                <button type="button" onClick={() => void search.retryLoadMore()}>
                  {t('retry')}
                </button>
              </div>
            )}
            {category.status === 'ready' &&
              category.hasMore &&
              category.paginationError === null && (
                <div
                  ref={loadMoreTargetRef}
                  className="search-results__sentinel"
                  data-yaqmc="search-load-sentinel"
                  role={category.loadingMore ? 'status' : undefined}
                  aria-label={category.loadingMore ? t('loading') : undefined}
                >
                  {category.loadingMore && <LoaderCircle size={20} aria-hidden="true" />}
                </div>
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
  kind: 'artist' | 'album' | 'playlist';
  items: ArtistPreview[] | AlbumPreview[] | PlaylistPreview[];
}) {
  const { t } = useTranslation('pages', { keyPrefix: 'search' });
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
        ) : kind === 'album' ? (
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
        ) : (
          <article className="catalog-preview-card" key={`${kind}-${item.id.trim() || index}`}>
            <EntityLink
              entity="playlist"
              id={item.id}
              className="catalog-preview-card__link"
              ariaLabel={(item as PlaylistPreview).title}
            >
              <Artwork artwork={(item as PlaylistPreview).artwork} />
              <strong>{(item as PlaylistPreview).title}</strong>
            </EntityLink>
            {(item as PlaylistPreview).creator && (
              <span className="catalog-preview-card__artist">
                {(item as PlaylistPreview).creator}
              </span>
            )}
            <span className="catalog-preview-card__year">
              {t('playlistTrackCount', { count: (item as PlaylistPreview).trackCount })}
            </span>
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
