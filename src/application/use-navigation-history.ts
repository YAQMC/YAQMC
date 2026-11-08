import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { isProviderCatalogRoute, scopeCatalogRoute, type AppRoute } from './navigation';
import { runAfterLyricsClose } from './lyrics-presentation-actions';

export interface NavigationHistory {
  entries: AppRoute[];
  index: number;
}

const initialRoute: AppRoute = { page: 'home' };

export function routesEqual(first: AppRoute, second: AppRoute): boolean {
  if (first.page !== second.page) return false;
  if (isProviderCatalogRoute(first) && isProviderCatalogRoute(second)) {
    if (first.providerId !== second.providerId) return false;
    if (first.page === 'area' && second.page === 'area') {
      return first.encArea === second.encArea && first.title === second.title;
    }
    return 'id' in first && 'id' in second && first.id === second.id;
  }
  if (first.page === 'search' && second.page === 'search') return first.query === second.query;
  if (first.page === 'plugins' && second.page === 'plugins') {
    return (first.tab ?? 'manage') === (second.tab ?? 'manage');
  }
  if (first.page === 'plugin-page' && second.page === 'plugin-page') {
    return first.pluginId === second.pluginId && first.pageId === second.pageId;
  }
  if (first.page === 'account-playlist' && second.page === 'account-playlist') {
    return first.playlist.id === second.playlist.id;
  }
  return true;
}

export interface NavigationHistoryController {
  route: AppRoute;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Live view for event handlers registered once (e.g. the Android back button). */
  historyRef: RefObject<NavigationHistory>;
  navigate: (route: AppRoute) => void;
  goBack: () => void;
  goForward: () => void;
}

/** In-app back/forward stack. Every transition closes the lyrics stage first. */
export function useNavigationHistory(providerId: string): NavigationHistoryController {
  const [history, setHistory] = useState<NavigationHistory>({ entries: [initialRoute], index: 0 });
  const historyRef = useRef(history);

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  const navigate = useCallback(
    (nextRoute: AppRoute) => {
      const scopedRoute = scopeCatalogRoute(nextRoute, providerId);
      void runAfterLyricsClose(() => {
        setHistory((current) => {
          const active = current.entries[current.index] ?? initialRoute;
          if (routesEqual(active, scopedRoute)) return current;
          return {
            entries: [...current.entries.slice(0, current.index + 1), scopedRoute],
            index: current.index + 1,
          };
        });
      });
    },
    [providerId],
  );

  const goBack = useCallback(() => {
    void runAfterLyricsClose(() => {
      setHistory((current) => ({ ...current, index: Math.max(0, current.index - 1) }));
    });
  }, []);

  const goForward = useCallback(() => {
    void runAfterLyricsClose(() => {
      setHistory((current) => ({
        ...current,
        index: Math.min(current.entries.length - 1, current.index + 1),
      }));
    });
  }, []);

  return {
    route: history.entries[history.index] ?? initialRoute,
    canGoBack: history.index > 0,
    canGoForward: history.index < history.entries.length - 1,
    historyRef,
    navigate,
    goBack,
    goForward,
  };
}
