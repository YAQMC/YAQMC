import { useCallback, useEffect, useRef, useState } from 'react';
import type { AlbumPreview, ArtistCatalogKind, ArtistCatalogPage, Song } from '../domain/music';
import type { MusicProvider } from '../providers/music-provider';

export type ArtistCatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ArtistCatalogCategoryState {
  status: ArtistCatalogStatus;
  items: Array<Song | AlbumPreview>;
  page: number;
  hasMore: boolean;
  error: unknown | null;
  loadingMore: boolean;
  paginationError: unknown | null;
}

interface ArtistCatalogState {
  artistId: string;
  providerId: string;
  provider: MusicProvider;
  categories: Record<ArtistCatalogKind, ArtistCatalogCategoryState>;
}

type ArtistCatalogAction =
  | { type: 'reset'; artistId: string; provider: MusicProvider }
  | { type: 'start'; kind: ArtistCatalogKind }
  | { type: 'success'; kind: ArtistCatalogKind; result: ArtistCatalogPage }
  | { type: 'error'; kind: ArtistCatalogKind; error: unknown }
  | { type: 'page-start'; kind: ArtistCatalogKind }
  | { type: 'page-cancel'; kind: ArtistCatalogKind }
  | { type: 'page-success'; kind: ArtistCatalogKind; result: ArtistCatalogPage }
  | { type: 'page-error'; kind: ArtistCatalogKind; error: unknown };

interface RequestRecord {
  controller: AbortController;
  generation: number;
  kind: ArtistCatalogKind;
  artistId: string;
}

export interface UseArtistCatalogOptions {
  provider: MusicProvider;
  artistId: string;
  activeKind: ArtistCatalogKind | null;
}

export interface UseArtistCatalogResult {
  categories: Record<ArtistCatalogKind, ArtistCatalogCategoryState>;
  retry: () => Promise<void>;
  retryLoadMore: () => Promise<void>;
  loadMore: () => Promise<void>;
}

function emptyCategory(): ArtistCatalogCategoryState {
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

function emptyCategories(): Record<ArtistCatalogKind, ArtistCatalogCategoryState> {
  return { song: emptyCategory(), album: emptyCategory() };
}

function initialState(artistId: string, provider: MusicProvider): ArtistCatalogState {
  return {
    artistId,
    providerId: provider.id,
    provider,
    categories: emptyCategories(),
  };
}

function uniqueById(items: Array<Song | AlbumPreview>): Array<Song | AlbumPreview> {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = item.id.trim();
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function deduplicateResult(result: ArtistCatalogPage): ArtistCatalogPage {
  return result.kind === 'song'
    ? { ...result, items: uniqueById(result.items) as Song[] }
    : { ...result, items: uniqueById(result.items) as AlbumPreview[] };
}

function resultMatches(
  result: ArtistCatalogPage,
  artistId: string,
  kind: ArtistCatalogKind,
  page: number,
): boolean {
  return result.artistId.trim() === artistId && result.kind === kind && result.page === page;
}

function reduce(state: ArtistCatalogState, action: ArtistCatalogAction): ArtistCatalogState {
  if (action.type === 'reset') return initialState(action.artistId, action.provider);

  const category = state.categories[action.kind];
  const categories = { ...state.categories };
  switch (action.type) {
    case 'start':
      categories[action.kind] = {
        ...emptyCategory(),
        status: 'loading',
      };
      break;
    case 'success':
      categories[action.kind] = {
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
        ...emptyCategory(),
        status: 'error',
        error: action.error,
      };
      break;
    case 'page-start':
      categories[action.kind] = { ...category, loadingMore: true, paginationError: null };
      break;
    case 'page-cancel':
      categories[action.kind] = { ...category, loadingMore: false };
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

export function useArtistCatalog({
  provider,
  artistId: rawArtistId,
  activeKind,
}: UseArtistCatalogOptions): UseArtistCatalogResult {
  const artistId = rawArtistId.trim();
  const [state, setState] = useState(() => initialState(artistId, provider));
  const stateRef = useRef(state);
  const generationRef = useRef(0);
  const requestRef = useRef<RequestRecord | null>(null);

  const dispatch = useCallback((action: ArtistCatalogAction) => {
    const next = reduce(stateRef.current, action);
    stateRef.current = next;
    setState(next);
  }, []);

  const abortActive = useCallback(() => {
    requestRef.current?.controller.abort();
    requestRef.current = null;
  }, []);

  const startInitial = useCallback(
    (kind: ArtistCatalogKind, requestedArtistId: string, generation: number) => {
      const controller = new AbortController();
      requestRef.current = { controller, generation, kind, artistId: requestedArtistId };
      dispatch({ type: 'start', kind });

      let pending: Promise<ArtistCatalogPage>;
      try {
        pending = provider.getArtistCatalog(requestedArtistId, kind, controller.signal, 1, 20);
      } catch (error: unknown) {
        if (requestRef.current?.controller === controller) {
          requestRef.current = null;
          dispatch({ type: 'error', kind, error });
        }
        return;
      }

      void pending
        .then((rawResult) => {
          const request = requestRef.current;
          if (
            controller.signal.aborted ||
            !request ||
            request.controller !== controller ||
            generation !== generationRef.current ||
            stateRef.current.artistId !== requestedArtistId ||
            stateRef.current.provider !== provider
          ) {
            return;
          }
          requestRef.current = null;
          if (!resultMatches(rawResult, requestedArtistId, kind, 1)) {
            dispatch({ type: 'error', kind, error: new Error('Invalid artist catalog response') });
            return;
          }
          dispatch({ type: 'success', kind, result: deduplicateResult(rawResult) });
        })
        .catch((error: unknown) => {
          const request = requestRef.current;
          if (
            controller.signal.aborted ||
            !request ||
            request.controller !== controller ||
            generation !== generationRef.current ||
            stateRef.current.artistId !== requestedArtistId ||
            stateRef.current.provider !== provider
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
    if (!activeKind) return;
    const kind = activeKind;
    const category = stateRef.current.categories[kind];
    const requestedArtistId = stateRef.current.artistId;
    if (
      !requestedArtistId ||
      category.status !== 'ready' ||
      !category.hasMore ||
      category.loadingMore ||
      stateRef.current.provider !== provider
    ) {
      return;
    }

    abortActive();
    const generation = ++generationRef.current;
    const controller = new AbortController();
    requestRef.current = { controller, generation, kind, artistId: requestedArtistId };
    dispatch({ type: 'page-start', kind });
    const nextPage = category.page + 1;
    try {
      const result = await provider.getArtistCatalog(
        requestedArtistId,
        kind,
        controller.signal,
        nextPage,
        20,
      );
      const request = requestRef.current;
      if (
        controller.signal.aborted ||
        !request ||
        request.controller !== controller ||
        generation !== generationRef.current ||
        stateRef.current.artistId !== requestedArtistId ||
        stateRef.current.provider !== provider
      ) {
        return;
      }
      requestRef.current = null;
      if (!resultMatches(result, requestedArtistId, kind, nextPage)) {
        dispatch({
          type: 'page-error',
          kind,
          error: new Error('Invalid artist catalog response'),
        });
        return;
      }
      dispatch({ type: 'page-success', kind, result });
    } catch (error: unknown) {
      const request = requestRef.current;
      if (
        controller.signal.aborted ||
        !request ||
        request.controller !== controller ||
        generation !== generationRef.current ||
        stateRef.current.artistId !== requestedArtistId ||
        stateRef.current.provider !== provider
      ) {
        return;
      }
      requestRef.current = null;
      dispatch({ type: 'page-error', kind, error });
    }
  }, [abortActive, activeKind, dispatch, provider]);

  const retry = useCallback(async () => {
    if (!activeKind || !stateRef.current.artistId) return;
    abortActive();
    const generation = ++generationRef.current;
    startInitial(activeKind, stateRef.current.artistId, generation);
  }, [abortActive, activeKind, startInitial]);

  const retryLoadMore = useCallback(async () => {
    await loadMore();
  }, [loadMore]);

  useEffect(() => {
    const previous = stateRef.current;
    const invalidated =
      previous.artistId !== artistId ||
      previous.providerId !== provider.id ||
      previous.provider !== provider;
    if (invalidated) {
      abortActive();
      const generation = ++generationRef.current;
      stateRef.current = initialState(artistId, provider);
      dispatch({ type: 'reset', artistId, provider });
      if (artistId && activeKind) startInitial(activeKind, artistId, generation);
    } else if (artistId && activeKind) {
      const category = previous.categories[activeKind];
      if (category.status === 'idle' || (category.status === 'loading' && !requestRef.current)) {
        const generation = ++generationRef.current;
        startInitial(activeKind, artistId, generation);
      } else if (category.loadingMore && !requestRef.current) {
        dispatch({ type: 'page-cancel', kind: activeKind });
      }
    } else {
      abortActive();
      generationRef.current += 1;
    }

    return () => {
      abortActive();
      generationRef.current += 1;
    };
  }, [abortActive, activeKind, artistId, dispatch, provider, startInitial]);

  const visibleCategories =
    state.artistId === artistId && state.provider === provider
      ? state.categories
      : emptyCategories();

  return { categories: visibleCategories, retry, retryLoadMore, loadMore };
}
