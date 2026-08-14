import { Search, X } from 'lucide-react';
import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePlayerStore } from '../application/player-store';
import { useMusicProvider } from '../application/provider-context';
import type { AppRoute } from '../application/navigation';
import { MediaCard } from '../components/MediaCard';
import { TrackList } from '../components/TrackList';
import { IconButton } from '../components/ui/IconButton';
import type { HomeFeed, SearchResult } from '../domain/music';

interface SearchPageProps {
  initialQuery?: string;
  feed: HomeFeed;
  onNavigate: (route: AppRoute) => void;
}

const emptyResult: SearchResult = { query: '', songs: [], albums: [], playlists: [] };

type SearchState =
  | { status: 'idle'; query: ''; providerId: ''; result: SearchResult; error: null }
  | { status: 'loading'; query: string; providerId: string; result: SearchResult; error: null }
  | { status: 'ready'; query: string; providerId: string; result: SearchResult; error: null }
  | { status: 'error'; query: string; providerId: string; result: SearchResult; error: string };

const idleSearchState: SearchState = {
  status: 'idle',
  query: '',
  providerId: '',
  result: emptyResult,
  error: null,
};

export function SearchPage({ initialQuery = '', feed, onNavigate }: SearchPageProps) {
  const { t } = useTranslation('pages', { keyPrefix: 'search' });
  const { t: errors } = useTranslation('errors');
  const provider = useMusicProvider();
  const playTracks = usePlayerStore((state) => state.playTracks);
  const [inputValue, setInputValue] = useState(initialQuery);
  const [searchState, setSearchState] = useState<SearchState>(() => {
    const query = initialQuery.trim();
    return query
      ? {
          status: 'loading',
          query,
          providerId: provider.id,
          result: { ...emptyResult, query },
          error: null,
        }
      : idleSearchState;
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const normalizedInput = inputValue.trim();
  const submittedQuery = useDeferredValue(normalizedInput);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRequestGeneration = useRef(0);
  const activeController = useRef<AbortController | null>(null);

  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    if (!submittedQuery) return;

    const controller = new AbortController();
    const generation = ++activeRequestGeneration.current;
    activeController.current = controller;
    void provider
      .search(submittedQuery, controller.signal)
      .then((next) => {
        if (controller.signal.aborted || generation !== activeRequestGeneration.current) return;
        setSearchState({
          status: 'ready',
          query: submittedQuery,
          providerId: provider.id,
          result: { ...next, query: submittedQuery },
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || generation !== activeRequestGeneration.current) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setSearchState({
          status: 'error',
          query: submittedQuery,
          providerId: provider.id,
          result: { ...emptyResult, query: submittedQuery },
          error: searchErrorMessage(error, errors),
        });
      });
    return () => {
      controller.abort();
      if (activeController.current === controller) activeController.current = null;
    };
  }, [submittedQuery, errors, provider]);

  const { result, error } = searchState;
  const hasResults = result.songs.length + result.albums.length + result.playlists.length > 0;
  const stateMatchesInput =
    searchState.query === normalizedInput && searchState.providerId === provider.id;
  const displayedResultQuery =
    searchState.status === 'ready' && stateMatchesInput ? searchState.query : '';
  const searching = Boolean(
    normalizedInput && (searchState.status === 'loading' || !stateMatchesInput),
  );
  const canDisplayResult = searchState.status === 'ready' && stateMatchesInput;

  const updateQuery = (value: string) => {
    setInputValue(value);
    const query = value.trim();
    if (query === normalizedInput) return;
    activeController.current?.abort();
    activeController.current = null;
    activeRequestGeneration.current += 1;
    setLoadingMore(false);
    setSearchState(
      query
        ? {
            status: 'loading',
            query,
            providerId: provider.id,
            result: { ...emptyResult, query },
            error: null,
          }
        : idleSearchState,
    );
  };

  const loadMore = async () => {
    if (!canDisplayResult || !result.hasMore || loadingMore) return;
    const requestedQuery = result.query;
    const generation = activeRequestGeneration.current;
    setLoadingMore(true);
    try {
      const next = await provider.search(requestedQuery, undefined, (result.page ?? 1) + 1, 20);
      if (generation !== activeRequestGeneration.current || normalizedInput !== requestedQuery) {
        return;
      }
      setSearchState({
        status: 'ready',
        query: requestedQuery,
        providerId: provider.id,
        result: {
          ...next,
          query: requestedQuery,
          songs: uniqueById([...result.songs, ...next.songs]),
          albums: uniqueById([...result.albums, ...next.albums]),
          playlists: uniqueById([...result.playlists, ...next.playlists]),
        },
        error: null,
      });
    } catch (caught) {
      if (generation === activeRequestGeneration.current && normalizedInput === requestedQuery) {
        setSearchState({
          status: 'error',
          query: requestedQuery,
          providerId: provider.id,
          result: { ...emptyResult, query: requestedQuery },
          error: searchErrorMessage(caught, errors),
        });
      }
    } finally {
      if (generation === activeRequestGeneration.current) setLoadingMore(false);
    }
  };

  return (
    <div className="page standard-page search-page">
      <div className="search-page__field" data-searching={searching || undefined}>
        <Search size={20} />
        <input
          ref={inputRef}
          value={inputValue}
          onChange={(event) => updateQuery(event.target.value)}
          placeholder={t('placeholder')}
          aria-label={t('label')}
        />
        {inputValue && (
          <IconButton label={t('clear')} size="small" onClick={() => updateQuery('')}>
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
          </section>
        </>
      ) : canDisplayResult && hasResults ? (
        <div className="search-results">
          <header className="search-results__heading">
            <p className="eyebrow">{t('resultsFor')}</p>
            <h1>“{displayedResultQuery}”</h1>
          </header>
          {result.songs.length > 0 && (
            <section className="content-section">
              <div className="section-heading">
                <div>
                  <h2>{t('songs')}</h2>
                </div>
              </div>
              <TrackList tracks={result.songs} showAlbum compact />
            </section>
          )}
          {result.albums.length > 0 && (
            <section className="content-section">
              <div className="section-heading">
                <div>
                  <h2>{t('albums')}</h2>
                </div>
              </div>
              <div className="media-grid media-grid--four">
                {result.albums.map((album) => (
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
          {result.playlists.length > 0 && (
            <section className="content-section content-section--last">
              <div className="section-heading">
                <div>
                  <h2>{t('playlists')}</h2>
                </div>
              </div>
              <div className="media-grid media-grid--four">
                {result.playlists.map((playlist) => (
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
          {result.hasMore && (
            <button
              type="button"
              className="button button--secondary search-results__more"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? t('loading') : t('loadMore')}
            </button>
          )}
        </div>
      ) : searchState.status === 'error' && stateMatchesInput ? (
        <div className="empty-state empty-state--error">
          <span>
            <Search size={24} />
          </span>
          <h1>{t('unavailable')}</h1>
          <p>{error}</p>
        </div>
      ) : searchState.status === 'ready' && stateMatchesInput ? (
        <div className="empty-state">
          <span>
            <Search size={24} />
          </span>
          <h1>{t('noMatches', { query: displayedResultQuery })}</h1>
          <p>{t('noMatchesHint')}</p>
        </div>
      ) : null}
    </div>
  );
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
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
