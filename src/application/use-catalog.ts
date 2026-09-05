import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ProviderError,
  type AccountSnapshot,
  type HomeFeed,
  type LibrarySnapshot,
} from '../domain/music';
import { useAccountStore } from './account-runtime';
import { useMusicProvider } from './provider-context';

type CatalogDataState =
  | { status: 'loading'; home: null; library: null; message: null }
  | { status: 'ready'; home: HomeFeed; library: LibrarySnapshot; message: null }
  | { status: 'error'; home: null; library: null; message: string };

export type CatalogState = CatalogDataState & { retry: () => void };

const HOME_REFRESH_MS = 15 * 60 * 1_000;

function accountHomeKey(snapshot: AccountSnapshot): string {
  const profile = snapshot.profile;
  const entitlement = snapshot.entitlement;
  return [
    snapshot.revision,
    snapshot.state,
    profile?.maskedIdentity ?? '',
    profile?.nickname ?? '',
    profile?.avatarUrl ?? '',
    entitlement?.tier ?? '',
    entitlement?.membership ?? '',
    entitlement?.expiresAtMs ?? '',
    entitlement?.secondaryEntitlements?.join(',') ?? '',
    entitlement?.permittedQualities.join(',') ?? '',
    entitlement?.observedMaximumQuality ?? '',
  ].join('\u0000');
}

export function useCatalog(): CatalogState {
  const { t } = useTranslation('errors');
  const provider = useMusicProvider();
  const accountKey = useAccountStore((current) => accountHomeKey(current.snapshot));
  const previousAccount = useRef<{
    provider: typeof provider;
    key: string;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<CatalogDataState>({
    status: 'loading',
    home: null,
    library: null,
    message: null,
  });
  const retry = useCallback(() => {
    setState({ status: 'loading', home: null, library: null, message: null });
    setAttempt((current) => current + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    void Promise.all([provider.getHome(controller.signal), provider.getLibrary(controller.signal)])
      .then(([home, library]) => {
        setState({ status: 'ready', home, library, message: null });
        void provider
          .getHome(controller.signal, true)
          .then((refreshedHome) => {
            setState((current) =>
              current.status === 'ready' ? { ...current, home: refreshedHome } : current,
            );
          })
          .catch(() => {
            // The cache-backed first paint remains valid; later refreshes retry.
          });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        const message =
          error instanceof ProviderError
            ? error.code === 'offline'
              ? t('offline')
              : error.code === 'timeout'
                ? t('timeout')
                : error.code === 'rate-limited'
                  ? t('rateLimited')
                  : t('catalogFailed')
            : t('catalogFailed');
        setState({
          status: 'error',
          home: null,
          library: null,
          message,
        });
      });

    return () => controller.abort();
  }, [attempt, provider, t]);

  useEffect(() => {
    const previous = previousAccount.current;
    previousAccount.current = { provider, key: accountKey };
    if (previous === null || previous.provider !== provider || previous.key === accountKey) {
      return;
    }

    const controller = new AbortController();
    void provider
      .getHome(controller.signal, true)
      .then((home) => {
        setState((current) => (current.status === 'ready' ? { ...current, home } : current));
      })
      .catch(() => {
        // Keep the current feed. A later account event or periodic refresh retries.
      });
    return () => controller.abort();
  }, [accountKey, provider]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void provider
        .getHome(undefined, true)
        .then((home) => {
          setState((current) => (current.status === 'ready' ? { ...current, home } : current));
        })
        .catch(() => {
          // A background refresh failure keeps the current feed; the next
          // interval retries and the initial load already reported errors.
        });
    }, HOME_REFRESH_MS);

    return () => window.clearInterval(interval);
  }, [provider]);

  useEffect(() => {
    if (state.status !== 'error') return;
    let retried = false;
    const retryAfterConnectivityChange = () => {
      if (retried || document.visibilityState !== 'visible') return;
      retried = true;
      retry();
    };
    window.addEventListener('online', retryAfterConnectivityChange);
    document.addEventListener('visibilitychange', retryAfterConnectivityChange);
    return () => {
      window.removeEventListener('online', retryAfterConnectivityChange);
      document.removeEventListener('visibilitychange', retryAfterConnectivityChange);
    };
  }, [retry, state.status]);

  return { ...state, retry };
}
