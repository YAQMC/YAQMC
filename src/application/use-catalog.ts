import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HomeFeed, LibrarySnapshot } from '../domain/music';
import { useMusicProvider } from './provider-context';

export type CatalogState =
  | { status: 'loading'; home: null; library: null; message: null }
  | { status: 'ready'; home: HomeFeed; library: LibrarySnapshot; message: null }
  | { status: 'error'; home: null; library: null; message: string };

export function useCatalog(): CatalogState {
  const { t } = useTranslation('errors');
  const provider = useMusicProvider();
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

  return state;
}
