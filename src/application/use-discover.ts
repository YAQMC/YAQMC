import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DiscoverFeed } from '../domain/music';
import { useMusicProvider } from './provider-context';

export type DiscoverState =
  | { status: 'loading'; discover: null; message: null }
  | { status: 'ready'; discover: DiscoverFeed; message: null }
  | { status: 'error'; discover: null; message: string };

const DISCOVER_REFRESH_MS = 15 * 60 * 1_000;

export function useDiscover(): DiscoverState {
  const { t } = useTranslation('errors');
  const provider = useMusicProvider();
  const [state, setState] = useState<DiscoverState>({
    status: 'loading',
    discover: null,
    message: null,
  });

  useEffect(() => {
    const controller = new AbortController();

    void provider
      .getDiscover(controller.signal)
      .then((discover) => {
        setState({ status: 'ready', discover, message: null });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setState({
          status: 'error',
          discover: null,
          message: t('catalogFailed'),
        });
      });

    void provider
      .getDiscover(controller.signal, true)
      .then((discover) => {
        setState((current) => (current.status === 'ready' ? { ...current, discover } : current));
      })
      .catch(() => {
        // A startup refresh failure keeps the cached feed; the periodic
        // refresh retries later.
      });

    return () => controller.abort();
  }, [provider, t]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void provider
        .getDiscover()
        .then((discover) => {
          setState((current) => (current.status === 'ready' ? { ...current, discover } : current));
        })
        .catch(() => {
          // A background refresh failure keeps the current feed; the next
          // interval retries.
        });
    }, DISCOVER_REFRESH_MS);

    return () => window.clearInterval(interval);
  }, [provider]);

  return state;
}
