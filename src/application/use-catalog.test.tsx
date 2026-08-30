import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MusicProvider } from '../providers/music-provider';
import { homeFeed, librarySnapshot } from '../providers/fake/fixtures';
import { MusicProviderRoot } from './provider-root';
import { useCatalog } from './use-catalog';

function CatalogProbe() {
  const catalog = useCatalog();
  return <span data-testid="catalog-status">{catalog.status}</span>;
}

describe('useCatalog', () => {
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
    expect(provider.getHome).toHaveBeenCalledTimes(2);
    expect(provider.getLibrary).toHaveBeenCalledOnce();
    expect(provider.getAccountSnapshot).not.toHaveBeenCalled();
  });
});
