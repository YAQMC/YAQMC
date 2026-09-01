import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MusicProvider } from '../providers/music-provider';
import { homeFeed, librarySnapshot } from '../providers/fake/fixtures';
import { MusicProviderRoot } from './provider-root';
import { resetAccountRuntimeForTest, useAccountStore } from './account-runtime';
import { useCatalog } from './use-catalog';

function CatalogProbe() {
  const catalog = useCatalog();
  return <span data-testid="catalog-status">{catalog.status}</span>;
}

describe('useCatalog', () => {
  afterEach(() => resetAccountRuntimeForTest());

  it('does not invoke account methods while loading the public catalog', async () => {
    const provider = {
      id: 'catalog-with-disabled-account',
      displayName: 'Catalog fixture',
      getHome: vi.fn().mockResolvedValue(homeFeed),
      getDiscover: vi.fn(),
      getArea: vi.fn(),
      getSong: vi.fn(),
      getAlbum: vi.fn(),
      getArtist: vi.fn(),
      getArtistCatalog: vi.fn(),
      getPlaylist: vi.fn(),
      getLibrary: vi.fn().mockResolvedValue(librarySnapshot),
      getLyrics: vi.fn(),
      search: vi.fn(),
      getAccountSnapshot: vi.fn().mockRejectedValue(new Error('account unavailable')),
    } satisfies MusicProvider & {
      getAccountSnapshot: () => Promise<never>;
    };

    render(
      <MusicProviderRoot provider={provider}>
        <CatalogProbe />
      </MusicProviderRoot>,
    );

    await waitFor(() => expect(screen.getByTestId('catalog-status')).toHaveTextContent('ready'));
    await waitFor(() => expect(provider.getHome).toHaveBeenCalledTimes(2));
    expect(provider.getLibrary).toHaveBeenCalledOnce();
    expect(provider.getAccountSnapshot).not.toHaveBeenCalled();
  });

  it('forces a home refresh when the account snapshot changes', async () => {
    const provider = {
      id: 'catalog-account-refresh',
      displayName: 'Catalog fixture',
      getHome: vi.fn().mockResolvedValue(homeFeed),
      getDiscover: vi.fn(),
      getArea: vi.fn(),
      getSong: vi.fn(),
      getAlbum: vi.fn(),
      getArtist: vi.fn(),
      getArtistCatalog: vi.fn(),
      getPlaylist: vi.fn(),
      getLibrary: vi.fn().mockResolvedValue(librarySnapshot),
      getLyrics: vi.fn(),
      search: vi.fn(),
    } satisfies MusicProvider;

    render(
      <MusicProviderRoot provider={provider}>
        <CatalogProbe />
      </MusicProviderRoot>,
    );

    await waitFor(() => expect(provider.getHome).toHaveBeenCalledTimes(2));
    act(() => {
      useAccountStore.setState((current) => ({
        snapshot: { ...current.snapshot, revision: current.snapshot.revision + 1 },
      }));
    });

    await waitFor(() => expect(provider.getHome).toHaveBeenCalledTimes(3));
    expect(provider.getHome).toHaveBeenLastCalledWith(expect.any(AbortSignal), true);
  });
});
