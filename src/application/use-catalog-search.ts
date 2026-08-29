import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ArtistPreview,
  AlbumPreview,
  CatalogSearchKind,
  PlaylistPreview,
  SearchResult,
  Song,
} from '../domain/music';
import type { MusicProvider } from '../providers/music-provider';

export type SearchCategoryStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface SearchCategoryState {
  status: SearchCategoryStatus;
  items: Array<Song | ArtistPreview | AlbumPreview | PlaylistPreview>;
  page: number;
  hasMore: boolean;
  error: unknown | null;
  loadingMore: boolean;
  paginationError: unknown | null;
}

export interface CatalogSearchState {
  query: string;
  providerId: string;
  provider: MusicProvider;
  categories: Record<CatalogSearchKind, SearchCategoryState>;
}

export interface UseCatalogSearchOptions {
  provider: MusicProvider;
  query: string;
  initialKind?: CatalogSearchKind;
}

export interface UseCatalogSearchResult {
  query: string;
  activeKind: CatalogSearchKind;
  categories: Record<CatalogSearchKind, SearchCategoryState>;
  setActiveKind: (kind: CatalogSearchKind) => void;
  retry: () => Promise<void>;
  retryLoadMore: () => Promise<void>;
  loadMore: () => Promise<void>;
}

type SearchAction =
  | { type: 'reset'; query: string; provider: MusicProvider }
  | { type: 'start'; kind: CatalogSearchKind }
  | { type: 'cancel'; kind: CatalogSearchKind }
  | { type: 'success'; kind: CatalogSearchKind; result: SearchResult }
  | { type: 'error'; kind: CatalogSearchKind; error: unknown }
  | { type: 'page-start'; kind: CatalogSearchKind }
  | { type: 'page-success'; kind: CatalogSearchKind; result: SearchResult }
  | { type: 'page-error'; kind: CatalogSearchKind; error: unknown };

function emptyCategory(): SearchCategoryState {
  return {
    status: 'idle',
    items: [],
    page: 1,
    hasMore: false,
    error: null,
    loadingMore: false,
    paginationError: null,
  };
}

function emptyCategories(): Record<CatalogSearchKind, SearchCategoryState> {
  return {
    song: emptyCategory(),
    artist: emptyCategory(),
    album: emptyCategory(),
    playlist: emptyCategory(),
  };
}

function initialState(query: string, provider: MusicProvider): CatalogSearchState {
  return { query, providerId: provider.id, provider, categories: emptyCategories() };
}

function reduce(state: CatalogSearchState, action: SearchAction): CatalogSearchState {
  if (action.type === 'reset') return initialState(action.query, action.provider);

  const category = state.categories[action.kind];
  const categories = { ...state.categories };
  switch (action.type) {
    case 'start':
      categories[action.kind] = {
        ...category,
        status: 'loading',
        items: [],
        page: 1,
        hasMore: false,
        error: null,
        loadingMore: false,
        paginationError: null,
      };
      break;
    case 'cancel':
      categories[action.kind] = {
        ...category,
        status: category.items.length > 0 ? 'ready' : 'idle',
        loadingMore: false,
      };
      break;
    case 'success':
      categories[action.kind] = {
        ...category,
        status: 'ready',
        items: action.result.items,
        page: action.result.page,
        hasMore: action.result.hasMore,
        error: null,
        loadingMore: false,
        paginationError: null,
      };
      break;
    case 'error':
      categories[action.kind] = {
        ...category,
        status: 'error',
        items: [],
        page: 1,
        hasMore: false,
        error: action.error,
        loadingMore: false,
        paginationError: null,
      };
      break;
    case 'page-start':
      categories[action.kind] = { ...category, loadingMore: true, paginationError: null };
      break;
    case 'page-success':
      categories[action.kind] = {
        ...category,
        status: 'ready',
        items: uniqueById([...category.items, ...action.result.items]),
        page: action.result.page,
        hasMore: action.result.hasMore,
        loadingMore: false,
        paginationError: null,
      };
      break;
    case 'page-error':
      categories[action.kind] = { ...category, loadingMore: false, paginationError: action.error };
      break;
  }
  return { ...state, categories };
}

function uniqueById(items: Array<Song | ArtistPreview | AlbumPreview | PlaylistPreview>) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = item.id.trim();
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function deduplicateResult(result: SearchResult): SearchResult {
  switch (result.kind) {
    case 'song':
      return { ...result, items: uniqueById(result.items) as Song[] };
    case 'artist':
      return { ...result, items: uniqueById(result.items) as ArtistPreview[] };
    case 'album':
      return { ...result, items: uniqueById(result.items) as AlbumPreview[] };
    case 'playlist':
      return { ...result, items: uniqueById(result.items) as PlaylistPreview[] };
  }
}

function resultMatches(result: SearchResult, kind: CatalogSearchKind, query: string): boolean {
  return result.kind === kind && result.query.trim() === query;
}

interface RequestRecord {
  controller: AbortController;
  generation: number;
  kind: CatalogSearchKind;
  query: string;
  phase: 'initial' | 'page';
}

export function useCatalogSearch({
  provider,
  query: rawQuery,
  initialKind = 'song',
}: UseCatalogSearchOptions): UseCatalogSearchResult {
  const query = rawQuery.trim();
  const [activeKind, setActiveKindState] = useState<CatalogSearchKind>(initialKind);
  const [state, setState] = useState(() => initialState(query, provider));
  const stateRef = useRef(state);
  const generationRef = useRef(0);
  const requestRef = useRef<RequestRecord | null>(null);

  const dispatch = useCallback((action: SearchAction) => {
    const next = reduce(stateRef.current, action);
    stateRef.current = next;
    setState(next);
  }, []);

  const abortActive = useCallback(() => {
    requestRef.current?.controller.abort();
    requestRef.current = null;
  }, []);

  const setActiveKind = useCallback(
    (kind: CatalogSearchKind) => {
      if (kind === activeKind) return;
      const request = requestRef.current;
      if (request) {
        dispatch({ type: 'cancel', kind: request.kind });
        abortActive();
        generationRef.current += 1;
      }
      setActiveKindState(kind);
    },
    [abortActive, activeKind, dispatch],
  );

  const startInitial = useCallback(
    (kind: CatalogSearchKind, requestedQuery: string, generation: number) => {
      const controller = new AbortController();
      requestRef.current = {
        controller,
        generation,
        kind,
        query: requestedQuery,
        phase: 'initial',
      };
      dispatch({ type: 'start', kind });
      let pending: Promise<SearchResult>;
      try {
        pending = provider.search(requestedQuery, kind, controller.signal, 1, 20);
      } catch (error: unknown) {
        if (requestRef.current?.controller === controller) {
          requestRef.current = null;
          dispatch({ type: 'error', kind, error });
        }
        return;
      }
      void pending
        .then((result) => {
          const request = requestRef.current;
          if (
            controller.signal.aborted ||
            !request ||
            request.controller !== controller ||
            generation !== generationRef.current ||
            stateRef.current.query !== requestedQuery ||
            stateRef.current.providerId !== provider.id
          ) {
            return;
          }
          requestRef.current = null;
          if (!resultMatches(result, kind, requestedQuery) || result.page !== 1) {
            dispatch({ type: 'error', kind, error: new Error('Invalid search response') });
          } else {
            dispatch({
              type: 'success',
              kind,
              result: deduplicateResult(result),
            });
          }
        })
        .catch((error: unknown) => {
          const request = requestRef.current;
          if (
            controller.signal.aborted ||
            !request ||
            request.controller !== controller ||
            generation !== generationRef.current ||
            stateRef.current.query !== requestedQuery ||
            stateRef.current.providerId !== provider.id
          ) {
            return;
          }
          requestRef.current = null;
          dispatch({ type: 'error', kind, error });
        });
    },
    [dispatch, provider],
  );

  const loadMore = useCallback(async () => {
    const kind = activeKind;
    const category = stateRef.current.categories[kind];
    const requestedQuery = stateRef.current.query;
    if (
      !requestedQuery ||
      category.status !== 'ready' ||
      !category.hasMore ||
      category.loadingMore ||
      stateRef.current.providerId !== provider.id
    ) {
      return;
    }
    abortActive();
    const generation = ++generationRef.current;
    const controller = new AbortController();
    requestRef.current = { controller, generation, kind, query: requestedQuery, phase: 'page' };
    dispatch({ type: 'page-start', kind });
    try {
      const result = await provider.search(
        requestedQuery,
        kind,
        controller.signal,
        category.page + 1,
        20,
      );
      const request = requestRef.current;
      if (
        controller.signal.aborted ||
        !request ||
        request.controller !== controller ||
        generation !== generationRef.current ||
        stateRef.current.query !== requestedQuery ||
        stateRef.current.providerId !== provider.id
      ) {
        return;
      }
      requestRef.current = null;
      if (!resultMatches(result, kind, requestedQuery) || result.page !== category.page + 1) {
        dispatch({ type: 'page-error', kind, error: new Error('Invalid search response') });
      } else {
        dispatch({ type: 'page-success', kind, result });
      }
    } catch (error: unknown) {
      const request = requestRef.current;
      if (
        controller.signal.aborted ||
        !request ||
        request.controller !== controller ||
        generation !== generationRef.current ||
        stateRef.current.query !== requestedQuery ||
        stateRef.current.providerId !== provider.id
      ) {
        return;
      }
      requestRef.current = null;
      dispatch({ type: 'page-error', kind, error });
    }
  }, [abortActive, activeKind, dispatch, provider]);

  const retry = useCallback(async () => {
    const kind = activeKind;
    const requestedQuery = stateRef.current.query;
    if (!requestedQuery) return;
    abortActive();
    const generation = ++generationRef.current;
    startInitial(kind, requestedQuery, generation);
  }, [abortActive, activeKind, startInitial]);

  const retryLoadMore = useCallback(async () => {
    await loadMore();
  }, [loadMore]);

  useEffect(() => {
    const previous = stateRef.current;
    const invalidated =
      previous.query !== query ||
      previous.providerId !== provider.id ||
      previous.provider !== provider;
    if (invalidated) {
      abortActive();
      const generation = ++generationRef.current;
      stateRef.current = initialState(query, provider);
      dispatch({ type: 'reset', query, provider });
      if (query) startInitial(activeKind, query, generation);
    } else {
      const category = previous.categories[activeKind];
      if (
        query &&
        (category.status === 'idle' || (category.status === 'loading' && !requestRef.current))
      ) {
        const generation = ++generationRef.current;
        startInitial(activeKind, query, generation);
      }
    }

    return () => {
      abortActive();
      generationRef.current += 1;
    };
  }, [abortActive, activeKind, dispatch, provider, query, startInitial]);

  const visibleCategories =
    state.query === query && state.provider === provider ? state.categories : emptyCategories();

  return {
    query,
    activeKind,
    categories: visibleCategories,
    setActiveKind,
    retry,
    retryLoadMore,
    loadMore,
  };
}
