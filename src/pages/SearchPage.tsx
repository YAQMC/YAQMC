import { Search, X } from 'lucide-react';
import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { usePlayerStore } from '../application/player-store';
import { useMusicProvider } from '../application/provider-context';
import type { AppRoute } from '../application/navigation';
import type { HomeFeed, SearchResult } from '../domain/music';
import { MediaCard } from '../components/MediaCard';
import { TrackList } from '../components/TrackList';
import { IconButton } from '../components/ui/IconButton';
import { useTranslation } from 'react-i18next';

interface SearchPageProps {
  initialQuery?: string;
  feed: HomeFeed;
  onNavigate: (route: AppRoute) => void;
}

const emptyResult: SearchResult = { query: '', songs: [], albums: [], playlists: [] };

export function SearchPage({ initialQuery = '', feed, onNavigate }: SearchPageProps) {
  const { t } = useTranslation('pages', { keyPrefix: 'search' });
  const { t: errors } = useTranslation('errors');
  const provider = useMusicProvider();
  const playTracks = usePlayerStore((state) => state.playTracks);
  const [query, setQuery] = useState(initialQuery);
  const [result, setResult] = useState<SearchResult>(emptyResult);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const deferredQuery = useDeferredValue(query.trim());
  const inputRef = useRef<HTMLInputElement>(null);
  const activeQuery = useRef('');

  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    if (!deferredQuery) return;

    const controller = new AbortController();
    activeQuery.current = deferredQuery;
    void provider
      .search(deferredQuery, controller.signal)
      .then((next) => {
        setResult(next);
        setError(null);
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setResult({ ...emptyResult, query: deferredQuery });
          setError(searchErrorMessage(error, errors));
        }
      });
    return () => controller.abort();
  }, [deferredQuery, errors, provider]);

  const hasResults = result.songs.length + result.albums.length + result.playlists.length > 0;
  const searching = Boolean(deferredQuery && result.query !== deferredQuery);

  const updateQuery = (value: string) => {
    setQuery(value);
    if (!value.trim()) {
      setResult(emptyResult);
      setError(null);
    }
  };

  const loadMore = async () => {
    if (!result.hasMore || loadingMore) return;
    const requestedQuery = result.query;
    setLoadingMore(true);
    try {
      const next = await provider.search(requestedQuery, undefined, (result.page ?? 1) + 1, 20);
      if (activeQuery.current !== requestedQuery) return;
      setResult({
        ...next,
        songs: uniqueById([...result.songs, ...next.songs]),
        albums: uniqueById([...result.albums, ...next.albums]),
        playlists: uniqueById([...result.playlists, ...next.playlists]),
      });
    } catch (caught) {
      if (activeQuery.current === requestedQuery) setError(searchErrorMessage(caught, errors));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="page standard-page search-page">
      <div className="search-page__field" data-searching={searching || undefined}>
        <Search size={20} />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => updateQuery(event.target.value)}
          placeholder={t('placeholder')}
          aria-label={t('label')}
        />
        {query && (
          <IconButton label={t('clear')} size="small" onClick={() => updateQuery('')}>
            <X size={16} />
          </IconButton>
        )}
      </div>

      {!deferredQuery ? (
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
      ) : hasResults ? (
        <div className="search-results">
          <header className="search-results__heading">
            <p className="eyebrow">{t('resultsFor')}</p>
            <h1>“{result.query}”</h1>
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
          {error && <p className="search-results__error">{error}</p>}
        </div>
      ) : error ? (
        <div className="empty-state empty-state--error">
          <span>
            <Search size={24} />
          </span>
          <h1>{t('unavailable')}</h1>
          <p>{error}</p>
        </div>
      ) : !searching ? (
        <div className="empty-state">
          <span>
            <Search size={24} />
          </span>
          <h1>{t('noMatches', { query: deferredQuery })}</h1>
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
