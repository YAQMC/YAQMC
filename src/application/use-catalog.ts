import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AccountSnapshot, HomeFeed, LibrarySnapshot } from '../domain/music';
import { useAccountStore } from './account-runtime';
import { useMusicProvider } from './provider-context';

export type CatalogState =
  | { status: 'loading'; home: null; library: null; message: null }
  | { status: 'ready'; home: HomeFeed; library: LibrarySnapshot; message: null }
  | { status: 'error'; home: null; library: null; message: string };

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
  const [state, setState] = useState<CatalogState>({
    status: 'loading',
    home: null,
    library: null,
    message: null,
  });

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
        setState({
          status: 'error',
          home: null,
          library: null,
          message: t('catalogFailed'),
        });
      });

    return () => controller.abort();
  }, [provider, t]);

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

  return state;
}
